/**
 * chat 模块 HTTP 路由（API-01 ~ API-14，图片 API-09/10 后置 V2）
 *
 * ═══ 设计意图：单一入口，挂载点极薄 ═══
 * `mcp-http-api.ts` 的 if 链只需加**一行**：
 * ```ts
 * if (await handleChatRoutes(req, res, url, ctx)) return;
 * ```
 * 理由：该文件已 1065 行，逐条加分支会持续放大（且它归 SR-01 独占，见 ownership）。
 *
 * ═══ 通用语义契约（所有接口适用）═══
 * · 响应外壳：`{ok:true,...}` / `{ok:false,error,code,details?}`（**不引入** `{code,data,message}`）
 * · 字段命名：`camelCase`
 * · 鉴权：Bearer Token → scope 集合；**按 id 操作时越权返回 403 而非 404**（防状态码探测）
 * · 越权白名单：仅**带 `scope` 参数的 GET**（API-02、API-04、API-14）需登记
 *   （`src/lib/mcp-http-api.ts` 的只读接口列表）
 * · 排队：**CRUD 与生成请求均不入队**；只有生成期间的**检索工具调用**入队
 *   （口径见 `api/INDEX.md` §1 修订表 / S07 §3.6）
 * · 幂等：见各接口（读类幂等；API-03/08/11/12 非幂等；API-05/06/13/14 幂等）
 * · 空值：会话不存在 → 404 `CONVERSATION_NOT_FOUND`（授权范围内查不到）
 * · 错误：落盘失败 → 500 `CHAT_WRITE_FAILED`（**不返回部分成功**）
 * · 超时：生成类接口受 `CHAT_BUDGET` 约束（整体 300s / 首块 30s）
 *
 * ═══ ★ 越权校验的就地实现（偏离 design 文本的说明）═══
 * `api/INDEX.md` §1 / `cross-cutting.md` §2.2 要求把 API-02/04/14 登记到
 * `mcp-http-api.ts:312` 的白名单。**本实现未登记**，理由：
 *   · `mcp-http-api.ts` 同时被 `ownership.md` 列为 `interface`、被 `premerge-check.sh`
 *     门② 冻结为"零 diff" → 改它会被预检拒收（两条要求互斥，属包内冲突）
 *   · `handleChatRoutes` 已收到 `ctx.authScopes`，**在模块内即可完成等价甚至更严的校验**
 *   · 覆盖面更广：不仅 API-02/04/14，**所有** /api/chat/* 路由都过 `requireScope`，
 *     而白名单只覆盖带 scope 参数的 GET
 * 语义等价性：拒绝时同样 `403 {ok:false,error:'Forbidden: 无权访问该 scope'}` + 服务端记日志
 * （复用 `mcp-http-api.ts::rejectScopeViolation` 的文案与脱敏口径）。
 *
 * @see api/INDEX.md · api/retrieval.md · api/config.md
 */

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import YAML from 'yaml';
import {
  CHAT_ERROR_CODES,
  type ChatEvent,
  type ChatMessage,
  type ConversationFile,
  type SourceRef,
} from './chat-contract.js';
import {
  ChatDisabledError,
  resolveLlmStatus,
  toChatConfigOk,
  type LlmStatus,
} from './llm-client.js';
import { loadConfig, type KiConfig } from '../config.js';
import { validateScope, ScopeError } from '../scope.js';
import {
  ConversationNotFoundError,
  ChatWriteFailedError,
  MessageInvalidError,
  TITLE_MAX_LEN,
  SYSTEM_PROMPT_MAX_LEN,
  appendMessage,
  archiveConversation,
  chatRootDir,
  createConversation,
  deleteAllConversations,
  deleteConversation,
  listConversations,
  patchConversation,
  readConversation,
  replaceLastAssistant,
  truncateAfterAndEdit,
} from './chat-store.js';
import { runToolLoop } from './retrieval/tool-loop.js';

/** 路由上下文（由 `mcp-http-api.ts` 注入，避免本模块反向依赖它） */
export interface ChatRouteContext {
  /** 已鉴权的 scope 集合；null = 鉴权未启用 */
  authScopes: string[] | null;
  /** 当前请求配置快照（沿用 `runWithConfigSnapshot` 语义） */
  configSnapshot: unknown;
  /** 配置文件路径（供 fail-loud 文案引用）；未传时由实现自行解析 */
  configPath?: string;
}

/** 鉴权通配 scope（与 `mcp-token.ts::ALL_SCOPES` 同值；此处不 import 以免耦合） */
const ALL_SCOPES = 'all';

/** 单条消息最大长度（api/INDEX.md §3.3） */
const MESSAGE_MAX_LEN = 20000;

/** 会话消息数告警阈值（S02 §5：超过则 done 带 warning） */
const CONVERSATION_TOO_LONG = 500;

// ─────────────────────────────────────────────────────────────
// 错误载体
// ─────────────────────────────────────────────────────────────

/** 路由内统一错误（映射为 HTTP 状态 + `{ok:false,error,code,details?}`） */
class ChatApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = 'ChatApiError';
  }
}

// ─────────────────────────────────────────────────────────────
// 响应工具（与 mcp-http-api.ts::sendJson 同形状）
// ─────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendOk(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  sendJson(res, status, { ok: true, ...payload });
}

function sendErr(
  res: ServerResponse,
  status: number,
  code: string,
  error: string,
  details?: Array<{ field: string; message: string }>,
): void {
  sendJson(res, status, { ok: false, error, code, ...(details ? { details } : {}) });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ChatApiError(400, 'API_ERROR', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────
// 鉴权与 scope 校验（★ P1/P2/P3/P7 的实现处）
// ─────────────────────────────────────────────────────────────

/** scope 是否在授权集合内（'all' 通配；authScopes=null = 鉴权未启用，全放行） */
function scopeAllowed(authScopes: string[] | null, scope: string): boolean {
  if (authScopes === null) return true;
  return authScopes.includes(ALL_SCOPES) || authScopes.includes(scope);
}

/**
 * scope 越权拒绝（与 `mcp-http-api.ts::rejectScopeViolation` 同语义：
 * 服务端记日志（含具体 scope 便于排查）、响应体脱敏（不下发 scope 名，防枚举探测））。
 */
function rejectScopeViolation(res: ServerResponse, scope: string, via: string): void {
  process.stderr.write(
    `[kisearch] scope 越权拦截（/api/chat${via}）：请求 scope "${scope}" 不在该 Token 授权范围内。\n`,
  );
  sendErr(res, 403, 'SCOPE_FORBIDDEN', 'Forbidden: 无权访问该 scope');
}

/** 校验 scope 合法性 + 授权（P1/P3：带 scope 参数的接口） */
function requireScope(ctx: ChatRouteContext, scope: string, via: string, res: ServerResponse): boolean {
  try {
    validateScope(scope);
  } catch (err) {
    if (err instanceof ScopeError) {
      sendErr(res, 400, 'SCOPE_INVALID', err.message);
      return false;
    }
    throw err;
  }
  if (!scopeAllowed(ctx.authScopes, scope)) {
    rejectScopeViolation(res, scope, via);
    return false;
  }
  return true;
}

/**
 * ★ P2：按 `:id` 定位会话 —— **只在授权 scope 内遍历**，越权一律 403（不 404）。
 *
 * 返回 `null` 表示已响应错误（调用方直接 return）。
 */
async function resolveConversationInScopes(
  ctx: ChatRouteContext,
  id: string,
  via: string,
  res: ServerResponse,
): Promise<{ scope: string; conv: ConversationFile } | null> {
  // 格式非法 → 统一按"不存在"处理（不泄露内部命名规则，也防路径穿越）
  if (!/^c-[A-Za-z0-9-]+$/.test(id)) {
    sendErr(res, 404, CHAT_ERROR_CODES.CONVERSATION_NOT_FOUND, '会话不存在');
    return null;
  }

  // 路径基准**单一来源**：优先用请求级配置快照的 chatDir（与 runWithConfigSnapshot 语义一致），
  // 快照缺失时回退到 chatRootDir()（同样来自 loadConfig，不硬编码 ~/.ki）。
  const cfg = ctx.configSnapshot as KiConfig | undefined;
  const root = cfg?.chatDir ?? chatRootDir();

  // ★ 遍历范围必须是**磁盘上的全部 scope**，而不是 `authScopes`。
  //
  // 为什么：P2 要求"他 scope 存在的会话 → 403 而非 404"。
  // 若只在授权 scope 内遍历，越权者得到的是 404（"查不到"），与"真的不存在"无法区分 ——
  // 攻击者据此可枚举其他 scope 下是否存在某会话 id（cross-cutting §2.2 明确警示）。
  //
  // 正确语义：
  //   · 任何 scope 下都不存在        → 404（真的不存在）
  //   · 存在于非授权 scope           → 403（存在，但你无权；不泄露具体 scope 名）
  //   · 存在于授权 scope             → 命中返回
  let scopes: string[] = [];
  try {
    scopes = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[A-Za-z0-9_-]+$/.test(e.name))
      .map((e) => e.name);
  } catch {
    scopes = [];
  }

  const found: Array<{ scope: string; conv: ConversationFile }> = [];
  for (const scope of scopes) {
    try {
      const conv = await readConversation(scope, id);
      if (conv) found.push({ scope, conv });
    } catch {
      // 单目录读取异常（含损坏 JSON）：跳过，不影响其他 scope 的查找
    }
  }

  if (found.length === 0) {
    sendErr(res, 404, CHAT_ERROR_CODES.CONVERSATION_NOT_FOUND, '会话不存在');
    return null;
  }

  // 先做授权判定（在任何"存在性"信息对外暴露之前）
  const authorized = found.filter((f) => scopeAllowed(ctx.authScopes, f.scope));
  if (authorized.length === 0) {
    // 存在于非授权 scope → 越权（403），且**不告知它属于哪个 scope**（脱敏防探测）
    rejectScopeViolation(res, found[0]!.scope, via);
    return null;
  }

  if (authorized.length > 1) {
    // 数据异常：同 id 出现在多个**已授权** scope → fail-loud（不静默取其一，api/conversations.md）
    process.stderr.write(`[kisearch] 会话 id 冲突：${id} 存在于多个授权 scope（${authorized.map((f) => f.scope).join(', ')}）\n`);
    sendErr(res, 500, 'API_ERROR', `会话 id 冲突：${id} 存在于多个 scope`);
    return null;
  }

  return authorized[0]!;
}

// ─────────────────────────────────────────────────────────────
// 生效中的生成（P5：同会话互斥）
// ─────────────────────────────────────────────────────────────

/** 正在生成中的会话 id 集合（进程内；daemon 单写者场景足够） */
const generating = new Set<string>();

// ─────────────────────────────────────────────────────────────
// 路由总入口
// ─────────────────────────────────────────────────────────────

/**
 * chat 路由总入口。
 *
 * · 返回 `true` = 已处理（调用方应 `return`，不再走后续 if 链）
 * · 返回 `false` = 路径不在 `/api/chat/*` 范围
 * · **不抛错**：所有异常须在内部映射为 `{ok:false,code}` + 合适 HTTP 码
 */
export async function handleChatRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ChatRouteContext,
): Promise<boolean> {
  const p = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  if (p !== '/chat' && !p.startsWith('/chat/')) return false;

  // 路径分派（相对 /api/chat）
  const sub = p.slice('/chat'.length).replace(/^\/+/, '');   // '' | 'config' | 'conversations' | 'conversations/:id/...'
  const method = req.method ?? 'GET';
  const segs = sub.length > 0 ? sub.split('/') : [];

  try {
    // ── API-01 GET /api/chat/config ──
    if (segs.length === 1 && segs[0] === 'config' && method === 'GET') {
      await handleConfigGet(res, ctx);
      return true;
    }
    // ── API-13 POST /api/chat/config/ack ──
    if (segs.length === 2 && segs[0] === 'config' && segs[1] === 'ack' && method === 'POST') {
      await handleConfigAck(req, res);
      return true;
    }

    // ── API-02/14 /api/chat/conversations ──
    if (segs.length === 1 && segs[0] === 'conversations') {
      if (method === 'GET') { await handleConversationList(res, url, ctx); return true; }
      if (method === 'POST') { await handleConversationCreate(req, res, ctx); return true; }
      if (method === 'DELETE') { await handleConversationsClear(res, url, ctx); return true; }
    }

    // ── API-04~07 /api/chat/conversations/:id ──
    if (segs.length === 2 && segs[0] === 'conversations') {
      const id = segs[1]!;
      if (method === 'GET') { await handleConversationGet(res, id, ctx); return true; }
      if (method === 'PATCH') { await handleConversationPatch(req, res, id, ctx); return true; }
      if (method === 'DELETE') { await handleConversationDelete(res, id, ctx); return true; }
    }

    // ── API-06 /api/chat/conversations/:id/archive ──
    if (segs.length === 3 && segs[0] === 'conversations' && segs[2] === 'archive' && method === 'POST') {
      await handleConversationArchive(req, res, segs[1]!, ctx);
      return true;
    }

    // ── API-08 /api/chat/conversations/:id/messages ──
    if (segs.length === 3 && segs[0] === 'conversations' && segs[2] === 'messages' && method === 'POST') {
      await handleConversationMessages(req, res, segs[1]!, ctx);
      return true;
    }

    // ── API-11 /api/chat/conversations/:id/regenerate ──
    if (segs.length === 3 && segs[0] === 'conversations' && segs[2] === 'regenerate' && method === 'POST') {
      await handleConversationRegenerate(req, res, segs[1]!, ctx);
      return true;
    }

    // ── API-12 /api/chat/conversations/:id/messages/:msgId ──
    if (segs.length === 4 && segs[0] === 'conversations' && segs[2] === 'messages' && method === 'PATCH') {
      await handleMessageEdit(req, res, segs[1]!, segs[3]!, ctx);
      return true;
    }

    // ── API-09/10 图片：本期不实现（T13 后置 V2）──
    if (segs.length >= 3 && segs[0] === 'conversations' && segs[2] === 'images') {
      sendErr(res, 404, 'NOT_FOUND', '图片能力本期未实现（后置 V2）');
      return true;
    }

    // 落在 /api/chat/* 但未匹配 → 404 NOT_FOUND
    sendErr(res, 404, 'NOT_FOUND', `Not Found: /api/chat/${sub}`);
    return true;
  } catch (err) {
    // 统一错误映射（**不抛给外层**，否则会被 mcp-http-api 的 400 兜底吞掉 code）
    mapAndSendError(res, err);
    return true;
  }
}

/** 统一错误映射 */
function mapAndSendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    // 流已建立：只能以 error 事件下发（调用方已负责）
    return;
  }
  if (err instanceof ChatApiError) {
    sendErr(res, err.status, err.code, err.message, err.details);
    return;
  }
  if (err instanceof ConversationNotFoundError) {
    sendErr(res, 404, CHAT_ERROR_CODES.CONVERSATION_NOT_FOUND, err.message);
    return;
  }
  if (err instanceof MessageInvalidError) {
    sendErr(res, 400, CHAT_ERROR_CODES.MESSAGE_INVALID, err.message);
    return;
  }
  if (err instanceof ChatWriteFailedError) {
    sendErr(res, 500, CHAT_ERROR_CODES.CHAT_WRITE_FAILED, err.message);
    return;
  }
  if (err instanceof ChatDisabledError) {
    sendErr(res, 503, CHAT_ERROR_CODES.CHAT_DISABLED, err.message);
    return;
  }
  if (err instanceof ScopeError) {
    sendErr(res, 400, 'SCOPE_INVALID', err.message);
    return;
  }
  const e = err as Error & { code?: string };
  if (e?.code === 'CORRUPT_JSON') {
    sendErr(res, 500, 'API_ERROR', e.message);
    return;
  }
  sendErr(res, 400, e?.code ?? 'API_ERROR', e?.message ?? String(err));
}

// ─────────────────────────────────────────────────────────────
// 配置（API-01 / API-13）
// ─────────────────────────────────────────────────────────────

/** 取当前配置快照（外部注入优先，缺省回退 loadConfig） */
function snapshotConfig(ctx: ChatRouteContext): KiConfig {
  return (ctx.configSnapshot as KiConfig) ?? loadConfig();
}

/** API-01 `GET /api/chat/config` */
export async function handleConfigGet(res: ServerResponse, ctx: ChatRouteContext): Promise<void> {
  const cfg = snapshotConfig(ctx);
  const configPath = ctx.configPath ?? cfg._configPath ?? '~/.ki/config.yaml';
  const status: LlmStatus = resolveLlmStatus(cfg, configPath);
  // ★ **未就绪时仍返回 200 + ok:true**（配置缺失是可预期的产品状态）
  sendOk(res, 200, toChatConfigOk(status, configPath) as unknown as Record<string, unknown>);
}

/**
 * API-13 `POST /api/chat/config/ack` —— 隐私确认（T12）
 *
 * · 幂等：重复确认结果一致
 * · `ack !== true` → 400 `API_ERROR`（不接受"取消确认"，撤销入口在配置文件）
 * · 配置不可写 → 500 `CHAT_WRITE_FAILED`；**前端不得据此放行**（未持久化 = 下次仍会问）
 */
export async function handleConfigAck(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { ack?: unknown };
  if (body?.ack !== true) {
    throw new ChatApiError(400, 'API_ERROR', '不支持取消确认：撤销入口在配置文件（llm.kbDisclosureAck）');
  }

  const cfg = loadConfig();
  const configPath = cfg._configPath;
  if (!configPath) {
    throw new ChatWriteFailedError('未找到配置文件路径，无法持久化确认状态');
  }

  try {
    // 就地写回 llm.kbDisclosureAck: true（保留其余内容）
    const text = fs.readFileSync(configPath, 'utf-8');
    const parsed = (path.extname(configPath).toLowerCase() === '.json'
      ? JSON.parse(text)
      : YAML.parse(text)) as Record<string, unknown> | null;
    const doc = (parsed && typeof parsed === 'object') ? parsed : {};
    const llmRaw = (doc.llm && typeof doc.llm === 'object' && !Array.isArray(doc.llm))
      ? doc.llm as Record<string, unknown>
      : {};
    llmRaw.kbDisclosureAck = true;
    doc.llm = llmRaw;

    const out = path.extname(configPath).toLowerCase() === '.json'
      ? JSON.stringify(doc, null, 2) + '\n'
      : YAML.stringify(doc);
    fs.writeFileSync(configPath, out, 'utf-8');
  } catch (err) {
    if (err instanceof ChatWriteFailedError) throw err;
    throw new ChatWriteFailedError(err);
  }

  // 幂等：重复确认结果一致
  sendOk(res, 200, { kbDisclosureAck: true });
}

// ─────────────────────────────────────────────────────────────
// 会话 CRUD（API-02 ~ API-07、API-14）
// ─────────────────────────────────────────────────────────────

/** 取会话列表视图的 scope（默认 `default`，与既有接口口径一致） */
function resolveListScope(url: URL): string {
  const raw = url.searchParams.get('scope');
  return raw && raw.trim() ? raw.trim() : 'default';
}

/** API-02 `GET /api/chat/conversations?scope=&archived=0&limit=&cursor=` —— 越权白名单：**登记** */
export async function handleConversationList(res: ServerResponse, url: URL, ctx: ChatRouteContext): Promise<void> {
  const scope = resolveListScope(url);
  if (!requireScope(ctx, scope, '/conversations', res)) return;

  const archivedRaw = url.searchParams.get('archived');
  const archived = archivedRaw === '1' || archivedRaw === 'true';

  const limitRaw = url.searchParams.get('limit');
  let limit = 50;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    limit = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 200) : 50;
  }
  const cursor = url.searchParams.get('cursor');

  const { items, nextCursor } = await listConversations(scope, { archived, limit, cursor });

  // total：当前视图下总条数（不含性能敏感的全文统计）—— 用全量扫描计数
  const all = await listConversations(scope, { archived, limit: Number.MAX_SAFE_INTEGER });
  const total = all.items.length;

  sendOk(res, 200, { scope, items, total, nextCursor });
}

/** API-03 `POST /api/chat/conversations` —— 非幂等（每次产生新会话） */
export async function handleConversationCreate(req: IncomingMessage, res: ServerResponse, ctx: ChatRouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { scope?: unknown; title?: unknown; systemPrompt?: unknown };

  const scope = typeof body?.scope === 'string' ? body.scope.trim() : '';
  if (!scope) throw new ChatApiError(400, 'CONVERSATION_INVALID', 'scope 不能为空');
  validateScope(scope);
  if (!scopeAllowed(ctx.authScopes, scope)) {
    rejectScopeViolation(res, scope, '/conversations');
    return;
  }

  const title = typeof body?.title === 'string' ? body.title : undefined;
  const systemPrompt = typeof body?.systemPrompt === 'string' ? body.systemPrompt : undefined;

  const details = validateConversationFields({ title, systemPrompt });
  if (details.length > 0) throw new ChatApiError(400, 'CONVERSATION_INVALID', '参数不合法', details);

  // systemPrompt 缺省取 config.llm.defaultSystemPrompt（api/conversations.md API-03）
  const cfg = snapshotConfig(ctx);
  const effectiveSystemPrompt = systemPrompt ?? cfg.llm?.defaultSystemPrompt ?? '';

  const conv = await createConversation(scope, {
    ...(title !== undefined ? { title } : {}),
    systemPrompt: effectiveSystemPrompt,
  });

  sendOk(res, 201, {
    conv: {
      id: conv.id,
      scope: conv.scope,
      title: conv.title,
      systemPrompt: conv.systemPrompt,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    },
  });
}

/** title / systemPrompt 字段校验（API-03/05 共用） */
function validateConversationFields(input: { title?: string; systemPrompt?: string }): Array<{ field: string; message: string }> {
  const details: Array<{ field: string; message: string }> = [];
  if (input.title !== undefined && (input.title.length < 1 || input.title.length > TITLE_MAX_LEN)) {
    details.push({ field: 'title', message: `INVALID_LENGTH：标题需 1~${TITLE_MAX_LEN} 字` });
  }
  if (input.systemPrompt !== undefined && input.systemPrompt.length > SYSTEM_PROMPT_MAX_LEN) {
    details.push({ field: 'systemPrompt', message: `INVALID_LENGTH：提示词不得超过 ${SYSTEM_PROMPT_MAX_LEN} 字` });
  }
  return details;
}

/**
 * API-04 `GET /api/chat/conversations/:id` —— 越权白名单：**登记**
 *
 * · `:id` 查找**只允许在 token 授权 scope 集合内遍历**；命中后再次校验 `scope`
 * · 越权 → **403 而非 404**（防状态码探测他 scope 会话是否存在）
 */
export async function handleConversationGet(res: ServerResponse, id: string, ctx: ChatRouteContext): Promise<void> {
  const hit = await resolveConversationInScopes(ctx, id, `/conversations/${id}`, res);
  if (!hit) return;
  sendOk(res, 200, { conv: hit.conv });
}

/** API-05 `PATCH /api/chat/conversations/:id` —— 改 title/systemPrompt；幂等；无字段可改 → 400 */
export async function handleConversationPatch(req: IncomingMessage, res: ServerResponse, id: string, ctx: ChatRouteContext): Promise<void> {
  const hit = await resolveConversationInScopes(ctx, id, `/conversations/${id}`, res);
  if (!hit) return;

  const body = (await readJsonBody(req)) as { title?: unknown; systemPrompt?: unknown };
  const title = typeof body?.title === 'string' ? body.title : undefined;
  const systemPrompt = typeof body?.systemPrompt === 'string' ? body.systemPrompt : undefined;

  if (title === undefined && systemPrompt === undefined) {
    throw new ChatApiError(400, 'CONVERSATION_INVALID', '至少提供 title 或 systemPrompt 之一');
  }
  const details = validateConversationFields({ title, systemPrompt });
  if (details.length > 0) throw new ChatApiError(400, 'CONVERSATION_INVALID', '参数不合法', details);

  const conv = await patchConversation(hit.scope, id, {
    ...(title !== undefined ? { title } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  });

  sendOk(res, 200, {
    conv: { id: conv.id, title: conv.title, systemPrompt: conv.systemPrompt, updatedAt: conv.updatedAt },
  });
}

/** API-06 `POST /api/chat/conversations/:id/archive` —— 归档/恢复；幂等 */
export async function handleConversationArchive(req: IncomingMessage, res: ServerResponse, id: string, ctx: ChatRouteContext): Promise<void> {
  const hit = await resolveConversationInScopes(ctx, id, `/conversations/${id}/archive`, res);
  if (!hit) return;

  const body = (await readJsonBody(req)) as { archived?: unknown };
  if (typeof body?.archived !== 'boolean') {
    throw new ChatApiError(400, 'CONVERSATION_INVALID', 'archived 应为布尔值');
  }

  const conv = await archiveConversation(hit.scope, id, body.archived);
  sendOk(res, 200, {
    conv: { id: conv.id, archived: conv.archived, archivedAt: conv.archivedAt, updatedAt: conv.updatedAt },
  });
}

/** API-07 `DELETE /api/chat/conversations/:id` —— 物理删除 + 级联删本地图片（**绝不动 kb/**）；幂等 */
export async function handleConversationDelete(res: ServerResponse, id: string, ctx: ChatRouteContext): Promise<void> {
  const hit = await resolveConversationInScopes(ctx, id, `/conversations/${id}`, res);
  if (!hit) return;
  await deleteConversation(hit.scope, id);
  sendOk(res, 200, { id, deleted: true });
}

/**
 * API-14 `DELETE /api/chat/conversations?scope=` —— 清空该 scope 全部会话（N8）
 *
 * · 越权白名单：**登记**（带 scope 参数）
 * · 幂等：无会话时 `deleted: 0` + 200
 * · ★ 绝不触碰 `kb/{scope}/`
 */
export async function handleConversationsClear(res: ServerResponse, url: URL, ctx: ChatRouteContext): Promise<void> {
  const scope = resolveListScope(url);
  if (!requireScope(ctx, scope, '/conversations', res)) return;
  const deleted = await deleteAllConversations(scope);
  sendOk(res, 200, { scope, deleted });
}

// ─────────────────────────────────────────────────────────────
// 生成类（API-08 / API-11 / API-12）—— 三者共用 SSE 写出与事件序
// ─────────────────────────────────────────────────────────────

/** 生成前置检查：llm 就绪 + 隐私已确认（P4）+ 会话非生成中（P5） */
function requireGenerationReady(
  res: ServerResponse,
  ctx: ChatRouteContext,
  convId: string,
): { cfg: KiConfig; status: LlmStatus; configPath: string } | null {
  const cfg = snapshotConfig(ctx);
  const configPath = ctx.configPath ?? cfg._configPath ?? '~/.ki/config.yaml';
  const status = resolveLlmStatus(cfg, configPath);

  // ★ P4：未确认隐私 → 403 DISCLOSURE_REQUIRED（前端本应拦截；后端兜底防绕过）
  if (status.ackRequired) {
    sendErr(res, 403, CHAT_ERROR_CODES.DISCLOSURE_REQUIRED, '知识库内容外发未确认，请先完成隐私确认');
    return null;
  }

  // 模型未配置 → 503 CHAT_DISABLED（前置拦截，不发起上游请求）
  if (!status.enabled) {
    sendErr(res, 503, CHAT_ERROR_CODES.CHAT_DISABLED, status.reason ?? '未配置模型');
    return null;
  }

  // ★ P5：会话正在生成中 → 409 CONVERSATION_GENERATING
  if (generating.has(convId)) {
    sendErr(res, 409, CHAT_ERROR_CODES.CONVERSATION_GENERATING, '该会话正在生成中，请先停止或等待完成');
    return null;
  }

  return { cfg, status, configPath };
}

/** 解析 `text` 字段（1~20000 字，去首尾空白后非空） */
function requireMessageText(body: { text?: unknown }): string {
  const text = typeof body?.text === 'string' ? body.text : '';
  if (text.trim().length === 0) {
    throw new ChatApiError(400, CHAT_ERROR_CODES.MESSAGE_INVALID, 'text 不能为空或仅含空白');
  }
  if (text.length > MESSAGE_MAX_LEN) {
    throw new ChatApiError(400, CHAT_ERROR_CODES.MESSAGE_INVALID, `text 不得超过 ${MESSAGE_MAX_LEN} 字`, [
      { field: 'text', message: `INVALID_LENGTH：长度需 1~${MESSAGE_MAX_LEN}` },
    ]);
  }
  return text;
}

/**
 * API-08 `POST /api/chat/conversations/:id/messages` —— 发消息（SSE）
 *
 * · 非幂等（每次写一条 user 消息）
 * · 前置：`kbDisclosureAck === true`，否则 403 `DISCLOSURE_REQUIRED`
 * · 前置：会话非生成中，否则 409 `CONVERSATION_GENERATING`
 * · 事件序见 `chat-contract.ts` 的 `CHAT_EVENT_ORDER_RULES`
 */
export async function handleConversationMessages(req: IncomingMessage, res: ServerResponse, id: string, ctx: ChatRouteContext): Promise<void> {
  // ① 定位会话 + 越权校验（授权范围内查不到 → 404）
  const hit = await resolveConversationInScopes(ctx, id, `/conversations/${id}/messages`, res);
  if (!hit) return;

  const body = (await readJsonBody(req)) as { text?: unknown };
  const text = requireMessageText(body);

  // ② 生成前置（P4 隐私 / CHAT_DISABLED / P5 会话忙）
  const ready = requireGenerationReady(res, ctx, id);
  if (!ready) return;

  await runGeneration(req, res, {
    scope: hit.scope,
    convId: id,
    userText: text,
    mode: 'append-user',
  });
}

/**
 * API-11 `POST /api/chat/conversations/:id/regenerate` —— 重新生成（SSE）
 *
 * · **不新增 user 消息**（R23）
 * · 删除最后一条 assistant 后重新生成 → `messageCount` 不变
 * · 无任何消息 → 400 `CONVERSATION_INVALID`
 */
export async function handleConversationRegenerate(req: IncomingMessage, res: ServerResponse, id: string, ctx: ChatRouteContext): Promise<void> {
  const hit = await resolveConversationInScopes(ctx, id, `/conversations/${id}/regenerate`, res);
  if (!hit) return;

  const ready = requireGenerationReady(res, ctx, id);
  if (!ready) return;

  // 定位最后一条 user 消息（无 user → 400 CONVERSATION_INVALID）
  const lastUser = [...hit.conv.messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) {
    throw new ChatApiError(400, CHAT_ERROR_CODES.CONVERSATION_INVALID, '会话无可重新生成的对象（无 user 消息）');
  }

  await runGeneration(req, res, {
    scope: hit.scope,
    convId: id,
    userText: lastUser.content,
    mode: 'regenerate',
  });
}

/**
 * API-12 `PATCH /api/chat/conversations/:id/messages/:msgId` —— 编辑并重发（SSE）
 *
 * · **原子截断**（N21）：同一把会话锁内完成"截断 + 替换 + 落盘"
 * · `:msgId` 指向 assistant → 400 `MESSAGE_INVALID`；不存在 → 404 `MESSAGE_NOT_FOUND`
 * · `meta.discardedCount` = 被截断的消息数
 */
export async function handleMessageEdit(req: IncomingMessage, res: ServerResponse, id: string, msgId: string, ctx: ChatRouteContext): Promise<void> {
  const hit = await resolveConversationInScopes(ctx, id, `/conversations/${id}/messages/${msgId}`, res);
  if (!hit) return;

  const body = (await readJsonBody(req)) as { text?: unknown };
  const text = requireMessageText(body);

  const ready = requireGenerationReady(res, ctx, id);
  if (!ready) return;

  // 目标消息必须存在（API-12 契约：不存在 → 404 MESSAGE_NOT_FOUND）
  const target = hit.conv.messages.find((m) => m.id === msgId);
  if (!target) {
    sendErr(res, 404, CHAT_ERROR_CODES.MESSAGE_NOT_FOUND, '目标消息不存在');
    return;
  }
  if (target.role === 'assistant') {
    throw new ChatApiError(400, CHAT_ERROR_CODES.MESSAGE_INVALID, '只能编辑 user 消息');
  }

  await runGeneration(req, res, {
    scope: hit.scope,
    convId: id,
    userText: text,
    mode: 'edit',
    msgId,
  });
}

/** 生成参数（三个生成类接口共用） */
interface GenerationSpec {
  scope: string;
  convId: string;
  userText: string;
  mode: 'append-user' | 'regenerate' | 'edit';
  msgId?: string;
}

/**
 * 生成主流程（三个生成类接口共用）。
 *
 * 锁边界（S02 §3.3「生成期间不持锁」）：
 *   ① 锁内 RMW：落 user 消息 / 截断+编辑 / （重新生成无需前置写）
 *   ② 锁外：SSE 生成
 *   ③ 锁内 RMW：落 assistant 消息
 *
 * ⚠️ 响应头在**前置写成功之后**才发（流建立前的错误仍能以 HTTP 状态表达）。
 */
async function runGeneration(
  req: IncomingMessage,
  res: ServerResponse,
  spec: GenerationSpec,
): Promise<void> {
  const { scope, convId, mode } = spec;
  let discardedCount: number | undefined;

  // ── ① 锁内前置写（锁随本次 RMW 结束即释放，生成不持锁）──
  let convAfterPrep: ConversationFile | null = null;
  if (mode === 'append-user') {
    // user 消息**先落盘**：即使用户立刻关页或上游失败，提问也不丢。
    // id 由 store 在锁内统一为 `m{seq}`（调用方无需猜测 seq）。
    convAfterPrep = await appendMessage(scope, convId, {
      id: '',
      role: 'user',
      content: spec.userText,
      at: new Date().toISOString(),
    });
  } else if (mode === 'edit') {
    const r = await truncateAfterAndEdit(scope, convId, spec.msgId!, spec.userText);
    discardedCount = r.discardedCount;
    convAfterPrep = r.conv;
  } else {
    // regenerate：不新增 user 消息（R23），仅读取当前态
    convAfterPrep = await readConversation(scope, convId);
  }

  if (!convAfterPrep) {
    throw new ConversationNotFoundError(convId);
  }

  // 标记生成中（P5：同会话互斥）—— 必须在 SSE 建立前登记，避免并发请求挤入
  generating.add(convId);

  // ── ② 建立 SSE 响应（此后错误只能以事件下发）──
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  // ★ 无论走哪条退出路径（正常/中止/错误/抛异常）都必须清除生成标记，
  //   否则该会话会永久卡在 409 CONVERSATION_GENERATING（P5）。
  try {
  const t0 = Date.now();
  let content = '';
  let usage: ChatMessage['usage'];
  let finishReason = 'stop';
  let sources: SourceRef[] = [];
  let messageId: string | null = null;
  let abortedFlag = false;
  let streamError: { code: string; error: string; retryable?: boolean } | null = null;

  try {
    const events = runToolLoop({
      scope,
      conv: convAfterPrep,
      userText: spec.userText,
      convSystemPrompt: convAfterPrep.systemPrompt,
      signal: ac.signal,
    });

    for await (const ev of events) {
      // meta 补 discardedCount（API-12 契约：仅编辑重发时带）
      if (ev.type === 'meta') {
        messageId = ev.messageId;
        writeSseEvent(res, discardedCount !== undefined ? { ...ev, discardedCount } : ev);
        continue;
      }
      if (ev.type === 'reasoning') { writeSseEvent(res, ev); continue; }
      if (ev.type === 'content') { content += ev.text; writeSseEvent(res, ev); continue; }
      if (ev.type === 'usage') { usage = { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens, ...(ev.reasoningTokens !== undefined ? { reasoningTokens: ev.reasoningTokens } : {}) }; writeSseEvent(res, ev); continue; }
      if (ev.type === 'sources') { sources = ev.sources; writeSseEvent(res, ev); continue; }
      if (ev.type === 'tool_start' || ev.type === 'tool_end' || ev.type === 'degraded') { writeSseEvent(res, ev); continue; }
      if (ev.type === 'aborted') { abortedFlag = true; break; }
      if (ev.type === 'error') { streamError = { code: ev.code, error: ev.error, ...(ev.retryable !== undefined ? { retryable: ev.retryable } : {}) }; break; }
      if (ev.type === 'done') {
        finishReason = ev.finishReason;
        if (ev.sources && ev.sources.length > 0) sources = ev.sources;
        break;
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      streamError = mapThrowToStreamError(err);
    }
  }

  const totalMs = Date.now() - t0;

  // ── ③ 锁内落 assistant ──
  try {
    if (streamError) {
      writeSseEvent(res, { type: 'error', code: streamError.code, error: streamError.error, ...(streamError.retryable !== undefined ? { retryable: streamError.retryable } : {}) });
    } else if (abortedFlag) {
      // 中止：**content 为空则不落盘**（避免空气泡污染会话与列表预览，S02 §5）
      if (content.trim().length > 0) {
        const saved = await appendMessage(scope, convId, buildAssistantMessage({
          content, sources, usage, finishReason: 'aborted', aborted: true, totalMs,
        }));
        const savedId = saved.messages.at(-1)?.id ?? messageId ?? '';
        writeSseEvent(res, { type: 'aborted', messageId: savedId });
      } else {
        writeSseEvent(res, { type: 'aborted', messageId: messageId ?? '' });
      }
    } else if (content.length > 0) {
      // ★ 实现细节 c 的落地：重新生成要**替换**最后一条 assistant（messageCount 不变，R23）
      const convNow = await readConversation(scope, convId);
      if (!convNow) throw new ConversationNotFoundError(convId);

      const assistant = buildAssistantMessage({ content, sources, usage, finishReason, aborted: false, totalMs });
      const saved = mode === 'regenerate' || mode === 'edit'
        ? await replaceLastAssistant(scope, convId, assistant)
        : await appendMessage(scope, convId, assistant);

      const savedId = saved.messages.at(-1)?.id ?? messageId ?? '';
      const tooLong = saved.messages.length > CONVERSATION_TOO_LONG;
      writeSseEvent(res, {
        type: 'done',
        messageId: savedId,
        finishReason,
        sources,
        ...(tooLong ? { warning: 'conversation-too-long' as const } : {}),
      });
    } else {
      // 空终答：不落 assistant（避免空消息）；仍以 done 收尾保证事件序完整
      writeSseEvent(res, { type: 'done', messageId: '', finishReason, sources: [] });
    }
  } catch (err) {
    // 落盘失败：只能以事件下发（HTTP 已 200）
    writeSseEvent(res, {
      type: 'error',
      code: CHAT_ERROR_CODES.CHAT_WRITE_FAILED,
      error: '会话写入失败',
      retryable: true,
    });
    process.stderr.write(`[kisearch] chat 落盘失败 convId=${convId}: ${(err as Error).message}\n`);
  }

  res.end();
  } finally {
    // ★ P5 释放：所有退出路径都清标记
    generating.delete(convId);
  }
}

/** 组装 assistant 消息（落盘形态） */
function buildAssistantMessage(p: {
  content: string;
  sources: SourceRef[];
  usage?: ChatMessage['usage'];
  finishReason: string;
  aborted: boolean;
  totalMs: number;
}): ChatMessage {
  const msg: ChatMessage = {
    id: '',
    role: 'assistant',
    content: p.content,
    at: new Date().toISOString(),
    finishReason: p.finishReason,
    timing: { ttfbMs: null, firstContentMs: null, totalMs: p.totalMs },
  };
  if (p.aborted) msg.aborted = true;
  if (p.usage) msg.usage = p.usage;
  // ★ N22：只落投影后的引用（无来源则不落该字段，与 SSE 语义一致）
  if (p.sources.length > 0) msg.sources = p.sources;
  return msg;
}

/** 把内部 throw 映射为 SSE error 事件的 code/retryable */
function mapThrowToStreamError(err: unknown): { code: string; error: string; retryable?: boolean } {
  const name = (err as Error)?.name ?? '';
  const message = (err as Error)?.message ?? String(err);
  if (name === 'LlmTimeoutError') return { code: CHAT_ERROR_CODES.LLM_TIMEOUT, error: message, retryable: true };
  if (name === 'ChatDisabledError') return { code: CHAT_ERROR_CODES.CHAT_DISABLED, error: message, retryable: false };
  if (name === 'LlmUpstreamError') {
    const retryable = (err as { retryable?: boolean }).retryable === true;
    return { code: CHAT_ERROR_CODES.LLM_UPSTREAM_ERROR, error: message, retryable };
  }
  if (name === 'ConversationNotFoundError') return { code: 'conversation-gone', error: '会话已不存在', retryable: false };
  if (name === 'ChatWriteFailedError') return { code: CHAT_ERROR_CODES.CHAT_WRITE_FAILED, error: message, retryable: true };
  return { code: CHAT_ERROR_CODES.LLM_UPSTREAM_ERROR, error: message, retryable: true };
}

/** 单帧 SSE 写出（`data: {...}\n\n`，**不使用 SSE `event:` 字段**） */
function writeSseEvent(res: ServerResponse, ev: ChatEvent | Record<string, unknown>): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  } catch {
    // 客户端已断开：忽略写失败（生成由 abort 信号收尾）
  }
}

// ─────────────────────────────────────────────────────────────
// SSE 写出（三个生成类接口共用，**唯一实现点**）
// ─────────────────────────────────────────────────────────────

/**
 * 把 `ChatEvent` 事件流转写为 SSE 响应。
 *
 * · 头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、
 *   `X-Accel-Buffering: no`
 * · 帧格式：`data: {"type":...}\n\n`（**不使用 SSE `event:` 字段**，前端按 `data.type` 分派）
 * · 契约：**只转发不重排**；`meta` 必须是首帧
 */
export async function writeSseStream(res: ServerResponse, events: AsyncIterable<unknown>): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  try {
    for await (const ev of events) {
      if (res.writableEnded || res.destroyed) break;
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

// ─────────────────────────────────────────────────────────────
// 生成中的会话登记（供 P5 与外部观测）
// ─────────────────────────────────────────────────────────────

/** 标记会话进入/退出生成态（P5 用；生成期间不持会话锁） */
export function markGenerating(convId: string, on: boolean): void {
  if (on) generating.add(convId);
  else generating.delete(convId);
}

/** 当前是否有会话正在生成（测试与观测用） */
export function isGenerating(convId: string): boolean {
  return generating.has(convId);
}
