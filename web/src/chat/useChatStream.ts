/**
 * useChatStream —— 流式对话 hook（SSE 事件 → store 状态）
 *
 * ═══ 职责边界 ═══
 * · 只做**事件 → 状态**的搬运与生命周期管理；**不含**检索/生成业务（那在后端）
 * · 是**唯一**允许 dispatch `stream*` 动作的地方（单写者，保证同一时刻一个活跃流）
 *
 * ═══ 通用语义契约 ═══
 * · 前置：`config.enabled === true` 且 `ackRequired === false`（否则调用方应阻塞发送）
 * · 后置：流结束后 store 的 `streaming.active === false`，内容已并入 `messages`
 * · 空值：`abort()` 在无活跃流时**静默无操作**（不抛错）
 * · 错误：HTTP 层错 → `dispatch(streamDegraded)`? **否** —— 应写入消息的错误态并提示可重试（N4）
 * · 中止：`abort()` → 后端发 `aborted` 事件 → UI 标记「已中止」并**保留已生成部分**（N6）
 * · 并发：单写者 —— 新流开始前必须 abort 旧流（切会话 / 重新生成 / 编辑重发均适用）
 * · 副作用：网络请求；**不落盘**
 *
 * @see design/S03_前端对话面板与流式对话_DESIGN.md §9.1
 */

import type { ChatStore } from './chatStore';

export interface ChatStreamApi {
  /** 发消息（API-08） */
  send(convId: string, text: string): Promise<void>;
  /** 重新生成（API-11，不新增 user 消息） */
  regenerate(convId: string): Promise<void>;
  /** 编辑并重发（API-12，后端原子截断） */
  editAndResend(convId: string, msgId: string, text: string): Promise<void>;
  /** 中止当前生成（N6：保留已生成部分并标记「已中止」） */
  abort(): void;
  /** 是否存在活跃流 */
  isStreaming(): boolean;
}

/**
 * 消费 SSE 事件并更新 store。**事件分派规则见 `chatContract.ts` 的 `ChatEvent` 联合类型**。
 *
 * 实现要点（勿省）：
 * · `tool_start` / `tool_end` → `progress` 步骤（R11a 的"每一秒都有反馈"）
 * · `sources` → 挂到本轮 assistant 消息上（刷新后由后端落盘还原）
 * · `degraded` → 设置**可见**标记（N17，不得静默）
 * · `reasoning` → 只进内存态的 `reasoning` 字段（**不落盘**，D7）
 */
export function useChatStream(_store: ChatStore): ChatStreamApi {
  throw new Error(`STUB:SR-02:useChatStream`);
}
