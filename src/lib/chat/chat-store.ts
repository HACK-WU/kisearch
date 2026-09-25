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

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../store.js';
import { loadConfig, resolveDefaultChatDir } from '../config.js';
import { validateScope } from '../scope.js';
import type { ConversationFile, ChatMessage, ConversationSummary } from './chat-contract.js';

/** 会话不存在（映射 404 `CONVERSATION_NOT_FOUND`） */
export class ConversationNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`会话不存在：${id}`);
    this.name = 'ConversationNotFoundError';
  }
}

/** 落盘失败（映射 500 `CHAT_WRITE_FAILED`） */
export class ChatWriteFailedError extends Error {
  constructor(public readonly cause?: unknown) {
    super(`会话落盘失败：${cause instanceof Error ? cause.message : String(cause ?? '未知原因')}`);
    this.name = 'ChatWriteFailedError';
  }
}

/** 会话正在生成中（映射 409 `CONVERSATION_GENERATING`） */
export class ConversationGeneratingError extends Error {
  constructor(public readonly id: string) {
    super(`会话正在生成中：${id}`);
    this.name = 'ConversationGeneratingError';
  }
}

// ─────────────────────────────────────────────────────────────
// 并发控制（S-02 §3.3 —— 本模块最关键的机制）
// ─────────────────────────────────────────────────────────────

/** 会话级读-改-写互斥的锁链（key = conversationId；执行完毕后回收） */
const locks = new Map<string, Promise<unknown>>();

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
  const prev = locks.get(id) ?? Promise.resolve();
  // 前序失败不阻塞后续：用 then(fn, fn) 双分支
  const run = prev.then(fn, fn);
  // 链尾：吞掉拒绝，避免未处理 Promise 拒绝告警
  const tail = run.catch(() => undefined);
  locks.set(id, tail);
  // 关键：链尾执行完毕后回收 key，避免 Map 随会话数无界增长
  void tail.finally(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return run;
}

// ─────────────────────────────────────────────────────────────
// 路径与读
// ─────────────────────────────────────────────────────────────

/**
 * `{config.dataDir}/chat/{scope}/`（独立于 `kb/`，见 D4）。
 *
 * ★ **基准必须来自 `loadConfig()`**（与 `getKbDir` 同源），**不得硬编码 `~/.ki`**：
 * · 硬编码会绕过 config 链路 → 用户配了 `KI_DATA_DIR` 或 `dataDir` 时 chat 数据**不跟随**
 * · 且会让测试**无法隔离**（没有 env 入口 → 测试只能写真实用户目录）
 * 落到 `~/.ki/chat/{scope}` 只是"默认 dataDir = `~/.ki/kb`"的结果，不是写死的值。
 */
export function chatDirFor(scope: string): string {
  validateScope(scope);
  return path.join(chatRootDir(), scope);
}

/**
 * 会话存储**根目录**（全部 scope 的父目录，即 `{chatDir}/`）。
 *
 * 单独导出（而非各处重复推导）是为了消除"路径基准"的多处副本 ——
 * `chat-routes` 的按 `:id` 跨 scope 查找需要根目录，而 `chatDirFor` 需要 scope 子目录，
 * 二者必须**同源**，否则会出现"查找用 A 基准、读写用 B 基准"的分裂 bug。
 */
export function chatRootDir(): string {
  const cfg = loadConfig();
  // `loadConfig()` 的 `parseAndExpand` 与 `buildDefaults()` 都保证 `chatDir` 非空，
  // 故此处的回退只是**纵深防御**；且复用 `resolveDefaultChatDir` 这一**唯一推导处**，
  // 不在此重写一遍 `dirname(dataDir)`（否则两处推导会各自漂移）。
  return cfg.chatDir ?? resolveDefaultChatDir(cfg.dataDir);
}

/** 会话文件路径 */
function convPath(scope: string, id: string): string {
  return path.join(chatDirFor(scope), `${id}.json`);
}

/** 本地图片附件目录（`{chatDir}/{scope}/assets/`） */
function assetsDirFor(scope: string): string {
  return path.join(chatDirFor(scope), 'assets');
}

/** `c-*.json` 会话文件名判定（磁盘上其他文件一律忽略，S02 §5） */
const CONV_FILE_RE = /^c-[A-Za-z0-9-]+\.json$/;

/** 防御路径穿越：id 只允许 `c-...` 形态 */
function assertValidId(id: string): void {
  if (!/^c-[A-Za-z0-9-]+$/.test(id)) {
    throw new ConversationNotFoundError(id);
  }
}

/** 读单个会话；不存在返回 `null`；文件损坏抛 `CORRUPT_JSON`（沿用 `readJson` 语义） */
export async function readConversation(scope: string, id: string): Promise<ConversationFile | null> {
  validateScope(scope);
  assertValidId(id);
  const data = readJson<ConversationFile>(convPath(scope, id));
  return data ?? null;
}

/** 列表排序键：`(updatedAt, id)` 严格递减；返回负数表示 a 应排在 b 之前（更靠前 = 更新） */
function compareDesc(a: { updatedAt: string; id: string }, b: { updatedAt: string; id: string }): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** 组合游标编解码：`{updatedAt}__{id}`（避免同毫秒漏条） */
export function encodeCursor(updatedAt: string, id: string): string {
  return `${updatedAt}__${id}`;
}

export function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  const idx = cursor.indexOf('__');
  if (idx < 0) return null;
  return { updatedAt: cursor.slice(0, idx), id: cursor.slice(idx + 2) };
}

/**
 * 列会话（按 `(updatedAt, id)` 严格递减）。
 *
 * · 分页：`cursor` 为 `{updatedAt}__{id}` 复合值（避免同毫秒漏条）
 * · 损坏文件：该条 `corrupted:true`，**其余正常返回**（不整体失败）
 * · 非 `c-*.json` 文件：忽略，不报错
 */
export async function listConversations(
  scope: string,
  opts: { archived?: boolean; limit?: number; cursor?: string | null },
): Promise<{ items: ConversationSummary[]; nextCursor: string | null }> {
  validateScope(scope);
  const dir = chatDirFor(scope);

  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => CONV_FILE_RE.test(n));
  } catch {
    // 目录不存在 → 空列表（幂等，不报错）
    return { items: [], nextCursor: null };
  }

  const wantArchived = opts.archived === true;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

  const summaries: ConversationSummary[] = [];
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    try {
      const conv = readJson<ConversationFile>(path.join(dir, name));
      if (!conv) continue;
      if (conv.archived !== wantArchived) continue;
      summaries.push({
        id: typeof conv.id === 'string' && conv.id ? conv.id : id,
        scope,
        title: typeof conv.title === 'string' ? conv.title : '',
        archived: conv.archived === true,
        updatedAt: typeof conv.updatedAt === 'string' ? conv.updatedAt : '',
        messageCount: typeof conv.messageCount === 'number' ? conv.messageCount : 0,
        lastMessagePreview: typeof conv.lastMessagePreview === 'string' ? conv.lastMessagePreview : '',
        corrupted: false,
      });
    } catch {
      // ★ 损坏文件：该条标 corrupted，其余正常返回（不整体失败，S02 §5）
      summaries.push({
        id, scope, title: '（损坏）', archived: wantArchived,
        updatedAt: '', messageCount: 0, lastMessagePreview: '', corrupted: true,
      });
    }
  }

  summaries.sort(compareDesc);

  // cursor 语义：返回**严格早于**游标位置之后的条目
  let filtered = summaries;
  if (cursor) {
    filtered = summaries.filter((s) => compareDesc(s, cursor) > 0);
  }

  const page = filtered.slice(0, limit);
  // 仅当还有剩余时才给 nextCursor（避免前端多发一次空请求）
  const hasMore = filtered.length > page.length;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.updatedAt, last.id) : null;

  return { items: page, nextCursor };
}

// ─────────────────────────────────────────────────────────────
// 写（CRUD）
// ─────────────────────────────────────────────────────────────

/** 生成会话 id：`c-{base36(Date.now())}-{rand4}`（横切约定 §1.1，不使用 UUID） */
function newConversationId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `c-${ts}-${rand}`;
}

/** 生成消息 id：`m{seq}`（横切约定 §1.1） */
export function newMessageId(seq: number): string {
  return `m${seq}`;
}

/** 默认标题：取首条用户消息前 24 字（S02 §3.2） */
function deriveTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.slice(0, 24) || '新会话';
}

/** 列表预览：末条消息前 60 字（S02 §3.2） */
function derivePreview(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 60);
}

/** 落盘包装：任何异常统一转 ChatWriteFailedError（不返回部分成功） */
function persist(scope: string, conv: ConversationFile): void {
  try {
    writeJson(convPath(scope, conv.id), conv as unknown as Record<string, unknown>);
  } catch (err) {
    throw new ChatWriteFailedError(err);
  }
}

/** 校验 title / systemPrompt 长度（api/INDEX.md §3.3） */
export const TITLE_MAX_LEN = 48;
export const SYSTEM_PROMPT_MAX_LEN = 4000;

/** 新建会话。id 形如 `c-{base36(Date.now())}-{rand4}`；`title` 默认取首条用户消息前 24 字 */
export async function createConversation(
  scope: string,
  input: { title?: string; systemPrompt?: string },
): Promise<ConversationFile> {
  validateScope(scope);
  const now = new Date().toISOString();
  const conv: ConversationFile = {
    version: 1,
    id: newConversationId(),
    scope,
    title: input.title?.trim() || '新会话',
    systemPrompt: input.systemPrompt ?? '',
    archived: false,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    seq: 0,
    messageCount: 0,
    lastMessagePreview: '',
    messages: [],
  };
  try {
    fs.mkdirSync(chatDirFor(scope), { recursive: true });
  } catch (err) {
    throw new ChatWriteFailedError(err);
  }
  persist(scope, conv);
  return conv;
}

/** 改 `title` / `systemPrompt`。幂等（同值重复提交结果一致） */
export async function patchConversation(
  scope: string,
  id: string,
  patch: { title?: string; systemPrompt?: string },
): Promise<ConversationFile> {
  validateScope(scope);
  return withConvLock(id, () => {
    const conv = readJson<ConversationFile>(convPath(scope, id));
    if (!conv) throw new ConversationNotFoundError(id);
    if (patch.title !== undefined) conv.title = patch.title;
    if (patch.systemPrompt !== undefined) conv.systemPrompt = patch.systemPrompt;
    conv.seq += 1;
    persist(scope, conv);
    return conv;
  });
}

/** 归档/恢复（软删）。幂等 */
export async function archiveConversation(
  scope: string,
  id: string,
  archived: boolean,
): Promise<ConversationFile> {
  validateScope(scope);
  return withConvLock(id, () => {
    const conv = readJson<ConversationFile>(convPath(scope, id));
    if (!conv) throw new ConversationNotFoundError(id);
    // 幂等：已是目标态则原样返回（仍刷新 updatedAt 会破坏幂等语义 → 不刷新）
    if (conv.archived === archived) return conv;
    conv.archived = archived;
    conv.archivedAt = archived ? new Date().toISOString() : null;
    conv.seq += 1;
    persist(scope, conv);
    return conv;
  });
}

/**
 * 物理删除。
 *
 * · 级联删除 `{chatDir}/{scope}/assets/{convId}__*`（**仅本地图片**）
 * · ★ **绝不删除 `kb/` 下的知识库资产**（N15 —— 属知识库资产，可能被文档引用）
 */
export async function deleteConversation(scope: string, id: string): Promise<void> {
  validateScope(scope);
  assertValidId(id);
  return withConvLock(id, () => {
    // 级联删本地图片：前缀匹配 {convId}__（S02 §3.2 的命名约定）
    try {
      const assets = assetsDirFor(scope);
      if (fs.existsSync(assets)) {
        for (const name of fs.readdirSync(assets)) {
          if (name.startsWith(`${id}__`)) {
            try {
              fs.unlinkSync(path.join(assets, name));
            } catch {
              // 单个图片删不掉不阻断（会话文件删除优先）；失败由调用方从磁盘状态观测
            }
          }
        }
      }
    } catch {
      // assets 目录不可读 → 跳过级联，不影响会话删除
    }

    // ★ 只删 {chatDir}/{scope}/ 下的会话文件；绝不触碰 kb/{scope}/
    try {
      fs.unlinkSync(convPath(scope, id));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // 幂等：已不存在不报错（API-07 幂等）
      if (e.code !== 'ENOENT') throw new ChatWriteFailedError(err);
    }
  });
}

/**
 * 清空该 scope 全部会话（API-14 / N8）。
 *
 * · 幂等：无会话时返回 `0`
 * · ★ 绝不触碰 `kb/{scope}/`
 * · 部分失败：已删的保留（不假装事务），抛 `ChatWriteFailedError`
 */
export async function deleteAllConversations(scope: string): Promise<number> {
  validateScope(scope);
  const dir = chatDirFor(scope);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => CONV_FILE_RE.test(n));
  } catch {
    return 0; // 目录不存在 → 幂等返回 0
  }

  let deleted = 0;
  const failures: unknown[] = [];
  for (const name of names) {
    try {
      fs.unlinkSync(path.join(dir, name));
      deleted += 1;
    } catch (err) {
      failures.push(err);
    }
  }

  // 清空 assets（本地图片随会话一起清；★ 同样不触碰 kb/）
  try {
    const assets = assetsDirFor(scope);
    if (fs.existsSync(assets)) {
      for (const name of fs.readdirSync(assets)) {
        try {
          fs.unlinkSync(path.join(assets, name));
        } catch (err) {
          failures.push(err);
        }
      }
    }
  } catch (err) {
    failures.push(err);
  }

  // 部分失败：已删的保留，抛错告知（不假装事务）
  if (failures.length > 0) throw new ChatWriteFailedError(failures[0]);
  return deleted;
}

// ─────────────────────────────────────────────────────────────
// 消息写入（三条路径，语义不同，勿混用）
// ─────────────────────────────────────────────────────────────

/** 追加消息（锁内读最新，杜绝 TOCTOU）。`seq += 1` */
export async function appendMessage(
  scope: string,
  id: string,
  msg: ChatMessage,
  patch?: Partial<ConversationFile>,
): Promise<ConversationFile> {
  validateScope(scope);
  return withConvLock(id, () => {
    const conv = readJson<ConversationFile>(convPath(scope, id));
    if (!conv) throw new ConversationNotFoundError(id);
    // ★ id 归一化：锁内统一为 `m{seq}`（横切约定 §1.1）。
    //   调用方无需知道 seq —— 它只能在锁内读到，由 store 赋值才不会有竞态。
    const stamped: ChatMessage = { ...msg, id: newMessageId(conv.seq + 1) };
    conv.messages.push(stamped);
    conv.seq += 1;
    conv.messageCount = conv.messages.length;
    conv.lastMessagePreview = derivePreview(stamped.content);
    // 首条 user 消息时补默认标题（S02 §3.2：title 默认取首条用户消息前 24 字）
    if (stamped.role === 'user' && conv.messages.filter((m) => m.role === 'user').length === 1) {
      if (!conv.title || conv.title === '新会话') conv.title = deriveTitle(stamped.content);
    }
    if (patch) {
      // 只允许补丁非 id/scope/messages 的会话级字段，且不覆盖 messages
      const { messages: _m, id: _i, scope: _s, ...rest } = patch;
      void _m; void _i; void _s;
      Object.assign(conv, rest);
    }
    persist(scope, conv);
    return conv;
  });
}

/**
 * **重新生成**专用：替换最后一条 assistant 消息（R23 / API-11）。
 *
 * · 不新增 user 消息
 * · 删除 `U` 之后的 assistant 后再追加新的 → `messageCount` **不变**
 * · 若最后一条是 user（首次生成失败）→ 等价于"继续生成"，不报错
 */
export async function replaceLastAssistant(
  scope: string,
  id: string,
  msg: ChatMessage,
): Promise<ConversationFile> {
  validateScope(scope);
  return withConvLock(id, () => {
    const conv = readJson<ConversationFile>(convPath(scope, id));
    if (!conv) throw new ConversationNotFoundError(id);

    // 从尾部向前找最后一条 assistant
    const messages = conv.messages;
    const lastAssistantIdx = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === 'assistant') return i;
      }
      return -1;
    })();

    const stamped: ChatMessage = { ...msg, id: newMessageId(conv.seq + 1) };
    if (lastAssistantIdx >= 0) {
      // 物理截断到最后一条 assistant 之前，再追加新回答 → messageCount 不变
      messages.splice(lastAssistantIdx, messages.length - lastAssistantIdx, stamped);
    } else {
      // 末尾是 user（首次生成中途失败）→ 等价"继续生成"，直接追加
      messages.push(stamped);
    }

    conv.seq += 1;
    conv.messageCount = messages.length;
    conv.lastMessagePreview = derivePreview(stamped.content);
    persist(scope, conv);
    return conv;
  });
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
export async function truncateAfterAndEdit(
  scope: string,
  id: string,
  msgId: string,
  newText: string,
): Promise<{ conv: ConversationFile; discardedCount: number }> {
  validateScope(scope);
  return withConvLock(id, () => {
    const conv = readJson<ConversationFile>(convPath(scope, id));
    if (!conv) throw new ConversationNotFoundError(id);

    const idx = conv.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) throw new ConversationNotFoundError(msgId);
    const target = conv.messages[idx]!;
    if (target.role === 'assistant') {
      throw new MessageInvalidError('只能编辑 user 消息');
    }

    const discardedCount = conv.messages.length - (idx + 1);
    // 物理截断其后全部（切片而非标记删除）
    conv.messages = conv.messages.slice(0, idx + 1);
    // 用编辑后文本替换该条 content（S07 §3.9 / api/retrieval.md §3 语义）
    conv.messages[idx] = { ...target, content: newText };

    conv.seq += 1;
    conv.messageCount = conv.messages.length;
    conv.lastMessagePreview = derivePreview(newText);
    persist(scope, conv);

    return { conv, discardedCount };
  });
}

/** 消息参数非法（映射 400 `MESSAGE_INVALID`） */
export class MessageInvalidError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = 'MessageInvalidError';
  }
}
