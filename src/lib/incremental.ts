/**
 * incremental.ts —— S-06：增量导入（git diff 直连，无 AI）
 *
 * REQ-04/06（批次 3）：删除 ai-results.json 增量契约，仅保留 git diff 驱动的
 * 增量直连链路：
 *   - added    → 读原文 → 切分 → 向量化 → 写 cache + local KB
 *   - modified → 先写新全 chunk（成功后再删旧全 chunk，写序见 D-3/质疑意见2）
 *   - deleted  → 按文件关联全 chunk memoryId 清理（向量 + cache + local KB + 路径向量）
 *   - 全部成功后才更新 source.commit 到 HEAD
 *   - 切分参数用 source 块持久化值（D-8）；无 git 明确报错（D-9）
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
import { deriveGroupPath, type ScanResultEntry } from './ai-results.js';
import {
  bulkVectorize,
  deleteMemory,
  type BatchVectorizeOptions,
} from './batch-vectorize.js';
import {
  buildRelationContent,
  buildGroupPathContent,
  deletePathVector,
  bulkStorePaths,
  type PathVectorizeEntry,
} from './path-vectorize.js';
import type {
  RelationsCache,
  ImportResult,
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
import { deriveChunkRelation, deriveChunkSourcePath, readFileToChunks } from './import.js';
import { MAX_CHUNKS_PER_FILE } from './chunker.js';

// ─── 类型 ───

export interface IncrementalStats {
  total: number;
  added: number;
  modified: number;
  deleted: number;
  errors: number;
  /** 是否写入向量层（false = 非向量化模式 --no-vector，仅 KB 层） */
  vector: boolean;
}

export interface IncrementalResult extends Omit<ImportResult, 'mode' | 'stats'> {
  mode: 'incremental';
  stats: IncrementalStats;
  previousCommit: string;
  newCommit: string;
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

/** REQ-05/09（批次 3）：不再写入 keywords / isFullText（旧数据字段只读兼容） */
function upsertRelation(
  cache: RelationsCache,
  groupPath: string,
  relationText: string,
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

// ─── 增量直连（git diff 驱动，无 AI，H-17 文件级覆盖更新）────────────────

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
  /** 非向量化模式：仅写 KB 层（relations-cache + local KB），跳过向量写入与向量删除；默认 true */
  vector?: boolean;
  /** 清洗总开关（false = --no-clean，关闭全部清洗含 hooks）；默认 true */
  cleanEnabled?: boolean;
  /** 内置清洗规则覆盖（--clean-rules 解析结果） */
  cleanRules?: Partial<import('./clean.js').CleanRules>;
}

/**
 * 把变更文件重新切分并向量化（added / modified 共用）。
 * 返回该文件的 chunk 条目（含 chunkRelation / chunkSourcePath）。
 */
function chunkifyFile(absPath: string, relPath: string, rootName: string, chunkSize: number, chunkOverlap: number): ScanResultEntry[] {
  const chunks = readFileToChunks(absPath, chunkSize, chunkOverlap);
  return chunks.map((chunk) => ({
    path: deriveChunkSourcePath(relPath, chunk.index), // foo.md#N
    groupPath: deriveGroupPath(rootName, relPath),
    text: chunk.text, // 原文
    memoryId: null,
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
  const vector = args.vector !== false;
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
      // 文件从未导入（或 cache 无关联）：无事可做，降级为信息提示而非 error（体验修复 P2）
      logWarn(`[delete skip] ${entry.path} 未关联 memoryId（文件可能从未成功导入），跳过删除`);
      continue;
    }
    // 1) 删除全部 chunk 向量（非向量化模式无向量，跳过）
    if (vector) {
      for (const id of ids) {
        const del = await deleteMemory(id, args.scope, memOpts);
        if (!del.ok) {
          errors.push({ path: entry.path, error: `[delete warn] 向量删除失败 id=${id.slice(0, 8)}：${del.error}` });
        }
      }
    }
    // 2) 清理 relations-cache + local KB（方案 D：文件级 relation sourcePath === 文件路径，无 #N）
    //    兼容旧数据：chunk 级 sourcePath（file#N）按前缀匹配
    const groupPaths = new Set<string>();
    for (const [groupPath, groupData] of Object.entries(relationsCache.groups)) {
      const rels = groupData.hot_relations.filter((r) => r.sourcePath && (r.sourcePath === entry.path || r.sourcePath.startsWith(entry.path + '#')));
      for (const rel of rels) {
        const idx = groupData.hot_relations.indexOf(rel);
        if (idx >= 0) groupData.hot_relations.splice(idx, 1);
        groupPaths.add(groupPath);
        removeFromLocalKb(args.scope, groupPath, rel.text);
        // 删除 ki-relation 路径向量（非向量化模式无路径向量，跳过）
        if (vector) {
          await deletePathVector(buildRelationContent(rel.text, groupPath), 'ki-relation', args.scope);
        }
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
      // 记入 errors：commit 仍推进（防永久卡死），但用户可见该文件未同步（旧数据保留）
      errors.push({
        path: e.path,
        error: `文件过大已跳过（${stat.size} bytes > ${maxFileSizeBytes}），旧数据保留。可手动切分后导入`,
      });
      continue;
    }

    // 读原文 → 切分 → 构造 chunk entries
    const entries = chunkifyFile(absPath, e.path, rootName, chunkSize, chunkOverlap);
    if (entries.length === 0) {
      errors.push({ path: e.path, error: '切分后无内容' });
      continue;
    }
    if (entries.length > MAX_CHUNKS_PER_FILE) {
      // 记入 errors：commit 仍推进（防永久卡死），但用户可见该文件未同步（旧数据保留）
      errors.push({
        path: e.path,
        error: `文件切分 chunk 数超限已跳过（${entries.length} > ${MAX_CHUNKS_PER_FILE}），旧数据保留。可增大 --chunk-size 或手动拆分后导入`,
      });
      continue;
    }

    // 方案 D：文件级 relation + memoryIds 多值
    // 文件级 relation = deriveRelationText(文件路径)（basename 去扩展名）；sourcePath = 文件路径（无 #N）
    const fileRelation = deriveRelationText(e.path);
    const groupPathFile = deriveGroupPath(rootName, e.path);
    const fileText = fs.readFileSync(absPath, 'utf-8');

    // 先写新全 chunk（bulkVectorize）
    // 非向量化模式（--no-vector）：跳过向量写入，memoryIds 为空，仅 KB 层
    const vec = vector
      ? await bulkVectorize(entries, args.scope, { timeoutMs: 60_000 + entries.length * 10_000 })
      : { ok: new Map<string, string>(), errors: [] };
    const okIds: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const en = entries[i];
      const memoryId = vector ? vec.ok.get(en.path) : undefined;
      if (vector && !memoryId) {
        const err = vec.errors.find((er) => er.path === en.path);
        errors.push({ path: en.path, error: `[${isModify ? 'modify' : 'add'}] ${err?.error || '向量化失败'}` });
        continue;
      }
      if (memoryId) okIds.push(memoryId);
      ensureGroupPathInTree(groupIndex, en.groupPath);
      groupsTouched.add(en.groupPath);
    }
    // 文件级 relation：local KB 写文件原文（未清洗，方案 D）+ relation-cache 挂 memoryIds（回填）
    writeLocalKb(args.scope, groupPathFile, fileRelation, fileText);
    upsertRelation(relationsCache, groupPathFile, fileRelation, okIds, e.path);
    if (okIds.length > 0) {
      // 供 modified 删旧使用（新 memoryIds 字段更新放在删旧成功后，P-2 先删后更）
      // 此处先记录新 id，删旧成功后再更新字段（见下方 isModify 分支）
    }
    // 路径向量（ki-relation 每条 chunk + ki-path 每 group）——非向量化时跳过
    if (vector) {
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
    }

    // modified：方案 D P-2 先删后更——基于旧 memoryIds 删旧向量 → 全部成功后再更新字段为新 okIds
    if (isModify) {
      const oldIds = e.memoryIds && e.memoryIds.length > 0 ? e.memoryIds : (e.memoryId ? [e.memoryId] : []);
      if (vector ? okIds.length > 0 : true) {
        let deleteOk = true;
        // 删旧向量（非向量化模式无向量可删；新旧 id 相同跳过）
        if (vector) {
          for (const oldId of oldIds) {
            if (okIds.includes(oldId)) continue; // 新旧 id 相同（内容未变时）跳过
            const del = await deleteMemory(oldId, args.scope, memOpts);
            if (!del.ok) {
              deleteOk = false;
              errors.push({ path: e.path, error: `[modify warn] 删旧向量失败 id=${oldId.slice(0, 8)}：${del.error}` });
            }
          }
        }
        // P-2：删旧全部成功 → 更新 memoryIds 字段为新 okIds；删旧失败 → 字段保持旧值（无孤儿向量）
        const rel = relationsCache.groups[groupPathFile]?.hot_relations.find((r) => r.text === fileRelation);
        if (rel) {
          if (deleteOk) {
            rel.memoryIds = okIds;
            rel.memoryId = okIds.length > 0 ? okIds[0] : undefined;
          } else {
            // 删旧失败：字段保持旧值（旧 id 仍在库中），不更新，告警提示增量未完成
            errors.push({
              path: e.path,
              error: `[modify] 删旧向量部分失败，relation memoryIds 保持旧值（${oldIds.length} 个旧 id），可重新执行或 rebuild-vector`,
            });
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
    throw new Error(
      `source 目录不在 git 仓库中（${sourceDir}）。增量更新依赖 git，请先 git init 或改用 --mode full 全量导入`
    );
  }
  const newSource = { ...existingSource, commit: newCommit };
  setSource(args.scope, newSource);
  logPhaseDone(4, TOTAL_PHASES, `source 已更新，commit=${newCommit.slice(0, 8)}`);

  // REQ-02 生命周期③：增量成功导入清除中断标记（diff 基于完整库的前提已满足）
  try {
    const { releaseImportLock } = await import('./interrupt.js');
    releaseImportLock(args.scope);
  } catch { /* 清理失败不阻断 */ }

  const total = diff.stats.added + diff.stats.modified + diff.stats.deleted;
  logSummary(`增量直连完成：total=${total}  added=${added}  modified=${modified}  deleted=${deleted}  errors=${errors.length}`);

  return {
    ok: true,
    action: 'import',
    mode: 'incremental',
    scope: args.scope,
    stats: { total, added, modified, deleted, errors: errors.length, vector },
    errors,
    groups: [...groupsTouched].sort(),
    source: newSource,
    previousCommit: existingSource.commit,
    newCommit,
  };
}
