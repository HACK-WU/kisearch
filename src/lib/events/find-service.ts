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
import { runDeepFind, type DeepFindDeps, type UnconfirmedCandidate } from './find-runner.js';
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

export async function runDeepFindAsSearchResult(
  scope: string,
  eventRef: string,
  deps: DeepFindDeps,
): Promise<DeepFindSearchResult> {
  const started = Date.now();
  const result = await runDeepFind(scope, eventRef, deps);

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
  };
}
