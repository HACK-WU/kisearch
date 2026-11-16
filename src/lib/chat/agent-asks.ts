/**
 * agent-asks.ts —— `ki_ask` 问答的**只读**视图（REQ-20261116-003 · S-02 / S-03）
 *
 * ═══ 为什么是独立模块而不是复用 chat-store ═══
 * 主会话列表 `listConversations` 是 `readdir` + 逐文件 `JSON.parse` 全量扫描，且 `total`
 * 还要再扫一遍（`chat-store.ts:195-223`、`chat-routes.ts:729-734`）。`ka-*` 是 agent 高频
 * 产物，混进去会让每次主列表请求多解析 N 个文件。所以这里走独立路径 + 独立接口。
 *
 * ═══ 只读边界 ═══
 * 本模块**不提供任何写操作**：`ka-*` 的写入方只有 MCP 通道（`ownerKey` 归属校验在那里）。
 * 改名 / 归档 / 删除也没有对应字段 —— 页面不渲染这些入口，而不是渲染了再报错。
 *
 * ═══ 与续接链路的关系 ═══
 * 零耦合：`context_id` 续接读的是 `readAskSession`（损坏即删），本模块用
 * `readAskSessionForRead`（损坏不删、返回三态）。两条路径的副作用语义不同，别合并。
 *
 * @see design/S02_列表与归属_DESIGN.md、design/S03_详情与只读回放_DESIGN.md
 */

import {
  askSessionRetainUntil,
  isAskSessionExpired,
  isAskSessionPastRetention,
  listAskSessionIds,
  readAskSessionForRead,
  type AskSessionFile,
  type AskSessionReadResult,
} from './ask/ask-store.js';
import type { AskOrigin } from './ask/ask-contract.js';
import { resolveAskSessionRetainDays, resolveAskSessionTtl } from './ask/ask-gc.js';
import { listTokens, tokenLabel, type TokenRecord } from '../mcp-token.js';
import type { SourceRef } from './chat-contract.js';

const DAY = 86_400_000;
/** 单页上限（与 S-02 契约一致） */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
/** 标题截断长度（列表行一行放得下） */
const TITLE_MAX = 48;
/**
 * Token 列表缓存：5s。
 *
 * 只做时间缓存、不监听 `mcp-tokens.json` 的 mtime —— 改 Token 名是低频运维动作，
 * 5s 内看到的仍是旧名无实际影响；换来的是每次列表请求不必重复读盘 + 解析。
 */
const TOKEN_CACHE_TTL_MS = 5_000;

/** 最小权限视图：`role` 缺省 = 鉴权未启用（与主列表"不过滤"口径一致） */
export interface AgentAskViewer {
  role?: string;
  userId?: string;
}

export interface AgentAskSummary {
  id: string;
  title: string;
  rounds: number;
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
  retainUntil: string;
  retainDaysLeft: number;
  /** 续接 TTL 已过（**列表不展示**：10 分钟即过期，恒亮无信息量） */
  contextExpired: boolean;
  corrupted: boolean;
}

export interface AgentAskGroup {
  id: string;
  kind: 'local' | 'token';
  label: string;
  tokenId?: string;
  tokenDeleted: boolean;
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
  items: AgentAskSummary[];
}

export interface AgentAskMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  background?: string;
  sources?: SourceRef[];
}

export interface AgentAskDetailPayload {
  id: string;
  scope: string;
  origin: { kind: 'local' | 'token'; tokenId?: string; label: string; tokenDeleted: boolean };
  createdAt: string;
  lastActiveAt: string;
  retainUntil: string;
  messages: AgentAskMessage[];
}

/** 对外错误（由路由映射为 HTTP 码 + code） */
export class AgentAskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentAskError';
  }
}

// ─────────────────────────────────────────────────────────────
// 扫描
// ─────────────────────────────────────────────────────────────

/** `ka-<base36(ms)>-<hex>` 的时间前缀（毫秒）；解析失败返回 0（排最后） */
function fileTimeOf(id: string): number {
  const body = id.startsWith('ka-') ? id.slice(3) : id;
  const dash = body.indexOf('-');
  if (dash <= 0) return 0;
  const ms = Number.parseInt(body.slice(0, dash), 36);
  return Number.isFinite(ms) ? ms : 0;
}

/** 列表标题 = 首条 user 消息压成一行并截断 */
function titleOf(file: AskSessionFile): string {
  const first = file.messages.find((m) => m.role === 'user');
  if (!first) return '（空问答）';
  const text = first.content.trim().replace(/\s+/g, ' ');
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

interface ScannedSession {
  id: string;
  origin: AskOrigin;
  createdAt: string;
  lastActiveAt: string;
  retainUntil: string;
  retainDaysLeft: number;
  title: string;
  rounds: number;
  messageCount: number;
  contextExpired: boolean;
}

/**
 * 扫一遍该 scope 下的短会话。
 *
 * · 按文件名时间**倒序**（新→旧）：排序不需要读文件内容；
 * · 超保留期的**直接跳过**（GC 尚未跑到时也不该出现在列表），否则会出现
 *   "列表里有、点开 410"的鬼影条目；
 * · 损坏文件**跳过**：`origin` 只存在文件内容里，读不出来就无从分组，硬塞进
 *   「本地连接」会给出错误的来源归属（详情直连仍可拿到 422，见 `getAgentAsk`）。
 */
async function scanSessions(
  scope: string,
  retainDays: number,
  ttlMs: number,
  now: number,
): Promise<ScannedSession[]> {
  const ids = listAskSessionIds(scope)
    .map((id) => ({ id, t: fileTimeOf(id) }))
    .sort((a, b) => b.t - a.t);

  const out: ScannedSession[] = [];
  for (const { id } of ids) {
    let result: AskSessionReadResult;
    try {
      result = await readAskSessionForRead(scope, id);
    } catch (error) {
      // 读失败仍然跳过（不能因为一条坏文件让整页列表失败），但要留痕：
      // "异常则跳过"如果不留任何痕迹，就是运维看不见的静默丢弃
      process.stderr.write(`[kisearch] agent 问答读取失败，已跳过：${scope}/${id} — ${(error as Error).message}\n`);
      continue;
    }
    if (result.kind === 'corrupt') {
      process.stderr.write(`[kisearch] agent 问答文件损坏，列表已跳过：${scope}/${id} — ${result.message}\n`);
      continue;
    }
    if (result.kind === 'missing') continue;
    const file = result.file;
    if (isAskSessionPastRetention(file, retainDays, now)) continue;
    const retainUntil = askSessionRetainUntil(file, retainDays);
    out.push({
      id,
      origin: file.origin,
      createdAt: file.createdAt,
      lastActiveAt: file.updatedAt,
      retainUntil,
      retainDaysLeft: Math.max(0, Math.ceil((Date.parse(retainUntil) - now) / DAY)),
      title: titleOf(file),
      rounds: file.messages.filter((m) => m.role === 'user').length,
      messageCount: file.messages.length,
      contextExpired: isAskSessionExpired(file, ttlMs, now),
    });
  }
  // ★ 分页游标比的是 `createdAt`（内容），文件名时间只用来决定"先读谁"。
  //   两者在 `createAskSession` 的正常写入下一致，但历史文件/手工落盘可能不同步，
  //   这里按内容重排一次，避免"页码跳条 / 两页重叠"。
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return out;
}

// ─────────────────────────────────────────────────────────────
// 归属
// ─────────────────────────────────────────────────────────────

let tokenCache: { at: number; records: TokenRecord[] } | null = null;
/**
 * 测试注入（生产不调用）：固定 Token 记录。
 *
 * 为什么需要：真实 Token 存在 `~/.ki/mcp-tokens.json`（路径不随 config 走），
 * 测试若直接读它，结论会随"用户此刻有哪些 Token"漂移 —— 归属与分组恰恰是本模块最该守住的东西。
 */
let tokenRecordsOverride: TokenRecord[] | null = null;

/** Token 列表（5s 缓存）：无名快照的旧记录靠它实时 join 出名称 */
function tokensSnapshot(): Map<string, TokenRecord> {
  const now = Date.now();
  let records: TokenRecord[];
  if (tokenCache && now - tokenCache.at < TOKEN_CACHE_TTL_MS) {
    records = tokenCache.records;
  } else if (tokenRecordsOverride) {
    records = tokenRecordsOverride;
    tokenCache = { at: now, records };
  } else {
    try {
      records = listTokens();
    } catch {
      // 读取失败按"没有 Token"处理（fail-closed）：所有 token 组视为已删除，仅 admin 可见
      records = [];
    }
    tokenCache = { at: now, records };
  }
  return new Map(records.map((r) => [r.id, r]));
}

interface GroupMeta {
  id: string;
  kind: 'local' | 'token';
  label: string;
  tokenId?: string;
  tokenDeleted: boolean;
}

/**
 * 由 origin 解析分组元信息。
 *
 * 名称**实时**取当前 Token 名（改名即跟随，分组不分裂）；Token 被删除后回退落盘时的
 * 名称快照，连快照都没有（`version:1` 旧文件）时用 id 前缀兜底。
 */
function groupMetaOf(origin: AskOrigin, tokens: Map<string, TokenRecord>): GroupMeta {
  if (origin.kind === 'local') {
    return { id: 'local', kind: 'local', label: '本地连接', tokenDeleted: false };
  }
  const tokenId = origin.tokenId ?? '';
  const rec = tokens.get(tokenId);
  const label = rec
    ? tokenLabel(rec)
    : (origin.tokenLabel ?? `已删除的 Token${tokenId ? `（${tokenId.slice(0, 6)}）` : ''}`);
  return { id: `token:${tokenId}`, kind: 'token', label, tokenId, tokenDeleted: !rec };
}

function isAdmin(viewer: AgentAskViewer): boolean {
  return viewer.role === undefined || viewer.role === 'admin';
}

/**
 * 能否看这一组 —— **列表过滤与详情校验共用同一个判断**。
 *
 * 分开写两份是越权漏洞的高发点：列表看不到、直接敲 URL 却能看。
 */
function canViewGroup(viewer: AgentAskViewer, meta: GroupMeta, tokens: Map<string, TokenRecord>): boolean {
  if (isAdmin(viewer)) return true;
  // 本机连接没有归属账号：非 admin 一律不可见
  if (meta.kind === 'local') return false;
  const rec = meta.tokenId ? tokens.get(meta.tokenId) : undefined;
  if (!rec) return false; // 已删除的 Token 无归属者，仅 admin
  return Boolean(viewer.userId) && rec.ownerId === viewer.userId;
}

// ─────────────────────────────────────────────────────────────
// 列表
// ─────────────────────────────────────────────────────────────

export interface ListAgentAsksOptions {
  scope: string;
  viewer: AgentAskViewer;
  limit?: number;
  cursor?: string | null;
  /** `all`（默认）| `local` | `token:<tokenId>` */
  group?: string;
}

/** 游标 `{createdAt}__{id}`（复合值，防同毫秒漏条；与主列表同口径） */
function encodeCursor(createdAt: string, id: string): string {
  return `${createdAt}__${id}`;
}

function decodeCursor(raw: string | null | undefined): { createdAt: string; id: string } | null {
  if (!raw) return null;
  const at = raw.indexOf('__');
  if (at <= 0) return null;
  return { createdAt: raw.slice(0, at), id: raw.slice(at + 2) };
}

export async function listAgentAskGroups(opts: ListAgentAsksOptions): Promise<{
  scope: string;
  groups: AgentAskGroup[];
  groupsTotal: number;
}> {
  const now = Date.now();
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const retainDays = resolveAskSessionRetainDays();
  const ttlMs = resolveAskSessionTtl();
  const tokens = tokensSnapshot();

  const scanned = await scanSessions(opts.scope, retainDays, ttlMs, now);

  const buckets = new Map<string, { meta: GroupMeta; items: ScannedSession[] }>();
  for (const session of scanned) {
    const meta = groupMetaOf(session.origin, tokens);
    if (!canViewGroup(opts.viewer, meta, tokens)) continue;
    const bucket = buckets.get(meta.id) ?? { meta, items: [] };
    bucket.items.push(session);
    buckets.set(meta.id, bucket);
  }

  // 只取指定组。非 admin 指定他人 token 组 → 无结果（不是 403：不泄露"存在这个组"）
  const only = opts.group && opts.group !== 'all' ? opts.group : null;
  const cursor = decodeCursor(opts.cursor);

  const groups: AgentAskGroup[] = [];
  for (const [groupId, bucket] of buckets) {
    if (only && groupId !== only) continue;
    const all = bucket.items; // 扫描时已按时间倒序
    const from = cursor
      ? all.filter((s) => (s.createdAt === cursor.createdAt ? s.id < cursor.id : s.createdAt < cursor.createdAt))
      : all;
    const page = from.slice(0, limit);
    const hasMore = from.length > page.length;
    const last = page[page.length - 1];
    groups.push({
      id: groupId,
      kind: bucket.meta.kind,
      label: bucket.meta.label,
      ...(bucket.meta.tokenId ? { tokenId: bucket.meta.tokenId } : {}),
      tokenDeleted: bucket.meta.tokenDeleted,
      count: all.length,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      items: page.map((s) => ({
        id: s.id,
        title: s.title,
        rounds: s.rounds,
        messageCount: s.messageCount,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        retainUntil: s.retainUntil,
        retainDaysLeft: s.retainDaysLeft,
        contextExpired: s.contextExpired,
        corrupted: false,
      })),
    });
  }

  // local 固定第一；token 组按组内最新一条时间倒序
  const latest = (g: AgentAskGroup): string => g.items[0]?.createdAt ?? '';
  groups.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'local' ? -1 : 1;
    return latest(b).localeCompare(latest(a));
  });

  return { scope: opts.scope, groups, groupsTotal: groups.length };
}

// ─────────────────────────────────────────────────────────────
// 详情
// ─────────────────────────────────────────────────────────────

export async function getAgentAsk(opts: { scope: string; viewer: AgentAskViewer; id: string }): Promise<AgentAskDetailPayload> {
  const { scope, viewer, id } = opts;
  const now = Date.now();
  const retainDays = resolveAskSessionRetainDays();
  const tokens = tokensSnapshot();

  const result = await readAskSessionForRead(scope, id);
  if (result.kind === 'missing') {
    throw new AgentAskError(404, 'AGENT_ASK_NOT_FOUND', `该问答不存在（或已清理）：${id}`);
  }
  if (result.kind === 'corrupt') {
    // 只读接口**不删**损坏文件（与续接路径的"损坏即删"相反），只报错
    throw new AgentAskError(422, 'AGENT_ASK_CORRUPTED', `该问答文件已损坏：${result.message}`);
  }
  const file = result.file;
  const meta = groupMetaOf(file.origin, tokens);
  // ★ 权限先于保留期：反过来的话，无权者可凭 410 与 404 的差异探测"这条记录存在过"
  if (!canViewGroup(viewer, meta, tokens)) {
    // 与"不存在"同码同文案：不让调用方探测"这条存在但你没权限"
    throw new AgentAskError(404, 'AGENT_ASK_NOT_FOUND', `该问答不存在（或已清理）：${id}`);
  }
  if (isAskSessionPastRetention(file, retainDays, now)) {
    throw new AgentAskError(410, 'AGENT_ASK_PAST_RETENTION', `该问答已超过 ${retainDays} 天保留期，已不可回看`);
  }

  return {
    id,
    scope,
    origin: {
      kind: meta.kind,
      ...(meta.tokenId ? { tokenId: meta.tokenId } : {}),
      label: meta.label,
      tokenDeleted: meta.tokenDeleted,
    },
    createdAt: file.createdAt,
    lastActiveAt: file.updatedAt,
    retainUntil: askSessionRetainUntil(file, retainDays),
    // 用户回放：**包含** background / sources（与模型回放的排除规则相反，见 S03 §1）
    messages: file.messages.map((m) => ({
      role: m.role,
      content: m.content,
      at: m.at,
      ...(m.background ? { background: m.background } : {}),
      ...(m.sources && m.sources.length > 0 ? { sources: m.sources } : {}),
    })),
  };
}

/** 冷启动 / 测试用：清 Token 缓存 */
export function resetAgentAskCaches(): void {
  tokenCache = null;
}

/** 测试专用：注入固定的 Token 记录（`null` = 恢复读真实文件） */
export function __setTokenRecordsForTest(records: TokenRecord[] | null): void {
  tokenRecordsOverride = records;
  tokenCache = null;
}
