/**
 * 索引可见性 · 唯一出口（REQ-20261113-004 · S-03）
 *
 * 为什么必须只有这一个出口：
 *   四类索引（dense / FTS / ki-relation / ki-path）× 三档可见性 × 调用方（删除链路、
 *   事件流转、rebuild-vector、编辑发布、覆盖写）＝ 组合爆炸。历史上已两次出现
 *   「摘了向量没摘 FTS」/「摘了 path 没摘 relation」的残留，都是因为各处自己拼调用。
 *
 * 两条硬约束：
 *   1. **摘除同步、写入异步**：用户点完流转要立刻搜不到（语义正确优先于响应速度）；
 *      embed 秒级/篇，只入 pending 队列，返回值带 `pending` 让 UI 显示"索引重建中"。
 *   2. **`ki-path` 是组级**：docId 只由 group 路径决定，一组一条。按文档摘会误伤
 *      同组其他可见文档 ⇒ 只有「组内全部文档都 hidden」时才摘。
 *
 * 另一条容易漏的：`ki-relation` 的 docId 只由 `relation 名 + scope + tag` 决定（跨组共享）。
 * 摘前必须确认同名文档没活在别的组，否则会连带摘掉兄弟组的关系向量。
 */

import path from 'path';
import { getKbDir } from './scope.js';
import { readJson, writeJson } from './store.js';
import { readAllGroupCaches } from './group-cache.js';
import { ftsDeleteByIds } from './fts-client.js';
import { vectorDelete } from './vector-client.js';
import { deletePathVector, buildRelationContent, buildGroupPathContent } from './path-vectorize.js';
import { readAllEvents, readEventTypes } from './events/store.js';
import type { Relation } from './scoring.js';
import type { Visibility } from './events/types.js';

export type IndexKind = 'dense' | 'fts' | 'relation' | 'path';

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`NOT_IMPLEMENTED: ${feature}`);
    this.name = 'NotImplementedError';
  }
}

/** `resolveVisibility` 的最小输入（避免依赖 `Relation` 的完整形状） */
export interface VisibilitySubject {
  lifecycle?: string;
  expiresAt?: number;
  eventId?: string;
}

export interface ResolveVisibilityInput {
  relation: VisibilitySubject;
  /** 仅 event 文档需要：按 eventId 查事件与类型（回调注入，避免循环依赖） */
  lookupEvent?: (eventId: string) => { stageKey: string; typeId: string } | null;
  lookupType?: (typeId: string) => { stages: Array<{ key: string; visibility: Visibility }> } | null;
}

export interface ResolvedVisibility {
  mode: Visibility;
  source: 'lifecycle' | 'event-stage' | 'fallback';
  /** 事件/类型缺失时的可读原因（N13：按 wiki 处理但要报诊断） */
  warning?: string;
}

export interface ApplyArgs {
  scope: string;
  group: string;
  relation: string;
  to: Visibility;
  /** 已知的旧档位（流转场景）；缺省时按当前阶段现算 */
  from?: Visibility;
  /** 追加的 pending 目标（默认按矩阵推导） */
  now?: number;
}

export interface ApplySkipped {
  kind: IndexKind;
  reason: string;
}

export interface ApplyResult {
  relation: string;
  from: Visibility;
  to: Visibility;
  removed: IndexKind[];
  written: IndexKind[];
  pending: IndexKind[];
  skipped: ApplySkipped[];
  failed: IndexKind[];
}

export interface RebuildArgs {
  scope: string;
  filter?: { group?: string; relations?: string[] };
}

export interface RebuildResult {
  applied: number;
  skipped: number;
}

/** 待补索引条目（落 `{scope}/.visibility-pending.json`，daemon 重启不丢） */
export interface PendingIndexWrite {
  relation: string;
  group: string;
  target: Visibility;
  kinds: IndexKind[];
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface PendingFile {
  version: 1;
  items: PendingIndexWrite[];
}

export interface VisibilityFailure {
  relation: string;
  group: string;
  kind: IndexKind;
  code: string;
  message: string;
  attempts: number;
  at: number;
}

export interface FailureFile {
  version: 1;
  items: VisibilityFailure[];
}

export function pendingFilePath(scope: string): string {
  return path.join(getKbDir(scope), '.visibility-pending.json');
}

export function failureFilePath(scope: string): string {
  return path.join(getKbDir(scope), '.visibility-failures.json');
}

/** 判定文档应处的档位（纯查询，不碰索引） */
export function resolveVisibility(input: ResolveVisibilityInput): ResolvedVisibility {
  const { relation } = input;
  if (relation.lifecycle !== 'event') return { mode: 'full', source: 'lifecycle' };

  const eventId = relation.eventId;
  if (!eventId) {
    return { mode: 'full', source: 'fallback', warning: '文档标记为 event 但没有 eventId，按 wiki 处理' };
  }
  const event = input.lookupEvent?.(eventId);
  if (!event) {
    return { mode: 'full', source: 'fallback', warning: `事件 ${eventId} 不存在（悬空引用），按 wiki 处理` };
  }
  const type = input.lookupType?.(event.typeId);
  if (!type) {
    return { mode: 'full', source: 'fallback', warning: `事件类型 ${event.typeId} 不存在，按 wiki 处理` };
  }
  const stage = type.stages.find((s) => s.key === event.stageKey);
  if (!stage) {
    return { mode: 'full', source: 'fallback', warning: `阶段 ${event.stageKey} 不在类型中（悬空引用），按 wiki 处理` };
  }
  return { mode: stage.visibility, source: 'event-stage' };
}

// ─────────────────────────────────────────────────────────────
// 摘除 / 写入矩阵
// ─────────────────────────────────────────────────────────────

/** 3×3 矩阵：返回需要同步摘除与异步写入的类别 */
export function planTransition(from: Visibility, to: Visibility): { remove: IndexKind[]; write: IndexKind[] } {
  if (from === to) return { remove: [], write: [] };
  if (to === 'hidden') {
    return {
      // 从 full 下来要先摘 dense；从 fts-only 下来本就没有 dense
      remove: [...(from === 'full' ? (['dense'] as IndexKind[]) : []), 'fts', 'relation'],
      write: [],
    };
  }
  if (to === 'fts-only') {
    return {
      remove: from === 'full' ? ['dense'] : [],
      write: from === 'hidden' ? ['fts', 'relation'] : [],
    };
  }
  // to === 'full'
  if (from === 'hidden') return { remove: [], write: ['dense', 'fts', 'relation'] };
  return { remove: [], write: ['dense'] };
}

function findRelation(scope: string, group: string, relation: string): Relation | null {
  for (const [g, doc] of readAllGroupCaches(scope)) {
    if (g !== group) continue;
    return doc.hot_relations.find((r) => r.text === relation) ?? null;
  }
  return null;
}

/** 同 scope 内是否还有别的组持有同名文档（`ki-relation` docId 跨组共享） */
function hasOtherHolders(scope: string, group: string, relation: string): boolean {
  for (const [g, doc] of readAllGroupCaches(scope)) {
    if (g === group) continue;
    if (doc.hot_relations.some((r) => r.text === relation)) return true;
  }
  return false;
}

interface Lookups {
  events: Map<string, { stageKey: string; typeId: string }>;
  types: Map<string, { stages: Array<{ key: string; visibility: Visibility }> }>;
}

/** 一次性读事件与类型，供档位解析复用（避免每篇文档各读一遍盘） */
function buildLookups(scope: string): Lookups {
  return {
    events: new Map(readAllEvents(scope).map((e) => [e.id, { stageKey: e.stageKey, typeId: e.typeId }])),
    types: new Map(readEventTypes(scope).map((t) => [t.id, { stages: t.stages.map((s) => ({ key: s.key, visibility: s.visibility })) }])),
  };
}

/** 组内是否还有非 hidden 文档（决定 `ki-path` 能否摘） */
function groupHasVisibleDocs(scope: string, group: string, lookups: Lookups): boolean {
  for (const [g, doc] of readAllGroupCaches(scope)) {
    if (g !== group) continue;
    for (const rel of doc.hot_relations) {
      const resolved = resolveVisibility({
        relation: rel,
        lookupEvent: (id) => lookups.events.get(id) ?? null,
        lookupType: (id) => lookups.types.get(id) ?? null,
      });
      if (resolved.mode !== 'hidden') return true;
    }
  }
  return false;
}

function loadPending(scope: string): PendingFile {
  try {
    const raw = readJson<PendingFile>(pendingFilePath(scope));
    if (raw && Array.isArray(raw.items)) return raw;
  } catch (err) {
    console.warn(`[visibility] pending 文件损坏，按空处理：${(err as Error).message}`);
  }
  return { version: 1, items: [] };
}

function savePending(scope: string, file: PendingFile): void {
  writeJson(pendingFilePath(scope), file as unknown as Record<string, unknown>);
}

function enqueuePending(scope: string, group: string, relation: string, target: Visibility, kinds: IndexKind[], now: number): void {
  const file = loadPending(scope);
  const idx = file.items.findIndex((i) => i.relation === relation && i.group === group);
  const entry: PendingIndexWrite = { relation, group, target, kinds, createdAt: now, attempts: 0 };
  if (idx >= 0) file.items[idx] = entry;
  else file.items.push(entry);
  savePending(scope, file);
}

function recordFailure(scope: string, failure: VisibilityFailure): void {
  try {
    const raw = readJson<FailureFile>(failureFilePath(scope));
    const file: FailureFile = raw && Array.isArray(raw.items) ? raw : { version: 1, items: [] };
    file.items.push(failure);
    writeJson(failureFilePath(scope), file as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn(`[visibility] 写诊断文件失败：${(err as Error).message}`);
  }
}

/**
 * 单文档档位切换。调用方必须已持 scope 写锁（本函数不自己加锁）。
 *
 * 失败语义：**摘除失败也把档位标记为 `to`** —— 宁可"声明已隐藏但索引残留"被诊断发现，
 * 也不要"声明未隐藏但索引已摘"导致语义检索直接搜不到。残留会进诊断文件，可重试。
 */
export async function applyVisibility(args: ApplyArgs): Promise<ApplyResult> {
  const now = args.now ?? Date.now();
  const rel = findRelation(args.scope, args.group, args.relation);
  const lookups = buildLookups(args.scope);
  // 旧档位：调用方（流转）通常知道；不知道时按当前阶段现算，而不是默认 full
  const from = args.from ?? resolveVisibility({
    relation: rel ?? {},
    lookupEvent: (id) => lookups.events.get(id) ?? null,
    lookupType: (id) => lookups.types.get(id) ?? null,
  }).mode;
  const plan = planTransition(from, args.to);

  const removed: IndexKind[] = [];
  const failed: IndexKind[] = [];
  const skipped: ApplySkipped[] = [];

  for (const kind of plan.remove) {
    if (kind === 'dense') {
      const ids = rel?.memoryIds?.length ? rel.memoryIds : rel?.memoryId ? [rel.memoryId] : [];
      if (ids.length === 0) {
        skipped.push({ kind, reason: 'no-dense-ids' });
        continue;
      }
      try {
        const res = await vectorDelete({ scope: args.scope, ids });
        if (res.errors.length > 0) throw new Error(res.errors[0].reason);
        removed.push(kind);
      } catch (err) {
        failed.push(kind);
        recordFailure(args.scope, {
          relation: args.relation, group: args.group, kind, code: 'DENSE_DELETE_FAILED',
          message: (err as Error).message, attempts: 1, at: now,
        });
      }
      continue;
    }

    if (kind === 'fts') {
      const ids = rel?.ftsIds ?? [];
      if (ids.length === 0) {
        skipped.push({ kind, reason: 'no-fts-ids' });
        continue;
      }
      try {
        const res = await ftsDeleteByIds({ scope: args.scope, ids });
        if (res.failed > 0) throw new Error(`${res.failed} 条未删成功`);
        removed.push(kind);
      } catch (err) {
        failed.push(kind);
        recordFailure(args.scope, {
          relation: args.relation, group: args.group, kind, code: 'FTS_DELETE_FAILED',
          message: (err as Error).message, attempts: 1, at: now,
        });
      }
      continue;
    }

    if (kind === 'relation') {
      if (hasOtherHolders(args.scope, args.group, args.relation)) {
        skipped.push({ kind, reason: 'other-holders' });
        continue;
      }
      const res = await deletePathVector(buildRelationContent(args.relation, args.group), 'ki-relation', args.scope);
      if (res.ok) removed.push(kind);
      else {
        failed.push(kind);
        recordFailure(args.scope, {
          relation: args.relation, group: args.group, kind, code: 'RELATION_VECTOR_DELETE_FAILED',
          message: res.error ?? 'unknown', attempts: 1, at: now,
        });
      }
      continue;
    }

  }

  /**
   * `ki-path` 是**组级**索引，不属于文档矩阵（`planTransition` 也不会返回它）：
   * 单独在循环外判定。放在循环里会永远不执行 —— 这行曾经是一段死代码。
   */
  if (args.to === 'hidden') {
    if (groupHasVisibleDocs(args.scope, args.group, lookups)) {
      skipped.push({ kind: 'path', reason: 'group-has-visible-docs' });
    } else {
      const res = await deletePathVector(buildGroupPathContent(args.group), 'ki-path', args.scope);
      if (res.ok) removed.push('path');
      else failed.push('path');
    }
  }

  if (plan.write.length > 0) {
    enqueuePending(args.scope, args.group, args.relation, args.to, plan.write, now);
  }

  return {
    relation: args.relation,
    from,
    to: args.to,
    removed,
    written: [],
    // `pending` 只报真正入队的写入类别
    pending: plan.write,
    skipped,
    failed,
  };
}

/**
 * 便捷入口：按 scope 现读事件/类型，算出某文档当前应处的档位。
 *
 * 供写入路径调用（`ki_sync_relation` 覆盖写、编辑发布）—— 它们必须知道
 * 「这份文档现在能不能被检索」，否则一次编辑就把 hidden 文档重新索引回可检索。
 */
export function resolveVisibilityOfRelation(scope: string, rel: Relation | undefined): ResolvedVisibility {
  if (!rel || rel.lifecycle !== 'event') return { mode: 'full', source: 'lifecycle' };
  const lookups = buildLookups(scope);
  return resolveVisibility({
    relation: rel,
    lookupEvent: (id) => lookups.events.get(id) ?? null,
    lookupType: (id) => lookups.types.get(id) ?? null,
  });
}

/**
 * 当前 scope 下所有 `hidden` 文档的 `{group}\u0000{relation}` 集合。
 *
 * 用途：`rebuild-vector` 重建前过滤 —— 手动重建最容易把 hidden 文档整套重建回可检索，
 * 而重建结果看起来完全正常（"重建成功 N 篇"），没人会发现语义被推翻。
 */
export function collectHiddenRelations(scope: string): Set<string> {
  const lookups = buildLookups(scope);
  const out = new Set<string>();
  for (const [group, doc] of readAllGroupCaches(scope)) {
    for (const rel of doc.hot_relations) {
      const resolved = resolveVisibility({
        relation: rel,
        lookupEvent: (id) => lookups.events.get(id) ?? null,
        lookupType: (id) => lookups.types.get(id) ?? null,
      });
      if (resolved.mode === 'hidden') out.add(`${group}\u0000${rel.text}`);
    }
  }
  return out;
}

/**
 * 按当前档位重建（rebuild-vector / restore 用）。
 *
 * 只处理「事件文档」：wiki 文档本来就该 full，重建时不需要额外动作。
 * `hidden` 的跳过并计数，交给调用方在重建结果里说明"跳过了 N 篇不可见文档"。
 */
export async function rebuildVisibility(args: RebuildArgs): Promise<RebuildResult> {
  let applied = 0;
  let skipped = 0;
  const lookups = buildLookups(args.scope);
  for (const [group, doc] of readAllGroupCaches(args.scope)) {
    if (args.filter?.group && args.filter.group !== group) continue;
    for (const rel of doc.hot_relations) {
      if (args.filter?.relations && !args.filter.relations.includes(rel.text)) continue;
      if (rel.lifecycle !== 'event') continue;
      const resolved = resolveVisibility({
        relation: rel,
        lookupEvent: (id) => lookups.events.get(id) ?? null,
        lookupType: (id) => lookups.types.get(id) ?? null,
      });
      if (resolved.mode === 'full') {
        applied += 1;
        continue;
      }
      await applyVisibility({ scope: args.scope, group, relation: rel.text, to: resolved.mode });
      if (resolved.mode === 'hidden') skipped += 1;
      else applied += 1;
    }
  }
  return { applied, skipped };
}
