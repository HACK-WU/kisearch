/**
 * incremental.ts —— S-06：增量导入
 *
 * 三类操作：
 *   - action='add'    → 新增：bulkVectorize → 写 relations-cache + local KB
 *   - action='modify' → 更新：mem delete oldId → bulkVectorize → 写新 memoryId
 *   - action='delete' → 删除：mem delete oldId → 移除 cache + local KB
 *
 * Group 树只增不删；source.commit 全部成功后才更新到 HEAD。
 * 使用 bulk-store 批量向量化 add + modify，消除逐条 mem store 的进程启动开销。
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  getGroupIndexPath,
  getRelationsCachePath,
  getLocalKbDir,
  getSource,
  setSource,
  ensureGroupPathInTree,
  type GroupIndex,
} from './scope.js';
import { readJson, writeJson, ensureScopeDir, readGroupIndex } from './store.js';
import { normalizeAiResults, type ScanResultEntry, type AiResultsFile } from './ai-results.js';
import {
  bulkVectorize,
  deleteMemory,
  type BatchVectorizeOptions,
} from './batch-vectorize.js';
import {
  buildRelationContent,
  buildGroupPathContent,
  storeOnePath,
  deletePathVector,
  bulkStorePaths,
  type PathVectorizeEntry,
} from './path-vectorize.js';
import type {
  RelationsCache,
  ImportResult,
  HandleImportArgs,
} from './import.js';
import {
  logPhaseStart,
  logPhaseDone,
  logProgress,
  logInfo,
  logSummary,
} from './progress.js';

// ─── 类型 ───

export interface IncrementalStats {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  errors: number;
}

export interface IncrementalResult extends Omit<ImportResult, 'mode' | 'stats'> {
  mode: 'incremental';
  stats: IncrementalStats;
  previousCommit: string;
  newCommit: string;
}

interface ClassifiedEntries {
  add: ScanResultEntry[];
  modify: ScanResultEntry[];
  delete: ScanResultEntry[];
}

// ─── 工具 ───

function stripMarkdownExtension(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

function deriveRelationText(filePath: string): string {
  const base = stripMarkdownExtension(path.posix.basename(filePath));
  return base.replace(/[*~`]/g, '').trim() || base;
}

function getGitHead(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// ─── 分类 ───

export function classifyEntries(entries: ScanResultEntry[]): ClassifiedEntries {
  const out: ClassifiedEntries = { add: [], modify: [], delete: [] };
  for (const e of entries) {
    if (e.action === 'modify') out.modify.push(e);
    else if (e.action === 'delete') out.delete.push(e);
    else out.add.push(e);
  }
  return out;
}

// ─── Group 树 ───

// ensureGroupPathInTree 已提取到 scope.ts 作为公共函数

// ─── relations-cache 写/删 ───

function generateNextId(cache: RelationsCache): string {
  let max = 0;
  for (const data of Object.values(cache.groups)) {
    for (const r of data.hot_relations) {
      const m = r.id.match(/^rel_(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
  }
  return `rel_${String(max + 1).padStart(3, '0')}`;
}

function ensureCacheGroup(cache: RelationsCache, groupPath: string) {
  if (!cache.groups[groupPath]) {
    cache.groups[groupPath] = {
      hot_relations: [],
      keywords: [],
      max_hot_count: cache.partition_config?.maxHotCount ?? 10,
    };
  }
  return cache.groups[groupPath];
}

function upsertRelation(
  cache: RelationsCache,
  groupPath: string,
  relationText: string,
  keywords: string[],
  memoryId: string,
  sourcePath: string
): void {
  const grp = ensureCacheGroup(cache, groupPath);
  let rel = grp.hot_relations.find((r) => r.text === relationText);
  if (!rel) {
    rel = {
      id: generateNextId(cache),
      text: relationText,
      score: 0,
      useCount: 0,
      lastUsedTime: null,
      isImported: true,
    };
    grp.hot_relations.push(rel);
  } else {
    rel.isImported = true;
  }
  rel.memoryId = memoryId;
  rel.sourcePath = sourcePath;

  for (const kw of keywords || []) {
    const t = String(kw).trim();
    if (t && !grp.keywords.includes(t)) grp.keywords.push(t);
  }
  const maxKw = cache.partition_config?.maxKeywordCount ?? 50;
  if (grp.keywords.length > maxKw) {
    grp.keywords.splice(0, grp.keywords.length - maxKw);
  }
}

/**
 * 按 sourcePath 删除 relation。
 * 如果删除后该 group 为空，本期不清理 group 自身（保持 Group 树只增不删的契约）。
 * @returns 是否真的删掉了一条 relation
 */
export function removeFromCache(cache: RelationsCache, sourcePath: string): boolean {
  for (const groupData of Object.values(cache.groups)) {
    const idx = groupData.hot_relations.findIndex((r) => r.sourcePath === sourcePath);
    if (idx >= 0) {
      groupData.hot_relations.splice(idx, 1);
      return true;
    }
  }
  return false;
}

// ─── local KB ───

function loadLocalKb(localKbPath: string): Record<string, unknown> {
  if (!fs.existsSync(localKbPath)) return {};
  return readJson<Record<string, unknown>>(localKbPath) || {};
}

function writeLocalKb(scope: string, groupPath: string, relationText: string, moduleInfo: string): void {
  const localKbPath = getLocalKbDir(scope, groupPath);
  fs.mkdirSync(path.dirname(localKbPath), { recursive: true });
  const localKb = loadLocalKb(localKbPath);
  localKb[relationText] = moduleInfo;
  writeJson(localKbPath, localKb);
}

export function removeFromLocalKb(scope: string, groupPath: string, relationText: string): boolean {
  const localKbPath = getLocalKbDir(scope, groupPath);
  if (!fs.existsSync(localKbPath)) return false;
  const localKb = loadLocalKb(localKbPath);
  if (!(relationText in localKb)) return false;
  delete localKb[relationText];
  writeJson(localKbPath, localKb);
  return true;
}

// ─── 主入口 ───

export interface HandleIncrementalArgs extends HandleImportArgs {
  // memBinPath 已移除，直接使用全局 mem 命令
}

export function handleIncremental(args: HandleIncrementalArgs): IncrementalResult {
  const TOTAL_PHASES = 4;
  ensureScopeDir(args.scope);

  // Phase 1: 校验 source 块 + 解析 ai-results
  logPhaseStart(1, TOTAL_PHASES, '校验增量导入前置条件 ...');
  const existingSource = getSource(args.scope);
  if (!existingSource) {
    throw new Error(
      `scope "${args.scope}" 尚未首次导入，无法执行增量。请先执行 scan-kb import 完成全量导入。`
    );
  }

  const results: AiResultsFile = normalizeAiResults(args.resultsFile);
  if (args.sourceDirOverride) results.meta.sourceDir = args.sourceDirOverride;
  if (args.rootNameOverride) results.meta.rootName = args.rootNameOverride;

  if (!fs.existsSync(results.meta.sourceDir) || !fs.statSync(results.meta.sourceDir).isDirectory()) {
    throw new Error(`meta.sourceDir 不存在或不是目录：${results.meta.sourceDir}`);
  }
  if (results.meta.rootName !== existingSource.rootName) {
    throw new Error(
      `meta.rootName="${results.meta.rootName}" 与首次导入的 rootName="${existingSource.rootName}" 不一致`
    );
  }
  logPhaseDone(1, TOTAL_PHASES, '校验通过');

  // 读取 group-index + relations-cache
  const groupIndexPath = getGroupIndexPath(args.scope);
  const relationsCachePath = getRelationsCachePath(args.scope);
  const groupIndex = readGroupIndex(args.scope);
  const relationsCache = readJson<RelationsCache>(relationsCachePath);
  if (!groupIndex || !relationsCache) {
    throw new Error('scope 缺少 group-index.json 或 relations-cache.json');
  }

  // 分类
  const cls = classifyEntries(results.entries);
  const errors: { path: string; error: string }[] = [];
  const groupsTouched = new Set<string>();
  const memOpts: BatchVectorizeOptions = { timeoutMs: 60_000 };

  let added = 0;
  let modified = 0;
  let deleted = 0;

  // ── Phase 2: 删除过时条目 ──────────────────────────────
  const deleteTotal = cls.delete.length;
  logPhaseStart(2, TOTAL_PHASES, `删除过时条目（${deleteTotal} 条）...`);
  for (let i = 0; i < cls.delete.length; i++) {
    const e = cls.delete[i];
    logProgress(i + 1, deleteTotal, `[delete] ${e.path}`);
    if (!e.memoryId) {
      errors.push({ path: e.path, error: 'delete 条目缺少 memoryId' });
      continue;
    }
    const del = deleteMemory(e.memoryId, memOpts);
    if (!del.ok) {
      errors.push({ path: e.path, error: `[delete warn] mem delete 失败：${del.error}` });
    }
    const relationText = deriveRelationText(e.path);
    // 同时删除对应的 ki-relation 向量
    const relContent = buildRelationContent(relationText, e.groupPath, e.keywords || []);
    deletePathVector(relContent, 'ki-relation', args.scope);
    const removedFromCache = removeFromCache(relationsCache, e.path);
    if (!removedFromCache) {
      errors.push({ path: e.path, error: `[delete warn] relations-cache 中未找到 sourcePath=${e.path}` });
    }
    removeFromLocalKb(args.scope, e.groupPath, relationText);
    if (del.ok) deleted++;
  }
  logPhaseDone(2, TOTAL_PHASES, `删除完成：${deleted} 条`);

  // ── Phase 3: 预处理 modify + bulk-store 批量向量化 ─────
  const modifyWithId = cls.modify.filter((e) => e.memoryId);
  const modifyWithoutId = cls.modify.filter((e) => !e.memoryId);
  const vectorizeTotal = cls.add.length + cls.modify.length;

  logPhaseStart(3, TOTAL_PHASES, `预处理 modify + 批量向量化（add=${cls.add.length}, modify=${cls.modify.length}）...`);

  // 3a) 预删除 modify 旧 memoryId（失败不阻塞）
  if (modifyWithId.length > 0) {
    logInfo(`预删除 ${modifyWithId.length} 条旧记忆 ...`);
    for (const e of modifyWithId) {
      const del = deleteMemory(e.memoryId!, memOpts);
      if (!del.ok) {
        errors.push({ path: e.path, error: `[modify warn] mem delete oldId 失败：${del.error}` });
      }
    }
  }

  if (vectorizeTotal > 0) {
    // 3b) 构建批量向量化列表（add + modify）
    const toVectorize: ScanResultEntry[] = [...cls.add, ...cls.modify];
    // 基于 entry 本身属性推导 origin，保证与 toVectorize 顺序一致
    const origins: Array<'add' | 'modify'> = toVectorize.map((e) => {
      if (e.action !== 'modify') return 'add' as const;
      // modify 但无 memoryId → 降级为 add
      return e.memoryId ? 'modify' as const : 'add' as const;
    });

    // 3c) 批量向量化
    const vec = bulkVectorize(toVectorize, args.scope, {
      timeoutMs: 60_000 + vectorizeTotal * 10_000,
    });

    // 3d) 写 relations-cache + local KB
    for (let i = 0; i < toVectorize.length; i++) {
      const e = toVectorize[i];
      const origin = origins[i];
      const memoryId = vec.ok.get(e.path);

      if (!memoryId) {
        const err = vec.errors.find((err) => err.path === e.path);
        const prefix = origin === 'modify' ? '[modify] ' : '[add] ';
        errors.push({ path: e.path, error: `${prefix}${err?.error || '向量化失败'}` });
        continue;
      }

      ensureGroupPathInTree(groupIndex, e.groupPath);
      groupsTouched.add(e.groupPath);
      const relationText = deriveRelationText(e.path);
      upsertRelation(relationsCache, e.groupPath, relationText, e.keywords || [], memoryId, e.path);
      const absPath = path.resolve(results.meta.sourceDir, e.path);
      const moduleInfo = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : (e.summary || '');
      writeLocalKb(args.scope, e.groupPath, relationText, moduleInfo);

      if (origin === 'modify') modified++;
      else added++;
    }

    logPhaseDone(3, TOTAL_PHASES, `向量化完成：add=${added}, modify=${modified}, errors=${vec.errors.length}`);
  } else {
    logPhaseDone(3, TOTAL_PHASES, '无需向量化');
  }

  // ── 路径向量同步（ki-path + ki-relation）──
  const pathEntries: PathVectorizeEntry[] = [];
  const groupKeywordsMap = new Map<string, Set<string>>();

  for (const e of [...cls.add, ...cls.modify]) {
    const relationText = deriveRelationText(e.path);
    const keywords = e.keywords || [];

    if (!groupKeywordsMap.has(e.groupPath)) groupKeywordsMap.set(e.groupPath, new Set());
    const kwSet = groupKeywordsMap.get(e.groupPath)!;
    for (const kw of keywords) kwSet.add(String(kw).trim());

    pathEntries.push({
      text: buildRelationContent(relationText, e.groupPath, keywords),
      tag: 'ki-relation',
      scope: args.scope,
    });
  }

  for (const [groupPath, kwSet] of groupKeywordsMap) {
    pathEntries.push({
      text: buildGroupPathContent(groupPath, [...kwSet]),
      tag: 'ki-path',
      scope: args.scope,
    });
  }

  if (pathEntries.length > 0) {
    logInfo(`写入路径向量索引（${pathEntries.length} 条）...`);
    bulkStorePaths(pathEntries);
  }

  // ── Phase 4: 持久化 + 更新 source.commit ──────────────
  logPhaseStart(4, TOTAL_PHASES, '持久化 + 更新 source ...');
  writeJson(groupIndexPath, groupIndex as unknown as Record<string, unknown>);
  writeJson(relationsCachePath, relationsCache as unknown as Record<string, unknown>);

  const newCommit = getGitHead(results.meta.sourceDir);
  if (!newCommit) {
    throw new Error(`无法获取 sourceDir 的 git HEAD：${results.meta.sourceDir}`);
  }
  const newSource = { ...existingSource, commit: newCommit };
  setSource(args.scope, newSource);
  logPhaseDone(4, TOTAL_PHASES, `source 已更新，commit=${newCommit.slice(0, 8)}`);

  logSummary(`增量导入完成：total=${results.entries.length}  added=${added}  modified=${modified}  deleted=${deleted}  errors=${errors.length}`);

  return {
    ok: true,
    action: 'import',
    mode: 'incremental',
    scope: args.scope,
    stats: {
      total: results.entries.length,
      added,
      modified,
      deleted,
      errors: errors.length,
    },
    errors,
    groups: [...groupsTouched].sort(),
    source: newSource,
    previousCommit: existingSource.commit,
    newCommit,
  };
}
