/**
 * import.ts —— S-04：统一导入命令的核心实现
 *
 * 5 个 Phase：
 *   Phase 1: validateAndNormalize  → 读 ai-results.json，校验 + 补全
 *   Phase 2: bulkVectorize          → 调 mem bulk-store 批量向量化（支持断点续跑）
 *   Phase 3: ensureGroups           → 按 groupPath 建 Group 树
 *   Phase 4: writeRelations         → 写 relations-cache + local KB（含 memoryId/sourcePath）
 *   Phase 5: recordSource           → 写 group-index.source 块（含 git HEAD commit）
 *
 * 仅处理 full 模式；增量模式由 S-06 在此基础上扩展。
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
  type GroupIndexSource,
  type GroupIndex,
} from './scope.js';
import { readJson, writeJson, ensureScopeDir, readGroupIndex } from './store.js';
import { DEFAULT_PARTITION_CONFIG, type PartitionConfig } from './constants.js';
import type { Relation } from './scoring.js';

import { normalizeAiResults, type AiResultsFile, type ScanResultEntry } from './ai-results.js';
import { bulkVectorize, type BatchVectorizeResult } from './batch-vectorize.js';
import {
  buildGroupPathContent,
  buildRelationContent,
  bulkStorePaths,
  type PathVectorizeEntry,
} from './path-vectorize.js';
import {
  readProgressFile,
  writeProgressFile,
  cleanProgressFile,
  validateProgressFile,
  type ProgressEntry,
  logPhaseStart,
  logPhaseDone,
  logInfo,
  logSummary,
} from './progress.js';

// ─── 类型 ───────────────────────────────────────────────

export interface GroupData {
  hot_relations: Relation[];
  keywords: string[];
  max_hot_count: number;
}

export interface RelationsCache {
  version: number;
  scope: string;
  partition_config: PartitionConfig;
  groups: Record<string, GroupData>;
  updatedAt: string | null;
}

export interface ImportContext {
  scope: string;
  sourceDir: string;
  rootName: string;
  entries: ScanResultEntry[];
  /** path → memoryId（成功向量化的条目） */
  memoryMap: Map<string, string>;
  /** Phase 3 创建/确认的 Group 路径（含 rootName 前缀） */
  groups: Set<string>;
  /** mapping 模式：path → relationText（覆盖默认推导） */
  mapping?: Map<string, MappingTarget>;
}

export interface ImportStats {
  total: number;
  vectorized: number;
  errors: number;
}

export interface ImportResult {
  ok: true;
  action: 'import';
  mode: 'full' | 'incremental';
  scope: string;
  stats: ImportStats;
  errors: { path: string; error: string }[];
  groups: string[];
  source: GroupIndexSource;
}

export interface MappingTarget {
  groupPath: string;        // 含 rootName 前缀的完整 group path
  relation: string;
  codeRefs?: string[];
}

interface MappingFileSource {
  file: string;
  relation: string;
  code_refs?: string[];
}
interface MappingFileGroup {
  path: string;
  sources: MappingFileSource[];
}
interface MappingFile {
  root_name?: string;
  groups?: MappingFileGroup[];
}

export interface HandleImportArgs {
  scope: string;
  resultsFile: string;
  /** 强制覆盖 ai-results.meta.sourceDir（一般无需传） */
  sourceDirOverride?: string;
  /** 强制覆盖 ai-results.meta.rootName（一般无需传） */
  rootNameOverride?: string;
  /** mapping 文件路径 */
  mappingFile?: string;
}

// ─── 工具函数 ───────────────────────────────────────────

function trimSlashes(input: string): string {
  return input.replace(/^\/+|\/+$/g, '');
}

function stripMarkdownExtension(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** 从 entry.path 推导 relation 文本（剥 .md + 去掉 markdown 强格式字符） */
function deriveRelationText(filePath: string): string {
  const base = stripMarkdownExtension(path.posix.basename(filePath));
  const cleaned = base.replace(/[*~`]/g, '').trim();
  return cleaned || base;
}

/** 把 commit hash 取出来，失败返回 null */
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

// ─── Group 树构建 ───────────────────────────────────────

// ensureGroupPathInTree 已提取到 scope.ts 作为公共函数

// ─── relations-cache 操作 ───────────────────────────────

function ensureCacheGroup(cache: RelationsCache, groupPath: string): GroupData {
  if (!cache.groups[groupPath]) {
    cache.groups[groupPath] = {
      hot_relations: [],
      keywords: [],
      max_hot_count: (cache.partition_config || DEFAULT_PARTITION_CONFIG).maxHotCount,
    };
  }
  return cache.groups[groupPath];
}

function generateNextId(cache: RelationsCache): string {
  let maxNum = 0;
  for (const data of Object.values(cache.groups)) {
    for (const rel of data.hot_relations) {
      const m = rel.id.match(/^rel_(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
      }
    }
  }
  return `rel_${String(maxNum + 1).padStart(3, '0')}`;
}

/**
 * upsert：以 (groupPath + relationText) 为主键
 * 注意 sourcePath 是更可靠的主键（避免不同目录同名文件冲突），但为兼容
 * 既有 import-kb 行为，仍以 relationText 作为去重维度。
 */
function upsertRelation(
  cache: RelationsCache,
  groupPath: string,
  relationText: string,
  keywords: string[],
  memoryId: string | null | undefined,
  sourcePath: string | null | undefined
): void {
  const groupData = ensureCacheGroup(cache, groupPath);
  let rel = groupData.hot_relations.find((r) => r.text === relationText);

  if (!rel) {
    rel = {
      id: generateNextId(cache),
      text: relationText,
      score: 0,
      useCount: 0,
      lastUsedTime: null,
      isImported: true,
    };
    groupData.hot_relations.push(rel);
  } else {
    // 已存在：刷新为导入态，不做评分回退（与 import-kb 行为一致）
    rel.isImported = true;
  }
  if (memoryId) rel.memoryId = memoryId;
  if (sourcePath) rel.sourcePath = sourcePath;

  // keywords 合并去重到 Group 级
  for (const kw of keywords || []) {
    const t = String(kw).trim();
    if (t && !groupData.keywords.includes(t)) {
      groupData.keywords.push(t);
    }
  }
  const maxKw = (cache.partition_config || DEFAULT_PARTITION_CONFIG).maxKeywordCount;
  if (groupData.keywords.length > maxKw) {
    groupData.keywords.splice(0, groupData.keywords.length - maxKw);
  }
}

// ─── local KB 操作 ───────────────────────────────────────

function loadLocalKb(localKbPath: string): Record<string, unknown> {
  if (!fs.existsSync(localKbPath)) return {};
  return readJson<Record<string, unknown>>(localKbPath) || {};
}

function appendCodeRefs(moduleInfo: string, codeRefs?: string[]): string {
  if (!codeRefs || codeRefs.length === 0) return moduleInfo;
  const refs = codeRefs.map((s) => s.trim()).filter(Boolean);
  if (refs.length === 0) return moduleInfo;
  return `${moduleInfo}\n\n## 代码定位\n${refs.map((r) => `- ${r}`).join('\n')}`;
}

function writeLocalKb(scope: string, groupPath: string, relationText: string, moduleInfo: string): void {
  const localKbPath = getLocalKbDir(scope, groupPath);
  fs.mkdirSync(path.dirname(localKbPath), { recursive: true });
  const localKb = loadLocalKb(localKbPath);
  localKb[relationText] = moduleInfo;
  writeJson(localKbPath, localKb);
}

// ─── mapping 解析 ───────────────────────────────────────

function loadMappingFile(filePath: string, rootName: string): {
  rootName: string;
  byPath: Map<string, MappingTarget>;
} {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as MappingFile;
  const finalRoot = (data.root_name && data.root_name.trim()) || rootName;
  const byPath = new Map<string, MappingTarget>();

  for (const group of data.groups || []) {
    const trimmed = trimSlashes(String(group.path || ''));
    let normalized = trimmed;
    if (trimmed) {
      const segs = trimmed.split('/').filter(Boolean);
      if (segs[0] === finalRoot) {
        // 用户已带 rootName 前缀：去重
        normalized = segs.slice(1).join('/');
      }
    }
    const fullGroupPath = normalized ? `${finalRoot}/${normalized}` : finalRoot;

    for (const src of group.sources || []) {
      const filePosix = toPosix(String(src.file || ''));
      if (!filePosix) continue;
      byPath.set(filePosix, {
        groupPath: fullGroupPath,
        relation: String(src.relation || '').replace(/[*~`]/g, '').trim(),
        codeRefs: src.code_refs,
      });
    }
  }

  return { rootName: finalRoot, byPath };
}

// ─── Phase 实现 ─────────────────────────────────────────

/** Phase 1: 校验 + 归一化 */
function phase1Validate(args: HandleImportArgs): {
  results: AiResultsFile;
  mapping?: Map<string, MappingTarget>;
} {
  const results = normalizeAiResults(args.resultsFile);
  // override
  if (args.sourceDirOverride) results.meta.sourceDir = args.sourceDirOverride;
  if (args.rootNameOverride) results.meta.rootName = args.rootNameOverride;

  // sourceDir 必须存在
  if (!fs.existsSync(results.meta.sourceDir) || !fs.statSync(results.meta.sourceDir).isDirectory()) {
    throw new Error(`meta.sourceDir 不存在或不是目录：${results.meta.sourceDir}`);
  }

  let mapping: Map<string, MappingTarget> | undefined;
  if (args.mappingFile) {
    if (!fs.existsSync(args.mappingFile)) {
      throw new Error(`mapping 文件不存在：${args.mappingFile}`);
    }
    const m = loadMappingFile(args.mappingFile, results.meta.rootName);
    // mapping 中的 root_name 优先级最高
    results.meta.rootName = m.rootName;
    mapping = m.byPath;
  }

  return { results, mapping };
}

/** Phase 2: 批量向量化（使用 bulk-store + 断点续跑）*/
function phase2Vectorize(
  entries: ScanResultEntry[],
  scope: string,
  rootName: string,
  totalPhases: number
): {
  vec: BatchVectorizeResult;
  skippedFromProgress: Map<string, string>; // path → memoryId（从进度文件恢复的）
  newProgressEntries: ProgressEntry[];
} {
  const skippedFromProgress = new Map<string, string>();
  const newProgressEntries: ProgressEntry[] = [];

  // 检查进度文件（断点续跑）
  const existingProgress = validateProgressFile(
    readProgressFile(scope),
    scope,
    'full',
    rootName
  );

  let skipCount = 0;
  if (existingProgress && existingProgress.completed.length > 0) {
    for (const entry of existingProgress.completed) {
      skippedFromProgress.set(entry.path, entry.memoryId);
    }
    skipCount = skippedFromProgress.size;
    logInfo(`发现进度文件，跳过已完成: ${skipCount} 条`);
  }

  // 过滤掉 action=delete 的条目
  const allToVectorize = entries.filter((e) => e.action !== 'delete');
  // 过滤掉进度文件中已完成的条目
  const needVectorize = allToVectorize.filter((e) => !skippedFromProgress.has(e.path));

  logPhaseStart(2, totalPhases, `批量向量化（${allToVectorize.length} 条${skipCount > 0 ? `，${skipCount} 已跳过` : ''}）...`);

  let vec: BatchVectorizeResult;

  if (needVectorize.length === 0) {
    // 所有条目已向量量化
    vec = { ok: new Map(), errors: [] };
    logPhaseDone(2, totalPhases, `全部已跳过，无需向量化`);
  } else {
    vec = bulkVectorize(needVectorize, scope, { timeoutMs: 60_000 + needVectorize.length * 10_000 });

    // 构建新完成的进度条目
    for (const [p, mid] of vec.ok) {
      const entry = needVectorize.find((e) => e.path === p);
      if (entry) {
        newProgressEntries.push({
          path: entry.path,
          groupPath: entry.groupPath,
          relation: deriveRelationText(entry.path),
          memoryId: mid,
        });
      }
    }

    logPhaseDone(2, totalPhases, `向量化完成：新增 ${vec.ok.size}，失败 ${vec.errors.length}${skipCount > 0 ? `，跳过 ${skipCount}` : ''}`);
  }

  // 合并 memoryMap 并写入进度文件
  const mergedCompleted: ProgressEntry[] = [
    ...(existingProgress?.completed || []),
    ...newProgressEntries,
  ];
  writeProgressFile(scope, {
    scope,
    mode: 'full',
    rootName,
    startedAt: existingProgress?.startedAt || new Date().toISOString(),
    total: allToVectorize.length,
    completed: mergedCompleted,
  });

  return { vec, skippedFromProgress, newProgressEntries };
}

/** Phase 3: ensure groups */
function phase3EnsureGroups(
  ctx: ImportContext,
  groupIndex: GroupIndex
): void {
  for (const e of ctx.entries) {
    const target = ctx.mapping?.get(e.path);
    const groupPath = target ? target.groupPath : e.groupPath;
    ensureGroupPathInTree(groupIndex, groupPath);
    ctx.groups.add(groupPath);
  }
}

/** Phase 4: 写 relations-cache + local KB */
function phase4WriteRelations(
  ctx: ImportContext,
  cache: RelationsCache
): void {
  for (const e of ctx.entries) {
    if (e.action === 'delete') continue;
    const memoryId = ctx.memoryMap.get(e.path) || e.memoryId || null;

    const target = ctx.mapping?.get(e.path);
    const groupPath = target ? target.groupPath : e.groupPath;
    const relationText = target?.relation || deriveRelationText(e.path);

    upsertRelation(cache, groupPath, relationText, e.keywords || [], memoryId, e.path);

    // local KB 写文件实体
    const absPath = path.resolve(ctx.sourceDir, e.path);
    let moduleInfo: string;
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      moduleInfo = fs.readFileSync(absPath, 'utf-8');
    } else {
      // 文件不存在时退化为只用 summary，避免 fail
      moduleInfo = e.summary || '';
    }
    if (target?.codeRefs) {
      moduleInfo = appendCodeRefs(moduleInfo, target.codeRefs);
    }
    writeLocalKb(ctx.scope, groupPath, relationText, moduleInfo);
  }
}

/** Phase 5: 记录 source */
function phase5RecordSource(scope: string, sourceDir: string, rootName: string): GroupIndexSource {
  const head = getGitHead(sourceDir);
  if (!head) {
    throw new Error(`source.dir 不在 git 仓库中或无法获取 HEAD：${sourceDir}`);
  }
  const source: GroupIndexSource = {
    dir: path.resolve(sourceDir),
    rootName,
    commit: head,
  };
  setSource(scope, source);
  return source;
}

// ─── 主入口 ─────────────────────────────────────────────

const TOTAL_PHASES = 5;

export function handleImport(args: HandleImportArgs): ImportResult {
  // 0) 准备 scope 目录
  ensureScopeDir(args.scope);

  // Phase 1: 校验 + 归一化
  logPhaseStart(1, TOTAL_PHASES, '校验 ai-results.json ...');
  const { results, mapping } = phase1Validate(args);
  const total = results.entries.length;
  logPhaseDone(1, TOTAL_PHASES, `校验通过，共 ${total} 条条目，rootName="${results.meta.rootName}"`);

  // Phase 2: 批量向量化（含断点续跑）
  const { vec, skippedFromProgress } = phase2Vectorize(
    results.entries,
    args.scope,
    results.meta.rootName,
    TOTAL_PHASES
  );

  // 合并 memoryMap：进度文件恢复的 + 本次新向量化的
  const mergedMap = new Map([...skippedFromProgress, ...vec.ok]);
  const skipCount = skippedFromProgress.size;

  // ── 路径向量写入（ki-path + ki-relation）──
  const pathEntries: PathVectorizeEntry[] = [];
  const groupKeywordsMap = new Map<string, Set<string>>();

  for (const e of results.entries) {
    if (e.action === 'delete') continue;
    const target = mapping?.get(e.path);
    const groupPath = target ? target.groupPath : e.groupPath;
    const relationText = target?.relation || deriveRelationText(e.path);
    const keywords = e.keywords || [];

    // 收集每个 Group 的关键词（去重）
    if (!groupKeywordsMap.has(groupPath)) groupKeywordsMap.set(groupPath, new Set());
    const kwSet = groupKeywordsMap.get(groupPath)!;
    for (const kw of keywords) kwSet.add(String(kw).trim());

    // ki-relation 向量
    pathEntries.push({
      text: buildRelationContent(relationText, groupPath, keywords),
      tag: 'ki-relation',
      scope: args.scope,
    });
  }

  // ki-path 向量（每个 Group 一条，合并关键词）
  for (const [groupPath, kwSet] of groupKeywordsMap) {
    pathEntries.push({
      text: buildGroupPathContent(groupPath, [...kwSet]),
      tag: 'ki-path',
      scope: args.scope,
    });
  }

  if (pathEntries.length > 0) {
    logInfo(`写入路径向量索引（${pathEntries.length} 条）...`);
    const pathResult = bulkStorePaths(pathEntries);
    if (pathResult.errors.length > 0) {
      logInfo(`路径向量写入：成功 ${pathResult.ok.size}，失败 ${pathResult.errors.length}`);
    }
  }

  const ctx: ImportContext = {
    scope: args.scope,
    sourceDir: results.meta.sourceDir,
    rootName: results.meta.rootName,
    entries: results.entries,
    memoryMap: mergedMap,
    groups: new Set<string>(),
    mapping,
  };

  // 读取 group-index + relations-cache
  const groupIndexPath = getGroupIndexPath(args.scope);
  const relationsCachePath = getRelationsCachePath(args.scope);
  const groupIndex = readGroupIndex(args.scope);
  const relationsCache = readJson<RelationsCache>(relationsCachePath);
  if (!groupIndex || !relationsCache) {
    throw new Error('scope 初始化失败：缺少 group-index.json 或 relations-cache.json');
  }

  // Phase 3: 构建 Group 树
  logPhaseStart(3, TOTAL_PHASES, '构建 Group 树 ...');
  phase3EnsureGroups(ctx, groupIndex);
  logPhaseDone(3, TOTAL_PHASES, `Group 树构建完成，涉及 ${ctx.groups.size} 个 Group`);

  // Phase 4 — 只处理向量化成功（或本身不需向量化）的条目
  const successfulEntries = ctx.entries.filter((e) => {
    if (e.action === 'delete') return false;
    return ctx.memoryMap.has(e.path);
  });
  ctx.entries = successfulEntries;
  logPhaseStart(4, TOTAL_PHASES, `写入元数据（${ctx.entries.length} 条 relations + local KB）...`);
  phase4WriteRelations(ctx, relationsCache);

  // 持久化
  writeJson(groupIndexPath, groupIndex as unknown as Record<string, unknown>);
  writeJson(relationsCachePath, relationsCache as unknown as Record<string, unknown>);
  logPhaseDone(4, TOTAL_PHASES, '元数据写入完成');

  // Phase 5: 记录 source
  logPhaseStart(5, TOTAL_PHASES, '记录 source commit ...');
  const source = phase5RecordSource(args.scope, results.meta.sourceDir, results.meta.rootName);
  logPhaseDone(5, TOTAL_PHASES, `source 已记录，commit=${source.commit.slice(0, 8)}`);

  // 成功完成，清理进度文件（REQ-04）
  cleanProgressFile(args.scope);

  logSummary(`导入完成：total=${total}  vectorized=${mergedMap.size}  skipped=${skipCount}  errors=${vec.errors.length}`);

  return {
    ok: true,
    action: 'import',
    mode: 'full',
    scope: args.scope,
    stats: {
      total,
      vectorized: mergedMap.size,
      errors: vec.errors.length,
    },
    errors: vec.errors,
    groups: [...ctx.groups].sort(),
    source,
  };
}
