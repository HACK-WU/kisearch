/**
 * chatStore.ts —— **AppShell 级常驻状态**（D15 硬约束的落点）
 *
 * ═══ ★ 为什么必须在 AppShell 级 ═══
 * D15：关闭面板 = **隐藏，不卸载、不中止生成**。
 * 若流式累积态（content / reasoning / 工具步骤）与"当前会话"存在 **面板组件内部**，
 * 关闭面板 → 组件卸载 → 状态丢失 + 可能连带 abort —— 正是 D15 要防的。
 *
 * 因此：**store 实例在 `AppShell` 创建（常驻），面板组件只是视图**。
 *
 * ═══ 通用语义契约 ═══
 * · 生命周期：随 AppShell 挂载创建，随其卸载销毁（本应用 AppShell 是唯一 layout → 事实上全程存活）
 * · 空值：无活动会话 → `activeConvId: null` + `messages: []`
 * · 并发：同一会话的流式状态**单写者**（由 `useChatStream` 保证同一时刻只有一个活跃流）
 * · abort 时机：仅「切会话 / 删会话 / daemon 退出」中止；**关闭面板不中止**
 * · 副作用：不落盘（落盘归后端）；纯内存态
 *
 * @see design/S03_前端对话面板与流式对话_DESIGN.md §9.3 · S05 §9.2
 */

import type { ChatMessage, SourceRef } from '@/api/chatContract';

/** 生成期间的动态反馈条目（按时间序，供 R11a 展示） */
export type ProgressStep =
  | { kind: 'tool'; phase: 'start' | 'end'; label: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'answering' };

/** 降级标记（**必须可见，不得静默** —— N17） */
export interface DegradedMark {
  reason: 'tools-unsupported' | 'retrieval-unavailable' | 'semantic-degraded';
  label: string;
}

/** 流式累积态（生成期间实时变化） */
export interface StreamingState {
  /** 是否正在生成 */
  active: boolean;
  /** 本次 assistant 消息 id（`meta` 事件给出） */
  messageId: string | null;
  content: string;
  /** 思考内容 —— **仅内存，不落盘**（D7）；刷新/切会话即失 */
  reasoning: string;
  /** 工具步骤 + 生成中状态（R11a：每一秒都要有可见反馈） */
  progress: ProgressStep[];
  /** 降级标记 */
  degraded: DegradedMark | null;
}

export interface ChatUiState {
  /** 面板是否展开（D15：false 仅代表隐藏，不代表卸载） */
  open: boolean;
  activeConvId: string | null;
  /** 已落盘的消息（当前会话） */
  messages: ChatMessage[];
  /** 生成中累积态 */
  streaming: StreamingState;
}

/** 初始值（面板默认展开，T1：默认态可后续调整并记忆用户选择） */
export const INITIAL_CHAT_STATE: ChatUiState = {
  open: true,
  activeConvId: null,
  messages: [],
  streaming: {
    active: false,
    messageId: null,
    content: '',
    reasoning: '',
    progress: [],
    degraded: null,
  },
};

/** 动作（视图层只通过这些动作改状态） */
export type ChatAction =
  | { type: 'setOpen'; open: boolean }
  | { type: 'setActiveConv'; convId: string | null }
  | { type: 'setMessages'; messages: ChatMessage[] }
  | { type: 'streamStart'; messageId: string }
  | { type: 'streamContent'; text: string }
  | { type: 'streamReasoning'; text: string }
  | { type: 'streamProgress'; step: ProgressStep }
  | { type: 'streamDegraded'; mark: DegradedMark }
  | { type: 'streamSources'; sources: SourceRef[] }
  | { type: 'streamEnd' }
  | { type: 'reset' };

/**
 * 纯函数 reducer（**无副作用**，便于测试与并发推理）。
 *
 * ⚠️ **骨架期的实现边界**（重要，勿误解为"骨架被绕过"）：
 * · **UI 动作**（`setOpen` / `setActiveConv` / `reset`）→ 有最小实现，
 *   因为它们在**启动与首屏路径**上；此处抛错会导致 `AppShell` 白屏
 * · **数据动作**（`setMessages` / `stream*`）→ **抛错**，它们是业务逻辑，属实现方职责
 *
 * 关键约定：
 * · `streamEnd` 后 `content`/`reasoning`/`progress` 清空（已并入 `messages`）
 * · `setActiveConv` 视为"切会话" → **调用方负责 abort 进行中的流**（reducer 不做副作用）
 */
export function chatReducer(state: ChatUiState, action: ChatAction): ChatUiState {
  switch (action.type) {
    case 'setOpen':
      return { ...state, open: action.open };
    case 'setActiveConv':
      return {
        ...state,
        activeConvId: action.convId,
        messages: [],
        streaming: INITIAL_CHAT_STATE.streaming,
      };
    case 'reset':
      return { ...INITIAL_CHAT_STATE, open: state.open };
    // ▼ 以下为业务逻辑：骨架期统一抛错（调用即失败，不静默返回假值）
    case 'setMessages':
    case 'streamStart':
    case 'streamContent':
    case 'streamReasoning':
    case 'streamProgress':
    case 'streamDegraded':
    case 'streamSources':
    case 'streamEnd':
      throw new Error(`STUB:SR-02:chatReducer:${action.type}`);
  }
}

/** store 句柄（在 AppShell 创建，通过 Context 下发给面板） */
export interface ChatStore {
  getState(): ChatUiState;
  dispatch(action: ChatAction): void;
  subscribe(listener: () => void): () => void;
}

/**
 * 创建常驻 store（★ 在 `AppShell` 内调用一次，**不要在 `ChatPanel` 内调用**）。
 *
 * 骨架期即为**完整实现**：它是纯内存订阅容器，不含业务逻辑，无实现价值空间。
 * 业务逻辑在 `chatReducer` 的数据动作与 `useChatStream` 中（那些才是抛错点）。
 */
export function createChatStore(): ChatStore {
  let state = INITIAL_CHAT_STATE;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action: ChatAction) => {
      state = chatReducer(state, action);
      for (const l of listeners) l();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
