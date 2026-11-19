/**
 * find-service.ts —— 「AI 查找」深度通道的服务层（REQ-20261116-005 二期 · S-03）
 *
 * 只做两件事，把「执行」与「对外形状」隔开：
 *   1. 调 `runDeepFind`（门禁 / 工具循环 / 三重校验都在它里面）；
 *   2. 把它的产物补成 `RefSearchResult` —— 库统计、`reason`、`excluded` 与快速通道同口径，
 *      前端才能用同一套渲染（`origin` 字段决定默认勾选策略，不需要两套响应）。
 *
 * 为什么库统计不放进 runner：runner 只认「候选与校验」，库统计是面板文案口径，
 * 跟快速通道共用 `countDocsByTargets` 才不会出现两种「共 N 篇」。
 */

import { loadConfig } from '../config.js';
import { GovernanceError } from '../governance-errors.js';
import { readAllGroupCaches } from '../group-cache.js';
import { readViews } from '../scope-view.js';
import { countDocsByTargets } from './find-targets.js';
import { acquireFindSlot, releaseFindSlot, type DeepFindDeps, type DeepFindResult, type UnconfirmedCandidate } from './find-runner.js';
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
 * 这里只做**装配**（事件 → 用户消息所需的一切）与**并发槽**，循环/工具/解析都在内核里。
 * 与 `find-runner.runDeepFind` 的差别：不再自带一份循环与工具执行器。
 */
async function runDeepFindSharedCore(
  scope: string,
  eventRef: string,
  deps: DeepFindDeps,
  onProgress?: (call: { name: string; args: Record<string, unknown>; ms: number; ok: boolean; round: number }) => void,
): Promise<DeepFindResult> {
  const cfg = deps.kiConfig ?? loadConfig();
  const promptCfg = readPromptConfig(cfg).config;
  const findCfg = promptCfg.find ?? defaultFindConfig();

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
  await acquireFindSlot(queueKey, deps.signal);
  try {
    return await runDeepFindCore({
      event: event as never,
      eventType: null,
      members,
      refs,
      targets: [...new Set(deps.targets)],
      viewOf,
      prompt: findCfg.prompt.content,
      skills,
      usedKeys,
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
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
  } finally {
    releaseFindSlot(queueKey);
  }
}

export async function runDeepFindAsSearchResult(
  scope: string,
  eventRef: string,
  deps: DeepFindDeps,
): Promise<DeepFindSearchResult> {
  const started = Date.now();
  const result = await runDeepFindSharedCore(scope, eventRef, deps, deps.onProgress);

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
    steps: result.steps,
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
