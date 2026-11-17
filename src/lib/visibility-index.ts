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
import { getKbDir, getLocalKbDir } from './scope.js';
import { readJson, writeJson } from './store.js';
import { readAllGroupCaches, loadGroupCache, writeGroupCache } from './group-cache.js';
import { ftsDeleteByIds } from './fts-client.js';
import { vectorDelete, vectorSearch, ensureVectorAvailable } from './vector-client.js';
import { deletePathVector, buildGroupPathContent } from './path-vectorize.js';
import { removeRelationPathVectors } from './relation-path-vector.js';
import {
  recomputeContentVectorIds,
  pickContentVectorHits,
  contentVectorTags,
  extractKbBody,
  CONTENT_FALLBACK_SEARCH_LIMIT,
} from './content-vector-match.js';
import { readAllEvents } from './events/store.js';
import { listTypes } from './events/type-service.js';
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
  /** 与 `failed` 一一对应的错误原因（批量调用方需要向用户/AI 透出具体失败） */
  failedDetails?: Array<{ kind: IndexKind; error: string }>;
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
  /**
   * `hidden → full` 必须补 `path`：`to==='hidden'` 时组级 `ki-path` 会被摘除（见下方
   * `groupHasVisibleDocs` 判定），而此前 `write` 不含 path ⇒ 组里唯一的事件文档解绑 /
   * 恢复 / 重建后，该组路径向量永久缺失，按组路径的语义检索再也搜不到（且页面无感）。
   * `fts-only → full` 不需要：path 只在 hidden 时被摘，fts-only 期间仍在。
   */
  if (from === 'hidden') return { remove: [], write: ['dense', 'fts', 'relation', 'path'] };
  return { remove: [], write: ['dense'] };
}

/** 一次性读到的全部分片（批量档位切换复用，避免逐条全量扫盘） */
type GroupCaches = ReturnType<typeof readAllGroupCaches>;

function findRelationIn(caches: GroupCaches, group: string, relation: string): Relation | null {
  const doc = caches.get(group);
  return doc?.hot_relations.find((r) => r.text === relation) ?? null;
}

/** 同 scope 内是否还有别的组持有同名文档（`ki-relation` docId 跨组共享） */
function hasOtherHoldersIn(caches: GroupCaches, group: string, relation: string): boolean {
  for (const [g, doc] of caches) {
    if (g === group) continue;
    if (doc.hot_relations.some((r) => r.text === relation)) return true;
  }
  return false;
}

interface Lookups {
  events: Map<string, { stageKey: string; typeId: string }>;
  types: Map<string, { stages: Array<{ key: string; visibility: Visibility }> }>;
}

/**
 * 一次性读事件与类型，供档位解析复用（避免每篇文档各读一遍盘）。
 *
 * ⚠️ 类型必须走 `listTypes` 而不是 `readEventTypes`：后者只读 `_types.json`，
 * 文件尚未落盘时返回空数组 —— 用内置类型（et_1/et_2/et_3）的新 scope 会因此把
 * 事件文档一律当 `full`，`hidden` 阶段形同虚设（解绑还因 `from===to` 短路而不补索引）。
 */
function buildLookups(scope: string): Lookups {
  return {
    events: new Map(readAllEvents(scope).map((e) => [e.id, { stageKey: e.stageKey, typeId: e.typeId }])),
    types: new Map(listTypes(scope).map((t) => [t.id, { stages: t.stages.map((s) => ({ key: s.key, visibility: s.visibility })) }])),
  };
}

/** 组内是否还有非 hidden 文档（决定 `ki-path` 能否摘） */
function groupHasVisibleDocsIn(caches: GroupCaches, group: string, lookups: Lookups): boolean {
  const doc = caches.get(group);
  if (!doc) return false;
  for (const rel of doc.hot_relations) {
    const resolved = resolveVisibility({
      relation: rel,
      lookupEvent: (id) => lookups.events.get(id) ?? null,
      lookupType: (id) => lookups.types.get(id) ?? null,
    });
    if (resolved.mode !== 'hidden') return true;
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
 * 内容向量摘除的检索补救：按「正文比对」挑出本篇的内容向量并删除。
 *
 * 只在 `vectorDelete` 没能覆盖全部 ids 时调用（异常路径），代价是**一次 embedding 查询**。
 * 为什么不能省：hidden 是「语义上不可被检索」的隔离承诺，而它靠摘索引单点实现 ——
 * 少摘一条就是一次静默数据泄漏，读侧没有任何兜底能发现。
 */
async function deleteContentVectorsBySearch(
  scope: string,
  relation: string,
  body: string | null,
  opts: { tags?: string[]; siblingBodies?: string[] } = {},
): Promise<{ deleted: number; matched: number; error?: string }> {
  const hits = await vectorSearch({
    scope,
    query: relation,
    // tag 白名单：历史记录缺 tag 字段时，ki-relation（content 即 relation 名）会被标题判据
    // 整体命中 ⇒ 删掉跨组共享的关系向量，绕过 hasOtherHolders 保护
    tags: contentVectorTags(opts.tags),
    limit: CONTENT_FALLBACK_SEARCH_LIMIT,
  });
  const { hits: matched } = pickContentVectorHits(hits, {
    relation,
    body,
    siblingBodies: opts.siblingBodies,
  });
  if (matched.length === 0) return { deleted: 0, matched: 0 };
  const res = await vectorDelete({ scope, ids: matched.map((hit) => hit.memoryId) });
  if (res.errors.length > 0) return { deleted: res.deleted, matched: matched.length, error: res.errors[0].reason };
  if (res.deleted < matched.length) {
    // 「命中 N 条只删掉 M 条（含 0）」= 隔离承诺没兑现，必须落 failed，不能只记 removed。
    return {
      deleted: res.deleted,
      matched: matched.length,
      error: `检索命中 ${matched.length} 条本篇内容向量，仅删除 ${res.deleted} 条`,
    };
  }
  return { deleted: res.deleted, matched: matched.length };
}


/**
 * 摘除成功后清掉 cache 里过期的内容向量 id。
 *
 * 为什么必做（而不是"反正删除侧能重算"）：`memoryIds` 是 cache 对外的「已向量化」声明，
 * 摘除后它们指向的是**已被删除的 docId**。不清掉的后果不止删除侧 0 命中——
 * `group-delete`（按 memoryIds 收集要删的向量）、`rebuild-vector`、`fts-rebuild`
 * 都照这批死 id 干活，而且 cache 长期谎报"这篇有 dense 索引"。
 * hidden → full 补写时 `vectorWriteBack` 会把新 id 写回，不会永久丢记录。
 */
function clearDenseIdsInCache(scope: string, group: string, relation: string): void {
  try {
    const doc = loadGroupCache(scope, group);
    const rel = doc?.hot_relations.find((item) => item.text === relation);
    if (!doc || !rel) return;
    if (!rel.memoryIds?.length && !rel.memoryId) return;
    delete rel.memoryIds;
    delete rel.memoryId;
    writeGroupCache(scope, group, doc);
  } catch (err) {
    // 清不掉只是 cache 不准确（下次删除仍能靠正文重算兜住），不能因此判摘除失败
    console.warn(`[visibility] 清理过期内容向量 id 失败（${group}/${relation}）：${(err as Error).message}`);
  }
}

/**
 * 单文档档位切换。调用方必须已持 scope 写锁（本函数不自己加锁）。
 *
 * 失败语义：**摘除失败也把档位标记为 `to`** —— 宁可"声明已隐藏但索引残留"被诊断发现，
 * 也不要"声明未隐藏但索引已摘"导致语义检索直接搜不到。残留会进诊断文件，可重试。
 */
export interface ApplyContext {
  /** 一次读到的全部分片（批量时复用，避免逐条全量扫盘） */
  caches: GroupCaches;
  lookups: Lookups;
  /** 批量调用方探测一次后注入，避免逐条 probe 向量引擎 */
  vectorAvailable?: boolean;
}

export async function applyVisibility(args: ApplyArgs): Promise<ApplyResult> {
  return applyVisibilityCore(args, {
    caches: readAllGroupCaches(args.scope),
    lookups: buildLookups(args.scope),
  });
}

async function applyVisibilityCore(args: ApplyArgs, ctx: ApplyContext): Promise<ApplyResult> {
  const now = args.now ?? Date.now();
  const rel = findRelationIn(ctx.caches, args.group, args.relation);
  const lookups = ctx.lookups;
  // 旧档位：调用方（流转）通常知道；不知道时按当前阶段现算，而不是默认 full
  const from = args.from ?? resolveVisibility({
    relation: rel ?? {},
    lookupEvent: (id) => lookups.events.get(id) ?? null,
    lookupType: (id) => lookups.types.get(id) ?? null,
  }).mode;
  const plan = planTransition(from, args.to);

  const removed: IndexKind[] = [];
  const failed: IndexKind[] = [];
  const failedDetails: Array<{ kind: IndexKind; error: string }> = [];
  const skipped: ApplySkipped[] = [];

  /**
   * `ki-relation` / `ki-path` 的摘除要先 `vectorSearch`（**需要 embedding**）。
   * 向量不可用时那次调用会长时间等超时，绑定/解绑接口会跟着卡住 ——
   * 这里先 fastFail 探一次：不可用就记 skipped，交给 pending/诊断，不阻塞主流程。
   */
  let vectorUsable = ctx.vectorAvailable;
  const ensureVector = async (): Promise<boolean> => {
    if (vectorUsable !== undefined) return vectorUsable;
    const res = await ensureVectorAvailable(args.scope, { fastFail: true }).catch(() => ({ available: false }));
    vectorUsable = res.available;
    return vectorUsable;
  };

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
        let deleted = res.deleted;
        /**
         * ★ 必须核对「库里是否真的没有这篇的内容向量」，不能只看 errors：
         * `vectorDelete` 对不存在的 docId 不报错，`deleted === 0` 时过去照样记成功 ——
         * 实测后果是「声明 hidden，但 ki_search 仍能召回该文档」
         * （`.debug/delete-vector-residual-20261116` E-04）。
         * cache 的 ids 一旦过期（补写失败 / tag 变更 / 写入形态切换），
         * 库里可能还挂着同内容的另一个 docId，只有「正文重算」与「检索比对」能挖出来。
         */
        let denseUnverified = false;
        if (deleted < ids.length) {
          // 一次读同组 KB：本篇正文（重算 docId）+ 兄弟文档正文（排除公共段落误判）
          const groupKb = (() => {
            try {
              return readJson<Record<string, unknown>>(getLocalKbDir(args.scope, args.group)) ?? {};
            } catch {
              return {} as Record<string, unknown>;
            }
          })();
          const body = extractKbBody(groupKb[args.relation]);
          if (body) {
            const extra = recomputeContentVectorIds(args.scope, body, rel?.tags).filter((id) => !ids.includes(id));
            if (extra.length > 0) {
              const res2 = await vectorDelete({ scope: args.scope, ids: extra });
              if (res2.errors.length > 0) throw new Error(res2.errors[0].reason);
              deleted += res2.deleted;
            }
          }
          // 「一条都没删到」才是 cache 全过期的实锤（实测泄漏场景）→ 检索比对补齐。
          // 部分命中时不做：那说明向量确实存在且已删掉一部分，剩余多是不存在的陈旧 id，
          // 为它付一次 embedding 会让每次阶段流转都变慢。
          if (deleted === 0) {
            // 检索需要 embedding：向量不可用时先 fastFail，别把绑定/解绑接口拖到超时
            // （与上方 relation / path 摘除同一口径）。
            if (!(await ensureVector())) {
              denseUnverified = true;
            } else {
              const siblingBodies = Object.entries(groupKb)
                .filter(([key]) => key !== args.relation)
                .map(([, raw]) => extractKbBody(raw))
                .filter((item): item is string => Boolean(item));
              const fallback = await deleteContentVectorsBySearch(args.scope, args.relation, body, {
                tags: rel?.tags,
                siblingBodies,
              });
              if (fallback.error) throw new Error(fallback.error);
              deleted += fallback.deleted;
            }
          }
        }
        if (denseUnverified) skipped.push({ kind, reason: 'vector-unavailable' });
        else {
          clearDenseIdsInCache(args.scope, args.group, args.relation);
          removed.push(kind);
        }
      } catch (err) {
        failed.push(kind);
        failedDetails.push({ kind, error: (err as Error).message });
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
        failedDetails.push({ kind, error: (err as Error).message });
        recordFailure(args.scope, {
          relation: args.relation, group: args.group, kind, code: 'FTS_DELETE_FAILED',
          message: (err as Error).message, attempts: 1, at: now,
        });
      }
      continue;
    }

    if (kind === 'relation') {
      if (hasOtherHoldersIn(ctx.caches, args.group, args.relation)) {
        skipped.push({ kind, reason: 'other-holders' });
        continue;
      }
      if (!(await ensureVector())) {
        skipped.push({ kind, reason: 'vector-unavailable' });
        continue;
      }
      // 与 delete-relation 同源（relation-path-vector）：单条 + 分块 `relation-NN` + 历史形态。
      // 过去这里只走 deletePathVector（按纯名检索），分块导入的文档 hidden 后 `relation-01`
      // 摘不掉 ⇒ 按关系名仍可被召回。
      const groupDoc = ctx.caches.get(args.group);
      const relVec = await removeRelationPathVectors({
        scope: args.scope,
        relation: args.relation,
        group: args.group,
        contentVectorCount: Math.max(0, (rel?.memoryIds?.length ?? 0) - (rel?.tags?.length ?? 0)),
        siblingNames: new Set((groupDoc?.hot_relations ?? [])
          .map((item) => item.text)
          .filter((name) => name !== args.relation)),
      });
      // `missing` = 三种形态都查过且库里没有（上一轮已摘 / 本来就没写）⇒ 视为已清理
      if (relVec.removed || relVec.missing) removed.push(kind);
      else {
        const error = relVec.reason ?? 'unknown';
        failed.push(kind);
        failedDetails.push({ kind, error });
        recordFailure(args.scope, {
          relation: args.relation, group: args.group, kind, code: 'RELATION_VECTOR_DELETE_FAILED',
          message: error, attempts: 1, at: now,
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
    if (groupHasVisibleDocsIn(ctx.caches, args.group, lookups)) {
      skipped.push({ kind: 'path', reason: 'group-has-visible-docs' });
    } else if (!(await ensureVector())) {
      skipped.push({ kind: 'path', reason: 'vector-unavailable' });
    } else {
      const res = await deletePathVector(buildGroupPathContent(args.group), 'ki-path', args.scope);
      if (res.ok) removed.push('path');
      else {
        failed.push('path');
        failedDetails.push({ kind: 'path', error: res.error ?? 'unknown' });
      }
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
    failedDetails,
  };
}

// ─────────────────────────────────────────────────────────────
// 批量档位切换（绑定/解绑一次多篇时用：一次 lookups、一次分片快照）
// ─────────────────────────────────────────────────────────────

export interface ApplyBatchItem {
  group: string;
  relation: string;
  /** 必须是**改字段前**的快照（改完再算会把自己算成新档位） */
  from: Visibility;
}

export interface ApplyBatchFailure {
  group: string;
  relation: string;
  kind: IndexKind;
  error: string;
}

export interface ApplyBatchResult {
  applied: number;
  pending: IndexKind[];
  failed: ApplyBatchFailure[];
}

/**
 * 批量按当前分片状态算各文档档位（一次 `buildLookups` + 一次分片读）。
 *
 * 供绑定路径在**改字段前**取 `from`；不提供这个入口，实现方只能逐条调
 * `resolveVisibilityOfRelation`，50 篇就是 50 次全量读。
 */
export function resolveVisibilityBatch(
  scope: string,
  items: Array<{ group: string; relation: string }>,
): Map<string, Visibility> {
  const out = new Map<string, Visibility>();
  if (items.length === 0) return out;
  const caches = readAllGroupCaches(scope);
  const lookups = buildLookups(scope);
  for (const item of items) {
    const rel = findRelationIn(caches, item.group, item.relation);
    const resolved = resolveVisibility({
      relation: rel ?? {},
      lookupEvent: (id) => lookups.events.get(id) ?? null,
      lookupType: (id) => lookups.types.get(id) ?? null,
    });
    out.set(`${item.group}\u0000${item.relation}`, resolved.mode);
  }
  return out;
}

/** 批量档位切换：共享一次分片快照与 lookups，逐条执行「摘除 + 入队」 */
export async function applyVisibilityBatch(
  scope: string,
  items: ApplyBatchItem[],
  to: Visibility,
): Promise<ApplyBatchResult> {
  if (items.length === 0) return { applied: 0, pending: [], failed: [] };
  const probe = await ensureVectorAvailable(scope, { fastFail: true }).catch(() => ({ available: false }));
  const ctx: ApplyContext = {
    caches: readAllGroupCaches(scope),
    lookups: buildLookups(scope),
    vectorAvailable: probe.available,
  };
  const pending = new Set<IndexKind>();
  const failed: ApplyBatchFailure[] = [];
  let applied = 0;

  for (const item of items) {
    const res = await applyVisibilityCore(
      { scope, group: item.group, relation: item.relation, from: item.from, to },
      ctx,
    );
    applied += 1;
    for (const kind of res.pending) pending.add(kind);
    for (const detail of res.failedDetails ?? []) {
      failed.push({ group: item.group, relation: item.relation, kind: detail.kind, error: detail.error });
    }
    // 兜底：理论上 failedDetails 已覆盖全部 failed
    for (const kind of res.failed) {
      if (!(res.failedDetails ?? []).some((d) => d.kind === kind)) {
        failed.push({ group: item.group, relation: item.relation, kind, error: 'unknown' });
      }
    }
  }

  return { applied, pending: [...pending], failed };
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
