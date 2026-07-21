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
  logProgress,
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
  // 持久化真实 docId（zvec 中删除向量的唯一钥匙）：供后续 diff → 增量 modify/delete 关联旧向量
  // 与 incremental.upsertRelation 对称；向量化失败时 memoryId 为 null，保留旧值不覆盖
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
async function phase2Vectorize(
  entries: ScanResultEntry[],
  scope: string,
  rootName: string,
  totalPhases: number
): Promise<{
  vec: BatchVectorizeResult;
  skippedFromProgress: Map<string, string>; // path → memoryId（从进度文件恢复的）
  newProgressEntries: ProgressEntry[];
}> {
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

  // 增量写入进度文件的辅助函数
  const startedAt = existingProgress?.startedAt || new Date().toISOString();
  let lastSaveCount = 0;
  const SAVE_INTERVAL = 5; // 每完成 5 条写一次进度文件

  function saveProgressIncrement() {
    const merged: ProgressEntry[] = [
      ...(existingProgress?.completed || []),
      ...newProgressEntries,
    ];
    writeProgressFile(scope, {
      scope,
      mode: 'full',
      rootName,
      startedAt,
      total: allToVectorize.length,
      completed: merged,
    });
    lastSaveCount = newProgressEntries.length;
  }

  // SIGINT 处理：中断时保存已有进度
  const sigintHandler = () => {
    if (newProgressEntries.length > lastSaveCount) {
      saveProgressIncrement();
    }
    process.stderr.write(`\n⚠ 中断：已保存 ${newProgressEntries.length} 条向量化进度，重新执行 import 可从断点继续\n`);
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  let vec: BatchVectorizeResult;

  if (needVectorize.length === 0) {
    // 所有条目已向量量化
    vec = { ok: new Map(), errors: [] };
    logPhaseDone(2, totalPhases, `全部已跳过，无需向量化`);
  } else {
    // entry lookup map for onProgress callback
    const entryLookup = new Map(needVectorize.map((e) => [e.path, e]));

    vec = await bulkVectorize(needVectorize, scope, {
      timeoutMs: 60_000 + needVectorize.length * 10_000,
      onProgress: (completed, _failedCount) => {
        // 从回调结果中提取新增的条目（只添加尚未在 newProgressEntries 中的）
        const currentPaths = new Set(newProgressEntries.map((e) => e.path));
        for (const { path: p, memoryId } of completed) {
          if (currentPaths.has(p)) continue;
          const entry = entryLookup.get(p);
          if (entry) {
            newProgressEntries.push({
              path: entry.path,
              groupPath: entry.groupPath,
              relation: deriveRelationText(entry.path),
              memoryId,
            });
            currentPaths.add(p);
          }
        }
        // 每 N 条增量写入进度文件
        if (newProgressEntries.length - lastSaveCount >= SAVE_INTERVAL) {
          saveProgressIncrement();
        }
      },
    });

    // 最终补充：将 vec.ok 中可能漏掉的条目也加入（容错）
    const finalPaths = new Set(newProgressEntries.map((e) => e.path));
    for (const [p, mid] of vec.ok) {
      if (finalPaths.has(p)) continue;
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

  // 移除 SIGINT 处理器
  process.removeListener('SIGINT', sigintHandler);

  // 最终写入进度文件
  saveProgressIncrement();

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
    // 将完整路径及所有父级都加入 groups（如 'wiki/部署运维' → 'wiki' + 'wiki/部署运维'）
    const segments = groupPath.split('/').filter(Boolean);
    for (let i = 1; i <= segments.length; i++) {
      ctx.groups.add(segments.slice(0, i).join('/'));
    }
  }
}

/** Phase 4: 写 relations-cache + local KB */
function phase4WriteRelations(
  ctx: ImportContext,
  cache: RelationsCache
): void {
  const total = ctx.entries.length;
  for (let i = 0; i < ctx.entries.length; i++) {
    const e = ctx.entries[i];
    if (e.action === 'delete') continue;
    logProgress(i + 1, total, e.path);
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

export async function handleImport(args: HandleImportArgs): Promise<ImportResult> {
  // 0) 准备 scope 目录
  ensureScopeDir(args.scope);

  // Phase 1: 校验 + 归一化
  logPhaseStart(1, TOTAL_PHASES, '校验 ai-results.json ...');
  const { results, mapping } = phase1Validate(args);
  const total = results.entries.length;
  logPhaseDone(1, TOTAL_PHASES, `校验通过，共 ${total} 条条目，rootName="${results.meta.rootName}"`);

  // Phase 2: 批量向量化（含断点续跑）
  // Phase 2 与 Phase 3/4 并行执行，消除串行阻塞

  // ── 预构建路径向量条目（仅依赖 Phase 1 结果，可提前计算）──
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

  // ── 预读取 group-index + relations-cache（两分支共享）──
  const groupIndexPath = getGroupIndexPath(args.scope);
  const relationsCachePath = getRelationsCachePath(args.scope);
  const groupIndex = readGroupIndex(args.scope);
  const relationsCache = readJson<RelationsCache>(relationsCachePath);
  if (!groupIndex || !relationsCache) {
    const missing: string[] = [];
    if (!groupIndex) missing.push(`group-index.json 不存在：${groupIndexPath}`);
    if (!relationsCache) missing.push(`relations-cache.json 不存在：${relationsCachePath}`);
    throw new Error(
      `scope 初始化异常：基础索引文件缺失\n` +
      missing.join('\n') + '\n' +
      `修复：删除 scope 目录后重新执行 import 命令，或手动从 _template/ 复制模板文件`
    );
  }

  // ── Phase 2 与 Phase 3/4 并行执行 ──
  const [vectorizeResult, kbResult] = await Promise.all([
    // 分支 A: 向量化 + 路径向量写入
    (async () => {
      const { vec, skippedFromProgress } = await phase2Vectorize(
        results.entries,
        args.scope,
        results.meta.rootName,
        TOTAL_PHASES
      );

      // 路径向量写入
      if (pathEntries.length > 0) {
        logInfo(`写入路径向量索引（${pathEntries.length} 条）...`);
        const pathResult = await bulkStorePaths(pathEntries);
        logInfo(`路径向量写入完成：成功 ${pathResult.ok.size}，失败 ${pathResult.errors.length}`);
      }

      return { vec, skippedFromProgress };
    })(),

    // 分支 B: Group 树 + KB 写入
    (async () => {
      const ctx: ImportContext = {
        scope: args.scope,
        sourceDir: results.meta.sourceDir,
        rootName: results.meta.rootName,
        entries: results.entries,
        memoryMap: new Map(), // Phase 3/4 不再依赖 memoryMap（S-03 已移除 memoryId 写入）
        groups: new Set<string>([results.meta.rootName]),
        mapping,
      };

      // Phase 3: 构建 Group 树
      logPhaseStart(3, TOTAL_PHASES, '构建 Group 树 ...');
      phase3EnsureGroups(ctx, groupIndex);
      logPhaseDone(3, TOTAL_PHASES, `Group 树构建完成，涉及 ${ctx.groups.size} 个 Group`);

      // Phase 4: 写入 relations-cache + local KB
      // 行为变更：所有非 delete 条目都写入 relations-cache（向量化失败不影响 KB 通道）
      const validEntries = ctx.entries.filter((e) => e.action !== 'delete');
      ctx.entries = validEntries;
      logPhaseStart(4, TOTAL_PHASES, `写入元数据（${ctx.entries.length} 条 relations + local KB）...`);
      phase4WriteRelations(ctx, relationsCache);

      // 持久化
      writeJson(groupIndexPath, groupIndex as unknown as Record<string, unknown>);
      writeJson(relationsCachePath, relationsCache as unknown as Record<string, unknown>);
      logPhaseDone(4, TOTAL_PHASES, '元数据写入完成');

      return { ctx, groupIndex };
    })(),
  ]);

  // 合并 memoryMap：进度文件恢复的 + 本次新向量化的
  const mergedMap = new Map([...vectorizeResult.skippedFromProgress, ...vectorizeResult.vec.ok]);
  const skipCount = vectorizeResult.skippedFromProgress.size;

  const ctx = kbResult.ctx;

  // 回填真实 docId 到 relations-cache：Phase 2（向量化，产出 docId）与 Phase 4（写 cache）并行执行，
  // docId 仅在 Promise.all 结束后才汇集到 mergedMap，故此处补一次 memoryId 回填并重新持久化，
  // 使后续 diff → 增量 modify/delete 能定位旧向量（docId 是 zvec 删除向量的唯一钥匙）。
  if (mergedMap.size > 0) {
    for (const groupData of Object.values(relationsCache.groups)) {
      for (const rel of groupData.hot_relations) {
        const docId = rel.sourcePath ? mergedMap.get(rel.sourcePath) : undefined;
        if (docId) rel.memoryId = docId;
      }
    }
    writeJson(relationsCachePath, relationsCache as unknown as Record<string, unknown>);
  }

  // Phase 5: 记录 source
  logPhaseStart(5, TOTAL_PHASES, '记录 source commit ...');
  const source = phase5RecordSource(args.scope, results.meta.sourceDir, results.meta.rootName);
  logPhaseDone(5, TOTAL_PHASES, `source 已记录，commit=${source.commit.slice(0, 8)}`);

  // 成功完成，清理进度文件（REQ-04）
  cleanProgressFile(args.scope);

  logSummary(`导入完成：total=${total}  vectorized=${mergedMap.size}  skipped=${skipCount}  errors=${vectorizeResult.vec.errors.length}`);

  return {
    ok: true,
    action: 'import',
    mode: 'full',
    scope: args.scope,
    stats: {
      total,
      vectorized: mergedMap.size,
      errors: vectorizeResult.vec.errors.length,
    },
    errors: vectorizeResult.vec.errors,
    groups: [...ctx.groups].sort(),
    source,
  };
}
