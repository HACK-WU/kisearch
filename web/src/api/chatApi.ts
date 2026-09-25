/**
 * chatApi.ts —— `/api/chat/*` 接口封装 + SSE 解析
 *
 * ═══ 通用语义契约 ═══
 * · 通道：同源 `fetch`（dev 经 Vite proxy → 7423）；**浏览器绝不直连第三方模型**
 * · SSE 用 `fetch` + `ReadableStream`（**不用 `EventSource`**：它只支持 GET、无法带请求体、无法中途 abort）
 * · 事件分派：按 `data.type`（**不使用 SSE `event:` 字段**，见 api/INDEX.md §1）
 * · 错误：非 2xx → 抛 `ChatApiError`（带 `code`）；流中 `{type:'error'}` → 作为事件产出，**不抛**
 * · 空值：列表无数据 → `{items: [], nextCursor: null}`（不返回 null）
 * · 幂等：读类幂等；`createConversation` / `streamMessage` / `streamRegenerate` / `streamEditMessage` 非幂等
 * · 中止：`AbortSignal` 触发 → 流正常结束（后端发 `aborted` 事件）
 *
 * ⚠️ **骨架桩的参数命名约定**：本文件所有未实现函数的参数以 `_` 前缀
 *   （`web/tsconfig.json` 开了 `noUnusedParameters`，而桩体是 `throw`，
 *    非 `_` 前缀的未使用参数会导致 `tsc --noEmit` 失败）。
 *   **实现时**把 `_` 去掉即可，参数语义见各函数 JSDoc。
 *
 * @see api/INDEX.md · api/retrieval.md
 */

import type { ChatConfigOk, ChatEvent, ConversationFile, ConversationSummary } from '@/api/chatContract';

/** chat 接口基础路径（导出以便其他模块复用，避免多处硬编码） */
export const CHAT_API_BASE = '/api/chat';

/** 契约错误（HTTP 层）；流内错误以 `{type:'error'}` 事件表达 */
export class ChatApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(`STUB:SR-02:ChatApiError:${message}`);
  }
}

// ─── 配置（API-01 / API-13）────────────────────────────────

/**
 * GET `/api/chat/config`。**未就绪时仍 200**（`enabled:false`），不抛错。
 *
 * 消费方须区分三个正交状态：`enabled`（能否对话）/ `supportsTools`（走哪条检索路径）/ `ackRequired`（是否需先确认）。
 */
export async function getChatConfig(): Promise<ChatConfigOk> {
  throw new Error(`STUB:SR-02:getChatConfig`);
}

/** POST `/api/chat/config/ack` —— 隐私确认（T12）。幂等 */
export async function ackDisclosure(): Promise<{ ok: true; kbDisclosureAck: true }> {
  throw new Error(`STUB:SR-02:ackDisclosure`);
}

// ─── 会话 CRUD（API-02 ~ API-07 / API-14）──────────────────

/**
 * @param _scope 会话归属 scope（**同时是检索边界**，见 N23）
 * @param _opts.archived 是否看已归档（默认 false）
 * @param _opts.cursor `{updatedAt}__{id}` 复合游标
 */
export async function listConversations(
  _scope: string,
  _opts?: { archived?: boolean; limit?: number; cursor?: string | null },
): Promise<{ items: ConversationSummary[]; nextCursor: string | null }> {
  throw new Error(`STUB:SR-02:listConversations`);
}

/** @param _input `title` ≤48 字、`systemPrompt` ≤4000 字；均可不传（title 默认取首条用户消息前 24 字） */
export async function createConversation(
  _scope: string,
  _input?: { title?: string; systemPrompt?: string },
): Promise<{ conv: Pick<ConversationFile, 'id' | 'title' | 'systemPrompt' | 'createdAt' | 'updatedAt'> }> {
  throw new Error(`STUB:SR-02:createConversation`);
}

/** @param _id 会话 id；越权时后端返回 **403 而非 404**（防状态码探测） */
export async function getConversation(
  _id: string,
): Promise<{ conv: ConversationFile }> {
  throw new Error(`STUB:SR-02:getConversation`);
}

/** @param _patch 至少一项；`PATCH` 无任何可改字段 → 400 `CONVERSATION_INVALID` */
export async function patchConversation(
  _id: string,
  _patch: { title?: string; systemPrompt?: string },
): Promise<{ conv: Pick<ConversationFile, 'id' | 'title' | 'systemPrompt' | 'updatedAt'> }> {
  throw new Error(`STUB:SR-02:patchConversation`);
}

/** @param _archived `true` = 归档（软删）；`false` = 恢复 */
export async function archiveConversation(
  _id: string,
  _archived: boolean,
): Promise<{ conv: Pick<ConversationFile, 'id' | 'archived' | 'archivedAt'> }> {
  throw new Error(`STUB:SR-02:archiveConversation`);
}

/** 物理删除（前端须二次确认）；后端级联删本地图片，**绝不动 kb/** */
export async function deleteConversation(_id: string): Promise<{ ok: true }> {
  throw new Error(`STUB:SR-02:deleteConversation`);
}

/**
 * DELETE `/api/chat/conversations?scope=` —— 清空全部（N8）。幂等。
 *
 * @param _scope 目标 scope；**绝不触碰 `kb/{scope}/`**
 */
export async function clearConversations(_scope: string): Promise<{ ok: true; deleted: number }> {
  throw new Error(`STUB:SR-02:clearConversations`);
}

// ─── 生成类（API-08 / API-11 / API-12）—— 三者共用 SSE 解析 ────

/**
 * API-08 发消息。产出**完整事件序**（含 `meta` 首帧与 `done`/`error` 末帧）。
 *
 * ⚠️ 契约：实现必须**逐帧解析并 yield**（不得等整条流结束再返回），
 * 否则 R8 的"首字 1s 量级"与 R11a 的"每一秒都有反馈"无法满足。
 *
 * @param _convId 会话 id（后端保证同一会话的写入串行化）
 * @param _text 1~20000 字；空白 → 400 `MESSAGE_INVALID`
 * @param _signal 中止信号（切会话 / 点停止 / 删会话时触发）
 */
export async function* streamMessage(
  _convId: string,
  _text: string,
  _signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  throw new Error(`STUB:SR-02:streamMessage`);
}

/** API-11 重新生成（**不新增 user 消息**，R23）；后端替换最后一条 assistant，`messageCount` 不变 */
export async function* streamRegenerate(
  _convId: string,
  _signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  throw new Error(`STUB:SR-02:streamRegenerate`);
}

/**
 * API-12 编辑并重发（N21 原子截断由后端保证）。
 *
 * `meta.discardedCount` 告知被丢弃的轮数 → UI 应在操作前提示"将丢弃其后 N 轮"。
 *
 * @param _msgId 必须是 **user 消息**；指向 assistant → 400 `MESSAGE_INVALID`
 */
export async function* streamEditMessage(
  _convId: string,
  _msgId: string,
  _text: string,
  _signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  throw new Error(`STUB:SR-02:streamEditMessage`);
}
