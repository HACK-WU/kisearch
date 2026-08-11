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
import { DEFAULT_PARTITION_CONFIG, parseContentTags, type PartitionConfig } from './constants.js';
import type { Relation } from './scoring.js';
import { splitIntoChunks, MAX_CHUNKS_PER_FILE, type Chunk } from './chunker.js';

import { deriveGroupPath, type ScanResultEntry } from './ai-results.js';
import { bulkVectorize } from './batch-vectorize.js';
import { cleanMarkdownText, runCleanHooks, type CleanRules } from './clean.js';
import { acquireImportLock, releaseImportLock, clearImportLock, writeInterruptMark } from './interrupt.js';
import {
  buildGroupPathContent,
  buildRelationContent,
  bulkStorePaths,
  type PathVectorizeEntry,
} from './path-vectorize.js';
import { vectorBulkStore } from './vector-client.js';
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
  /** 被跳过的文件数（过大 / chunk 超限），结构化输出可观测（体验修复） */
  skipped: number;
  /** 是否写入向量层（false = 非向量化模式 --no-vector，仅 KB 层） */
  vector: boolean;
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
  /** 非向量化模式：仅写 KB 层（relations-cache + local KB），跳过向量写入；默认 true */
  vector?: boolean;
  /** 清洗总开关（false = --no-clean，关闭全部清洗含 hooks）；默认 true */
  cleanEnabled?: boolean;
  /** 内置清洗规则覆盖（--clean-rules 解析结果） */
  cleanRules?: Partial<import('./clean.js').CleanRules>;
  /** 文档级自定义标签（逗号分隔多个）。非向量化时忽略；向量化时为每个导入文件写一条 tag 内容向量 */
  tags?: string;
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

/** 默认格式白名单：.md（REQ-08，可配置扩展 .markdown 等） */
const DEFAULT_EXTENSIONS = ['.md'];

/**
 * 递归收集 sourceDir 下白名单格式文件（相对路径，posix 风格）+ 非白名单跳过统计（REQ-08）
 * @param sourceDir 源目录
 * @param extensions 格式白名单（默认 [.md]）；传空数组时用默认
 * @returns files=白名单文件列表；skippedNonMd=非白名单文件相对路径列表（汇总提示用）
 */
function collectMarkdownFiles(sourceDir: string, extensions: string[] = DEFAULT_EXTENSIONS): { files: string[]; skippedNonMd: string[] } {
  const out: string[] = [];
  const skippedNonMd: string[] = [];
  const exts = extensions.length > 0 ? extensions.map((e) => e.toLowerCase()) : DEFAULT_EXTENSIONS;
  const isAllowed = (name: string): boolean => exts.some((e) => name.toLowerCase().endsWith(e));

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过隐藏目录与备份目录
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(abs);
      } else if (entry.isFile()) {
        if (isAllowed(entry.name)) {
          out.push(toPosix(path.relative(sourceDir, abs)));
        } else {
          // 非白名单文件：跳过并汇总（REQ-08；隐藏文件/临时文件不报）
          if (!entry.name.startsWith('.')) skippedNonMd.push(toPosix(path.relative(sourceDir, abs)));
        }
      }
    }
  };
  walk(sourceDir);
  return { files: out.sort(), skippedNonMd };
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
  return splitIntoChunks(text, { chunkSize, overlap: chunkOverlap });
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

/** 直导入口：把 sourceDir 下的 Markdown 目录直接导入（无 AI 依赖，方案 D：local KB 文件原文 + memoryIds 多值） */
export async function handleDirectImport(
  args: HandleDirectImportArgs
): Promise<ImportResult> {
  const scope = args.scope;
  const sourceDir = path.resolve(args.sourceDir);
  const rootName = args.rootName.trim();
  const chunkSize = args.chunkSize ?? 1000;
  const chunkOverlap = args.chunkOverlap ?? 150;
  const vector = args.vector !== false;
  // 清洗开关：--no-clean 关闭全部；--clean-rules 覆盖内置规则（批次 3 接入实际清洗）
  const cleanEnabled = args.cleanEnabled !== false;
  const cleanRules: CleanRules | undefined = args.cleanRules;
  // 文档级自定义标签：逗号分隔、去空、去重、过滤内部保留 tag（ki-search/ki-relation/ki-path）
  const customTags = parseContentTags(args.tags);

  if (!rootName) throw new Error('rootName 不能为空');
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`sourceDir 不存在或不是目录：${sourceDir}`);
  }

  // 0) 准备 scope 目录 + 并发锁 + 信号捕获 + 预读索引（REQ-01/02，N4）
  //    REQ-08：格式白名单 + 大小上限从 config scopes.<scope>.import 读取（默认 .md / 1MB）
  ensureScopeDir(scope);
  // 并发导入锁（N4）：同 scope 并发导入拒绝；SIGKILL 残留锁自动清理
  if (!acquireImportLock(scope)) {
    throw new Error(`scope "${scope}" 已有导入进行中（import.lock 存在），请等待完成或清理锁文件后重试`);
  }
  // REQ-01：SIGINT/SIGTERM 捕获 → 写中断标记 + 明确提示；SIGKILL 不可捕获由 probe 兜底（双路径）
  let interrupted = false;
  /** 中断时可读的进度状态（文件处理循环中更新；信号回调是同步的，无法读异步循环内变量） */
  let importedFileCount = 0;
  let totalFileCount = 0;
  const onInterrupt = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    try {
      writeInterruptMark(scope, { processedFiles: importedFileCount, totalFiles: totalFileCount, signal });
      process.stderr.write(`\n⚠ 导入已中断（${signal}），已写中断标记（已完成 ${importedFileCount}/${totalFileCount} 个文件）。重新导入或执行 ki rebuild-vector 恢复\n`);
      // 中断路径同步清锁（N4：避免 SIGTERM 后 import.lock 残留）；保留中断标记供引导（不清标记）
      clearImportLock(scope);
    } catch { /* 标记/锁清理失败不阻断退出 */ }
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  const { loadConfig, getScopeImportConfig, getScopeCleanConfig } = await import('./config.js');
  const cfg = loadConfig();
  const importCfg = getScopeImportConfig(cfg, scope);
  const extensions = importCfg?.extensions ?? DEFAULT_EXTENSIONS;
  const maxFileSizeBytes = args.maxFileSizeBytes ?? importCfg?.maxFileSize ?? 1024 * 1024; // 默认 1MB（REQ-08）
  // REQ-07：外部清洗 hook（config scopes.<scope>.clean.hooks；--no-clean 时全部关闭）
  const cleanCfg = getScopeCleanConfig(cfg, scope);
  const cleanHooks = cleanEnabled ? (cleanCfg?.hooks ?? []) : [];
  const { files, skippedNonMd } = collectMarkdownFiles(sourceDir, extensions);
  if (files.length === 0) {
    throw new Error(`目录下未发现 .md 文件（格式白名单：${extensions.join(', ')}）：${sourceDir}`);
  }
  if (skippedNonMd.length > 0) {
    logWarn(`跳过 ${skippedNonMd.length} 个不支持格式的文件：${skippedNonMd.slice(0, 10).join(', ')}${skippedNonMd.length > 10 ? ` ...等 ${skippedNonMd.length} 个` : ''}`);
  }

  const relationsCachePath0 = getRelationsCachePath(scope);
  const relationsCache0 = readJson<RelationsCache>(relationsCachePath0);
  if (!relationsCache0) {
    throw new Error(`scope 初始化异常：基础索引文件缺失，请删除 scope 目录后重新 import 或从 _template/ 复制`);
  }

  logInfo(`扫描到 ${files.length} 个文件（chunkSize=${chunkSize}, overlap=${chunkOverlap}）`);

  // 1) 方案 D 逐文件：前置检查 → 写 local KB 文件原文 → 清洗 → 切分 → 构造向量化条目
  //    文件级 relation 记录：{ groupPath, relation(文件级), sourcePath(文件路径), memoryIds(向量化后回填) }
  const fileRecords: {
    rel: string;
    groupPath: string;
    relation: string;
    chunks: Chunk[];          // 清洗后切分结果（向量化输入）
    entries: ScanResultEntry[]; // 向量化条目（text=清洗后 chunk）
  }[] = [];
  const skipped: string[] = [];
  const conflictSkipped: string[] = [];
  totalFileCount = files.length; // 中断标记总文件数（REQ-01）

  for (const rel of files) {
    const absPath = path.resolve(sourceDir, rel);
    const stat = fs.statSync(absPath);
    // 前置检查（先于写 local KB）：大小超限 / chunk 超限 / relation 冲突
    if (stat.size > maxFileSizeBytes) {
      skipped.push(rel);
      logWarn(`文件过大已跳过（${stat.size} bytes > ${maxFileSizeBytes}）：${rel}，可手动切分后导入`);
      continue;
    }
    const fileText = fs.readFileSync(absPath, 'utf-8');
    const groupPath = deriveGroupPath(rootName, rel);
    const relation = deriveRelationText(rel); // 文件级 relation（basename 去 .md）
    // relation 冲突检查（用户决策 O1 + 幂等修复）：
    //   - 同 group 下 relation 名已存在 **且 sourcePath 不同**（真冲突：不同文件同名）→ 跳过 + 反馈
    //   - 同 group 下 relation 名已存在 **且 sourcePath 相同**（幂等重导：同一文件重跑 import）→ 不跳过，允许覆盖更新
    const groupData = relationsCache0.groups[groupPath];
    const existingRel = groupData?.hot_relations.find((r) => r.text === relation);
    if (existingRel && existingRel.sourcePath !== rel) {
      conflictSkipped.push(rel);
      logWarn(`relation 冲突已跳过（同 group "${groupPath}" 下已有 "${relation}"）：${rel}`);
      continue;
    }
    if (existingRel && existingRel.sourcePath === rel) {
      // 幂等重导：同一文件已存在，允许覆盖（重新写入 local KB + 向量化）
      logWarn(`文件已存在，幂等重导覆盖（${rel}）`);
    }
    // 方案 D：第一步直接写 local KB（文件级原文，未清洗）
    writeLocalKb(scope, groupPath, relation, fileText);

    // 清洗（方案 D：清洗只作用于向量化输入；local KB 存原文）
    // 执行顺序：内置规则 → 外部 hooks（REQ-07）；hook 全失败 → P-7 回滚 local KB + skipped
    let textForVector = cleanEnabled ? cleanMarkdownText(fileText, cleanRules) : fileText;
    if (cleanEnabled && cleanHooks.length > 0) {
      const hookResult = await runCleanHooks(textForVector, cleanHooks);
      if (!hookResult.ok) {
        // P-7：所有 hooks 均失败 → 不写入向量 + local KB 回滚（删除已写原文），文件计入 skipped
        skipped.push(rel);
        logWarn(`清洗 hook 失败已跳过（${rel}）：${hookResult.failedHooks.join(', ')}，已回滚 local KB`);
        removeFromLocalKb(scope, groupPath, relation);
        continue;
      }
      textForVector = hookResult.text;
    }

    const chunks = splitIntoChunks(textForVector, { chunkSize, overlap: chunkOverlap });
    if (chunks.length > MAX_CHUNKS_PER_FILE) {
      skipped.push(rel);
      logWarn(`文件切分 chunk 数超限已跳过（${chunks.length} > ${MAX_CHUNKS_PER_FILE}）：${rel}，可增大 --chunk-size 或手动拆分后导入`);
      removeFromLocalKb(scope, groupPath, relation); // 超限同样回滚（保持一致性）
      continue;
    }
    const entries = chunks.map((chunk) => ({
      path: deriveChunkSourcePath(rel, chunk.index), // sourcePath = 文件#N（向量化条目内部用）
      groupPath,
      text: chunk.text, // 清洗后 chunk（向量化 content）
      memoryId: null as string | null,
      chunkRelation: deriveChunkRelation(rel, chunk.index),
    }));
    fileRecords.push({ rel, groupPath, relation, chunks, entries });
    importedFileCount = fileRecords.length; // 中断标记已处理文件数（REQ-01）
    // 进度 = 已处理文件数（O-01 文件数分母）。不传 detail（文件名）：避免 TTY \r 刷新时
    // 长路径残留叠加成乱码（bug-impact-analysis），进度条仅显示文件数 + 百分比。
    logProgress(fileRecords.length, files.length);
  }
  if (skipped.length > 0) {
    logWarn(`跳过 ${skipped.length} 个文件（过大或 chunk 超限）：${skipped.join(', ')}`);
  }
  if (conflictSkipped.length > 0) {
    logWarn(`跳过 ${conflictSkipped.length} 个文件（relation 冲突）：${conflictSkipped.join(', ')}`);
  }
  if (fileRecords.length === 0) {
    throw new Error(`无可导入文件（全部被跳过：过大/超限/冲突 ${skipped.length + conflictSkipped.length} 个）`);
  }

  // 汇总全部向量化条目（chunk 粒度，供 bulkVectorize）
  const entries: ScanResultEntry[] = fileRecords.flatMap((r) => r.entries);
  logInfo(`切分完成：共 ${entries.length} 个 chunk（来自 ${fileRecords.length} 个文件，跳过 ${skipped.length + conflictSkipped.length}）`);

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

  // ── 预读 group-index（relations-cache 已在步骤 0 预读为 relationsCache0）──
  const groupIndexPath = getGroupIndexPath(scope);
  const relationsCachePath = getRelationsCachePath(scope);
  const groupIndex = readGroupIndex(scope);
  if (!groupIndex) {
    throw new Error(`scope 初始化异常：基础索引文件缺失，请删除 scope 目录后重新 import 或从 _template/ 复制`);
  }
  const relationsCache = relationsCache0;

  // ── Phase 2（向量化）串行于 Phase 3/4 之前（REQ-05 O-02/C-4：local KB 已前置，无并行进度条冲突）──
  logPhaseStart(2, TOTAL, '向量化 ...');
  // 非向量化模式（--no-vector）：跳过向量写入，memoryIds 为空（与 sync-relation 决策一致）
  const vectorizeResult = !vector
    ? { ok: new Map<string, string>(), errors: [] }
    : await bulkVectorize(entries, scope, {
        timeoutMs: 60_000 + entries.length * 10_000,
      });
  if (vector && pathEntries.length > 0) {
    const pathResult = await bulkStorePaths(pathEntries);
    logInfo(`路径向量写入完成：成功 ${pathResult.ok.size}，失败 ${pathResult.errors.length}`);
  }

  // ── 文档级自定义 tag 向量写入（可选）：为每个成功导入文件写一条 tag 内容向量 ──
  // 机制对齐 sync-relation：text=文件原文、tags=自定义 tag（每个 tag 各一条），
  // 使 `ki search -t <tag>` 能召回导入文件。tag 向量 docId 回填到文件级 relation 的 memoryIds。
  let tagMemoryMap = new Map<string, string[]>();
  if (vector && customTags.length > 0) {
    logPhaseStart(2, TOTAL, `写入自定义标签向量（${customTags.join(', ')}）...`);
    const tagEntries: { text: string; tags: string; group: string }[] = [];
    // fileRecords 含清洗后原文（textForVector）用于向量化；local KB 存原始 fileText
    for (const rec of fileRecords) {
      const origText = fs.readFileSync(path.resolve(sourceDir, rec.rel), 'utf-8');
      for (const t of customTags) {
        tagEntries.push({ text: origText, tags: t, group: rec.groupPath });
      }
    }
    if (tagEntries.length > 0) {
      try {
        const tagResult = await vectorBulkStore({ scope, entries: tagEntries });
        // 聚合到 文件 → [tag memoryIds]（成功条目按 index 回推文件/标签）
        const newMap = new Map<string, string[]>();
        for (const item of tagResult.results) {
          if (!item.success || !item.memoryId) continue;
          const rec = fileRecords[Math.floor(item.index / customTags.length)];
          if (!rec) continue;
          const arr = newMap.get(rec.rel) ?? [];
          arr.push(item.memoryId);
          newMap.set(rec.rel, arr);
        }
        tagMemoryMap = newMap;
        logInfo(`自定义标签向量写入完成：成功 ${tagResult.results.filter((r) => r.success).length}/${tagEntries.length}`);
      } catch (err) {
        logWarn(`自定义标签向量写入失败（不影响导入）：${(err as Error).message}`);
      }
    }
    logPhaseDone(2, TOTAL, `标签向量写入完成`);
  }

  // ── Phase 3/4：Group 树 + relation-cache（串行，KB 写入近实时无并行损失）──
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

  logPhaseStart(4, TOTAL, `写入元数据（${ctx.entries.length} 条 relations）...`);
  phase4WriteRelations(ctx, relationsCache);
  // 方案 D 回填：按文件聚合全部 chunk memoryId → 写入文件级 relation 的 memoryIds 多值
  const mergedMap = vectorizeResult.ok;
  if (mergedMap.size > 0 || tagMemoryMap.size > 0) {
    for (const rec of fileRecords) {
      // 该文件全部 chunk 的 memoryId（按 sourcePath 文件#N 匹配）
      const ids = rec.entries
        .map((e) => mergedMap.get(e.path))
        .filter((id): id is string => !!id);
      const groupData = relationsCache.groups[rec.groupPath];
      const rel = groupData?.hot_relations.find((r) => r.text === rec.relation);
      if (rel) {
        // 追加文档级自定义 tag 向量的 docId（使 -t <tag> 可召回）
        const tagIds = tagMemoryMap.get(rec.rel) ?? [];
        const allIds = [...ids, ...tagIds];
        if (allIds.length > 0) {
          rel.memoryIds = allIds;
          rel.memoryId = allIds[0]; // 兼容单值消费方
        }
      }
    }
  }
  writeJson(groupIndexPath, groupIndex as unknown as Record<string, unknown>);
  writeJson(relationsCachePath, relationsCache as unknown as Record<string, unknown>);
  logPhaseDone(4, TOTAL, '元数据写入完成');
  const kbResult = ctx;

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

  logSummary(`直导完成：files=${files.length}  chunks=${entries.length}  vectorized=${mergedMap.size}  skipped=${skipped.length}  errors=${vectorizeResult.errors.length}${vector ? '' : '  [非向量化:仅写KB层]'}`);

  // REQ-02 生命周期②：成功导入清除中断标记 + 释放导入锁（N4）
  releaseImportLock(scope);
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);

  return {
    ok: true,
    action: 'import',
    mode: 'full',
    scope,
    stats: {
      total: entries.length,
      vectorized: mergedMap.size,
      errors: vectorizeResult.errors.length,
      // skipped 合并：过大/超限/hook 失败 + relation 冲突（REQ-06：冲突计入 skipped）
      skipped: skipped.length + conflictSkipped.length,
      vector,
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
 * 方案 D（REQ-20260807-001）：文件级 relation 挂 memoryIds 多值
 */
function upsertRelation(
  cache: RelationsCache,
  groupPath: string,
  relationText: string,
  memoryIds: string[] | null | undefined,
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
  // 方案 D：持久化全部 chunk docId（文件级 relation 多值）
  // 向量化失败/--no-vector 时 memoryIds 为空数组（文件级 relation 记录仍存在，sourcePath 必写）
  if (Array.isArray(memoryIds)) {
    rel.memoryIds = memoryIds;
    if (memoryIds.length > 0) rel.memoryId = memoryIds[0]; // 兼容单值消费方（取第一个）
  }
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

/** 从 local KB 删除单条记录（P-7 hook 失败回滚用）；返回是否真的删了 */
function removeFromLocalKb(scope: string, groupPath: string, relationText: string): boolean {
  const localKbPath = getLocalKbDir(scope, groupPath);
  if (!fs.existsSync(localKbPath)) return false;
  const localKb = loadLocalKb(localKbPath);
  if (!(relationText in localKb)) return false;
  delete localKb[relationText];
  writeJson(localKbPath, localKb);
  return true;
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

/** Phase 4（方案 D）：只写 relations-cache 文件级 relation（local KB 已在导入第 1 步写入文件原文） */
function phase4WriteRelations(
  ctx: ImportContext,
  cache: RelationsCache
): void {
  // 文件级 relation 聚合：同 group 下相同 relation 名（文件级，basename 去扩展名）→ 一条记录
  const fileRelMap = new Map<string, { groupPath: string; relation: string; sourcePath: string }>();
  for (const e of ctx.entries) {
    // 从 entry.path（文件#N）还原文件路径
    const fileKey = e.path.includes('#') ? e.path.split('#')[0] : e.path;
    // 文件级 relation = deriveRelationText(fileKey)（basename 去扩展名）
    const fileRelation = deriveRelationText(fileKey);
    fileRelMap.set(fileKey, { groupPath: e.groupPath, relation: fileRelation, sourcePath: fileKey });
  }

  let i = 0;
  const total = fileRelMap.size;
  for (const { groupPath, relation, sourcePath } of fileRelMap.values()) {
    i++;
    // 不传 sourcePath detail：避免 TTY \r 刷新长路径残留叠加成乱码（与全量导入进度一致）
    logProgress(i, total);
    // 方案 D：文件级 relation 挂 memoryIds（向量化完成后由回填逻辑写入），此处先建空记录占位
    upsertRelation(cache, groupPath, relation, [], sourcePath);
  }
}
