/**
 * find-service.ts —— 「AI 查找」深度通道的服务层（REQ-20261116-005 二期 · S-03）
 *
 * 只做两件事，把「执行」与「对外形状」隔开：
 *   1. 调 `runDeepFindCore`（共享内核）并承担门禁 / 并发槽 / 硬超时；
 *   2. 把它的产物补成 `RefSearchResult` —— 库统计、`reason`、`excluded` 与快速通道同口径，
 *      前端才能用同一套渲染（`origin` 字段决定默认勾选策略，不需要两套响应）。
 *
 * 为什么库统计不放进 runner：runner 只认「候选与校验」，库统计是面板文案口径，
 * 跟快速通道共用 `countDocsByTargets` 才不会出现两种「共 N 篇」。
 */

import { loadConfig } from '../config.js';
import { resolveLlmStatus } from '../chat/llm-client.js';
import { GovernanceError } from '../governance-errors.js';
import { readAllGroupCaches } from '../group-cache.js';
import { readViews } from '../scope-view.js';
import { countDocsByTargets } from './find-targets.js';
import {
  acquireFindSlot,
  FIND_HARD_TIMEOUT_MS,
  releaseFindSlot,
  setFindLimitsForTest,
  type DeepFindDeps,
  type DeepFindResult,
  type UnconfirmedCandidate,
} from './find-runner.js';
import { runDeepFindCore } from './deep-find-core.js';
import { defaultFindConfig, FIND_DEFAULT_TOOL_CALLS, readPromptConfig } from '../chat/prompt-config.js';
import { findEnabledSkill } from '../chat/prompt-config.js';
import { collectMembers } from './members.js';
import { readRefs } from './refs-store.js';
import { findEventIn, readAllEvents } from './store.js';
import type { RefSearchResult } from './refs-service.js';

export interface DeepFindSearchResult extends RefSearchResult {
  /** 模型给出但未通过校验的项数（契约里的 `unconfirmedCount`） */
  unconfirmedCount: number;
  /** 明细（前端折叠展示，供排障） */
  unconfirmed: UnconfirmedCandidate[];
  /** `false` = 模型输出不是可解析的候选数组（前端据此区分"模型没给出结果"与"确实没有"） */
  parsed: boolean;
}

/**
 * 共享内核版「AI 查找」（2026-11-19 合并）：与 `ki_recall` 同一个 `runGroundedRecall`。
 *
 * 这里做**装配**（事件 → 用户消息所需的一切）、**门禁**、**并发槽**与**硬超时**，
 * 循环 / 工具 / 解析都在内核里。
 *
 * 2026-11-19：旧执行器 `runDeepFind` 删除时，门禁与 45s 硬超时一并搬到这里 ——
 * 它们是对外错误码契约（`FIND_LLM_UNAVAILABLE` / `FIND_TIMEOUT` …），不能跟着旧函数消失。
 */
async function runDeepFindSharedCore(
  scope: string,
  eventRef: string,
  deps: DeepFindDeps,
  onProgress?: (call: { name: string; args: Record<string, unknown>; ms: number; ok: boolean; round: number }) => void,
): Promise<{ result: DeepFindResult; queuedMs: number }> {
  const cfg = deps.kiConfig ?? loadConfig();
  const promptCfg = readPromptConfig(cfg).config;
  const findCfg = deps.config ?? promptCfg.find ?? defaultFindConfig();

  // ── ① 门禁（与 AI 分析同源，错误码换 FIND_ 前缀）──
  const llmStatus = deps.llm?.status(cfg) ?? resolveLlmStatus(cfg, cfg._configPath ?? '');
  if (llmStatus.ackRequired) {
    throw new GovernanceError('FIND_DISCLOSURE_REQUIRED', '尚未确认知识库内容外发给上游模型，请先完成隐私确认');
  }
  if (!llmStatus.enabled) {
    throw new GovernanceError('FIND_LLM_UNAVAILABLE', llmStatus.reason ?? '未配置 LLM 模型，无法执行深度查找');
  }
  if (!llmStatus.supportsTools) {
    throw new GovernanceError('FIND_TOOLS_UNSUPPORTED', '当前模型未启用工具调用（llm.supportsTools=false），深度查找不可用；可改用快速查找');
  }
  // 工具面按配置下发（旧实现读同一份；漏传时按全开兜住，老客户端不因此变空）
  const tools = findCfg.tools ?? { ki_search: true, ki_get_module_info: true, ki_group_list: true, ki_tag_list: true };
  if (!Object.values(tools).some((on) => on === true)) {
    throw new GovernanceError(
      'FIND_TOOLS_ALL_DISABLED',
      '已关闭全部查找工具，请先在「AI 设置 → AI 查找 → 工具与权限」中至少启用一个',
    );
  }

  const event = findEventIn(readAllEvents(scope), eventRef);
  if (!event) throw new GovernanceError('EVENT_NOT_FOUND', `事件「${eventRef}」不存在`);

  const members = collectMembers(scope, event.id).map((m) => ({ group: m.group, name: m.name }));
  const refs = readRefs(scope, event.id).map((r) => ({
    group: r.group,
    name: r.name,
    sourceScope: r.sourceScope ?? r.scope,
  }));
  // 已关联 / 已参考：不进候选（与旧实现同一口径）
  const usedKeys = new Set<string>([
    ...members.map((m) => `${scope}\u0000${m.group}\u0000${m.name}`),
    ...refs.map((r) => `${r.sourceScope ?? scope}\u0000${r.group}\u0000${r.name}`),
  ]);

  let viewsLazy: Record<string, { members: string[] }> | null = null;
  const viewOf = (name: string): string[] | null => {
    if (deps.viewMembers) return deps.viewMembers(name);
    if (viewsLazy === null) {
      try {
        viewsLazy = readViews(cfg);
      } catch {
        viewsLazy = {};
      }
    }
    const v = viewsLazy[name];
    return v && Array.isArray(v.members) ? v.members : null;
  };

  // 本场景的 skill（`refs-locate`）：与 `ki_recall` 共用同一个配置域，只取自己那个
  const scenarioSkill = findEnabledSkill(promptCfg, 'builtin-refs-locate');
  const skills = scenarioSkill ? [{ name: scenarioSkill.name, content: scenarioSkill.content, enabled: true }] : [];

  const queueKey = `${scope}\u0000${eventRef}`;
  if (deps.limits) setFindLimitsForTest(deps.limits);
  const queuedMs = await acquireFindSlot(queueKey, deps.signal);

  /*
   * 硬超时（45s，不可配）：与前端断开的 signal 合成一路，靠 `timedOut` 区分终态。
   * 前者 → FIND_TIMEOUT（504）；后者 → FIND_CANCELED（499）。
   */
  const controller = new AbortController();
  let timedOut = false;
  const outerSignal = deps.signal;
  const onOuterAbort = (): void => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const hardTimeoutMs = deps.hardTimeoutMs ?? FIND_HARD_TIMEOUT_MS;
  const hardTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, hardTimeoutMs);
  hardTimer.unref?.();

  try {
    const result = await runDeepFindCore({
      event: event as never,
      eventType: null,
      members,
      refs,
      targets: [...new Set(deps.targets)],
      viewOf,
      prompt: findCfg.prompt.content,
      skills,
      usedKeys,
      tools,
      // 查找没有"不限制"档：配置缺字段按默认 15 次（内核同源再兜一次）
      maxToolCalls: findCfg.maxToolCalls ?? FIND_DEFAULT_TOOL_CALLS,
      llm: {
        baseURL: cfg.llm?.baseURL ?? '',
        apiKey: cfg.llm?.apiKey ?? '',
        model: cfg.llm?.model ?? '',
        temperature: cfg.llm?.temperature,
        maxTokens: cfg.llm?.maxTokens,
        ...(findCfg.reasoningEffort ?? cfg.llm?.reasoningEffort
          ? { reasoningEffort: findCfg.reasoningEffort ?? cfg.llm?.reasoningEffort }
          : {}),
      },
      ...(deps.llm?.stream ? { stream: deps.llm.stream as never } : {}),
      ...(deps.runTool ? { runTool: deps.runTool } : {}),
      ...(deps.nowFn ? { now: deps.nowFn } : {}),
      signal: controller.signal,
      ...(onProgress ? { onProgress } : {}),
    });

    // 超时有候选 → 保留结果并标 partial；无候选 → 不返回空成功
    if (timedOut && result.candidates.length === 0) {
      throw new GovernanceError('FIND_TIMEOUT', '深度查找超时且没有产出候选，建议缩短检索范围或改用快速查找');
    }
    if (outerSignal?.aborted && !timedOut) {
      throw new GovernanceError('FIND_CANCELED', '查找已被中止');
    }
    return { result, queuedMs };
  } finally {
    clearTimeout(hardTimer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
    releaseFindSlot(queueKey);
  }
}

export async function runDeepFindAsSearchResult(
  scope: string,
  eventRef: string,
  deps: DeepFindDeps,
): Promise<DeepFindSearchResult> {
  const started = Date.now();
  const { result, queuedMs } = await runDeepFindSharedCore(scope, eventRef, deps, deps.onProgress);

  const event = findEventIn(readAllEvents(scope), eventRef);
  if (!event) throw new GovernanceError('EVENT_NOT_FOUND', `事件「${eventRef}」不存在`);

  // 库统计：与快速通道同一函数、同一口径（视图按成员库求和）
  const cfgForViews = deps.kiConfig ?? loadConfig();
  let viewsLazy: Record<string, { members: string[] }> | null = null;
  const viewMembersOf = (name: string): string[] | null => {
    if (deps.viewMembers) return deps.viewMembers(name);
    if (viewsLazy === null) {
      try {
        viewsLazy = readViews(cfgForViews);
      } catch {
        viewsLazy = {};
      }
    }
    const v = viewsLazy[name];
    return v && Array.isArray(v.members) ? v.members : null;
  };
  const caches = new Map<string, Map<string, { hot_relations: unknown[] }>>();
  const cachesOf = (s: string): Map<string, { hot_relations: unknown[] }> => {
    let c = caches.get(s);
    if (!c) {
      c = readAllGroupCaches(s) as unknown as Map<string, { hot_relations: unknown[] }>;
      caches.set(s, c);
    }
    return c;
  };
  // 去重后再统计：重复 target 会把同一库算两遍，`total` 随之偏大（HTTP 层已去重，这里兜底）
  const { rows: totalByScope, total } = countDocsByTargets([...new Set(deps.targets)], {
    viewMembers: viewMembersOf,
    cachesOf,
  });

  // `excluded` 对外只暴露**文档名**（与快速通道同口径，前端拿它做"已排除"提示）
  const members = collectMembers(scope, event.id).map((m) => m.name);
  const added = readRefs(scope, event.id).map((r) => r.name);

  return {
    candidates: result.candidates,
    /*
     * 排队耗时挂在首个步骤上：面板据此说"排队等了 N 秒"，而不是把等待算进检索耗时。
     * 没有步骤（模型一次工具都没调）时无处可挂，直接省略。
     */
    steps: queuedMs > 0 && result.steps.length > 0
      ? result.steps.map((s, i) => (i === 0 ? { ...s, metrics: { ...s.metrics, queuedMs } } : s))
      : result.steps,
    excluded: { associated: members, added },
    total,
    totalByScope,
    targets: [...new Set(deps.targets)],
    durationMs: Date.now() - started,
    query: result.query,
    // 由 runner 按轮次聚合：全部轮次都走全文才算 fulltext（面板据此如实显示"仅全文"）
    mode: result.mode,
    // 无候选一律 next-best：模型没给出可解析结果时靠 `parsed:false` 区分，不冒充"没有相关文档"
    ...(result.candidates.length === 0 ? { reason: 'no-hits' as const } : {}),
    ...(result.partial ? { partial: result.partial } : {}),
    unconfirmedCount: result.unconfirmedCount,
    unconfirmed: result.unconfirmed,
    parsed: result.parsed,
    // 与 `ki_recall` 同源的结论字段：模型本来就要写「最该先读什么 + 为什么」，
    // 面板不该把它丢掉（2026-11-19 用户反馈）
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.droppedCount ? { droppedCount: result.droppedCount } : {}),
    ...(result.uncertainties && result.uncertainties.length > 0
      ? { uncertainties: result.uncertainties }
      : {}),
  };
}
