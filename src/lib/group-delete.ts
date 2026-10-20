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
  migrateGroupIndex,
} from '../lib/scope.js';
import { loadConfig, resolveScope, getScopeWikiSync } from '../lib/config.js';
import { withScopeWriteLock } from '../lib/scope-write-lock.js';
import {
  assertNoPendingVectorMigration,
  vectorDelete,
  generateDocId,
  vectorListAuxDocsByGroups,
} from '../lib/vector-client.js';
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
  vectors: {
    deleted: number;
    failed: number;
    skipped: number;
    orphanIds: string[];
    /** 辅助向量按 group 清扫时，因「同名 relation 仍被存活组引用」而保留的条数 */
    sharedKept?: number;
    /** 内容向量因「同一 docId 仍被存活组引用」而保留的条数（同内容跨组共享） */
    sharedContentKept?: number;
    /** 辅助向量按 group 枚举到的条数（ki-relation + ki-path） */
    auxFound?: number;
  };
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

/**
 * 纯读取得归一化后的 Group 树（legacy `roots` → `groups`，**不写盘**）。
 *
 * 预览必须零写入，但也要与执行路径看到同一棵树：执行前会 `readGroupIndex` 触发迁移，
 * 预览若只读原始 `groups`，老 scope 上会出现「预览说没有、执行却删了」（K-03）。
 */
function readNormalizedGroups(scope: string): TreeGroups {
  const raw = readJson<Record<string, unknown>>(getGroupIndexPath(scope));
  if (!raw) return {};
  const migrated = migrateGroupIndex(raw);
  const doc = (migrated ?? raw) as { groups?: TreeGroups };
  return doc.groups ?? {};
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
  const tree = readNormalizedGroups(scope);
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
  const tree = readNormalizedGroups(scope);
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

/** 共享 docId 保护扫描的组数上限：超限时放弃判定（宁可保留辅助向量，也不误删存活组的） */
const SURVIVOR_SCAN_GROUP_CAP = 5000;

/**
 * 收集**未被删除**的组引用的 relation 名与内容向量 id。
 *
 * 为什么需要：向量 docId 是确定性的且**不含 group**——
 *  - 内容向量 `sha256(内容 + scope + tag)`：同内容跨组共用一条；
 *  - ki-relation `sha256(relation 名 + scope + tag)`：同名跨组共用一条
 *    （import 还会按 chunk 追加 `-NN` 后缀）。
 * 直接按「本组元数据」删除会连带删掉别的组仍在用的向量，故先扫存活组求引用集合。
 *
 * 超过 `SURVIVOR_SCAN_GROUP_CAP` 个存活组时返回 `degraded: true`：调用方退回
 * 保守策略（跳过辅助向量清扫），不冒误删风险。
 */
function collectSurvivingReferences(
  scope: string,
  deletedGroups: string[],
): { names: Set<string>; ids: Set<string>; degraded: boolean } {
  const names = new Set<string>();
  const ids = new Set<string>();
  const deletedSet = new Set(deletedGroups);
  const consider = (rels: CacheRelation[]): void => {
    for (const r of rels) {
      if (r.text) names.add(r.text);
      for (const id of r.memoryIds ?? (r.memoryId ? [r.memoryId] : [])) if (id) ids.add(id);
    }
  };

  if (hasShardedLayout(scope)) {
    const keys = listGroupPaths(scope).filter((k) => !deletedSet.has(k));
    if (keys.length > SURVIVOR_SCAN_GROUP_CAP) return { names, ids, degraded: true };
    for (const key of keys) {
      consider((loadGroupCache(scope, key)?.hot_relations ?? []) as CacheRelation[]);
    }
    return { names, ids, degraded: false };
  }

  const cache = loadCacheShape(scope) as unknown as {
    groups?: Record<string, { hot_relations?: CacheRelation[] }>;
  };
  const entries = Object.entries(cache?.groups ?? {});
  if (entries.length > SURVIVOR_SCAN_GROUP_CAP) return { names, ids, degraded: true };
  for (const [key, group] of entries) {
    if (deletedSet.has(key)) continue;
    consider(group.hot_relations ?? []);
  }
  return { names, ids, degraded: false };
}

/**
 * 判断某条 ki-relation 向量是否仍被存活组引用。
 *
 * 两种写入约定并存：`sync-relation` 用 relation 名原文，`import` 按 chunk 追加
 * `-01`/`-02`…（见 `import.ts` 的 `buildRelationContent(\`${text}-${NN}\`)`），
 * 因此既要精确命中，也要剥掉 chunk 后缀再比对。宁可多保留（幽灵）也不误删。
 */
function isSharedRelationName(text: string, survivors: Set<string>): boolean {
  if (survivors.has(text)) return true;
  const stripped = text.replace(/-\d{2,}$/, '');
  return stripped !== text && survivors.has(stripped);
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

  // 只读感知：不可解析 / 不存在 → 视为未初始化（保持既有语义，不改成 existsSync——
  // 那会把"文件损坏"从 SCOPE_NOT_INITIALIZED 变成 GROUP_NOT_FOUND，属无授权的行为变更）
  const hasIndex = readJson<Record<string, unknown>>(getGroupIndexPath(scope)) !== null;
  const shardKeys = readShardKeys(scope);
  if (!hasIndex && shardKeys.length === 0) {
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
      // 与执行同口径：内容向量 + 组路径向量（ki-path）。
      // 纯树 / FTS-only（无内容向量）时执行路径不会重算路径 id，故此处也不计入。
      vectors: vectorIds.size > 0 ? vectorIds.size + resolved.groups.length : 0,
      ftsDocs,
      emptyParents: computeEmptyParents(scope, resolved.canonical, resolved.groups),
    },
    willKeep: {
      wikiDir: wikiSource ? path.join(wikiSource, resolved.canonical) : null,
    },
    // 辅助向量（ki-relation / ki-path）按 group 元数据清扫，条数只有执行时才能确定；
    // 且跨组共享的 docId 会被保留，因此实际删除数可能少于预览值
    hint: '确认无误后追加 --yes 执行（执行时另会按 group 清扫 ki-relation / ki-path 辅助向量；'
      + '跨组共享的同名 relation / 同内容向量会保留，实际删除数可能少于预览）',
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
      // 按结构化 code 判定，不依赖中文文案（文案一改就会静默失效）
      code: (err as { code?: string }).code === 'SCOPE_OPERATION_BUSY' ? 'SCOPE_OPERATION_BUSY' : undefined,
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

  // ── 辅助向量枚举（ki-relation / ki-path）──
  // 这些向量的 docId 不含 group，无法由 relations 元数据推导（K-01/K-02）；
  // 但写入时 group 落进了已建索引的标量字段，故按 group 精确枚举后清扫。
  // 先把枚举做了，再决定是否需要扫存活组：纯树删除（无 relation、无辅助向量）可省掉
  // O(存活组数) 的引用扫描。
  let auxDocs: Awaited<ReturnType<typeof vectorListAuxDocsByGroups>>['docs'] = [];
  let auxSweepFailed = false;
  try {
    const aux = await vectorListAuxDocsByGroups({ scope, groups: plan.willDelete.groups });
    auxDocs = aux.docs;
    result.vectors.auxFound = auxDocs.length;
    if (aux.truncated) {
      result.warnings.push(
        `辅助向量枚举达到单批上限（${auxDocs.length} 条），可能有残留；可重复执行删除或 ki rebuild-vector 清理`,
      );
    }
  } catch (err) {
    auxSweepFailed = true;
    result.warnings.push(`辅助向量枚举失败（ki-relation / ki-path 可能残留）: ${(err as Error).message}`);
  }

  // 存活组的引用集合：确定性 docId 是**跨组共享**的，直接按本组元数据删会误删别的组
  //  - 内容向量：docId = sha256(内容 + scope + tag)，同内容跨组共用一条；
  //  - ki-relation：docId 只由 relation 名 + scope + tag 决定（import 还会按 chunk 加 `-NN`）。
  // 扫描失败一律按 degraded 处理并退回「不保护」的旧行为，不能让删除因兄弟分片损坏而中断。
  let survivors: { names: Set<string>; ids: Set<string>; degraded: boolean } = {
    names: new Set(), ids: new Set(), degraded: false,
  };
  const needSurvivorScan = relationIds.length > 0
    || auxDocs.some((d) => d.tag === 'ki-relation');
  if (needSurvivorScan) {
    try {
      survivors = collectSurvivingReferences(scope, plan.willDelete.groups);
    } catch (err) {
      survivors = { names: new Set(), ids: new Set(), degraded: true };
      result.warnings.push(`存活组引用扫描失败，跳过共享保护与辅助向量清扫: ${(err as Error).message}`);
    }
  }

  const vectorIds = new Set<string>();
  let sharedContentKept = 0;
  for (const id of relationIds) {
    if (!survivors.degraded && survivors.ids.has(id)) {
      sharedContentKept++;
      continue;
    }
    vectorIds.add(id);
  }
  // 组级路径向量（ki-path）的 docId 由内容 + scope + tag 决定，可安全重算删除。
  // 仅当该组确有内容向量时才重算路径向量 id：避免在纯树/FTS scope 上
  // 为一堆不存在的 id 初始化向量引擎（会让无向量的测试/CLI 卡在引擎启动）。
  if (relationIds.length > 0) {
    for (const group of plan.willDelete.groups) {
      vectorIds.add(generateDocId(buildGroupPathContent(group), scope, 'ki-path'));
    }
  }
  result.vectors.sharedContentKept = sharedContentKept;

  if (survivors.degraded) {
    result.warnings.push(
      `存活组数量超过 ${SURVIVOR_SCAN_GROUP_CAP}，跳过辅助向量清扫与共享向量保护`
      + '（ki-relation / ki-path 可能残留；可用 ki rebuild-vector 重建）',
    );
  } else if (auxDocs.length > 0) {
    let kept = 0;
    for (const doc of auxDocs) {
      if (doc.tag === 'ki-relation' && isSharedRelationName(doc.text, survivors.names)) {
        kept++;
        continue;
      }
      vectorIds.add(doc.id);
    }
    result.vectors.sharedKept = kept;
  }

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
      const raw = readJson<Record<string, unknown>>(indexPath);
      if (!raw) return;
      // legacy roots 归一化（不依赖窗口外那次迁移是否成功）
      const doc = (migrateGroupIndex(raw) ?? raw) as Record<string, unknown> & { groups?: TreeGroups };
      const groups = doc.groups ?? {};
      const removed = removeTreeNode(groups, target);
      if (removed) {
        pruneEmptyParents(scope, groups, target);
        doc.groups = groups;
        writeJson(indexPath, doc);
      }
      result.deleted.tree = removed;
    });
  } catch (err) {
    return { ...result, error: `group-index 树节点删除失败: ${(err as Error).message}` };
  }

  // ── 向量 / FTS（失败只降级，不回滚元数据） ──
  const idsToDelete = [...vectorIds];
  if (idsToDelete.length > 0) {
    try {
      const del = await vectorDelete({ scope, ids: idsToDelete });
      result.vectors.deleted = idsToDelete.length - del.failedIds.length;
      result.vectors.failed = del.failedIds.length;
      result.vectors.orphanIds = del.failedIds;
    } catch (err) {
      result.vectors.failed = idsToDelete.length;
      result.vectors.orphanIds = idsToDelete;
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

  // 辅助向量枚举失败也要标 degraded：否则用户会以为「删干净了」，而 ki search 仍能命中关系名
  result.degraded = result.vectors.failed > 0 || result.fts.failed > 0 || auxSweepFailed;
  if (result.degraded) {
    result.warnings.push('部分向量/FTS 未删除，可用 ki doc delete 清理孤儿索引');
  }
  result.ok = true;
  return result;
}
