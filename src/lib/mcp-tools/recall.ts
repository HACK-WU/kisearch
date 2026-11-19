/**
 * mcp-tools/recall.ts —— `ki_recall` MCP 工具（REQ-20261118-004 · S-02）。
 *
 * 职责**只有编排**（判定逻辑在内核 `lib/recall/run-recall.ts`）：
 *   参数校验 → 范围预检 → 门禁三态 → 频控 → 调内核（硬超时）→ 装配对外形状 → 审计。
 *
 * 2026-11-18 的关键变化（产品拍板）：
 *   · **只有模型通道**：不再有 `mode`、不再有 fast 降级。不调模型的"预取"不如让调用方
 *     自己 `ki_search` —— 保留它只会让「AI 预取」名不副实。
 *   · **门禁未过 = 直接不可用**（不是降级）：三态各自一个错误码，文案统一引导改用 `ki_search`。
 *   · **删结果缓存与并发槽**，只保留频控（唯一有效护栏）。
 *   · **只读 Token 可用**（产出只有清单与判断，不写数据；代价已由产品确认）。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { readPromptConfig, defaultFindConfig, RECALL_DEFAULT_ROUNDS, RECALL_DEFAULT_TOOL_CHARS, RECALL_SCENARIO_SKILL_ID } from '../chat/prompt-config.js';
import { resolveLlmStatus, streamChat, type ChatTurn, type LlmStreamPart } from '../chat/llm-client.js';
import { loadConfig, type KiConfig } from '../config.js';
import { listAllScopes } from '../scope.js';
import { readViews } from '../scope-view.js';
import { readAllGroupCaches } from '../group-cache.js';
import { ALL_SCOPES } from '../mcp-token.js';
import { engineRecallSearch } from '../recall/engine-search.js';
import { runFastRecall, type RecallSearchFn } from '../recall/fast-recall.js';
import {
  RECALL_TOOL_CODES,
  RETRYABLE_TOOL_CODES,
  RecallKernelError,
  toolCodeForKernel,
  type RecallToolCode,
} from '../recall/codes.js';
import { acquireRecallSlot, resolveRecallConfig, type RecallRuntimeConfig } from '../recall/limits.js';
import { recallLog } from '../recall/log.js';
import { runGroundedRecall, type GroundedToolRunner } from '../recall/run-recall.js';
import { makeRecallToolRunner } from '../recall/tool-runner.js';
import {
  buildRecallSystemPrompt,
  buildRecallUserMessage,
  type RecallRuntimeCfg,
} from '../recall/recall-prompt.js';
import { resolveRecallTargets } from '../recall/targets.js';
import {
  DEFAULT_LIMIT,
  EXCLUDE_MAX,
  HINTS_MAX,
  HINT_MAX_CHARS,
  MAX_LIMIT,
  MAX_SCOPE_INPUT,
  TASK_MAX_CHARS,
  type RecallHit,
  type NextAction,
  type NeedMoreItem,
} from '../recall/types.js';
import { ToolTimeoutError, withTimeout } from './util.js';

/** 工具描述：外部 AI 决定「要不要用 / 怎么用」的唯一依据 */
const TOOL_DESCRIPTION = '拿到新任务 / 需求 / bug、还不知道该读哪些文档时调用：给一段任务描述 + '
  + '必填的 `scope`（库名或知识视图，可多个），由 ki 自己的模型读正文判断后返回'
  + '「该先读哪几篇 + 为什么 + 整体结论 + 判断不了的点」。'
  + '工具不会替你挑库：不知道有哪些库就先调 `ki_scope_list` / `ki_view_list`，漏传会直接报错并回可用清单。'
  + '单次调用、不提问、不写任何数据；**需要模型**，未配置模型或未确认外发时不可用（此时请改用 `ki_search` 自行检索）。'
  + '要精确读全文用 `ki_get_module_info`；已知关键词要片段用 `ki_search`；读完要综合结论用 `ki_ask`。';

/** 单次扫描可用库时返回的条目上限（超出让调用方自己 `ki_scope_list`） */
const AVAILABLE_LIST_CAP = 20;

export interface RecallArgs {
  scope?: unknown;
  task?: unknown;
  hints?: unknown;
  exclude?: unknown;
  limit?: unknown;
}

export interface RecallToolDeps {
  /** 检索适配器（种子召回用；生产 `engineRecallSearch`，测试注入 fake） */
  search?: RecallSearchFn;
  /** 分片缓存读取（种子召回的可见性判定用） */
  cachesOf?: (scope: string) => ReturnType<typeof readAllGroupCaches>;
  /** 授权名字全集；`null` = 本机不限权 */
  tokenScopes?: string[] | null;
  kiConfig?: KiConfig;
  /** 范围解析注入点（listScopes / listViews / config）；测试用 */
  scopeDeps?: Omit<import('../events/find-targets.js').FindTargetDeps, 'tokenScopes'>;
  /** 调用方键（审计与频控维度） */
  principalKey?: string;
  /**
   * 取消信号（2026-11-19）：事件 AI 分析在开场预取时传入，用户点「停止」即中断，
   * 不让一次没人要的预取继续烧模型调用。
   */
  signal?: AbortSignal;
  /** 运行期预算（缺省按配置合并默认值） */
  runtime?: RecallRuntimeConfig;
  now?: () => number;
  /** —— 以下为测试注入点（生产不传，走真实实现）—— */
  stream?: (messages: ChatTurn[], opts?: Record<string, unknown>) => AsyncGenerator<LlmStreamPart>;
  runTool?: GroundedToolRunner;
  /** 覆盖 `prompt-config.recall` 域（测试用） */
  recallCfg?: RecallRuntimeCfg;
}

export interface RecallToolOk {
  ok: true;
  targets: string[];
  /** 整体结论（≤3 句）；0 候选时说明查了什么、为什么没有 */
  summary: string;
  candidates: RecallHit[];
  /** 判断不了的点（与 needMore 分开：前者"你看着办"，后者"请补信息再调一次"） */
  uncertainties: string[];
  nextActions: NextAction[];
  needMore: NeedMoreItem[];
  skipped: Array<{ name: string; reason: string }>;
  dropped: number;
  rounds: number;
  partial?: boolean;
  durationMs: number;
}

export interface RecallToolFail {
  ok: false;
  code: RecallToolCode;
  message: string;
  retryable: boolean;
  retryAfterSec?: number;
  /** `RECALL_SCOPE_REQUIRED` 时回可用库 / 视图清单，让调用方一次自愈 */
  available?: string[];
}

type RecallToolResult = RecallToolOk | RecallToolFail;

// ─── 小工具 ────────────────────────────────────────────

function ok(payload: RecallToolOk): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function fail(code: RecallToolCode, message: string, extra?: Partial<RecallToolFail>): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const payload: RecallToolFail = {
    ok: false,
    code,
    message,
    retryable: RETRYABLE_TOOL_CODES.has(code),
    ...extra,
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

/** 三态门禁的统一出路文案：**永远**指向 ki_search */
const KI_SEARCH_FALLBACK = '也可以改用 `ki_search` 自己检索（它不需要模型）。';

function normalizeScopeInput(raw: unknown): string[] {
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function normalizeStringList(raw: unknown, max: number, maxChars: number): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > max) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const v = item.trim();
    if (!v) continue;
    if (v.length > maxChars) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// ─── 生产工具执行器 ────────────────────────────────────

// ─── 主流程 ────────────────────────────────────────────

export async function executeRecall(
  args: RecallArgs,
  deps: RecallToolDeps = {},
): Promise<ReturnType<typeof ok> | ReturnType<typeof fail>> {
  const nowFn = deps.now ?? Date.now;
  const started = nowFn();
  const principalKey = deps.principalKey ?? 'local';
  const config = deps.kiConfig ?? loadConfig();

  // ── ① 入参校验 ──
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task || task.length > TASK_MAX_CHARS) {
    return fail(
      RECALL_TOOL_CODES.TASK_INVALID,
      `task 应为 1~${TASK_MAX_CHARS} 字的任务画像（2-3 句：目标 / 涉及 / 现象 / 期望），不是提问。实际 ${task.length} 字。`,
    );
  }
  const hints = normalizeStringList(args.hints, HINTS_MAX, HINT_MAX_CHARS);
  if (hints === null) {
    return fail(
      RECALL_TOOL_CODES.HINTS_INVALID,
      `hints 只放「强线索」：最多 ${HINTS_MAX} 条、每条 ≤${HINT_MAX_CHARS} 字（错误码 / 文件路径 / 模块名）。`,
    );
  }
  const exclude = normalizeStringList(args.exclude, EXCLUDE_MAX, 300);
  if (exclude === null) {
    return fail(RECALL_TOOL_CODES.TASK_INVALID, 'exclude 应为字符串数组（已读清单）。');
  }
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit)
    ? Math.min(MAX_LIMIT, Math.max(1, args.limit))
    : DEFAULT_LIMIT;

  // ── ② scope 必填（漏传回可用清单，一次自愈）──
  const scope = normalizeScopeInput(args.scope);
  if (scope.length === 0) {
    const available: string[] = [];
    try {
      available.push(...listAvailableNames(config, deps).slice(0, AVAILABLE_LIST_CAP));
    } catch {
      /* 扫库失败不影响报错本身 */
    }
    recallLog('error', { principalKey, targets: [], channel: 'deep', code: RECALL_TOOL_CODES.SCOPE_REQUIRED, task });
    return fail(
      RECALL_TOOL_CODES.SCOPE_REQUIRED,
      `scope 必填（库名或视图名，可多个）：本工具**不会**替你挑库，否则查错库无法复盘。`
      + `从下面清单里选，或在没把握时先调 ki_scope_list / ki_view_list。`,
      available.length > 0 ? { available } : {},
    );
  }
  if (scope.length > MAX_SCOPE_INPUT) {
    return fail(RECALL_TOOL_CODES.SCOPE_REQUIRED, `scope 最多 ${MAX_SCOPE_INPUT} 项，实际 ${scope.length}。`);
  }

  // ── ③ 范围预检：点名却不存在/无权 → 直接报错 ──
  const scopeDeps = deps.scopeDeps ?? { config };
  const pre = resolveRecallTargets({
    requested: scope,
    tokenScopes: deps.tokenScopes ?? null,
    ...(Object.keys(scopeDeps).length > 0 ? { deps: scopeDeps } : {}),
  });
  if (pre.forbiddenRequested.length > 0) {
    const bad = pre.forbiddenRequested;
    const hasForbidden = bad.some((b) => b.reason === 'forbidden');
    const code = hasForbidden ? RECALL_TOOL_CODES.SCOPE_FORBIDDEN : RECALL_TOOL_CODES.SCOPE_UNKNOWN;
    recallLog('error', { principalKey, targets: scope, channel: 'deep', code, task });
    return fail(
      code,
      `${hasForbidden ? '这些 scope 无权限访问' : '这些 scope 不存在（既不是库也不是视图）'}：`
      + bad.map((b) => `${b.name}（${b.reason}）`).join('、')
      + '。可先调 ki_scope_list / ki_view_list 确认。',
    );
  }
  if (pre.physicalTargets.length === 0) {
    recallLog('error', { principalKey, targets: scope, channel: 'deep', code: RECALL_TOOL_CODES.TARGETS_EMPTY, task });
    return fail(RECALL_TOOL_CODES.TARGETS_EMPTY, '全部 scope 都不可用（不存在 / 无权限 / 视图无成员）。');
  }

  // ── ④ 门禁三态：**未过即不可用**（不降级）──
  const status = resolveLlmStatus(config, config._configPath ?? '');
  if (!status.enabled) {
    recallLog('error', { principalKey, targets: pre.targets, channel: 'deep', code: RECALL_TOOL_CODES.MODEL_UNAVAILABLE, task });
    return fail(
      RECALL_TOOL_CODES.MODEL_UNAVAILABLE,
      `未配置模型，本工具无法工作（它靠模型读正文判断相关性）：${status.reason ?? '请在 config.yaml 的 llm 段填写 baseURL / model / apiKey'}。`
      + KI_SEARCH_FALLBACK,
    );
  }
  if (status.ackRequired) {
    recallLog('error', { principalKey, targets: pre.targets, channel: 'deep', code: RECALL_TOOL_CODES.DISCLOSURE_REQUIRED, task });
    return fail(
      RECALL_TOOL_CODES.DISCLOSURE_REQUIRED,
      '知识库内容外发未确认：预取会把文档正文发送给上游模型。请先在「AI 设置」完成隐私确认'
      + '（写入 llm.kbDisclosureAck），或由管理员在 config.yaml 中设置。'
      + KI_SEARCH_FALLBACK,
    );
  }
  if (!status.supportsTools) {
    recallLog('error', { principalKey, targets: pre.targets, channel: 'deep', code: RECALL_TOOL_CODES.TOOLS_UNSUPPORTED, task });
    return fail(
      RECALL_TOOL_CODES.TOOLS_UNSUPPORTED,
      '当前模型不支持 function calling（llm.supportsTools=false），预取需要模型自己调用检索工具。'
      + '请换一个支持工具调用的模型。'
      + KI_SEARCH_FALLBACK,
    );
  }

  // ── ⑤ 频控（唯一护栏，满了不排队）──
  const runtime = deps.runtime ?? resolveRecallConfig(config.recall);
  const slot = acquireRecallSlot(principalKey, runtime, nowFn());
  if (!slot.ok) {
    recallLog('throttled', { principalKey, targets: pre.targets, channel: 'deep', code: RECALL_TOOL_CODES.THROTTLED, task });
    return fail(
      RECALL_TOOL_CODES.THROTTLED,
      `预取调用过于频繁（每分钟上限 ${runtime.throttlePerMinute} 次）：请 ${slot.retryAfterSec ?? 1} 秒后重试。`
      + KI_SEARCH_FALLBACK,
      { retryAfterSec: slot.retryAfterSec },
    );
  }

  // ── ⑥ 读配置 + 种子召回 + 模型循环（硬超时）──
  const recallCfg = deps.recallCfg ?? resolveRecallSection(config);

  // 种子召回只是「给模型的起点」：失败不影响主流程（模型会自己 ki_search）
  let seed: Array<{ scope: string; group: string; name: string }> = [];
  try {
    const seedRes = await runFastRecall(
      { scope: pre.targets, task, limit: 10, ...(hints.length > 0 ? { hints } : {}), ...(exclude.length > 0 ? { exclude } : {}) },
      {
        tokenScopes: deps.tokenScopes ?? null,
        search: deps.search ?? engineRecallSearch,
        cachesOf: deps.cachesOf ?? ((sc) => readAllGroupCaches(sc)),
        scopeDeps: deps.scopeDeps ?? { config },
      },
    );
    seed = seedRes.candidates;
  } catch {
    seed = [];
  }

  const runner = deps.runTool ?? makeRecallToolRunner({
    targets: pre.physicalTargets,
    toolChars: recallCfg.toolResponseChars,
  });

  let result;
  try {
    result = await withTimeout(
      runGroundedRecall({
        systemPrompt: buildRecallSystemPrompt(recallCfg),
        userMessage: buildRecallUserMessage({
          task,
          ...(hints.length > 0 ? { hints } : {}),
          ...(exclude.length > 0 ? { exclude } : {}),
          ...(seed.length > 0 ? { seed } : {}),
        }),
        ...(exclude.length > 0 ? { exclude } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
        limit,
        tools: recallCfg.tools,
        maxRounds: recallCfg.maxRounds,
        llm: {
          baseURL: config.llm?.baseURL ?? '',
          apiKey: config.llm?.apiKey ?? '',
          model: config.llm?.model ?? '',
          temperature: config.llm?.temperature,
          maxTokens: config.llm?.maxTokens,
          ...(recallCfg.reasoningEffort ? { reasoningEffort: recallCfg.reasoningEffort } : {}),
        },
        stream: deps.stream ?? ((messages, opts) => streamChat(messages as ChatTurn[], opts as never)),
        ...(runner ? { runTool: runner } : {}),
        now: nowFn,
      }),
      runtime.hardTimeoutMs,
      'ki_recall',
    );
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      recallLog('error', { principalKey, targets: pre.targets, channel: 'deep', code: RECALL_TOOL_CODES.TIMEOUT, task });
      return fail(
        RECALL_TOOL_CODES.TIMEOUT,
        `预取超过 ${Math.round(runtime.hardTimeoutMs / 1000)} 秒仍未完成：请补强线索（错误码 / 路径 / 模块名）或缩小 scope；`
        + '本次未返回任何结论，不要当成「没有相关文档」。'
        + KI_SEARCH_FALLBACK,
        { retryAfterSec: 1 },
      );
    }
    if (err instanceof RecallKernelError) {
      const code = toolCodeForKernel(err.code);
      recallLog('error', { principalKey, targets: pre.targets, channel: 'deep', code, task });
      return fail(code, `预取执行失败：${err.message}`);
    }
    recallLog('error', { principalKey, targets: pre.targets, channel: 'deep', code: RECALL_TOOL_CODES.INTERNAL, task });
    return fail(
      RECALL_TOOL_CODES.INTERNAL,
      `预取执行异常：${err instanceof Error ? err.message : String(err)}`,
      { retryAfterSec: 1 },
    );
  }

  // ── ⑦ 装配 + 审计 ──
  const payload: RecallToolOk = {
    ok: true,
    targets: pre.targets,
    summary: result.summary,
    candidates: result.candidates,
    uncertainties: result.uncertainties,
    nextActions: result.nextActions,
    needMore: result.needMore,
    skipped: pre.skipped.map((s) => ({ name: s.name, reason: s.reason })),
    dropped: result.dropped,
    rounds: result.rounds,
    ...(result.partial ? { partial: true } : {}),
    durationMs: nowFn() - started,
  };
  recallLog(result.candidates.length > 0 ? 'ok' : 'empty', {
    principalKey,
    targets: pre.targets,
    channel: 'deep',
    candidates: result.candidates.length,
    rounds: result.rounds,
    durationMs: payload.durationMs,
    task,
    ...(result.partial ? { partial: true } : {}),
  });
  return ok(payload);
}

// ─── 辅助 ──────────────────────────────────────────────

/**
 * 泄漏清单（漏传 scope 时回给调用方）。
 *
 * **视图排在前面**（2026-11-19 真机）：视图是管理员策展过的范围，而库列表里往往混着
 * `bulk-test` / `e2e-test` 这类临时库 —— 按扫描顺序截取前 20 项时，视图会被整批挤出，
 * 调用方看到的全是噪声。
 */
function listAvailableNames(config: KiConfig, deps: RecallToolDeps): string[] {
  const views: string[] = [];
  const scopes: string[] = [];
  try {
    const table = deps.scopeDeps?.listViews?.() ?? readViews(config);
    views.push(...Object.keys(table));
  } catch {
    /* 读不到视图不影响库清单 */
  }
  if (deps.tokenScopes === null || deps.tokenScopes === undefined) {
    try {
      const injected = deps.scopeDeps?.listScopes?.();
      scopes.push(...(injected ?? listAllScopes()));
    } catch {
      /* 扫库失败不影响清单本身 */
    }
  } else {
    scopes.push(...deps.tokenScopes);
  }
  return [...new Set([...views, ...scopes])].filter((n) => n !== ALL_SCOPES);
}

function resolveRecallSection(config: KiConfig): RecallRuntimeCfg {
  const cfg = readPromptConfig(config).config;
  /*
   * 与「AI 查找」**共用同一个配置域**（2026-11-18 用户拍板：一套逻辑 + 一份配置）。
   * 场景差异只靠 skill：这里只注入 `task-recall`，find 侧只注入 `refs-locate`。
   */
  const section = cfg.find ?? defaultFindConfig();
  const scenario = section.skills.filter((s) => s.enabled && s.id === RECALL_SCENARIO_SKILL_ID);
  return {
    prompt: section.prompt.content,
    // 查找域的工具集是「知识库只读四件套」，预取额外需要列库能力
    tools: { ki_scope_list: true, ...section.tools },
    maxRounds: RECALL_DEFAULT_ROUNDS,
    toolResponseChars: RECALL_DEFAULT_TOOL_CHARS,
    ...(section.reasoningEffort ? { reasoningEffort: section.reasoningEffort } : {}),
    skills: scenario.map((s) => ({ id: s.id, name: s.name, content: s.content, enabled: s.enabled })),
  };
}


// ─── 注册 ──────────────────────────────────────────────

export function registerRecallTool(server: McpServer, principalKey: string): void {
  server.tool(
    'ki_recall',
    TOOL_DESCRIPTION,
    {
      /*
       * ⚠️ 这里**故意不标 required**（2026-11-18 真机发现）：标成必填时 MCP SDK 会在进入
       *    处理函数**之前**就用 `invalid_union` 拒绝，调用方拿不到「可用库 / 视图清单」，
       *    设计里的「一次自愈」（RECALL_SCOPE_REQUIRED + available）永远走不到。
       *    改由处理函数判空并回结构化错误 —— 语义仍是必填，只是错误更可行动。
       */
      scope: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(MAX_SCOPE_INPUT)])
        .optional()
        .describe('检索范围（**必填**）：库名或知识视图名，可多个。不确定有哪些库时先调 ki_scope_list / ki_view_list；'
          + '不传会直接报错并返回当前可用的库与视图清单，不会自动挑库'),
      task: z.string().min(1).max(TASK_MAX_CHARS)
        .describe('任务画像（2-3 句）：要做什么 / 涉及哪个模块或页面 / 什么现象 / 期望什么。不是提问'),
      hints: z.array(z.string().max(HINT_MAX_CHARS)).max(HINTS_MAX).optional()
        .describe('强线索：文件路径 / 报错码 / 模块名 / 接口名'),
      exclude: z.array(z.string().max(300)).max(EXCLUDE_MAX).optional()
        .describe('已读清单："scope::group::name" 或 "group::name"；再次调用时传入，避免重复推荐'),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('候选条数上限，默认 8'),
    },
    async (args) => executeRecall(args as RecallArgs, { principalKey }),
  );
}
