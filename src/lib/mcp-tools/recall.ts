/**
 * mcp-tools/recall.ts —— `ki_recall` MCP 工具（REQ-20261118-003 · S-02）。
 *
 * 职责**只有编排**（判定逻辑都在 `lib/recall/`）：
 *   参数校验 → 通道选择 → 并发/频控 → 范围预检 → 调内核（带硬超时）→ 装配对外形状 → 审计日志。
 *
 * 四条准入/降级口径（与设计 S-02 §6 一一对应）：
 *   1. **一期 `auto` 恒为 `fast`，且不标 `degraded`** ——「服务端还没这个通道」不是本次降级，
 *      每次都标会把真正降级的信号淹掉（D-02-7）；
 *   2. **显式 `mode:'deep'` 直接报 `RECALL_MODE_UNAVAILABLE`**（fail-loud + 给出路），
 *      不静默改走 fast（用户点了"深度"，悄悄换成"快速"是最坏的做法）；
 *   3. **点名却不存在/无权的 scope 直接报错**，不静默跳过 —— 与「AI 查找」（配置里有错就跳过）
 *      相反：那里是配置漂移，这里是人明确点了名；
 *   4. 并发满**不排队**，直接 `RECALL_BUSY` + `retryAfterSec`（D-02-4）。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig, type KiConfig } from '../config.js';
import { readAllGroupCaches } from '../group-cache.js';
import { ALL_SCOPES } from '../mcp-token.js';
import { listAllScopes } from '../scope.js';
import { readViews } from '../scope-view.js';
import { buildNextActions } from '../recall/assemble.js';
import {
  RECALL_TOOL_CODES,
  RETRYABLE_TOOL_CODES,
  RecallKernelError,
  toolCodeForKernel,
  type RecallToolCode,
} from '../recall/codes.js';
import { engineRecallSearch } from '../recall/engine-search.js';
import { runFastRecall, type FastRecallDeps, type RecallSearchFn } from '../recall/fast-recall.js';
import {
  acquireRecallSlot,
  readRecallCache,
  recallCacheKey,
  releaseRecallSlot,
  resolveRecallConfig,
  writeRecallCache,
  type RecallRuntimeConfig,
} from '../recall/limits.js';
import { recallLog } from '../recall/log.js';
import { resolveRecallTargets } from '../recall/targets.js';
import {
  DEFAULT_LIMIT,
  EXCLUDE_MAX,
  HINTS_MAX,
  HINT_MAX_CHARS,
  MAX_LIMIT,
  MAX_SCOPE_INPUT,
  TASK_MAX_CHARS,
  TOP_ACTIONS,
  type RecallCandidate,
  type RecallRequest,
} from '../recall/types.js';
import { ToolTimeoutError, withTimeout } from './util.js';

/** 工具描述：外部 AI 决定「要不要用 / 怎么用」的唯一依据，四要素缺一不可 */
const TOOL_DESCRIPTION = '拿到新任务 / 需求 / bug、还不知道该读哪些文档时调用：给一段任务描述 + '
  + '必填的 `scope`（库名或知识视图，可多个），返回值得先读的文档清单（含理由与建议阅读顺序）。'
  + '工具不会替你挑库：不知道有哪些库就先调 `ki_scope_list` / `ki_view_list`，漏传会直接报错并回可用清单。'
  + '单次调用、不提问、不写任何数据。要精确读全文用 `ki_get_module_info`；已知关键词要片段用 `ki_search`；'
  + '读完要综合结论用 `ki_ask`。默认只返回文档清单与理由，不返回正文。';

/** 单次扫描可用库时返回的条目上限（超出让调用方自己 `ki_scope_list`） */
const AVAILABLE_LIST_CAP = 20;

export interface RecallArgs {
  scope?: unknown;
  task?: unknown;
  hints?: unknown;
  exclude?: unknown;
  limit?: unknown;
  mode?: unknown;
}

export interface RecallToolDeps {
  /** 检索适配器（生产 `engineRecallSearch`；测试注入 fake） */
  search?: RecallSearchFn;
  /** 分片缓存读取（默认读真实 group-cache） */
  cachesOf?: FastRecallDeps['cachesOf'];
  /** 授权名字全集；`null` = 本机不限权 */
  tokenScopes?: string[] | null;
  kiConfig?: KiConfig;
  /** 范围解析注入点（listScopes / listViews / config）；测试用，生产走真实 views.json */
  scopeDeps?: Omit<import('../events/find-targets.js').FindTargetDeps, 'tokenScopes'>;
  /** 调用方键（审计与频控维度） */
  principalKey?: string;
  /** 运行期预算（缺省按配置合并默认值） */
  runtime?: RecallRuntimeConfig;
  now?: () => number;
}

export interface RecallToolOk {
  ok: true;
  targets: string[];
  channel: 'fast' | 'deep';
  degraded?: boolean;
  degradedReason?: string;
  query: string;
  candidates: RecallCandidate[];
  nextActions: ReturnType<typeof buildNextActions>;
  needMore: Array<{ field: string; hint: string }>;
  skipped: Array<{ name: string; reason: string }>;
  excludedHidden: number;
  dropped: number;
  ignoredExclude?: number;
  cached?: boolean;
  truncated?: boolean;
  durationMs: number;
}

export interface RecallToolFail {
  ok: false;
  code: RecallToolCode;
  message: string;
  retryable: boolean;
  retryAfterSec?: number;
  /** 未传 scope 时附可用清单，让调用方一次自愈 */
  available?: { scopes: string[]; views: string[]; truncated: boolean };
}

export type RecallToolResult = RecallToolOk | RecallToolFail;

function fail(code: RecallToolCode, message: string, extra?: Partial<RecallToolFail>): RecallToolFail {
  return { ok: false, code, message, retryable: RETRYABLE_TOOL_CODES.has(code), ...(extra ?? {}) };
}

/** 把 `scope` 入参归一成数组；非法形状返回 null（由调用方报 SCOPE_REQUIRED） */
function normalizeScopeInput(raw: unknown): string[] | null {
  if (typeof raw === 'string') return raw.trim() ? [raw.trim()] : null;
  if (Array.isArray(raw)) {
    const list = raw
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return list.length > 0 ? list.slice(0, MAX_SCOPE_INPUT) : null;
  }
  return null;
}

/** 可用的库与视图清单（只给名字，用于漏传 scope 时一次自愈） */
function availableTargets(
  cfg: KiConfig,
  tokenScopes: string[] | null,
): { scopes: string[]; views: string[]; truncated: boolean } {
  const allowAll = tokenScopes === null || tokenScopes.includes(ALL_SCOPES);
  const allow = (name: string): boolean => allowAll || (tokenScopes ?? []).includes(name);
  let scopes: string[] = [];
  let views: string[] = [];
  try {
    scopes = listAllScopes().filter(allow);
  } catch {
    scopes = [];
  }
  try {
    views = Object.keys(readViews(cfg)).filter(allow);
  } catch {
    views = [];
  }
  const total = scopes.length + views.length;
  const cappedScopes = scopes.slice(0, AVAILABLE_LIST_CAP);
  const cappedViews = views.slice(0, Math.max(0, AVAILABLE_LIST_CAP - cappedScopes.length));
  return {
    scopes: cappedScopes,
    views: cappedViews,
    truncated: total > cappedScopes.length + cappedViews.length,
  };
}

/** 统计格式非法的 exclude 条目（工具层只计数，不阻断：拼错一条不该让整次调用失败） */
function countInvalidExclude(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  let invalid = 0;
  for (const item of raw) {
    if (typeof item !== 'string') {
      invalid += 1;
      continue;
    }
    const parts = item.split('::').map((p) => p.trim());
    const valid = (parts.length === 2 || parts.length === 3) && parts.every((p) => p.length > 0);
    if (!valid) invalid += 1;
  }
  return invalid;
}

/**
 * 工具主体（导出以便单测，不依赖 MCP 传输层）。
 *
 * 顺序刻意是「先校验 → 再占槽 → 再预检范围 → 最后才检索」：范围预检失败时不浪费一次检索，
 * 且槽位一定在 `finally` 释放（异常路径漏释放会让并发槽永久少一个）。
 */
export async function executeRecall(args: RecallArgs, deps: RecallToolDeps = {}): Promise<RecallToolResult> {
  const now = deps.now ?? ((): number => Date.now());
  const startedAt = now();
  const principalKey = deps.principalKey ?? 'local';
  const cfg = deps.kiConfig ?? loadConfig();
  const runtime = deps.runtime ?? resolveRecallConfig(cfg.recall);
  const search = deps.search ?? engineRecallSearch;
  const cachesOf = deps.cachesOf ?? ((scope: string) => readAllGroupCaches(scope) as unknown as ReturnType<FastRecallDeps['cachesOf']>);

  // ── ① 入参 ─────────────────────────────────────────────
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (task.length === 0 || task.length > TASK_MAX_CHARS) {
    return fail(
      RECALL_TOOL_CODES.TASK_INVALID,
      task.length === 0
        ? '任务画像为空：请用 2-3 句写「要做什么 / 涉及哪个模块 / 什么现象 / 期望什么」（不是提问）。'
        : `任务画像过长（${task.length} 字符，上限 ${TASK_MAX_CHARS}）：请压到 2-3 句；长材料请改用 hints 传错误码 / 路径 / 函数名。`,
    );
  }

  const hintsRaw = Array.isArray(args.hints) ? args.hints : [];
  if (hintsRaw.length > HINTS_MAX || hintsRaw.some((h) => typeof h !== 'string' || h.length > HINT_MAX_CHARS)) {
    return fail(
      RECALL_TOOL_CODES.HINTS_INVALID,
      `hints 只放「强线索」：最多 ${HINTS_MAX} 条、每条 ≤${HINT_MAX_CHARS} 字（错误码 / 文件路径 / 模块名）；长材料请自行摘。`,
    );
  }
  const hints = hintsRaw
    .filter((h): h is string => typeof h === 'string')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  const excludeRaw = Array.isArray(args.exclude) ? args.exclude.slice(0, EXCLUDE_MAX) : [];
  const exclude = excludeRaw.filter((e): e is string => typeof e === 'string' && e.trim().length > 0);
  const ignoredExclude = countInvalidExclude(excludeRaw);

  const mode = args.mode === 'deep' ? 'deep' : args.mode === 'fast' ? 'fast' : 'auto';
  if (mode === 'deep') {
    return fail(
      RECALL_TOOL_CODES.MODE_UNAVAILABLE,
      '深度通道尚未在本版本提供（当前只有确定性通道）：请改用 mode="auto" 或 "fast"；'
      + '深度通道会随二期提供，届时 auto 会自动选择。',
    );
  }

  const limitRaw = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.floor(limitRaw)), runtime.maxCandidates, MAX_LIMIT);

  // ── ② scope（必填，缺了要给可用清单）─────────────────────
  const scope = normalizeScopeInput(args.scope);
  if (!scope) {
    const available = availableTargets(cfg, deps.tokenScopes ?? null);
    recallLog('error', { principalKey, targets: [], channel: 'fast', code: RECALL_TOOL_CODES.SCOPE_REQUIRED, task });
    return fail(
      RECALL_TOOL_CODES.SCOPE_REQUIRED,
      '未传 scope（必填）：查哪几个库 / 视图由你决定，本工具不会自动挑库。'
      + '请从下面的可用清单里选，或先调 ki_scope_list / ki_view_list 查看。',
      { available },
    );
  }

  // ── ③ 并发 + 频控（不排队，满了直接拒）────────────────────
  const slot = acquireRecallSlot(principalKey, runtime, now());
  if (!slot.ok) {
    recallLog('throttled', { principalKey, targets: scope, channel: 'fast', code: slot.code, task });
    return fail(
      slot.code ?? RECALL_TOOL_CODES.BUSY,
      slot.code === RECALL_TOOL_CODES.BUSY
        ? `预取并发已达上限（${runtime.maxConcurrent} 个在途）：请 ${slot.retryAfterSec ?? 1} 秒后重试，或暂用 ki_search。`
        : `调用过于频繁（每 ${runtime.throttlePerMinute} 次/分钟）：请 ${slot.retryAfterSec ?? 1} 秒后重试。`,
      { ...(slot.retryAfterSec !== undefined ? { retryAfterSec: slot.retryAfterSec } : {}) },
    );
  }

  const scopeDeps = deps.scopeDeps ?? (deps.kiConfig ? { config: deps.kiConfig } : {});

  try {
    // ── ④ 范围预检：点名却不可用 → 直接报错（做过一次检索再报错是浪费）──
    try {
      const pre = resolveRecallTargets({
        requested: scope,
        tokenScopes: deps.tokenScopes ?? null,
        ...(Object.keys(scopeDeps).length > 0 ? { deps: scopeDeps } : {}),
      });
      if (pre.forbiddenRequested.length > 0) {
        const bad = pre.forbiddenRequested;
        const hasForbidden = bad.some((b) => b.reason === 'forbidden');
        const code = hasForbidden ? RECALL_TOOL_CODES.SCOPE_FORBIDDEN : RECALL_TOOL_CODES.SCOPE_UNKNOWN;
        recallLog('error', { principalKey, targets: scope, channel: 'fast', code, task });
        return fail(
          code,
          `${hasForbidden ? '这些 scope 无权限访问' : '这些 scope 不存在（既不是库也不是视图）'}：`
          + bad.map((b) => `${b.name}（${b.reason === 'forbidden' ? '无权' : b.reason === 'missing' ? '不存在' : '视图无成员'}）`).join('、')
          + '。请改用有权限的库 / 视图，或先 ki_scope_list 确认名字。',
        );
      }
    } catch (err) {
      if (err instanceof RecallKernelError) {
        const code = toolCodeForKernel(err.code);
        return fail(code, err.message);
      }
      throw err;
    }

    // ── ⑤ 检索（带缓存 + 硬超时）──────────────────────────
    const cacheStats = { calls: 0, cached: 0 };
    const searchWithCache: RecallSearchFn = async (searchArgs) => {
      cacheStats.calls += 1;
      const key = recallCacheKey(searchArgs.scope, searchArgs.query, searchArgs.mode ?? 'hybrid');
      const hit = readRecallCache<Awaited<ReturnType<RecallSearchFn>>>(key, runtime.cacheTtlSec, now());
      if (hit) {
        cacheStats.cached += 1;
        return hit.value;
      }
      const fresh = await search(searchArgs);
      writeRecallCache(key, fresh, now());
      return fresh;
    };

    const request: RecallRequest = {
      scope,
      task,
      ...(hints.length > 0 ? { hints } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
      limit,
    };

    let core;
    try {
      core = await withTimeout(
        runFastRecall(request, {
          tokenScopes: deps.tokenScopes ?? null,
          search: searchWithCache,
          cachesOf,
          ...(Object.keys(scopeDeps).length > 0 ? { scopeDeps } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        }),
        runtime.hardTimeoutMs,
        'ki_recall',
      );
    } catch (err) {
      if (err instanceof ToolTimeoutError) {
        recallLog('error', { principalKey, targets: scope, channel: 'fast', code: RECALL_TOOL_CODES.TIMEOUT, task });
        return fail(
          RECALL_TOOL_CODES.TIMEOUT,
          `预取超过 ${Math.round(runtime.hardTimeoutMs / 1000)} 秒仍未出结果：请补强线索（错误码 / 路径）或缩小 scope 后重试。`,
        );
      }
      if (err instanceof RecallKernelError) {
        const code = toolCodeForKernel(err.code);
        recallLog('error', { principalKey, targets: scope, channel: 'fast', code, task });
        return fail(code, err.message);
      }
      const message = (err as Error).message;
      recallLog('error', { principalKey, targets: scope, channel: 'fast', code: RECALL_TOOL_CODES.INTERNAL, task });
      return fail(RECALL_TOOL_CODES.INTERNAL, `预取内部错误：${message}（可重试；持续失败请查服务端日志）`);
    }

    const cached = cacheStats.calls > 0 && cacheStats.cached === cacheStats.calls;
    recallLog(core.candidates.length > 0 ? 'ok' : 'empty', {
      principalKey,
      targets: core.targets,
      physicalCount: core.targets.length,
      channel: 'fast',
      candidates: core.candidates.length,
      cached,
      task,
      durationMs: core.durationMs,
    });

    return {
      ok: true,
      targets: core.targets,
      channel: 'fast',
      query: core.query,
      candidates: core.candidates,
      nextActions: buildNextActions(core.candidates, TOP_ACTIONS),
      needMore: core.needMore,
      skipped: core.skipped,
      excludedHidden: core.excludedHidden,
      dropped: core.dropped,
      ...(ignoredExclude > 0 ? { ignoredExclude } : {}),
      ...(cached ? { cached } : {}),
      ...(core.truncated ? { truncated: true } : {}),
      durationMs: now() - startedAt,
    };
  } finally {
    releaseRecallSlot();
  }
}

/** 成功形状：与其它工具一致（`content[0].text` 是 JSON 字符串） */
function okResult(result: RecallToolOk): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function failResult(result: RecallToolFail): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

export function registerRecallTool(server: McpServer, principalKey = 'local'): void {
  server.tool(
    'ki_recall',
    TOOL_DESCRIPTION,
    {
      scope: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(MAX_SCOPE_INPUT)])
        .describe('检索范围（必填）：库名或知识视图名，可多个。不确定有哪些库时先调 ki_scope_list / ki_view_list；'
          + '不传会直接报错并返回当前 Token 可用的库与视图清单，不会自动挑库'),
      task: z.string().min(1).max(TASK_MAX_CHARS)
        .describe('任务画像（2-3 句）：要做什么 / 涉及哪个模块或页面 / 什么现象 / 期望什么。不是提问，不要写成问题句'),
      hints: z.array(z.string().max(HINT_MAX_CHARS)).max(HINTS_MAX).optional()
        .describe('强线索：文件路径 / 报错码 / 模块名 / 接口名（能唯一指向位置的最好）'),
      exclude: z.array(z.string().max(300)).max(EXCLUDE_MAX).optional()
        .describe('已读清单："scope::group::name" 或 "group::name"（省略 scope 表示任意库）'),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional()
        .describe(`候选条数上限，默认 ${DEFAULT_LIMIT}（还受服务端 recall.maxCandidates 限制）`),
      mode: z.enum(['auto', 'fast', 'deep']).optional()
        .describe('缺省 auto：有深度通道就用，否则确定性检索。deep 在当前版本会明确报不可用'),
    },
    async (args) => {
      const result = await executeRecall(args, { principalKey });
      return result.ok ? okResult(result) : failResult(result);
    },
  );
}
