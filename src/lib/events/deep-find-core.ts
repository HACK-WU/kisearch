/**
 * 「AI 查找」的模型通道 · 基于共享内核的实现（REQ-20261118-004 合并，2026-11-19）。
 *
 * 为什么要新文件而不是改 `find-runner`：后者把「循环 / 工具执行 / 三重校验 / 并发队列」
 * 全塞在一个 1000 行函数里，且 `steps`、`hitScores`、`saw*Search` 在**两个作用域**各声明一次 ——
 * 原地替换会连带打断面板数据（实测 tsc 报 9 处，已回滚）。所以这里做**同签名的第二实现**，
 * 验证通过后再切调用点、最后删旧循环。
 *
 * 与 `ki_recall` 的关系：**同一份内核**（`runGroundedRecall`）+ **同一份工具执行器**
 * （`makeRecallToolRunner`）。差异只在三处，且都不在循环里：
 *   ① 输入装配：事件 → 用户消息（`buildFindContext`）
 *   ② 强制 skill：仅页面侧加载 `refs-locate`（挑参考文档）；预取侧不加载任何 skill（2026-11-25 Q6）
 *   ③ 产物落点：候选进面板、由人勾选写入 refs（`ki_recall` 是 agent 直接消费）
 */

import type { ChatTurn, LlmStreamPart } from '../chat/llm-client.js';
import { streamChat } from '../chat/llm-client.js';
import { GROUNDED_OUTPUT_SPEC, runGroundedRecall } from '../recall/run-recall.js';
import { buildScopeNote, toolCallBudgetNote } from '../recall/recall-prompt.js';
import { buildRulesBlock, loadRulesForScopes, maybeGcRules } from '../rules/index.js';
import { makeRecallToolRunner, makeScopeResolver } from '../recall/tool-runner.js';
import { readAllGroupCaches } from '../group-cache.js';
import { loadConfig, type KiConfig } from '../config.js';
import { FIND_DEFAULT_TOOL_CALLS } from '../chat/prompt-config.js';
import { resolveVisibilityOfRelation } from '../visibility-index.js';
import { buildFindContext, type DeepFindDeps, type DeepFindResult, type UnconfirmedCandidate } from './find-runner.js';
import type { RefCandidate, RefSearchStep } from './refs-service.js';
import type { Visibility } from './types.js';

const TOOL_RESPONSE_CHARS = 10_000;
/**
 * 轮次安全阀（**不是预算**，2026-11-25 Q1 与预取侧统一口径）。
 *
 * 唯一预算是工具调用次数（`find.maxToolCalls`，默认 15）：调满即收口，模型不再调工具也会自然结束。
 * 这个值只用于防「模型反复空转」的死循环兜底，因此比任何真实使用量都宽。
 */
const ROUNDS_SAFETY_CAP = 30;

export interface DeepFindCoreArgs {
  event: Parameters<typeof buildFindContext>[0]['event'];
  eventType: { name: string } | null;
  members: Parameters<typeof buildFindContext>[0]['members'];
  refs: Parameters<typeof buildFindContext>[0]['refs'];
  /** 允许检索的物理库（调用方已解析并鉴权） */
  targets: string[];
  viewOf: (name: string) => string[] | null;
  /** 提示词与 skill（来自 `prompt-config.find`，与 `ki_recall` 同一份域） */
  prompt: string;
  /** 本场景要内联的 skill 正文（`refs-locate`） */
  skills: Array<{ name: string; content: string; enabled: boolean }>;
  /** 已关联 / 已参考文档的 key（`scope\0group\0name`），不进候选 */
  usedKeys: ReadonlySet<string>;
  /**
   * 工具开关（来自 `prompt-config.find.tools`）。
   * 缺省全开：调用方漏传时不能把工具面收成空（老客户端没有这个字段）。
   */
  tools?: Record<string, boolean>;
  /**
   * 单次查找允许的工具调用次数上限（来自 `prompt-config.find.maxToolCalls`）。
   *
   * 缺省按 `FIND_DEFAULT_TOOL_CALLS`（15）处理：AI 查找**没有"不限制"档**，
   * 配置缺失或调用方漏传都不能退化成无限调用。
   */
  maxToolCalls?: number;
  /**
   * 调用方授权集（2026-11-25 批 3-C，与 `ki_recall` 同口径）。
   *
   * **有该键**（含显式 `null` = 本机不限权）才允许模型在工具调用里自选 scope；
   * 不传 = 保持「只能查本次 targets」的旧行为（旧调用 / 单测不因此获得自由换库）。
   */
  tokenScopes?: string[] | null;
  /** 配置（构造 scope 解析器要读 views.json / 库清单）；缺省 `loadConfig()` */
  kiConfig?: KiConfig;
  llm: Record<string, unknown>;
  now?: () => number;
  signal?: AbortSignal;
  /** 工具调用进度（供 SSE 面板边跑边显示） */
  onProgress?: (call: { name: string; args: Record<string, unknown>; ms: number; ok: boolean; round: number }) => void;
  /** 测试注入 */
  stream?: (messages: ChatTurn[], opts?: Record<string, unknown>) => AsyncGenerator<LlmStreamPart>;
  /** 分片缓存读取（测试注入，避免依赖真实 kb 目录） */
  cachesOf?: (scope: string) => ReturnType<typeof readAllGroupCaches>;
  /** 工具执行器（测试注入，避免真检索） */
  runTool?: Parameters<typeof runGroundedRecall>[0]['runTool'];
}

function toolLabel(name: string): string {
  switch (name) {
    case 'ki_search': return '检索知识库';
    case 'ki_get_module_info': return '读取文档正文';
    case 'ki_group_list': return '查看知识树';
    case 'ki_tag_list': return '查看标签';
    default: return name;
  }
}

/*
 * 工具调用预算说明（每轮都会追加 —— 查找路径恒有上限，没有"不限制"档）。
 *
 * 2026-11-25（A 方案）：实现搬到 `recall/recall-prompt.ts` 与「AI 预取」共用，
 * 避免两条链路各写一份后漂移；本文件只保留调用点。
 */

/**
 * 模型通道主流程：**共享内核** → 三重校验 → 面板装配。
 *
 * ⚠️ 并发队列仍由 `find-runner` 负责（调用方在切过来之前先取槽），本函数只管一次调用。
 */
export async function runDeepFindCore(args: DeepFindCoreArgs): Promise<DeepFindResult> {
  const now = args.now ?? Date.now;
  const started = now();
  /*
   * 允许出现的**物理库**：targets 里的视图要展开成成员库。
   * 只比对 `targets.includes(src)` 会把视图成员的候选全判成越界（2026-11-17 真机缺陷）。
   * 视图名本身仍不可作为文档所在库（下面的 `viewOf(src) !== null` 拦掉）。
   */
  const allowed = new Set<string>();
  for (const t of args.targets) {
    allowed.add(t);
    const members = args.viewOf(t);
    if (members) for (const m of members) allowed.add(m);
  }
  /*
   * 没有"不限制"档：漏传 / 配置缺字段都按默认 15 次兜住。
   *
   * ⚠️ 必须与内核（`run-recall.ts`）用**同一套归一化**（整数 + 正数），否则会出现两类漂移：
   *   · `Infinity` → 内核判非法降级成"不限制"，而提示词写着"最多 Infinity 次"；
   *   · `2.5` → 提示词说 2.5，内核 floor 成 2，模型按 2.5 规划、实际只能跑 2 次。
   */
  const rawCalls = args.maxToolCalls;
  const maxToolCalls = typeof rawCalls === 'number' && Number.isInteger(rawCalls) && rawCalls > 0
    ? rawCalls
    : FIND_DEFAULT_TOOL_CALLS;

  /*
   * 2026-11-25：与 `ki_recall` 同口径 —— 传了 `tokenScopes`（含 null）才允许模型自选 scope。
   * 解析器与预取侧共用同一份实现（`makeScopeResolver`），避免两条链路的鉴权/视图展开漂移。
   */
  // 用 !== undefined 而不是 hasOwnProperty：（对象展开常见）
  // 不等于调用方要求开启，否则会把测试/旧调用的越界候选一并放行。
  const switchable = args.tokenScopes !== undefined;
  const config = args.kiConfig ?? loadConfig();
  const resolver = switchable
    ? makeScopeResolver({
      config,
      tokenScopes: args.tokenScopes ?? null,
      defaultTargets: args.targets,
    })
    : null;

  /*
   * S-02：页面「AI 查找」与 ki_recall 同一份规则段。
   * 页面调用没有只读 Token 语义，读后可直接触发异步 GC。
   */
  let rulesBlock = '';
  try {
    rulesBlock = buildRulesBlock(loadRulesForScopes(config, args.targets));
    maybeGcRules(config, args.targets);
  } catch {
    rulesBlock = '';
  }

  const systemPrompt = [
    args.prompt.trim(),
    ...args.skills.filter((s) => s.enabled).map((s) => `### ${s.name}\n${s.content.trim()}`),
    ...(rulesBlock ? [rulesBlock] : []),
    ...(resolver
      ? [buildScopeNote({
        defaultTargets: args.targets,
        canSwitch: true,
        ...resolver.scopeCatalog(),
      })]
      : []),
    toolCallBudgetNote(maxToolCalls),
    GROUNDED_OUTPUT_SPEC,
  ].filter(Boolean).join('\n\n');

  const grounded = await runGroundedRecall({
    systemPrompt,
    userMessage: buildFindContext({
      event: args.event,
      typeName: args.eventType?.name ?? null,
      stageKey: args.event.stageKey,
      members: args.members,
      refs: args.refs,
      targets: args.targets,
      viewOf: args.viewOf,
    }),
    exclude: [...args.usedKeys],
    limit: 20,
    tools: args.tools ?? {
      ki_search: true, ki_get_module_info: true, ki_group_list: true, ki_scope_list: true, ki_tag_list: true,
    },
    maxRounds: ROUNDS_SAFETY_CAP,
    maxToolCalls,
    llm: args.llm,
    stream: args.stream ?? ((messages, opts) => streamChat(messages, opts as never)),
    runTool: args.runTool ?? makeRecallToolRunner({
      targets: args.targets,
      // 展示名用事件查找的入参原名（可能含视图），保证 scopesUsed 与 targets 同源可比
      defaultDisplay: args.targets,
      toolChars: TOOL_RESPONSE_CHARS,
      // 只有调用方传了 tokenScopes（= 允许换库）才注入；否则保持范围锁定
      ...(resolver ? { resolveScope: resolver.resolveScope, scopeCatalog: resolver.scopeCatalog } : {}),
    }),
    now,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.onProgress ? { onToolCall: args.onProgress } : {}),
  });

  /*
   * 2026-11-25：模型可自选 scope（与 `ki_recall` 同口径）—— **实际用过的库必须一并放行**，
   * 否则下面 ① 的范围校验会把跨库读到的候选全判成「越界」剔除（表现为"换了库却什么都拿不到"）。
   */
  if (resolver) {
    for (const used of grounded.scopesUsed ?? []) {
      allowed.add(used);
      const members = args.viewOf(used);
      if (members) for (const m of members) allowed.add(m);
    }
  }

  const unconfirmed: UnconfirmedCandidate[] = [];
  const candidates: RefCandidate[] = [];
  const seen = new Set<string>();
  const caches = new Map<string, ReturnType<typeof readAllGroupCaches>>();
  const cachesOf = (s: string): ReturnType<typeof readAllGroupCaches> => {
    if (args.cachesOf) return args.cachesOf(s);
    let c = caches.get(s);
    if (!c) {
      c = readAllGroupCaches(s);
      caches.set(s, c);
    }
    return c;
  };

  for (const hit of grounded.candidates) {
    const src = hit.scope;
    // ① 范围（视图名不是库，同样算越界）
    if (!allowed.has(src) || args.viewOf(src) !== null) {
      unconfirmed.push({ group: hit.group, name: hit.name, sourceScope: src, reason: 'out-of-scope' });
      continue;
    }
    // ② 存在性
    const rel = cachesOf(src).get(hit.group)?.hot_relations.find((r) => r.text === hit.name);
    if (!rel) {
      unconfirmed.push({ group: hit.group, name: hit.name, sourceScope: src, reason: 'not-found' });
      continue;
    }
    // ③ 未已用
    const key = `${src}\u0000${hit.group}\u0000${hit.name}`;
    if (args.usedKeys.has(key) || seen.has(key)) {
      unconfirmed.push({ group: hit.group, name: hit.name, sourceScope: src, reason: 'already-used' });
      continue;
    }
    seen.add(key);

    const visibility: Visibility = resolveVisibilityOfRelation(src, rel).mode;
    candidates.push({
      origin: 'deep',
      scope: src,
      group: hit.group,
      name: hit.name,
      // 共享内核不产出检索分数（模型按正文判断，不按分数），面板按 0 展示
      score: 0,
      // 只读到片段时如实标注（面板的 why 列会原样展示）
      why: hit.evidence === 'snippet' ? `${hit.why}（仅读到片段）` : hit.why,
      matchedKeywords: [],
      chunkHits: 0,
      weak: false,
      visibility,
    });
  }

  /*
   * 过程面板的 tools step。
   *
   * 2026-11-20 两处调整：
   *   ① 条件放宽为「有调用**或有思考**」—— 模型没调工具就直接给结论时，
   *      思考也要能显示，否则内核采到了却无处安放、面板一片空白；
   *   ② 挂上 `thinking` / `thinkingChars`：共享内核此前把 reasoning 分片丢了
   *      （契约与前端一直声明该字段，实现从不产出）。
   */
  const steps: RefSearchStep[] = grounded.toolTrace.length > 0 || grounded.thinking
    ? [{
      name: 'tools' as const,
      ms: grounded.durationMs,
      metrics: {
        calls: grounded.toolTrace.length,
        ok: grounded.toolTrace.filter((t) => t.ok).length,
        rounds: grounded.rounds,
      },
      ...(grounded.thinking
        ? { thinking: grounded.thinking.text, thinkingChars: grounded.thinking.chars }
        : {}),
      calls: grounded.toolTrace.map((t) => ({
        kind: 'tool' as const,
        name: t.name,
        label: toolLabel(t.name),
        ms: t.ms,
        args: JSON.stringify(t.args).slice(0, 300),
        ...(t.ok ? {} : { note: '调用返回错误' }),
      })),
    }]
    : [];

  return {
    candidates,
    unconfirmed,
    steps,
    query: '',
    // 2026-11-25：模型可能换库，如实回显「实际用过的范围」（与 `ki_recall` 的 scopesUsed 同口径）
    scopesUsed: grounded.scopesUsed ?? [],
    durationMs: now() - started,
    // 收口原因由内核给（budget = 工具调用次数用尽 / timeout = 超时）；只有片段降级时无原因，
    // 按历史口径仍报 timeout（`usedCalls` 让面板能如实说"用满 N 次"）
    ...(grounded.partial
      ? {
        partial: {
          reason: grounded.stopReason === 'budget' ? 'budget' as const : 'timeout' as const,
          usedRounds: grounded.rounds,
          usedCalls: grounded.toolTrace.length,
        },
      }
      : {}),
    unconfirmedCount: unconfirmed.length,
    parsed: grounded.parsedOk,
    // 与 `ki_recall` 同源的结论字段：MCP 侧一直在用，面板也应当能看到同一份
    ...(grounded.summary ? { summary: grounded.summary } : {}),
    ...(grounded.dropped > 0 ? { droppedCount: grounded.dropped } : {}),
    ...(grounded.uncertainties.length > 0 ? { uncertainties: grounded.uncertainties } : {}),
    // 内核按"实际发生的检索"聚合：全部降级才 fulltext，没有检索则不声称降级
    mode: grounded.mode ?? 'hybrid',
  };
}
