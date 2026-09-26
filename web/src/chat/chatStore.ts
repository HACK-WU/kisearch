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
  /**
   * 本轮流序号（由 `useChatStream` 的令牌注入，`streamStart` 时写入）。
   *
   * ★ 用途：让 `streamEnd` 具备"**只有当前流能收尾**"的守门能力。
   *   被取代的旧流其 `finally` 中的 `streamEnd{seq: 旧值}` 会被 reducer 直接忽略，
   *   不会把新流的累积态重置为初始态（竞态见 `useChatStream` 的 seqRef 注释）。
   *   `undefined` = 不带令牌（向后兼容：纯 reducer 单测可不传）。
   */
  seq: number | undefined;
  /** 本次 assistant 消息 id（`meta` 事件给出） */
  messageId: string | null;
  content: string;
  /** 思考内容 —— **仅内存，不落盘**（D7）；刷新/切会话即失 */
  reasoning: string;
  /** 工具步骤 + 生成中状态（R11a：每一秒都要有可见反馈） */
  progress: ProgressStep[];
  /** 降级标记 */
  degraded: DegradedMark | null;
  /**
   * 本轮是否被**中止**。
   *
   * 为什么必须有：`finalizeStream` 要把该标记写进并入 `messages` 的那条消息
   * （`ChatMessage.aborted`）——否则「用户主动停止」与「正常完成」在 UI 上外观完全相同
   * （「已中止」徽标永不显示，N6 失效）。
   *
   * 置位来源：`aborted` 事件（正常路径）/ 用户 abort 但事件未达（网络中断兜底）。
   */
  aborted: boolean;
  /**
   * 本轮来源引用缓冲（内部字段，**不扩大冻结的 `ChatAction` 形状**）。
   *
   * 为什么必须有：`sources` 事件到达时 assistant 消息**尚未写进 `messages`**
   * （消息在 `streamEnd` 才并入），此时"挂到消息上"无处可挂。
   * 因此先缓冲在 streaming 里，`streamEnd` 时一次性并入消息 —— 否则来源引用会静默丢失。
   */
  sources: SourceRef[];
}

export interface ChatUiState {
  /** 面板是否展开（D15：false 仅代表隐藏，不代表卸载） */
  open: boolean;
  activeConvId: string | null;
  /** 已落盘的消息（当前会话） */
  messages: ChatMessage[];
  /** 生成中累积态 */
  streaming: StreamingState;
  /**
   * **已完成消息的降级标记**（键 = `messageId`）。
   *
   * 为什么不挂在 `ChatMessage` 上：`ChatMessage` 形状在 `chatContract.ts` 里**冻结**
   * （前端副本与后端 SSOT 由 `contract-parity` 机械比对），无 `degraded` 字段。
   * 而 N17 要求标记"必须可见、不得静默"——若只存在 `streaming.degraded`，
   * 生成结束（`streamEnd` 清空累积态）后标记即消失，回看历史时用户会把
   * 「没检索」当成「检索了但没找到」。
   *
   * 因此放在会话级 UI 态里：**不扩冻结契约**，但生成结束后标记仍可见。
   * （刷新后由后端落盘内容还原——契约无该字段，故刷新后不保留，属已知边界。）
   */
  degradedByMessage: Record<string, DegradedMark>;
  /**
   * 一次性提示文案（当前为 `done.warning` 的落地，如「会话过长，建议新建会话」）。
   *
   * 为什么要有：`done.warning`（`tool-rounds-exhausted` / `conversation-too-long`）是
   * 唯一告知用户"本轮回答可能不完整"的通道；不消费它 = 前端零反馈（S03 §5 要求提示）。
   * 生命周期：`streamStart` / 切会话时清空（属"本轮"提示，不跨轮残留）。
   */
  notice: string | null;
}

/** 初始值（面板默认展开，T1：默认态可后续调整并记忆用户选择） */
export const INITIAL_CHAT_STATE: ChatUiState = {
  open: true,
  activeConvId: null,
  messages: [],
  streaming: {
    active: false,
    seq: undefined,
    messageId: null,
    content: '',
    reasoning: '',
    progress: [],
    degraded: null,
    aborted: false,
    sources: [],
  },
  degradedByMessage: {},
  notice: null,
};

/** 动作（视图层只通过这些动作改状态） */
export type ChatAction =
  | { type: 'setOpen'; open: boolean }
  | { type: 'setActiveConv'; convId: string | null }
  | { type: 'setMessages'; messages: ChatMessage[] }
  /** `seq`：本轮流序号（可选，见 `StreamingState.seq`） */
  | { type: 'streamStart'; messageId: string; seq?: number }
  | { type: 'streamContent'; text: string }
  | { type: 'streamReasoning'; text: string }
  | { type: 'streamProgress'; step: ProgressStep }
  | { type: 'streamDegraded'; mark: DegradedMark }
  | { type: 'streamSources'; sources: SourceRef[] }
  /** 本轮被中止（收到 `aborted` 事件，或用户 abort 而事件未达）→ 收尾时写进消息标记（N6） */
  | { type: 'streamAborted' }
  /**
   * 校正本轮 assistant 消息 id（`done` / `aborted` 事件携带**服务端落盘后的真实 id**）。
   * `meta` 给的是预估值，与落盘后的 `m{seq}` 可能不同 → 不校正会造成本地/磁盘 id 错位。
   */
  | { type: 'streamMessageId'; messageId: string }
  /** `seq`：仅当与 `StreamingState.seq` 一致时才收尾（可选，向后兼容纯 reducer 单测） */
  | { type: 'streamEnd'; seq?: number }
  /** 一次性提示（`done.warning` 落地）；`null` = 清除 */
  | { type: 'notice'; text: string | null }
  | { type: 'reset' };

/**
 * 纯函数 reducer（**无副作用**，便于测试与并发推理）。
 *
 * 关键约定：
 * · `streamEnd` 后 `content`/`reasoning`/`progress`/`aborted` 清空（已并入 `messages`）
 * · `setActiveConv` 视为"切会话" → **调用方负责 abort 进行中的流**（reducer 不做副作用），
 *   并清空该会话的降级标记表
 * · **"谁能收尾"由调用方把关**：被取代的旧流不得再 dispatch `streamEnd`
 *   （见 `useChatStream` 的流序号令牌）—— 否则它会把新流的累积态重置为初始态
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
        degradedByMessage: {},
        notice: null,
      };
    case 'reset':
      return { ...INITIAL_CHAT_STATE, open: state.open };

    // ▼ 消息本体：整体替换当前会话的已落盘消息（无活动的 assistant 占位）
    case 'setMessages':
      return { ...state, messages: action.messages };

    // ▼ 一次性提示（`done.warning`）：不改消息、不改累积态
    case 'notice':
      return { ...state, notice: action.text };

    // ▼ 流式动作：全部只改 streaming，不触碰 messages（消息在 streamEnd 时一次性并入）
    case 'streamStart': {
      // ★ 防「迟到且携带旧令牌的 streamStart」把守门复位：
      //   若允许更小的 seq 覆写 `streaming.seq`，被取代的旧流其 `streamEnd{seq: 旧值}`
      //   会**重新通过**守门 → 又回到"旧流重置新流累积态、新回答整段丢失"的原始缺陷。
      //   （唯一可能携带旧 seq 的来源是旧流迟到的 `meta` 事件。）
      //   `undefined`（未带令牌的纯 reducer 单测）不参与比较，保持向后兼容。
      if (
        action.seq !== undefined &&
        state.streaming.seq !== undefined &&
        action.seq < state.streaming.seq
      ) {
        return state;
      }
      // 新流开始：清空上一轮的累积态与一次性提示，避免交错（切会话 / 重新生成 / 编辑重发都走这里）
      return {
        ...state,
        notice: null,
        streaming: {
          active: true,
          seq: action.seq,
          messageId: action.messageId,
          content: '',
          reasoning: '',
          progress: [],
          degraded: null,
          aborted: false,
          sources: [],
        },
      };
    }

    case 'streamContent':
      // 增量追加（SSE 逐帧语义）；单写者由 useChatStream 保证
      return {
        ...state,
        streaming: { ...state.streaming, content: state.streaming.content + action.text },
      };

    case 'streamReasoning':
      // D7：只进内存态，不落盘、不写进 messages
      return {
        ...state,
        streaming: { ...state.streaming, reasoning: state.streaming.reasoning + action.text },
      };

    case 'streamProgress':
      return {
        ...state,
        streaming: { ...state.streaming, progress: [...state.streaming.progress, action.step] },
      };

    case 'streamDegraded':
      // N17：标记必须可见，不得静默。degraded 三类互斥且至多一次（由后端保证），
      // 故后到者不覆盖先到者——保留最先触发的原因，避免把"没检索"显示成"检索降级"。
      return {
        ...state,
        streaming: { ...state.streaming, degraded: state.streaming.degraded ?? action.mark },
      };

    case 'streamSources':
      // ★ 缓冲到 streaming（不是直接挂 messages）：`sources` 事件到达时本轮 assistant
      //   消息尚未并入 `messages`，此时无处可挂 → 直接挂会静默丢失来源引用。
      //   若重生成场景下该消息已存在，则同步挂上，避免"已有气泡看不到来源"。
      return {
        ...state,
        streaming: { ...state.streaming, sources: action.sources },
        messages: attachSources(state.messages, state.streaming.messageId, action.sources),
      };

    case 'streamAborted':
      // N6：把"本轮被中止"记进累积态 → 收尾时随消息一起落进 `ChatMessage.aborted`
      //     （原先该字段恒为 false，「已中止」徽标永不显示）
      return {
        ...state,
        streaming: { ...state.streaming, aborted: true },
      };

    case 'streamMessageId':
      // 用服务端真实 id 覆盖 `meta` 的预估值；**只改 id，不动内容/累积态**
      return {
        ...state,
        streaming: { ...state.streaming, messageId: action.messageId },
      };

    case 'streamEnd':
      // ★ 守门：带令牌时必须是"当前流"才能收尾。
      //   被取代的旧流（其 finally 迟于新流开始）在此被忽略 —— 否则它会把**新流**的
      //   streaming 重置为初始态（messageId=null），新流后续 content 收尾时整段丢弃。
      //   `action.seq === undefined` 表示不带令牌（纯 reducer 单测）→ 放行，保持向后兼容。
      if (action.seq !== undefined && action.seq !== state.streaming.seq) return state;
      // 收尾：把累积内容并入 messages，并清空流式态
      // （约定：content / reasoning / progress / aborted 清空）
      // · 无内容的流（如"中止且 content 为空"）不产生空气泡
      // · 已存在同 id 消息时做替换（重新生成的语义：替换而非追加重复）
      return {
        ...state,
        messages: finalizeStream(state.messages, state.streaming),
        // ★ N17：降级标记随消息**留存**（不进冻结的 ChatMessage，理由见 degradedByMessage 注释）。
        //   原先只落在 streaming.degraded，streamEnd 一清空 → 生成结束后回看历史看不到标记。
        degradedByMessage: retainDegraded(state.degradedByMessage, state.streaming),
        streaming: INITIAL_CHAT_STATE.streaming,
      };
  }
}

/** 收尾时把本轮降级标记留存到 `degradedByMessage`（键 = messageId）；无标记/无 id/无内容时原样返回 */
function retainDegraded(
  prev: Record<string, DegradedMark>,
  streaming: StreamingState,
): Record<string, DegradedMark> {
  const { degraded, messageId, content } = streaming;
  // 无内容 → `finalizeStream` 不会产生消息，标记无处可挂
  if (!degraded || !messageId || !content) return prev;
  return { ...prev, [messageId]: degraded };
}

/** 把本轮来源引用挂到指定 messageId 上；id 为空或无匹配时不改消息（来源仍由 done 事件兜底） */
function attachSources(
  messages: ChatMessage[],
  messageId: string | null,
  sources: SourceRef[],
): ChatMessage[] {
  if (!messageId) return messages;
  return messages.map((m) => (m.id === messageId ? { ...m, sources } : m));
}

/**
 * 流结束时的合并：把 streaming 累积态并入 messages。
 *
 * 为什么放在 reducer 里而不是调用方：D15 下"关闭面板"不应影响内容归属，
 * 把合并做成纯函数可以让"先关面板再结束"与"一直开着"走完全相同的代码路径。
 */
function finalizeStream(messages: ChatMessage[], streaming: StreamingState): ChatMessage[] {
  const { messageId, content, sources, aborted } = streaming;
  // 无内容 → 不新增消息（对齐 messages.md：中止且 content 为空时不落盘空气泡）
  if (!content) return messages;
  if (!messageId) return messages;

  // 来源引用随消息一起并入（★ 否则 sources 事件的内容会在收尾时丢失，R20 失效）
  const merged: SourceRef[] | undefined = sources.length > 0 ? sources : undefined;

  const existing = messages.findIndex((m) => m.id === messageId);
  if (existing >= 0) {
    // 重新生成：替换原 assistant 消息内容（来源与中止标记同步覆盖）
    const next = messages.slice();
    next[existing] = {
      ...next[existing]!,
      content,
      aborted,
      ...(merged ? { sources: merged } : {}),
    };
    return next;
  }

  return [
    ...messages,
    {
      id: messageId,
      role: 'assistant',
      content,
      at: new Date().toISOString(),
      // ★ N6：中止标记来自本轮 `aborted`（原先恒写 false → 「已中止」徽标永不显示）；
      //   "中止也要保留已生成部分"这条硬要求不变。
      aborted,
      ...(merged ? { sources: merged } : {}),
    },
  ];
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
