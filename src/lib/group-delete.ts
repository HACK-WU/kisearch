/**
 * group-delete.ts — 唯一删组 core（REQ-20261019-005 / S-01）
 *
 * planGroupDelete：只读预览，零写入。
 * executeGroupDelete：写锁 + 迁移守卫 + 两段元数据提交窗口 + 向量/FTS 清理。
 *
 * 约束：
 * - 只精确匹配路径，不做语义补全；
 * - 组级删除不触碰 source.dir / wiki 目标目录（D3/D4）；
 * - 元数据窗口内只做小 JSON 写，大目录 rmSync 在窗口外；
 * - 向量/FTS 失败不抛错，返回 degraded + orphanIds。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readJson, readGroupIndex, writeJson } from '../lib/store.js';
import {
  getGroupIndexPath,
  getRelationsCachePath,
  getKbDir,
  getLocalKbDir,
  validateScope,
  getSource,
} from '../lib/scope.js';
import { loadConfig, resolveScope, getScopeWikiSync } from '../lib/config.js';
import { withScopeWriteLock } from '../lib/scope-write-lock.js';
import { assertNoPendingVectorMigration, vectorDelete, generateDocId } from '../lib/vector-client.js';
import { buildGroupPathContent } from './path-vectorize.js';
import { ftsDeleteByIds } from '../lib/fts-client.js';
import { getSharedOperationCoordinator } from '../lib/operation-coordinator.js';
import { activeDrafts } from '../lib/relation-edit-draft.js';
import {
  listGroupPaths,
  loadGroupCache,
  deleteGroupCache,
  hasShardedLayout,
  loadCacheShape,
} from '../lib/group-cache.js';
import type { Relation } from './scoring.js';
import { callDaemon, shouldUseDaemonClient } from '../lib/daemon-client.js';

export interface GroupDeleteOptions {
  scope?: string;
  path: string;
  /** MCP 空节点删除：仅允许无子组、无 relation、无 KB 文件 */
  requireEmpty?: boolean;
}

export interface GroupDeleteTargets {
  groups: string[];          // 自身 + 全部子组
  relations: number;
  kbDir: string;
  kbFiles: number;
  assets: number;
  vectors: number;
  ftsDocs: number;
  emptyParents: string[];
}

export interface GroupDeletePlan {
  ok: true;
  scope: string;
  path: string;
  exists: true;
  willDelete: GroupDeleteTargets;
  willKeep: { wikiDir: string | null };
  hint: string;
}

export type GroupDeleteErrorCode =
  | 'INVALID_PATH'
  | 'GROUP_NOT_FOUND'
  | 'SCOPE_NOT_INITIALIZED'
  | 'GROUP_NOT_EMPTY'
  | 'DRAFT_IN_PROGRESS'
  | 'SCOPE_OPERATION_BUSY'
  | 'VECTOR_MIGRATION_PENDING';

export interface GroupDeleteError {
  ok: false;
  scope: string;
  path: string;
  code: GroupDeleteErrorCode;
  error: string;
  candidates?: string[];
  detail?: Record<string, unknown>;
}

export interface GroupDeleteResult {
  ok: boolean;
  scope: string;
  path: string;
  deleted: {
    groups: string[];
    relations: number;
    kbDir: boolean;
    tree: boolean;
  };
  vectors: { deleted: number; failed: number; skipped: number; orphanIds: string[] };
  fts: { deleted: number; failed: number; orphanIds: string[] };
  degraded: boolean;
  warnings: string[];
  error?: string;
  code?: GroupDeleteErrorCode;
}

interface TreeGroups {
  [key: string]: TreeGroups;
}

interface CacheRelation extends Relation {
  sourcePath?: string;
}

function errResult(
  scope: string,
  rawPath: string,
  code: GroupDeleteErrorCode,
  error: string,
  extra?: { candidates?: string[]; detail?: Record<string, unknown> },
): GroupDeleteError {
  return { ok: false, scope, path: rawPath, code, error, ...extra };
}

/** 归一化并校验组路径；非法时抛 Error（由调用方转 INVALID_PATH） */
export function normalizeGroupPath(raw: string): string {
  if (typeof raw !== 'string') throw new Error('路径必须是字符串');
  let decoded = raw.trim();
  if (!decoded) throw new Error('路径不能为空');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    throw new Error(`路径包含非法编码：${raw}`);
  }
  decoded = decoded.trim();
  if (!decoded) throw new Error('路径不能为空');
  if (decoded.includes('\0')) throw new Error('路径包含 NUL 字符');
  if (decoded.includes('\\')) throw new Error('路径不能包含反斜杠');
  const segs = decoded.split('/').filter((s, i, arr) => {
    // 允许首尾斜杠，但中间的空段一律拒绝
    if (s !== '') return true;
    if (i === 0 || i === arr.length - 1) return false;
    throw new Error('路径包含空段');
  });
  if (segs.length === 0) throw new Error('路径不能为空');
  for (const seg of segs) {
    if (seg === '.' || seg === '..') throw new Error(`路径不能包含 "${seg}"`);
    if (seg.trim() !== seg) throw new Error('路径段不能包含首尾空白');
  }
  return segs.join('/');
}

function walkTree(node: TreeGroups, prefix: string, out: string[]): void {
  for (const [name, child] of Object.entries(node)) {
    const p = prefix ? `${prefix}/${name}` : name;
    out.push(p);
    if (child && typeof child === 'object') walkTree(child, p, out);
  }
}

function readShardKeys(scope: string): string[] {
  try {
    if (hasShardedLayout(scope)) return listGroupPaths(scope);
    const legacy = loadCacheShape(scope) as unknown as { groups?: Record<string, unknown> };
    return Object.keys(legacy?.groups ?? {});
  } catch {
    return [];
  }
}

function treeHasExact(node: TreeGroups, p: string): boolean {
  const segs = p.split('/').filter(Boolean);
  let cur: TreeGroups | undefined = node;
  for (const seg of segs) {
    if (!cur || typeof cur[seg] !== 'object' || cur[seg] === null) return false;
    cur = cur[seg] as TreeGroups;
  }
  return true;
}

function findTreeNode(node: TreeGroups, p: string): TreeGroups | null {
  const segs = p.split('/').filter(Boolean);
  let cur: TreeGroups | undefined = node;
  for (const seg of segs) {
    if (!cur || typeof cur[seg] !== 'object' || cur[seg] === null) return null;
    cur = cur[seg] as TreeGroups;
  }
  return cur;
}

export function resolveExactGroupPath(
  scope: string,
  rawPath: string,
): { canonical: string; groups: string[] } | null {
  let canonical: string;
  try {
    canonical = normalizeGroupPath(rawPath);
  } catch {
    return null;
  }
  const data = readJson<{ groups?: TreeGroups }>(getGroupIndexPath(scope));
  const tree = (data?.groups ?? {}) as TreeGroups;
  const shardKeys = readShardKeys(scope);
  const treeExact = treeHasExact(tree, canonical);
  const shardExact = shardKeys.includes(canonical);
  if (!treeExact && !shardExact) return null;

  const treeGroups: string[] = [];
  const node = findTreeNode(tree, canonical);
  if (node) {
    treeGroups.push(canonical);
    walkTree(node, canonical, treeGroups);
  }
  const shardGroups = shardKeys.filter(
    (k) => k === canonical || k.startsWith(`${canonical}/`),
  );
  const groups = [...new Set([...treeGroups, ...shardGroups])].sort();
  return { canonical, groups };
}

function candidatePaths(scope: string, limit = 5): string[] {
  const data = readJson<{ groups?: TreeGroups }>(getGroupIndexPath(scope));
  const tree = (data?.groups ?? {}) as TreeGroups;
  const all: string[] = [];
  walkTree(tree, '', all);
  for (const k of readShardKeys(scope)) if (!all.includes(k)) all.push(k);
  return all.slice(0, limit);
}

function countFiles(dir: string): { files: number; assets: number } {
  let files = 0;
  let assets = 0;
  const walk = (d: string, inAssets: boolean): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full, inAssets || entry.name === 'assets');
      } else if (entry.isFile()) {
        files++;
        if (inAssets) assets++;
      }
    }
  };
  walk(dir, false);
  return { files, assets };
}

function loadRelations(scope: string, keys: string[]): CacheRelation[] {
  if (hasShardedLayout(scope)) {
    return keys.flatMap((k) => (loadGroupCache(scope, k)?.hot_relations ?? []) as CacheRelation[]);
  }
  const cache = loadCacheShape(scope) as unknown as {
    groups?: Record<string, { hot_relations?: CacheRelation[] }>;
  };
  return keys.flatMap((k) => cache.groups?.[k]?.hot_relations ?? []);
}

function resolveWikiSourceDir(scope: string): string | null {
  const source = getSource(scope);
  if (source?.dir) return source.dir;
  const wikiSync = getScopeWikiSync(loadConfig(), scope);
  if (wikiSync?.enabled && wikiSync.sourceDir) return wikiSync.sourceDir;
  return null;
}

function computeEmptyParents(scope: string, target: string, groups: string[]): string[] {
  const segs = target.split('/').filter(Boolean);
  const result: string[] = [];
  const remaining = new Set(groups);
  for (let i = segs.length - 1; i >= 1; i--) {
    const ancestor = segs.slice(0, i).join('/');
    const hasOther = [...remaining].some(
      (p) => !(p === target || p.startsWith(`${target}/`))
        && p !== ancestor
        && p.startsWith(`${ancestor}/`),
    );
    if (hasOther) continue;
    const kbDir = path.dirname(getLocalKbDir(scope, ancestor));
    if (fs.existsSync(kbDir)) continue;
    result.push(ancestor);
  }
  return result;
}

export async function planGroupDelete(
  opts: GroupDeleteOptions,
): Promise<GroupDeletePlan | GroupDeleteError> {
  let scope = opts.scope ?? '';
  let canonical = opts.path;
  try {
    scope = resolveScope(loadConfig(), opts.scope);
    validateScope(scope);
    canonical = normalizeGroupPath(opts.path);
  } catch (err) {
    return errResult(scope, canonical, 'INVALID_PATH', (err as Error).message);
  }

  const groupIndex = readJson<{ groups?: TreeGroups }>(getGroupIndexPath(scope));
  const shardKeys = readShardKeys(scope);
  if (!groupIndex && shardKeys.length === 0) {
    return errResult(scope, canonical, 'SCOPE_NOT_INITIALIZED', `scope "${scope}" 尚未初始化`);
  }

  const resolved = resolveExactGroupPath(scope, canonical);
  if (!resolved) {
    return errResult(scope, canonical, 'GROUP_NOT_FOUND', `Group "${canonical}" 不存在（只精确匹配）`, {
      candidates: candidatePaths(scope),
    });
  }

  const relations = loadRelations(scope, resolved.groups);
  const vectorIds = new Set<string>();
  let ftsDocs = 0;
  for (const rel of relations) {
    const ids = rel.memoryIds ?? (rel.memoryId ? [rel.memoryId] : []);
    for (const id of ids) if (id) vectorIds.add(id);
    ftsDocs += rel.ftsIds?.length ?? 0;
  }

  const kbDir = path.dirname(getLocalKbDir(scope, resolved.canonical));
  const stats = fs.existsSync(kbDir) ? countFiles(kbDir) : { files: 0, assets: 0 };
  const wikiSource = resolveWikiSourceDir(scope);

  return {
    ok: true,
    scope,
    path: resolved.canonical,
    exists: true,
    willDelete: {
      groups: resolved.groups,
      relations: relations.length,
      kbDir,
      kbFiles: stats.files,
      assets: stats.assets,
      vectors: vectorIds.size,
      ftsDocs,
      emptyParents: computeEmptyParents(scope, resolved.canonical, resolved.groups),
    },
    willKeep: {
      wikiDir: wikiSource ? path.join(wikiSource, resolved.canonical) : null,
    },
    hint: '确认无误后追加 --yes 执行',
  };
}

function removeTreeNode(groups: TreeGroups, target: string): boolean {
  const segs = target.split('/').filter(Boolean);
  const walk = (node: TreeGroups, idx: number): boolean => {
    const key = segs[idx];
    if (!(key in node)) return false;
    if (idx === segs.length - 1) {
      delete node[key];
      return true;
    }
    const child = node[key];
    if (typeof child !== 'object' || child === null) return false;
    return walk(child as TreeGroups, idx + 1);
  };
  return walk(groups, 0);
}

function relationsCountForKey(scope: string, key: string): number {
  if (hasShardedLayout(scope)) return loadGroupCache(scope, key)?.hot_relations.length ?? 0;
  try {
    const cache = loadCacheShape(scope) as unknown as {
      groups?: Record<string, { hot_relations?: unknown[] }>;
    };
    return cache.groups?.[key]?.hot_relations?.length ?? 0;
  } catch {
    return 0;
  }
}

function pruneEmptyParents(scope: string, groups: TreeGroups, target: string): void {
  const segs = target.split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 1; i--) {
    const ancestor = segs.slice(0, i).join('/');
    const node = findTreeNode(groups, ancestor);
    if (!node) continue;
    // 仍有子节点（树）→ 不清理
    if (Object.keys(node).length > 0) break;
    // 该父节点自身或其子键仍有 relation → 不清理（空键本身不算数据）
    const keysUnder = readShardKeys(scope).filter(
      (k) => k === ancestor || k.startsWith(`${ancestor}/`),
    );
    if (keysUnder.some((k) => relationsCountForKey(scope, k) > 0)) break;
    const kbDir = path.dirname(getLocalKbDir(scope, ancestor));
    if (fs.existsSync(kbDir)) break;
    removeTreeNode(groups, ancestor);
  }
}

export async function executeGroupDelete(
  opts: GroupDeleteOptions,
): Promise<GroupDeleteResult> {
  if (shouldUseDaemonClient()) {
    return callDaemon<GroupDeleteResult>('group-delete', opts);
  }
  let scope = opts.scope ?? '';
  try {
    scope = resolveScope(loadConfig(), opts.scope);
  } catch (err) {
    return {
      ok: false, scope, path: opts.path, code: 'INVALID_PATH',
      deleted: { groups: [], relations: 0, kbDir: false, tree: false },
      vectors: { deleted: 0, failed: 0, skipped: 0, orphanIds: [] },
      fts: { deleted: 0, failed: 0, orphanIds: [] },
      degraded: false, warnings: [], error: (err as Error).message,
    };
  }
  try {
    return await withScopeWriteLock(scope, 'group-delete', () => executeLocal(scope, opts));
  } catch (err) {
    const message = (err as Error).message;
    return {
      ok: false, scope, path: opts.path,
      code: message.includes('正在写入') ? 'SCOPE_OPERATION_BUSY' : undefined,
      deleted: { groups: [], relations: 0, kbDir: false, tree: false },
      vectors: { deleted: 0, failed: 0, skipped: 0, orphanIds: [] },
      fts: { deleted: 0, failed: 0, orphanIds: [] },
      degraded: false, warnings: [], error: message,
    };
  }
}

async function executeLocal(scope: string, opts: GroupDeleteOptions): Promise<GroupDeleteResult> {
  const emptyResult: GroupDeleteResult = {
    ok: false,
    scope,
    path: opts.path,
    deleted: { groups: [], relations: 0, kbDir: false, tree: false },
    vectors: { deleted: 0, failed: 0, skipped: 0, orphanIds: [] },
    fts: { deleted: 0, failed: 0, orphanIds: [] },
    degraded: false,
    warnings: [],
  };

  try {
    assertNoPendingVectorMigration(scope);
  } catch (err) {
    return { ...emptyResult, code: 'VECTOR_MIGRATION_PENDING', error: (err as Error).message };
  }

  // 执行路径允许做一次 legacy 迁移写（在写锁内）；plan 本身保持零写入
  try { readGroupIndex(scope); } catch { /* plan 会自行兜底 */ }
  const plan = await planGroupDelete({ scope, path: opts.path });
  if (!plan.ok) {
    return { ...emptyResult, path: plan.path, code: plan.code, error: plan.error };
  }
  const target = plan.path;
  const children = plan.willDelete.groups.filter((g) => g !== target);
  if (opts.requireEmpty && (children.length > 0 || plan.willDelete.relations > 0 || plan.willDelete.kbFiles > 0)) {
    return {
      ...emptyResult,
      path: target,
      code: 'GROUP_NOT_EMPTY',
      error: `Group "${target}" 非空：子组 ${children.length}、relation ${plan.willDelete.relations}、KB 文件 ${plan.willDelete.kbFiles}；`
        + `级联删除请用 CLI: ki group delete "${target}" --yes`,
    };
  }

  const drafts = activeDrafts(scope).filter(
    (d) => d.group === target || d.group.startsWith(`${target}/`),
  );
  if (drafts.length > 0) {
    return {
      ...emptyResult,
      path: target,
      code: 'DRAFT_IN_PROGRESS',
      error: `该 group 下有 ${drafts.length} 条未结束的编辑草稿（`
        + drafts.map((d) => `${d.group}/${d.relation}:${d.status}`).join(', ')
        + '）；请先 cancel 或 finish 后再删除',
    };
  }

  const relations = loadRelations(scope, plan.willDelete.groups);
  const relationIds = relations
    .flatMap((r) => r.memoryIds ?? (r.memoryId ? [r.memoryId] : []))
    .filter(Boolean);
  // 组级路径向量（ki-path）的 docId 由内容 + scope + tag 决定，可安全重算删除；
  // ki-relation 向量只含 relation 名、跨组共享，不能按组删除（保留）。
  // 仅当该组确有内容向量时才重算路径向量 id：避免在纯树/FTS scope 上
  // 为一堆不存在的 id 初始化向量引擎（会让无向量的测试/CLI 卡在引擎启动）。
  const pathIds = relationIds.length > 0
    ? plan.willDelete.groups.map((group) =>
      generateDocId(buildGroupPathContent(group), scope, 'ki-path'))
    : [];
  const vectorIds = [...new Set([...relationIds, ...pathIds])] as string[];
  const ftsIds = [...new Set(relations.flatMap((r) => r.ftsIds ?? []))];

  const result: GroupDeleteResult = {
    ...emptyResult,
    path: target,
    deleted: {
      groups: plan.willDelete.groups,
      relations: relations.length,
      kbDir: false,
      tree: false,
    },
  };

  // ── 窗口 1：删除 relations 分片（列表先消失） ──
  try {
    getSharedOperationCoordinator().withMetadataCommitSync(scope, () => {
      if (hasShardedLayout(scope)) {
        deleteGroupCache(scope, target);
      } else {
        const cachePath = getRelationsCachePath(scope);
        const cache = loadCacheShape(scope) as unknown as {
          groups: Record<string, unknown>;
          [k: string]: unknown;
        };
        for (const key of plan.willDelete.groups) delete cache.groups[key];
        writeJson(cachePath, cache as unknown as Record<string, unknown>);
      }
    });
  } catch (err) {
    return { ...result, error: `relations 元数据删除失败: ${(err as Error).message}` };
  }

  // ── 窗口外：递归删除 KB 目录（含 assets）；失败保留树节点，可重跑 ──
  const kbGroupDir = plan.willDelete.kbDir;
  try {
    if (fs.existsSync(kbGroupDir)) {
      const rel = path.relative(getKbDir(scope), kbGroupDir);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ...result, error: `KB 路径越界，拒绝递归删除: ${kbGroupDir}` };
      }
      fs.rmSync(kbGroupDir, { recursive: true, force: true });
      result.deleted.kbDir = true;
    } else {
      result.deleted.kbDir = true;
    }
  } catch (err) {
    return { ...result, error: `KB 目录删除失败（树节点保留，可重跑）: ${(err as Error).message}` };
  }

  // ── 窗口 2：删除树节点 + 清理确认为空的父节点 ──
  try {
    getSharedOperationCoordinator().withMetadataCommitSync(scope, () => {
      const indexPath = getGroupIndexPath(scope);
      const groupIndex = readJson<{ groups: TreeGroups }>(indexPath);
      if (!groupIndex) return;
      const removed = removeTreeNode(groupIndex.groups, target);
      if (removed) {
        pruneEmptyParents(scope, groupIndex.groups, target);
        writeJson(indexPath, groupIndex as unknown as Record<string, unknown>);
      }
      result.deleted.tree = removed;
    });
  } catch (err) {
    return { ...result, error: `group-index 树节点删除失败: ${(err as Error).message}` };
  }

  // ── 向量 / FTS（失败只降级，不回滚元数据） ──
  if (vectorIds.length > 0) {
    try {
      const del = await vectorDelete({ scope, ids: vectorIds });
      result.vectors.deleted = vectorIds.length - del.failedIds.length;
      result.vectors.failed = del.failedIds.length;
      result.vectors.orphanIds = del.failedIds;
    } catch (err) {
      result.vectors.failed = vectorIds.length;
      result.vectors.orphanIds = vectorIds;
      result.warnings.push(`向量删除失败: ${(err as Error).message}`);
    }
  }
  if (ftsIds.length > 0) {
    try {
      const fts = await ftsDeleteByIds({ scope, ids: ftsIds });
      result.fts.deleted = ftsIds.length - fts.failed;
      result.fts.failed = fts.failed;
      if (fts.failed > 0) result.fts.orphanIds = ftsIds;
    } catch (err) {
      result.fts.failed = ftsIds.length;
      result.fts.orphanIds = ftsIds;
      result.warnings.push(`FTS 删除失败: ${(err as Error).message}`);
    }
  }

  result.degraded = result.vectors.failed > 0 || result.fts.failed > 0;
  if (result.degraded) {
    result.warnings.push('部分向量/FTS 未删除，可用 ki doc delete 清理孤儿索引');
  }
  result.ok = true;
  return result;
}
