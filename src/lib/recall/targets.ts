/**
 * recall/targets.ts —— `ki_recall` 的范围解析（S-01 §3.1）。
 *
 * **范围只有一个来源：调用方显式传入的 `scope`。** 服务端不设默认库、不回退 `default` 库、
 * 也不隐式扩成「该 Token 的全部授权库」—— 否则「这次查了哪个库」就无法从入参复盘，
 * 出问题时连是"传错"还是"默认选错"都分不清（2026-11-18 拍板）。
 *
 * 判定逻辑不在这里重写：直接复用 `events/find-targets.ts::resolveScopeSet` 的
 * 「视图全有或全无 → 权限 → 缺失」三段判定（那个文件是范围的唯一判定真源）。
 * 本文件的职责只有三件：入参归一化、把请求项全部当 `extras` 走判定、按预算截断。
 */

import { resolveScopeSet, type FindTargetDeps } from '../events/find-targets.js';
import { ALL_SCOPES } from '../mcp-token.js';
import { loadConfig, type KiConfig } from '../config.js';
import { readViews } from '../scope-view.js';
import { RecallKernelError } from './codes.js';
import { MAX_PHYSICAL, MAX_SCOPE_INPUT, MAX_TARGETS, type RecallSkipped } from './types.js';

export interface ResolveRecallTargetsArgs {
  /** 调用方传入的 scope（工具层已把 string|string[] 归一化为数组） */
  requested: string[];
  /** 授权名字全集；`null` = 本机不限权（stdio / 回环） */
  tokenScopes: string[] | null;
  maxTargets?: number;
  /** 测试注入：绕开真实 views.json / 授权表 */
  deps?: Omit<FindTargetDeps, 'tokenScopes'>;
  /** 测试注入：视图名 → 成员；缺省读 views.json */
  viewMembers?: (name: string) => string[] | null;
}

export interface ResolveRecallTargetsResult {
  /** 已去重、已鉴权、已按 maxTargets 截断（顺序 = 入参顺序）。**可能是视图名**，只用于回显 */
  targets: string[];
  /**
   * 真正做检索与可见性判定的库（视图已展开为成员库，去重，≤ MAX_PHYSICAL）。
   *
   * ⚠️ 为什么不能直接拿 `targets` 去检索：视图不是物理库 —— `cachesOf(视图)` 恒为空，
   * 会让每一篇命中都被判成「索引里已不存在」而全部丢弃（2026-11-18 实现期发现）。
   */
  physicalTargets: string[];
  /** 被剔除的项（含 `truncated`） */
  skipped: RecallSkipped[];
  /** 调用方**显式传入**却不存在/无权的项 —— 工具层据此直接报错（人点名必须报错） */
  forbiddenRequested: RecallSkipped[];
  truncated: boolean;
}

/** 视图名 → 成员；`null` = 不是视图。读失败按「不是视图」处理会让越权成员展开通过，故失败时返回空数组 */
function makeViewLookup(args: ResolveRecallTargetsArgs): (name: string) => string[] | null {
  if (args.viewMembers) return args.viewMembers;
  let views: Record<string, { members: string[] }> | null = null;
  return (name: string): string[] | null => {
    if (views === null) {
      try {
        views = args.deps?.listViews?.() ?? readViews(args.deps?.config ?? loadConfig() as KiConfig);
      } catch {
        views = {};
      }
    }
    const hit = views[name];
    return hit && Array.isArray(hit.members) ? hit.members : null;
  };
}

export function resolveRecallTargets(args: ResolveRecallTargetsArgs): ResolveRecallTargetsResult {
  const maxTargets = args.maxTargets ?? MAX_TARGETS;

  const requested: string[] = [];
  const seen = new Set<string>();
  for (const raw of args.requested.slice(0, MAX_SCOPE_INPUT)) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    requested.push(name);
  }

  if (requested.length === 0) {
    throw new RecallKernelError(
      'SCOPE_REQUIRED',
      'ki_recall 需要显式 scope（库名或视图名），且不能是空字符串',
    );
  }

  /*
   * 本机（无 Token）视为不限权：`isScopeAccessAllowed` 对 ALL_SCOPES 恒真，
   * 这样授权判定只需一条分支，不必在 recall 里再写一份「本机特例」。
   */
  const tokenScopes = args.tokenScopes ?? [ALL_SCOPES];

  // 全部当 extras 走判定：bases 留空 —— recall 没有"天然可信的基线库"
  const resolved = resolveScopeSet([], requested, { ...args.deps, tokenScopes });

  // 先取"点名却不可用"的项，再往里追加截断项，避免把 truncated 误当越权去报错
  const forbiddenRequested: RecallSkipped[] = resolved.skipped.map((s) => ({ ...s }));
  const skipped: RecallSkipped[] = resolved.skipped.map((s) => ({ ...s }));

  const targets = resolved.targets.slice(0, maxTargets);
  let truncated = resolved.targets.length > targets.length;
  if (truncated) {
    for (const name of resolved.targets.slice(maxTargets)) {
      skipped.push({ name, reason: 'truncated' });
    }
  }

  // 视图 → 成员库：检索与可见性判定都发生在物理库上
  const viewMembersOf = makeViewLookup(args);
  const physicalTargets: string[] = [];
  const seenPhysical = new Set<string>();
  for (const target of targets) {
    const members = viewMembersOf(target);
    const list = members && members.length > 0 ? members : [target];
    for (const physical of list) {
      if (seenPhysical.has(physical)) continue;
      seenPhysical.add(physical);
      physicalTargets.push(physical);
    }
  }
  if (physicalTargets.length > MAX_PHYSICAL) {
    physicalTargets.length = MAX_PHYSICAL;
    truncated = true;
  }

  return { targets, physicalTargets, skipped, forbiddenRequested, truncated };
}
