/**
 * ask-store.ts —— `ki_ask` 短会话存储（REQ-20261113-001 二期 · S-03 §4.2）
 *
 * ═══ 它与 `chat-store` 的关系 ═══
 * 同一份磁盘目录、同一套原子写、同一把锁 —— 但**文件名前缀不同**：
 * `chat-store` 的列表只认 `CONV_FILE_RE = /^c-[A-Za-z0-9-]+\.json$/`（`chat-store.ts:127`），
 * 所以 `ka-*.json` 落在同一个 `{chatDir}/{scope}/` 下**天然不会**出现在 web 会话列表里。
 *
 * ★ 这就是为什么不需要新目录：少一套路径推导、少一棵要 GC 的树，也不会漏清理。
 *
 * ═══ 与 `chat-store` 的三处刻意差异 ═══
 * 1. **前缀不同**：`assertValidId`（`chat-store.ts:130`）强制 `^c-`，不能复用 → 本模块自带校验。
 * 2. **不进「清空会话」**：`clearConversations` 只删 `c-*`，短会话只能靠 TTL GC 兜底（S-03 §6）。
 * 3. **结构极简**：只存 `role + content + at`，**不存** reasoning / sources / 压缩快照 ——
 *    短会话只需"能回放对话"，不需要 UI 展示物（N12：reasoning 永不回放）。
 *
 * ═══ 语义边界（重要）═══
 * 本模块只做**纯读写**：不判过期、不判归属。那两个判定需要 `ttlMs` 与 `ownerKey` 上下文，
 * 放在 `ask-runner` 里做（否则 store 要依赖配置与身份，变成两层都懂业务）。
 *
 * @see design/S03_短会话续接_DESIGN.md §3.2 / §4.2
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { readJson, writeJson } from '../../store.js';
import { validateScope } from '../../scope.js';
import { chatDirFor, withConvLock } from '../chat-store.js';

/** 短会话文件（S-03 §4.2） */
export interface AskSessionFile {
  version: 1;
  /** `ka-` + base36(now) + 32 位 hex（≥128bit，不可猜：N11） */
  id: string;
  scope: string;
  /** 归属：`tokenId` / `'local'`；跨 key 复用一律拒绝（S-03 §4.3） */
  ownerKey: string;
  createdAt: string;
  /** 滑动 TTL 的**唯一**依据；由 `writeJson` 每次落盘自动打戳（S-03 §3.2 决策） */
  updatedAt: string;
  messages: AskSessionMessage[];
}

export interface AskSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 该条消息产生时刻（与 `updatedAt` 区分：这里记录"第几轮何时"） */
  at: string;
}

/** 单条消息内容上限：防止把超长答案整段留在盘上（答案本身受上游 maxTokens 约束） */
const MAX_MESSAGE_CHARS = 40_000;

/** `ka-*.json` 文件名判定（GC 与列表用） */
const ASK_FILE_RE = /^ka-[A-Za-z0-9-]+\.json$/;

/** id 形态：`ka-` + [A-Za-z0-9-]（与文件名判定同源，避免"能写不能读"） */
const ASK_ID_RE = /^ka-[A-Za-z0-9-]+$/;

function askPath(scope: string, id: string): string {
  return path.join(chatDirFor(scope), `${id}.json`);
}

/** 是否为合法短会话 id（供 handler 早判：非法一律按"不存在"处理，不做差异提示，避免成为探测面） */
export function isValidAskId(id: string): boolean {
  return ASK_ID_RE.test(id);
}

/** 防御路径穿越（复用 store 前必须先过这一关，不能把 `c-` 版校验套上来） */
export function assertValidAskId(id: string): void {
  if (!isValidAskId(id)) {
    throw new Error(`非法短会话 id：${id}`);
  }
}

/** 生成新 id：时间有序 + 128bit 随机（时间部分只为排查时肉眼可排序，不作为熵来源） */
function newAskSessionId(): string {
  return `ka-${Date.now().toString(36)}-${randomBytes(16).toString('hex')}`;
}

/**
 * 新建短会话（messages 为空）。
 *
 * 非幂等：每次调用都产生新 id。失败抛（不返回半成品）。
 */
export async function createAskSession(scope: string, ownerKey: string): Promise<AskSessionFile> {
  validateScope(scope);
  const now = new Date().toISOString();
  const file: AskSessionFile = {
    version: 1,
    id: newAskSessionId(),
    scope,
    ownerKey,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  writeJson(askPath(scope, file.id), file);
  return file;
}

/**
 * 读短会话；不存在 / id 非法 / 文件损坏 → `null`。
 *
 * 损坏处理（S-03 §6）：损坏文件无修复价值且会让每次调用都报同一个错，
 * 直接删除并按"不存在"返回，让调用方重新开启新会话。
 */
export async function readAskSession(scope: string, id: string): Promise<AskSessionFile | null> {
  validateScope(scope);
  if (!isValidAskId(id)) return null;
  const filePath = askPath(scope, id);
  try {
    return readJson<AskSessionFile>(filePath) ?? null;
  } catch {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // 删除失败也不影响本次返回（下次仍会走到这里，逐次重试）
    }
    return null;
  }
}

/**
 * 追加一轮消息（读-改-写，**同 id 串行**）。
 *
 * 为什么加锁：`writeJson` 只保证单次写原子，不覆盖"读-改-写"序列；
 * 同一 `context_id` 并发两次会让后写覆盖先写的消息（N10）。锁复用 `withConvLock`，
 * 与 `c-*` 会话共用同一 Map 也不会冲突（id 前缀不同）。
 *
 * 不存在的文件返回 `null`（调用方按"上下文已失效"报错，**不得**静默新建）。
 */
export async function appendAskTurn(
  scope: string,
  id: string,
  turns: AskSessionMessage[],
): Promise<AskSessionFile | null> {
  validateScope(scope);
  if (!isValidAskId(id)) return null;

  return withConvLock(id, async () => {
    const current = await readAskSession(scope, id);
    if (current === null) return null;
    const appended = turns.map((t) => ({
      role: t.role,
      content: t.content.length > MAX_MESSAGE_CHARS ? t.content.slice(0, MAX_MESSAGE_CHARS) : t.content,
      at: t.at,
    }));
    const next: AskSessionFile = {
      ...current,
      messages: [...current.messages, ...appended],
    };
    // writeJson 落盘时自动刷新 updatedAt ⇒ 滑动 TTL 顺延（S-03 §3.2 决策）
    writeJson(askPath(scope, id), next);
    return readJson<AskSessionFile>(askPath(scope, id)) ?? next;
  });
}

/** 删除短会话（幂等；不存在也不报错） */
export function deleteAskSession(scope: string, id: string): void {
  validateScope(scope);
  if (!isValidAskId(id)) return;
  try {
    fs.rmSync(askPath(scope, id), { force: true });
  } catch {
    // 删除失败不阻断调用方（GC 下一轮会再试）
  }
}

/** 列出该 scope 下所有短会话 id（GC 用；**只认 `ka-`**，绝不碰 `c-*` / assets / 压缩备份） */
export function listAskSessionIds(scope: string): string[] {
  validateScope(scope);
  let names: string[] = [];
  try {
    names = fs.readdirSync(chatDirFor(scope));
  } catch {
    return [];
  }
  return names.filter((n) => ASK_FILE_RE.test(n)).map((n) => n.slice(0, -'.json'.length));
}

/**
 * 过期判定（纯函数，便于单测）。
 *
 * 口径：`now - Date.parse(updatedAt) > ttlMs` ⇒ 过期。用 `updatedAt` 而非 `createdAt`
 * ⇒ **滑动**：每追加一轮就顺延（S-03 §3.2）。
 * 时间解析失败（脏数据）按**已过期**处理 —— 不可信的会话不应该被继续使用。
 */
export function isAskSessionExpired(file: Pick<AskSessionFile, 'updatedAt'>, ttlMs: number, now = Date.now()): boolean {
  const last = Date.parse(file.updatedAt);
  if (Number.isNaN(last)) return true;
  return now - last > ttlMs;
}

/** 过期时刻（ISO）—— 返回给调用方，让它知道最晚什么时候还能追问 */
export function askSessionExpiresAt(file: Pick<AskSessionFile, 'updatedAt'>, ttlMs: number): string {
  const last = Date.parse(file.updatedAt);
  const base = Number.isNaN(last) ? Date.now() : last;
  return new Date(base + ttlMs).toISOString();
}


