/**
 * 会话存储（S-02 + §9 v2）
 *
 * ═══ 通用语义契约（本模块所有函数适用）═══
 * · 前置：`scope` 必须已通过 `validateScope`（`src/lib/scope.ts`）
 * · 空值：会话不存在返回 `null`（读类）或抛 `ConversationNotFound`（写类）
 * · 错误：落盘失败抛 `ChatWriteFailed`（**不返回部分成功**）
 * · 幂等：读类天然幂等；`archiveConversation` 幂等；`createConversation` 非幂等
 * · 并发：**同一 `conversationId` 的读-改-写必须串行化**（见下方 withConvLock）
 * · 事务：单会话单文件，一次 `writeJson` 落盘（WAL 原子写，见 `src/lib/wal.ts`）
 * · 副作用：仅写 `{chatDir}/{scope}/`，**绝不触碰 `kb/`**
 *
 * ═══ 两条结构性不变量（不得违反）═══
 * 1. `ChatMessage` 不含 `reasoning`（D7）
 * 2. `ChatMessage` 不含检索原始结果，只落投影后的 `sources`（N22）
 *
 * @see design/S02_会话存储与写入一致性_DESIGN.md §3.3 / §9
 */

import type { ConversationFile, ChatMessage, ConversationSummary } from './chat-contract.js';

/** 会话不存在（映射 404 `CONVERSATION_NOT_FOUND`） */
export class ConversationNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`STUB:SR-01:ConversationNotFoundError`);
  }
}

/** 落盘失败（映射 500 `CHAT_WRITE_FAILED`） */
export class ChatWriteFailedError extends Error {
  constructor(public readonly cause?: unknown) {
    super(`STUB:SR-01:ChatWriteFailedError`);
  }
}

/** 会话正在生成中（映射 409 `CONVERSATION_GENERATING`） */
export class ConversationGeneratingError extends Error {
  constructor(public readonly id: string) {
    super(`STUB:SR-01:ConversationGeneratingError`);
  }
}

// ─────────────────────────────────────────────────────────────
// 并发控制（S-02 §3.3 —— 本模块最关键的机制）
// ─────────────────────────────────────────────────────────────

/**
 * 会话级读-改-写互斥。
 *
 * **为什么必须有**：`walWrite` 只保证**单次写入**原子，不覆盖"读-改-写"序列；
 * 并发（多标签页 / 重复提交）会导致 Last-Write-Wins **消息静默丢失**（N11）。
 *
 * **契约**：
 * · 前置：无
 * · 后置：同一 id 的 fn 严格串行；前序失败不阻塞后续
 * · 副作用：执行完毕后回收 Map key（否则随会话数无界增长）
 * · ⚠️ **生成期间不持锁**：调用方须分两段加锁（追加 user → 生成 → 追加 assistant）
 */
export function withConvLock<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
  throw new Error(`STUB:SR-01:withConvLock`);
}

// ─────────────────────────────────────────────────────────────
// 路径与读
// ─────────────────────────────────────────────────────────────

/** `{chatDir}/{scope}/`；`chatDir` 默认 `~/.ki/chat`（独立于 `kb/`，见 D4） */
export function chatDirFor(scope: string): string {
  throw new Error(`STUB:SR-01:chatDirFor`);
}

/** 读单个会话；不存在返回 `null`；文件损坏抛 `CORRUPT_JSON`（沿用 `readJson` 语义） */
export function readConversation(scope: string, id: string): Promise<ConversationFile | null> {
  throw new Error(`STUB:SR-01:readConversation`);
}

/**
 * 列会话（按 `(updatedAt, id)` 严格递减）。
 *
 * · 分页：`cursor` 为 `{updatedAt}__{id}` 复合值（避免同毫秒漏条）
 * · 损坏文件：该条 `corrupted:true`，**其余正常返回**（不整体失败）
 * · 非 `c-*.json` 文件：忽略，不报错
 */
export function listConversations(
  scope: string,
  opts: { archived?: boolean; limit?: number; cursor?: string | null },
): Promise<{ items: ConversationSummary[]; nextCursor: string | null }> {
  throw new Error(`STUB:SR-01:listConversations`);
}

// ─────────────────────────────────────────────────────────────
// 写（CRUD）
// ─────────────────────────────────────────────────────────────

/** 新建会话。id 形如 `c-{base36(Date.now())}-{rand4}`；`title` 默认取首条用户消息前 24 字 */
export function createConversation(
  scope: string,
  input: { title?: string; systemPrompt?: string },
): Promise<ConversationFile> {
  throw new Error(`STUB:SR-01:createConversation`);
}

/** 改 `title` / `systemPrompt`。幂等（同值重复提交结果一致） */
export function patchConversation(
  scope: string,
  id: string,
  patch: { title?: string; systemPrompt?: string },
): Promise<ConversationFile> {
  throw new Error(`STUB:SR-01:patchConversation`);
}

/** 归档/恢复（软删）。幂等 */
export function archiveConversation(
  scope: string,
  id: string,
  archived: boolean,
): Promise<ConversationFile> {
  throw new Error(`STUB:SR-01:archiveConversation`);
}

/**
 * 物理删除。
 *
 * · 级联删除 `{chatDir}/{scope}/assets/{convId}__*`（**仅本地图片**）
 * · ★ **绝不删除 `kb/` 下的知识库资产**（N15 —— 属知识库资产，可能被文档引用）
 */
export function deleteConversation(scope: string, id: string): Promise<void> {
  throw new Error(`STUB:SR-01:deleteConversation`);
}

/**
 * 清空该 scope 全部会话（API-14 / N8）。
 *
 * · 幂等：无会话时返回 `0`
 * · ★ 绝不触碰 `kb/{scope}/`
 * · 部分失败：已删的保留（不假装事务），抛 `ChatWriteFailedError`
 */
export function deleteAllConversations(scope: string): Promise<number> {
  throw new Error(`STUB:SR-01:deleteAllConversations`);
}

// ─────────────────────────────────────────────────────────────
// 消息写入（三条路径，语义不同，勿混用）
// ─────────────────────────────────────────────────────────────

/** 追加消息（锁内读最新，杜绝 TOCTOU）。`seq += 1` */
export function appendMessage(
  scope: string,
  id: string,
  msg: ChatMessage,
  patch?: Partial<ConversationFile>,
): Promise<ConversationFile> {
  throw new Error(`STUB:SR-01:appendMessage`);
}

/**
 * **重新生成**专用：替换最后一条 assistant 消息（R23 / API-11）。
 *
 * · 不新增 user 消息
 * · 删除 `U` 之后的 assistant 后再追加新的 → `messageCount` **不变**
 * · 若最后一条是 user（首次生成失败）→ 等价于"继续生成"，不报错
 */
export function replaceLastAssistant(
  scope: string,
  id: string,
  msg: ChatMessage,
): Promise<ConversationFile> {
  throw new Error(`STUB:SR-01:replaceLastAssistant`);
}

/**
 * **编辑并重发**专用（R24 / API-12 / N21）—— 原子截断。
 *
 * 契约（必须在**同一把会话锁内**完成）：
 * 1. `msgId` 不属于该会话 → 抛 `ConversationNotFoundError`
 * 2. `msgId` 指向 assistant → 抛 `MessageInvalidError`（只能编辑 user 消息）
 * 3. 物理截断 `msgId` 之后**全部**消息（不保留分支，D14 本期不做分支树）
 * 4. 用 `newText` 替换该消息 `content`，一次落盘
 * 5. 返回 `discardedCount`（供 SSE `meta` 事件告知前端）
 *
 * ⚠️ 锁只覆盖"截断 + 写入"；**生成在锁外**（沿用 S-02 §3.3）
 */
export function truncateAfterAndEdit(
  scope: string,
  id: string,
  msgId: string,
  newText: string,
): Promise<{ conv: ConversationFile; discardedCount: number }> {
  throw new Error(`STUB:SR-01:truncateAfterAndEdit`);
}

/** 消息参数非法（映射 400 `MESSAGE_INVALID`） */
export class MessageInvalidError extends Error {
  constructor(public readonly detail: string) {
    super(`STUB:SR-01:MessageInvalidError`);
  }
}
