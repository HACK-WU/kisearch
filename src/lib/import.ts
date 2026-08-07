/**
 * import.ts —— S-04：统一导入命令的核心实现（直导模式）
 *
 * 批次 3（REQ-04）删除 ai-results.json 输入契约后，本文件仅保留直导链路：
 *   Phase 2: bulkVectorize       → 调 vectorBulkStore 批量向量化
 *   Phase 3: ensureGroups        → 按 groupPath 建 Group 树
 *   Phase 4: writeRelations      → 写 relations-cache + local KB（含 memoryId/sourcePath）
 *   Phase 5: recordSource        → 写 group-index.source 块（含 git HEAD commit + 切分参数）
 *
 * 仅处理 full 模式；增量直连由 S-06（incremental.ts）基于 git diff 驱动。
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  getGroupIndexPath,
  getRelationsCachePath,
  getLocalKbDir,
  setSource,
  ensureGroupPathInTree,
  type GroupIndexSource,
  type GroupIndex,
} from './scope.js';
import { readJson, writeJson, ensureScopeDir, readGroupIndex } from './store.js';
import { DEFAULT_PARTITION_CONFIG, type PartitionConfig } from './constants.js';
import type { Relation } from './scoring.js';
import { splitIntoChunks, MAX_CHUNKS_PER_FILE, type Chunk } from './chunker.js';

import { deriveGroupPath, type ScanResultEntry } from './ai-results.js';
import { bulkVectorize, type BatchVectorizeResult } from './batch-vectorize.js';
import {
  buildGroupPathContent,
  buildRelationContent,
  bulkStorePaths,
  type PathVectorizeEntry,
} from './path-vectorize.js';
import {
  logPhaseStart,
  logPhaseDone,
  logProgress,
  logInfo,
  logWarn,
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

export interface HandleDirectImportArgs {
  scope: string;
  /** 外部 Wiki 根目录（绝对路径） */
  sourceDir: string;
  /** 导入根节点名称（= groupPath 首段） */
  rootName: string;
  /** 切分参数：目标长度（字符），默认 1000 */
  chunkSize?: number;
  /** 切分参数：重叠字符数，默认 150 */
  chunkOverlap?: number;
  /** 单文件大小上限（字节），超限跳过并告警；默认 2MB */
  maxFileSizeBytes?: number;
}

// ─── 工具函数 ───────────────────────────────────────────

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

// ─── 直导（原文直导 + 切分）工具 ─────────────────────────

/** 递归收集 sourceDir 下的 .md 文件（相对路径，posix 风格） */
function collectMarkdownFiles(sourceDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过隐藏目录与备份目录
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(abs);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        out.push(toPosix(path.relative(sourceDir, abs)));
      }
    }
  };
  walk(sourceDir);
  return out.sort();
}

/** chunk relation 命名：文件名-N（如 foo.md → foo-01），`#` 避免与 isUnsafeRelationName 冲突 */
export function deriveChunkRelation(filePath: string, chunkIndex: number): string {
  const base = deriveRelationText(filePath);
  return `${base}-${String(chunkIndex).padStart(2, '0')}`;
}

/** chunk 的 sourcePath：文件路径#序号（如 docs/foo.md#1），文件级 diff 前缀聚合的键 */
export function deriveChunkSourcePath(filePath: string, chunkIndex: number): string {
  return `${toPosix(filePath)}#${chunkIndex}`;
}

/** 读取文件内容并按参数切分；未超限返回单 chunk */
export function readFileToChunks(absPath: string, chunkSize: number, chunkOverlap: number): Chunk[] {
  const text = fs.readFileSync(absPath, 'utf-8');
  return splitIntoChunks(text, { chunkSize, chunkOverlap });
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

/** 直导入口：把 sourceDir 下的 Markdown 目录直接导入（无 AI 依赖） */
export async function handleDirectImport(
  args: HandleDirectImportArgs
): Promise<ImportResult> {
  const scope = args.scope;
  const sourceDir = path.resolve(args.sourceDir);
  const rootName = args.rootName.trim();
  const chunkSize = args.chunkSize ?? 1000;
  const chunkOverlap = args.chunkOverlap ?? 150;
  const maxFileSizeBytes = args.maxFileSizeBytes ?? 2 * 1024 * 1024;

  if (!rootName) throw new Error('rootName 不能为空');
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`sourceDir 不存在或不是目录：${sourceDir}`);
  }

  // 0) 准备 scope 目录 + 收集文件
  ensureScopeDir(scope);
  const files = collectMarkdownFiles(sourceDir);
  if (files.length === 0) {
    throw new Error(`目录下未发现 .md 文件：${sourceDir}`);
  }

  logInfo(`扫描到 ${files.length} 个 .md 文件（chunkSize=${chunkSize}, overlap=${chunkOverlap}）`);

  // 1) 逐文件读 + 切分 → 构造瘦身 ScanResultEntry（原文直导：text=chunk 原文）
  const entries: ScanResultEntry[] = [];
  const skipped: string[] = [];
  for (const rel of files) {
    const absPath = path.resolve(sourceDir, rel);
    const stat = fs.statSync(absPath);
    if (stat.size > maxFileSizeBytes) {
      skipped.push(rel);
      logWarn(`文件过大已跳过（${stat.size} bytes > ${maxFileSizeBytes}）：${rel}，可手动切分后导入`);
      continue;
    }
    const chunks = readFileToChunks(absPath, chunkSize, chunkOverlap);
    if (chunks.length > MAX_CHUNKS_PER_FILE) {
      skipped.push(rel);
      logWarn(`文件切分 chunk 数超限已跳过（${chunks.length} > ${MAX_CHUNKS_PER_FILE}）：${rel}，可增大 --chunk-size 或手动拆分后导入`);
      continue;
    }
    for (const chunk of chunks) {
      entries.push({
        path: deriveChunkSourcePath(rel, chunk.index), // sourcePath = 文件#N
        groupPath: deriveGroupPath(rootName, rel),
        text: chunk.text, // 原文直导：content = chunk 原文
        memoryId: null,
        chunkRelation: deriveChunkRelation(rel, chunk.index), // relation = 文件名-N
      });
    }
    logProgress(entries.length, files.length * 10, rel); // 粗粒度进度
  }
  if (skipped.length > 0) {
    logWarn(`跳过 ${skipped.length} 个超大文件`);
  }

  logInfo(`切分完成：共 ${entries.length} 个 chunk（来自 ${files.length} 个文件）`);

  // 2) Phase 2~5
  const TOTAL = 5;
  const memoryMap = new Map<string, string>();

  // ── 预构建路径向量条目（ki-relation 每个 chunk 一条 + ki-path 每 group 一条）──
  const pathEntries: PathVectorizeEntry[] = [];
  const groupSet = new Set<string>();
  for (const e of entries) {
    const groupPath = e.groupPath;
    groupSet.add(groupPath);
    pathEntries.push({
      text: buildRelationContent(e.chunkRelation || deriveChunkRelation(e.path.split('#')[0], Number(e.path.split('#')[1])), groupPath),
      tag: 'ki-relation',
      scope,
      group: groupPath,
    });
  }
  for (const groupPath of groupSet) {
    pathEntries.push({
      text: buildGroupPathContent(groupPath),
      tag: 'ki-path',
      scope,
    });
  }

  // ── 预读 group-index + relations-cache ──
  const groupIndexPath = getGroupIndexPath(scope);
  const relationsCachePath = getRelationsCachePath(scope);
  const groupIndex = readGroupIndex(scope);
  const relationsCache = readJson<RelationsCache>(relationsCachePath);
  if (!groupIndex || !relationsCache) {
    throw new Error(`scope 初始化异常：基础索引文件缺失，请删除 scope 目录后重新 import 或从 _template/ 复制`);
  }

  // ── Phase 2（向量化）与 Phase 3/4（KB）并行 ──
  const [vectorizeResult, kbResult] = await Promise.all([
    (async () => {
      const vec = await bulkVectorize(entries, scope, {
        timeoutMs: 60_000 + entries.length * 10_000,
      });
      if (pathEntries.length > 0) {
        const pathResult = await bulkStorePaths(pathEntries);
        logInfo(`路径向量写入完成：成功 ${pathResult.ok.size}，失败 ${pathResult.errors.length}`);
      }
      return vec;
    })(),
    (async () => {
      const ctx: ImportContext = {
        scope,
        sourceDir,
        rootName,
        entries,
        memoryMap,
        groups: new Set<string>([rootName]),
      };
      logPhaseStart(3, TOTAL, '构建 Group 树 ...');
      phase3EnsureGroups(ctx, groupIndex);
      logPhaseDone(3, TOTAL, `Group 树构建完成，涉及 ${ctx.groups.size} 个 Group`);

      logPhaseStart(4, TOTAL, `写入元数据（${ctx.entries.length} 条 relations + local KB）...`);
      phase4WriteRelations(ctx, relationsCache);
      writeJson(groupIndexPath, groupIndex as unknown as Record<string, unknown>);
      writeJson(relationsCachePath, relationsCache as unknown as Record<string, unknown>);
      logPhaseDone(4, TOTAL, '元数据写入完成');
      return ctx;
    })(),
  ]);

  // 回填真实 docId 到 relations-cache（memoryId）
  const mergedMap = vectorizeResult.ok;
  if (mergedMap.size > 0) {
    for (const groupData of Object.values(relationsCache.groups)) {
      for (const rel of groupData.hot_relations) {
        const docId = rel.sourcePath ? mergedMap.get(rel.sourcePath) : undefined;
        if (docId) rel.memoryId = docId;
      }
    }
    writeJson(relationsCachePath, relationsCache as unknown as Record<string, unknown>);
  }

  // Phase 5: 记录 source（含切分参数持久化 H-18；无 git 时全量直导可容忍——增量才强依赖 git）
  logPhaseStart(5, TOTAL, '记录 source commit ...');
  const head = getGitHead(sourceDir);
  const source: GroupIndexSource = {
    dir: sourceDir,
    rootName,
    commit: head || '',
    chunkSize,
    chunkOverlap,
  };
  setSource(scope, source);
  logPhaseDone(5, TOTAL, `source 已记录${head ? `，commit=${head.slice(0, 8)}` : '（非 git 仓库，commit 为空）'}`);

  // scope 未配置 sourceDir 时写入绝对路径（H-20）
  try {
    const { setScopeSourceDir } = await import('./config.js');
    const wrote = setScopeSourceDir(scope, sourceDir);
    if (wrote) {
      logInfo(`已写入 scope sourceDir（绝对路径）：${sourceDir}`);
    }
  } catch { /* 写入失败不阻断 */ }

  logSummary(`直导完成：files=${files.length}  chunks=${entries.length}  vectorized=${mergedMap.size}  errors=${vectorizeResult.errors.length}`);

  return {
    ok: true,
    action: 'import',
    mode: 'full',
    scope,
    stats: {
      total: entries.length,
      vectorized: mergedMap.size,
      errors: vectorizeResult.errors.length,
    },
    errors: vectorizeResult.errors,
    groups: [...kbResult.groups].sort(),
    source,
  };
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
 * REQ-05（批次 3）：不再写入 keywords / isFullText（旧数据字段只读兼容）
 */
function upsertRelation(
  cache: RelationsCache,
  groupPath: string,
  relationText: string,
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
}

// ─── local KB 操作 ───────────────────────────────────────

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

// ─── Phase 实现 ─────────────────────────────────────────

/** Phase 3: ensure groups */
function phase3EnsureGroups(
  ctx: ImportContext,
  groupIndex: GroupIndex
): void {
  for (const e of ctx.entries) {
    ensureGroupPathInTree(groupIndex, e.groupPath);
    // 将完整路径及所有父级都加入 groups（如 'wiki/部署运维' → 'wiki' + 'wiki/部署运维'）
    const segments = e.groupPath.split('/').filter(Boolean);
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
    logProgress(i + 1, total, e.path);
    const memoryId = ctx.memoryMap.get(e.path) || e.memoryId || null;

    const groupPath = e.groupPath;
    const relationText = e.chunkRelation || deriveRelationText(e.path);

    upsertRelation(cache, groupPath, relationText, memoryId, e.path);

    // local KB 写文件实体
    const absPath = path.resolve(ctx.sourceDir, e.path);
    let moduleInfo: string;
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      moduleInfo = fs.readFileSync(absPath, 'utf-8');
    } else {
      // 文件不存在时退化为只用 text，避免 fail
      moduleInfo = e.text || '';
    }
    writeLocalKb(ctx.scope, groupPath, relationText, moduleInfo);
  }
}
