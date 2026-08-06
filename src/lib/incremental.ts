/**
 * incremental.ts —— S-06：增量导入
 *
 * 三类操作：
 *   - action='add'    → 新增：bulkVectorize → 写 relations-cache + local KB
 *   - action='modify' → 更新：向量删除 oldId → bulkVectorize → 写新 memoryId
 *   - action='delete' → 删除：向量删除 oldId → 移除 cache + local KB
 *
 * Group 树只增不删；source.commit 全部成功后才更新到 HEAD。
 * 使用 bulk-store 批量向量化 add + modify，消除逐条向量写入的额外开销。
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
import { normalizeAiResults, deriveGroupPath, type ScanResultEntry, type AiResultsFile } from './ai-results.js';
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
  logWarn,
  logSummary,
} from './progress.js';
import { handleDiff, type DiffResult } from './diff.js';
import { splitIntoChunks } from './chunker.js';
import { deriveChunkRelation, deriveChunkSourcePath, readFileToChunks } from './import.js';

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
      // 增量导入同样基于 ai-results 的 summary（摘要，非全文）
      isFullText: false,
    };
    grp.hot_relations.push(rel);
  } else {
    rel.isImported = true;
    rel.isFullText = false;
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

export interface HandleIncrementalDirectArgs {
  scope: string;
  /** 外部 Wiki 根目录；缺省时用 source 块 dir（H-20 全量直导已写入） */
  sourceDir?: string;
  /** 切分参数：仅首次新增 chunk 时用于读取（缺省用 source 块持久化值，D-8） */
  chunkSize?: number;
  /** 切分参数（同上） */
  chunkOverlap?: number;
  /** 单文件大小上限（字节），超限跳过并告警；默认 2MB */
  maxFileSizeBytes?: number;
}

export async function handleIncremental(args: HandleIncrementalArgs): Promise<IncrementalResult> {
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
    const del = await deleteMemory(e.memoryId, args.scope, memOpts);
    if (!del.ok) {
      errors.push({ path: e.path, error: `[delete warn] 向量删除失败：${del.error}` });
    }
    const relationText = deriveRelationText(e.path);
    // 同时删除对应的 ki-relation 向量
    const relContent = buildRelationContent(relationText, e.groupPath);
    await deletePathVector(relContent, 'ki-relation', args.scope);
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
      const del = await deleteMemory(e.memoryId!, args.scope, memOpts);
      if (!del.ok) {
        errors.push({ path: e.path, error: `[modify warn] 向量删除 oldId 失败：${del.error}` });
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
    const vec = await bulkVectorize(toVectorize, args.scope, {
      timeoutMs: 60_000 + vectorizeTotal * 10_000,
    });

    // 3d) 写 relations-cache + local KB
    for (let i = 0; i < toVectorize.length; i++) {
      const e = toVectorize[i];
      const origin = origins[i];
      logProgress(i + 1, toVectorize.length, `[${origin}] ${e.path}`);
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
      text: buildRelationContent(relationText, e.groupPath),
      tag: 'ki-relation',
      scope: args.scope,
      group: e.groupPath,
    });
  }

  for (const [groupPath] of groupKeywordsMap) {
    pathEntries.push({
      text: buildGroupPathContent(groupPath),
      tag: 'ki-path',
      scope: args.scope,
    });
  }

  if (pathEntries.length > 0) {
    logInfo(`写入路径向量索引（${pathEntries.length} 条）...`);
    await bulkStorePaths(pathEntries);
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

// ─── 增量直连（git diff 驱动，无 AI，H-17 文件级覆盖更新）────────────────

/**
 * 把变更文件重新切分并向量化（added / modified 共用）。
 * 返回该文件的 chunk 条目（含 chunkRelation / chunkSourcePath）。
 */
function chunkifyFile(absPath: string, relPath: string, rootName: string, chunkSize: number, chunkOverlap: number): ScanResultEntry[] {
  const chunks = readFileToChunks(absPath, chunkSize, chunkOverlap);
  return chunks.map((chunk) => ({
    path: deriveChunkSourcePath(relPath, chunk.index), // foo.md#N
    groupPath: deriveGroupPath(rootName, relPath),
    summary: chunk.text, // 原文
    keywords: [],
    enriched: false,
    memoryId: null,
    action: 'add',
    chunkRelation: deriveChunkRelation(relPath, chunk.index), // foo-01
  }));
}

/**
 * 增量直连：基于 git diff（复用 handleDiff）驱动，无 AI 依赖。
 *
 * - added    → 读原文 → 切分 → 向量化 → 写 cache + local KB
 * - modified → 先写新全 chunk（成功后再删旧全 chunk，写序见 D-3/质疑意见2）
 * - deleted  → 按文件关联全 chunk memoryId 清理（向量 + cache + local KB + 路径向量）
 * - 全部成功后才更新 source.commit 到 HEAD
 * - 切分参数用 source 块持久化值（D-8）；无 git 明确报错（D-9）
 */
export async function handleIncrementalDirect(args: HandleIncrementalDirectArgs): Promise<IncrementalResult> {
  const TOTAL_PHASES = 4;
  ensureScopeDir(args.scope);

  // Phase 1: 校验首次导入 + source 块
  logPhaseStart(1, TOTAL_PHASES, '校验增量直连前置条件 ...');
  const existingSource = getSource(args.scope);
  if (!existingSource) {
    throw new Error(`scope "${args.scope}" 尚未首次导入，无法执行增量。请先执行 scan-kb import --source 完成全量直导。`);
  }

  const sourceDir = args.sourceDir ? path.resolve(args.sourceDir) : existingSource.dir;
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`source 目录不存在或不是目录：${sourceDir}`);
  }

  // 切分参数：source 块持久化值优先（D-8），缺省回退默认（H-18 缺失回退）
  const chunkSize = existingSource.chunkSize ?? args.chunkSize ?? 1000;
  const chunkOverlap = existingSource.chunkOverlap ?? args.chunkOverlap ?? 150;
  const maxFileSizeBytes = args.maxFileSizeBytes ?? 2 * 1024 * 1024;
  const rootName = existingSource.rootName;
  logPhaseDone(1, TOTAL_PHASES, `校验通过（sourceDir=${sourceDir}，chunkSize=${chunkSize}，rootName=${rootName}）`);

  // git diff 获取变更（无 git → handleDiff 内部明确报错，D-9）
  const diffOutput = handleDiff({ scope: args.scope });
  if (diffOutput.action === 'diff' && 'status' in diffOutput) {
    throw new Error(`scope "${args.scope}" 尚未首次导入，无法执行增量。`);
  }
  const diff = diffOutput as DiffResult;
  logInfo(`git diff: base=${diff.baseCommit.slice(0, 8)} head=${diff.headCommit.slice(0, 8)}  added=${diff.stats.added} modified=${diff.stats.modified} deleted=${diff.stats.deleted}`);

  // 读取 group-index + relations-cache
  const groupIndexPath = getGroupIndexPath(args.scope);
  const relationsCachePath = getRelationsCachePath(args.scope);
  const groupIndex = readGroupIndex(args.scope);
  const relationsCache = readJson<RelationsCache>(relationsCachePath);
  if (!groupIndex || !relationsCache) {
    throw new Error('scope 缺少 group-index.json 或 relations-cache.json');
  }

  const errors: { path: string; error: string }[] = [];
  const groupsTouched = new Set<string>();
  const memOpts: BatchVectorizeOptions = { timeoutMs: 60_000 };
  let added = 0;
  let modified = 0;
  let deleted = 0;

  // ── Phase 2: deleted 清理（按文件关联全 chunk memoryId）──
  logPhaseStart(2, TOTAL_PHASES, `清理 deleted（${diff.deleted.length} 个文件）...`);
  for (const entry of diff.deleted) {
    logProgress(diff.deleted.indexOf(entry) + 1, diff.deleted.length, `[delete] ${entry.path}`);
    const ids = entry.memoryIds && entry.memoryIds.length > 0 ? entry.memoryIds : (entry.memoryId ? [entry.memoryId] : []);
    if (ids.length === 0) {
      errors.push({ path: entry.path, error: 'deleted 文件未关联任何 memoryId（可能未导入过或 cache 缺失）' });
      continue;
    }
    // 1) 删除全部 chunk 向量
    for (const id of ids) {
      const del = await deleteMemory(id, args.scope, memOpts);
      if (!del.ok) {
        errors.push({ path: entry.path, error: `[delete warn] 向量删除失败 id=${id.slice(0, 8)}：${del.error}` });
      }
    }
    // 2) 清理 relations-cache + local KB（按文件前缀匹配 chunk sourcePath）
    const groupPaths = new Set<string>();
    for (const [groupPath, groupData] of Object.entries(relationsCache.groups)) {
      const rels = groupData.hot_relations.filter((r) => r.sourcePath && (r.sourcePath === entry.path || r.sourcePath.startsWith(entry.path + '#')));
      for (const rel of rels) {
        const idx = groupData.hot_relations.indexOf(rel);
        if (idx >= 0) groupData.hot_relations.splice(idx, 1);
        groupPaths.add(groupPath);
        removeFromLocalKb(args.scope, groupPath, rel.text);
        // 删除 ki-relation 路径向量
        await deletePathVector(buildRelationContent(rel.text, groupPath), 'ki-relation', args.scope);
      }
    }
    for (const gp of groupPaths) groupsTouched.add(gp);
    deleted++;
  }
  logPhaseDone(2, TOTAL_PHASES, `deleted 清理完成：${deleted} 个文件`);

  // ── Phase 3: modified 先写新 → 成功后再删旧；added 直接写 ──
  const processFiles = [...diff.added.map((e) => ({ e, isModify: false })), ...diff.modified.map((e) => ({ e, isModify: true }))];
  const writeTotal = processFiles.length;
  logPhaseStart(3, TOTAL_PHASES, `向量化写入（add=${diff.added.length}, modify=${diff.modified.length}）...`);

  for (let fi = 0; fi < processFiles.length; fi++) {
    const { e, isModify } = processFiles[fi];
    logProgress(fi + 1, writeTotal, `[${isModify ? 'modify' : 'add'}] ${e.path}`);
    const absPath = e.absPath || path.resolve(sourceDir, e.path);
    if (!fs.existsSync(absPath)) {
      errors.push({ path: e.path, error: `文件不存在：${absPath}` });
      continue;
    }
    const stat = fs.statSync(absPath);
    if (stat.size > maxFileSizeBytes) {
      logWarn(`文件过大已跳过（${stat.size} bytes > ${maxFileSizeBytes}）：${e.path}`);
      continue;
    }

    // 读原文 → 切分 → 构造 chunk entries
    const entries = chunkifyFile(absPath, e.path, rootName, chunkSize, chunkOverlap);
    if (entries.length === 0) {
      errors.push({ path: e.path, error: '切分后无内容' });
      continue;
    }

    // 先写新全 chunk（bulkVectorize + upsertRelation + local KB）
    const vec = await bulkVectorize(entries, args.scope, {
      timeoutMs: 60_000 + entries.length * 10_000,
    });
    const okIds: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const en = entries[i];
      const memoryId = vec.ok.get(en.path);
      if (!memoryId) {
        const err = vec.errors.find((er) => er.path === en.path);
        errors.push({ path: en.path, error: `[${isModify ? 'modify' : 'add'}] ${err?.error || '向量化失败'}` });
        continue;
      }
      okIds.push(memoryId);
      ensureGroupPathInTree(groupIndex, en.groupPath);
      groupsTouched.add(en.groupPath);
      upsertRelation(relationsCache, en.groupPath, en.chunkRelation || deriveRelationText(en.path), en.keywords || [], memoryId, en.path);
      writeLocalKb(args.scope, en.groupPath, en.chunkRelation || deriveRelationText(en.path), en.summary);
    }
    // 路径向量（ki-relation 每条 chunk + ki-path 每 group）
    const pathEntries: PathVectorizeEntry[] = [];
    const groupPathsOfFile = new Set(entries.map((x) => x.groupPath));
    for (const en of entries) {
      pathEntries.push({
        text: buildRelationContent(en.chunkRelation || deriveRelationText(en.path), en.groupPath),
        tag: 'ki-relation',
        scope: args.scope,
        group: en.groupPath,
      });
    }
    for (const gp of groupPathsOfFile) {
      pathEntries.push({ text: buildGroupPathContent(gp), tag: 'ki-path', scope: args.scope });
    }
    if (pathEntries.length > 0) {
      await bulkStorePaths(pathEntries);
    }

    // modified：新 chunk 全部成功后，再删旧全 chunk（写序 D-3/质疑意见2）
    if (isModify) {
      const oldIds = e.memoryIds && e.memoryIds.length > 0 ? e.memoryIds : (e.memoryId ? [e.memoryId] : []);
      if (okIds.length > 0) {
        for (const oldId of oldIds) {
          if (okIds.includes(oldId)) continue; // 新旧 id 相同（内容未变时）跳过
          const del = await deleteMemory(oldId, args.scope, memOpts);
          if (!del.ok) {
            errors.push({ path: e.path, error: `[modify warn] 删旧向量失败 id=${oldId.slice(0, 8)}：${del.error}` });
          }
        }
        // 清理旧 chunk 的 relations-cache / local KB / 路径向量（与 deleted 分支对齐）
        for (const [groupPath, groupData] of Object.entries(relationsCache.groups)) {
          const oldRels = groupData.hot_relations.filter(
            (r) => r.sourcePath && (r.sourcePath === e.path || r.sourcePath.startsWith(e.path + '#'))
          );
          for (const rel of oldRels) {
            const idx = groupData.hot_relations.indexOf(rel);
            if (idx >= 0) groupData.hot_relations.splice(idx, 1);
            groupsTouched.add(groupPath);
            removeFromLocalKb(args.scope, groupPath, rel.text);
            await deletePathVector(buildRelationContent(rel.text, groupPath), 'ki-relation', args.scope);
          }
        }
      } else {
        errors.push({ path: e.path, error: `[modify] 新 chunk 写入失败，保留旧数据待下次重试（okIds 为空）` });
      }
      modified++;
    } else {
      added++;
    }
  }
  logPhaseDone(3, TOTAL_PHASES, `向量化完成：add=${added}, modify=${modified}, errors=${errors.length}`);

  // ── Phase 4: 持久化 + 更新 source.commit ──
  logPhaseStart(4, TOTAL_PHASES, '持久化 + 更新 source ...');
  writeJson(groupIndexPath, groupIndex as unknown as Record<string, unknown>);
  writeJson(relationsCachePath, relationsCache as unknown as Record<string, unknown>);

  const newCommit = getGitHead(sourceDir);
  if (!newCommit) {
    throw new Error(`无法获取 sourceDir 的 git HEAD：${sourceDir}`);
  }
  const newSource = { ...existingSource, commit: newCommit };
  setSource(args.scope, newSource);
  logPhaseDone(4, TOTAL_PHASES, `source 已更新，commit=${newCommit.slice(0, 8)}`);

  const total = diff.stats.added + diff.stats.modified + diff.stats.deleted;
  logSummary(`增量直连完成：total=${total}  added=${added}  modified=${modified}  deleted=${deleted}  errors=${errors.length}`);

  return {
    ok: true,
    action: 'import',
    mode: 'incremental',
    scope: args.scope,
    stats: { total, added, modified, deleted, errors: errors.length },
    errors,
    groups: [...groupsTouched].sort(),
    source: newSource,
    previousCommit: existingSource.commit,
    newCommit,
  };
}
