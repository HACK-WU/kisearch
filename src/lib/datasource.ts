/**
 * 数据源（REQ-20261020-001）：持久化 + 登记 + 同步编排。
 *
 * 设计要点：
 *  - 清单落 `<kbDir>/datasource.json`（每 scope 一个），原子写、0600
 *  - **不写** `group-index.json.source`（Q-C）：wiki 写回不再指向用户源目录
 *  - 同步 = `handleDirectImport`（不写 source 块）+ 用**上一次成功同步的 seenRels**
 *    收窄候选（Q14）；**永不删除**，删除是独立动作（S-03）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resolveScope, type KiConfig } from './config.js';
import { getKbDir, getSource } from './scope.js';
import { ensureScopeDir } from './store.js';
import {
  DEFAULT_IMPORT_CONFLICT_MODE,
  DEFAULT_IMPORT_CONFLICT_SUFFIX,
  validateImportConflictMode,
  validateImportConflictSuffix,
  type ImportConflictMode,
} from './import-conflict.js';
import {
  collectMarkdownFiles,
  handleDirectImport,
  type HandleDirectImportArgs,
  type ImportResult,
} from './import.js';
import { resolveImportExtensions } from './config.js';
import { planImportPrune, type ImportPrunePlan } from './import-prune.js';
import { isSafeGroupPath, resolveGroupForSource } from './import-path.js';
import { uploadIdFromSourceDir } from './import-retry.js';
import type {
  DataSourceLastSync,
  DataSourceMigrationHint,
  DataSourcePendingDelete,
  DataSourceRecord,
  DataSourceResultSnapshot,
  DataSourceStaleReason,
  DataSourceSyncState,
} from './datasource-types.js';

export const DATASOURCE_FILE = 'datasource.json';

/** Web 上传暂存根（与 task-snapshot / mcp-http-api 同源：<home>/.ki/import-uploads） */
const UPLOADS_ROOT = path.join(os.homedir(), '.ki', 'import-uploads');

export function dataSourcePath(scope: string): string {
  return path.join(getKbDir(scope), DATASOURCE_FILE);
}

// ─── 读写 ───────────────────────────────────────────────

export type ReadDataSourceResult =
  | { ok: true; record: DataSourceRecord }
  | { ok: false; code: 'NOT_FOUND' | 'CORRUPT' | 'INVALID'; error: string };

export function readDataSource(scope: string): ReadDataSourceResult {
  const file = dataSourcePath(scope);
  if (!fs.existsSync(file)) {
    return { ok: false, code: 'NOT_FOUND', error: `数据源未登记：${scope}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return { ok: false, code: 'CORRUPT', error: `datasource.json 解析失败（${file}）：${(err as Error).message}` };
  }
  // 字段级校验会抛（如非法 conflictMode）：不能让单个坏记录把整个列表接口打挂
  let record: DataSourceRecord | null;
  try {
    record = normalizeRecord(scope, raw);
  } catch (err) {
    return { ok: false, code: 'INVALID', error: `datasource.json 字段非法（${file}）：${(err as Error).message}` };
  }
  if (!record) return { ok: false, code: 'INVALID', error: `datasource.json 结构非法（${file}）` };
  return { ok: true, record };
}

/**
 * 轻量可达性检查（列表用）：只 stat + access，**不扫描目录内容**。
 * ⚠️ 列表每次请求都会逐个 scope 调用——用 `checkSourceDir`（含 collectMarkdownFiles）
 * 会在数千篇的源目录上产生可观的 IO。
 */
export function checkSourceReachable(dir: string): { ok: true } | { ok: false; reason: string } {
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, reason: `不是目录：${dir}` };
  } catch {
    return { ok: false, reason: `目录不存在：${dir}` };
  }
  try {
    fs.accessSync(dir, fs.constants.R_OK);
  } catch (err) {
    return { ok: false, reason: `目录不可读：${dir}（${(err as Error).message}）` };
  }
  return { ok: true };
}

function normalizeRecord(scope: string, raw: unknown): DataSourceRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.dir !== 'string' || !v.dir.trim()) return null;
  const conflictMode = validateImportConflictMode(typeof v.conflictMode === 'string' ? v.conflictMode : undefined);
  const groupRaw = typeof v.group === 'string' ? v.group.trim() : '';
  const lastSync = v.lastSync && typeof v.lastSync === 'object' ? (v.lastSync as DataSourceLastSync) : null;
  // 兼容旧版快照：candidateSourcePaths 是 2026-10-21 新增，旧数据用 items 回填
  const pending = lastSync?.pendingDelete as (DataSourceLastSync['pendingDelete'] & { candidateSourcePaths?: unknown }) | undefined;
  if (pending && !Array.isArray(pending.candidateSourcePaths)) {
    pending.candidateSourcePaths = (pending.items ?? [])
      .map((item) => item.sourcePath)
      .filter((path): path is string => typeof path === 'string' && path.length > 0);
  }
  return {
    version: 1,
    scope,
    dir: path.resolve(v.dir),
    group: groupRaw ? groupRaw : null,
    conflictMode,
    conflictSuffix: typeof v.conflictSuffix === 'string'
      ? validateImportConflictSuffix(v.conflictSuffix)
      : DEFAULT_IMPORT_CONFLICT_SUFFIX,
    vector: v.vector !== false,
    chunkSize: typeof v.chunkSize === 'number' ? v.chunkSize : null,
    chunkOverlap: typeof v.chunkOverlap === 'number' ? v.chunkOverlap : null,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(),
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : Date.now(),
    lastSync,
  };
}

/** 原子写（tmp + rename），权限 0600 */
export function writeDataSource(scope: string, record: DataSourceRecord): void {
  const file = dataSourcePath(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ─── 目录校验 ───────────────────────────────────────────

export type SourceDirCode =
  | 'SOURCE_MISSING'
  | 'SOURCE_NOT_DIR'
  | 'SOURCE_UNREADABLE'
  | 'SOURCE_EMPTY'
  | 'SOURCE_IN_KB_DIR';

export type SourceDirCheck = { ok: true } | { ok: false; code: SourceDirCode; error: string };

/** 展开 `~` 并 resolve 为绝对路径 */
export function resolveSourceDirInput(input: string): string {
  const expanded = input.trim().replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(expanded);
}

/**
 * 目录可导入性校验（add 与 sync 共用）。
 * 不可读**必须 fail-loud**，绝不当成「0 个文件」——否则会诱导用户删除全部候选。
 */
export function checkSourceDir(dir: string, config: KiConfig, scope: string): SourceDirCheck {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return { ok: false, code: 'SOURCE_MISSING', error: `源目录不存在：${dir}` };
  }
  if (stat.isSymbolicLink()) {
    try {
      stat = fs.statSync(dir);
    } catch {
      return { ok: false, code: 'SOURCE_MISSING', error: `源目录符号链接已失效：${dir}` };
    }
  }
  if (!stat.isDirectory()) {
    return { ok: false, code: 'SOURCE_NOT_DIR', error: `源路径不是目录：${dir}` };
  }
  try {
    fs.accessSync(dir, fs.constants.R_OK);
  } catch (err) {
    return { ok: false, code: 'SOURCE_UNREADABLE', error: `源目录不可读：${dir}（${(err as Error).message}）` };
  }
  // 拒绝把索引目录当源导入
  const root = path.resolve(config.dataDir);
  const rel = path.relative(root, dir);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return { ok: false, code: 'SOURCE_IN_KB_DIR', error: `源目录不能位于数据目录内：${dir}` };
  }
  const files = collectMarkdownFiles(dir, resolveImportExtensions(config, scope)).files;
  if (files.length === 0) {
    const exts = resolveImportExtensions(config, scope).join(', ');
    return { ok: false, code: 'SOURCE_EMPTY', error: `源目录中没有可导入文件（格式白名单：${exts}）：${dir}` };
  }
  return { ok: true };
}

// ─── add / remove ───────────────────────────────────────

export interface AddDataSourceInput {
  scope: string;
  dir: string;
  group?: string | null;
  conflictMode?: string;
  conflictSuffix?: string;
  vector?: boolean;
  chunkSize?: number | null;
  chunkOverlap?: number | null;
  force?: boolean;
  config?: KiConfig;
}

export type AddDataSourceResult =
  | { ok: true; scope: string; record: DataSourceRecord; created: boolean; next: string }
  | { ok: false; scope: string; code: string; error: string };

export function addDataSource(input: AddDataSourceInput): AddDataSourceResult {
  const config = input.config ?? loadConfig();
  let scope: string;
  try {
    scope = resolveScope(config, input.scope);
  } catch (err) {
    return { ok: false, scope: input.scope, code: 'INVALID_SCOPE', error: (err as Error).message };
  }

  const dir = resolveSourceDirInput(input.dir);
  const conflictMode = validateImportConflictMode(input.conflictMode);
  const conflictSuffix = validateImportConflictSuffix(input.conflictSuffix);
  const chunkSize = input.chunkSize ?? null;
  const chunkOverlap = input.chunkOverlap ?? null;
  if (chunkSize !== null && (!Number.isInteger(chunkSize) || chunkSize <= 0)) {
    return { ok: false, scope, code: 'INVALID_CHUNK', error: `--chunk-size 必须为正整数：${chunkSize}` };
  }
  if (chunkOverlap !== null && (!Number.isInteger(chunkOverlap) || chunkOverlap < 0)) {
    return { ok: false, scope, code: 'INVALID_CHUNK', error: `--chunk-overlap 必须为非负整数：${chunkOverlap}` };
  }
  if (chunkSize !== null && chunkOverlap !== null && chunkOverlap >= chunkSize) {
    return { ok: false, scope, code: 'INVALID_CHUNK', error: `--chunk-overlap（${chunkOverlap}）必须小于 --chunk-size（${chunkSize}）` };
  }

  const dirCheck = checkSourceDir(dir, config, scope);
  if (!dirCheck.ok) return { ok: false, scope, code: dirCheck.code, error: dirCheck.error };

  const group = (input.group ?? '').trim() || null;
  // group 会拼进 local-kb / 分片路径：绝对路径、反斜杠、`..` 一律拒绝
  // （与 `/api/import/run`、`/api/import/preflight` 同口径）
  if (group !== null && !isSafeGroupPath(group)) {
    return { ok: false, scope, code: 'INVALID_GROUP', error: `非法 Group 路径：${group}（不可为绝对路径，或含 .. / 反斜杠）` };
  }
  const existing = readDataSource(scope);
  if (!existing.ok && existing.code !== 'NOT_FOUND') {
    return { ok: false, scope, code: existing.code, error: existing.error };
  }
  const prev = existing.ok ? existing.record : null;
  if (prev && !input.force && ((prev.dir !== dir) || (prev.group !== group))) {
    const changes: string[] = [];
    if (prev.dir !== dir) changes.push(`--source：${prev.dir} → ${dir}（旧路径下的文档会在下次同步进入待删候选，本次不会自动删）`);
    if (prev.group !== group) changes.push(`--group：${prev.group ?? '(自动)'} → ${group ?? '(自动)'}（旧 group 的文档会保留并产生重复，需手动清理）`);
    return {
      ok: false,
      scope,
      code: 'NEEDS_FORCE',
      error: `修改 ${changes.join('；')}。确认请加 --force`,
    };
  }

  if (!prev) ensureScopeDir(scope);
  const now = Date.now();
  const changed = prev !== null && (prev.dir !== dir || prev.group !== group);
  // 改 --source / --group（--force）：保留 seenRels（旧路径文档下次同步仍能进候选），
  // 但**清掉旧候选与 token**——它们是按旧目录算的，换目录后未同步即可删会与承诺不符。
  const lastSync = prev?.lastSync
    ? (changed
      ? {
        ...prev.lastSync,
        pendingDelete: { ...emptyPending(now), stale: true, staleReason: 'not-recomputed' as const },
      }
      : prev.lastSync)
    : null;
  const record: DataSourceRecord = {
    version: 1,
    scope,
    dir,
    group,
    conflictMode,
    conflictSuffix,
    vector: input.vector !== false,
    chunkSize,
    chunkOverlap,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    lastSync,
  };
  writeDataSource(scope, record);
  return {
    ok: true,
    scope,
    record,
    created: !prev,
    next: `ki datasource sync --scope ${scope}`,
  };
}

export type RemoveDataSourceResult =
  | { ok: true; scope: string; removed: boolean; /** 仅提示 */ legacySourceDir: string | null }
  | { ok: false; scope: string; code: string; error: string };

/** 取消登记：只删 datasource.json；**不碰** group-index.json.source（Q-C） */
export function removeDataSource(scopeInput: string, config: KiConfig = loadConfig()): RemoveDataSourceResult {
  let scope: string;
  try {
    scope = resolveScope(config, scopeInput);
  } catch (err) {
    return { ok: false, scope: scopeInput, code: 'INVALID_SCOPE', error: (err as Error).message };
  }
  const file = dataSourcePath(scope);
  const legacySourceDir = getSource(scope)?.dir ?? null;
  if (!fs.existsSync(file)) return { ok: true, scope, removed: false, legacySourceDir };
  try {
    fs.unlinkSync(file);
  } catch (err) {
    return { ok: false, scope, code: 'REMOVE_FAILED', error: `删除 datasource.json 失败：${(err as Error).message}` };
  }
  return { ok: true, scope, removed: true, legacySourceDir };
}

// ─── 枚举（列表 / 迁移提示） ─────────────────────────────

export interface DataSourceScopeScan {
  registered: { scope: string; record: DataSourceRecord }[];
  /** 有登记但目录不可读 */
  missing: { scope: string; reason: string }[];
  /** 有登记但 datasource.json 损坏/非法 */
  corrupt: { scope: string; reason: string }[];
  /** 有历史 source 块但无登记（只提示，不自动写入） */
  hints: DataSourceMigrationHint[];
}

/**
 * 扫描所有已登记数据源。
 * ⚠ 不能用 `scope.ts::listAllScopes()`：它的判据是「有 KB 数据」，会漏掉
 * 「登记了但从未同步」的 scope（而这恰恰是列表里最该出现的 `never` 状态）。
 */
export function scanDataSources(config: KiConfig = loadConfig()): DataSourceScopeScan {
  const out: DataSourceScopeScan = { registered: [], missing: [], corrupt: [], hints: [] };
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(config.dataDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
    const scope = entry.name;
    let read: ReadDataSourceResult;
    try {
      read = readDataSource(scope);
    } catch (err) {
      // 单条坏记录不得拖垮整个列表（readDataSource 已兜住绝大多数；此处是最后防线）
      out.corrupt.push({ scope, reason: (err as Error).message });
      continue;
    }
    if (read.ok) {
      // 列表只做轻量可达性检查（不扫目录内容）
      const reachable = checkSourceReachable(read.record.dir);
      if (reachable.ok) out.registered.push({ scope, record: read.record });
      else out.missing.push({ scope, reason: reachable.reason });
      continue;
    }
    if (read.code !== 'NOT_FOUND') {
      out.corrupt.push({ scope, reason: read.error });
      continue;
    }
    const legacy = getSource(scope);
    if (legacy?.dir) {
      // 只提示「仍可用的历史目录」：
      //  ① 目录必须存在且可读（失效路径登记了也没用）
      //  ② 排除 Web 上传暂存目录（`~/.ki/import-uploads/<uuid>`，24h 后必被清理）
      //  ③ 排除数据目录内部（自己导入自己）
      const inUploads = uploadIdFromSourceDir(legacy.dir, UPLOADS_ROOT) !== null;
      const relToData = path.relative(path.resolve(config.dataDir), path.resolve(legacy.dir));
      const insideData = !relToData.startsWith('..') && !path.isAbsolute(relToData);
      if (!inUploads && !insideData && checkSourceReachable(legacy.dir).ok) {
        out.hints.push({
          scope,
          dir: legacy.dir,
          ...(legacy.chunkSize !== undefined ? { chunkSize: legacy.chunkSize } : {}),
          ...(legacy.chunkOverlap !== undefined ? { chunkOverlap: legacy.chunkOverlap } : {}),
        });
      }
    }
  }
  // 最久未同步在前；无 lastSync 的排最后
  out.registered.sort((a, b) => (a.record.lastSync?.at ?? Number.MAX_SAFE_INTEGER) - (b.record.lastSync?.at ?? Number.MAX_SAFE_INTEGER));
  return out;
}

// ─── 同步编排 ───────────────────────────────────────────

export interface SyncDataSourceInput {
  scope: string;
  dryRun?: boolean;
  taskId?: string;
  onProgress?: HandleDirectImportArgs['onProgress'];
  abortSignal?: AbortSignal;
  onInterrupt?: () => void;
  config?: KiConfig;
}

export interface SyncSummary {
  state: DataSourceSyncState;
  durationMs: number;
  files: DataSourceResultSnapshot['files'] | null;
  pendingDelete: DataSourcePendingDelete | null;
}

export type SyncDataSourceResult =
  | { ok: true; scope: string; dryRun: true; plannedFiles: number; pendingDelete: DataSourcePendingDelete | null }
  | { ok: true; scope: string; dryRun: false; summary: SyncSummary }
  | { ok: false; scope: string; code: string; error: string; summary?: SyncSummary };

function emptyPending(now: number): DataSourcePendingDelete {
  return {
    computedAt: now,
    total: 0,
    overLimit: false,
    truncated: false,
    items: [],
    untouchedGroups: [],
    unableCount: 0,
    eligibleCount: 0,
    candidateSourcePaths: [],
    stale: false,
    staleReason: null,
    blocked: null,
  };
}

export function pendingFromPlan(plan: ImportPrunePlan | undefined, now: number): DataSourcePendingDelete {
  if (!plan) {
    return { ...emptyPending(now), blocked: 'ERROR', skipDetail: '未计算候选（prune 未启用或异常）' };
  }
  return {
    ...(plan.token ? { token: plan.token } : {}),
    computedAt: now,
    total: plan.total,
    overLimit: plan.overLimit,
    truncated: plan.truncated,
    items: plan.items.map((item) => ({
      group: item.group,
      relation: item.relation,
      sourcePath: item.sourcePath,
      ...(item.untouched ? { untouched: true } : {}),
    })),
    candidateSourcePaths: plan.overLimit && plan.allCandidateSourcePaths
      ? plan.allCandidateSourcePaths
      : plan.items.map((item) => item.sourcePath),
    untouchedGroups: plan.untouchedGroups,
    unableCount: plan.unableCount,
    eligibleCount: plan.eligibleCount,
    stale: false,
    staleReason: null,
    blocked: plan.skipReason ?? null,
    ...(plan.skipDetail ? { skipDetail: plan.skipDetail } : {}),
  };
}

function resultSnapshot(result: ImportResult): DataSourceResultSnapshot {
  const failures = (result.incomplete ?? []).slice(0, 20).map((item) => ({ path: item.path, reason: item.reason }));
  if (failures.length === 0) {
    for (const err of (result.errors ?? []).slice(0, 20)) failures.push({ path: err.path, reason: err.error });
  }
  return {
    files: {
      scanned: result.stats.files.scanned,
      completed: result.stats.files.completed,
      unchanged: result.stats.files.unchanged,
      skipped: result.stats.files.skipped,
      incomplete: result.stats.files.incomplete,
      duplicatesSkipped: result.stats.files.duplicatesSkipped,
    },
    vectorized: result.stats.vectorized,
    fullTextIndexed: result.stats.fullTextIndexed,
    groups: result.groups ?? [],
    conflicts: (result.conflicts ?? []).slice(0, 50).map((item) => ({
      path: item.path,
      relation: item.relation,
      action: item.action,
      ...(item.unchanged ? { unchanged: true } : {}),
    })),
    failures,
  };
}

/** 失败/取消时保留上一版基线与候选，并标记 stale（否则一次失败会抹掉唯一可用凭证） */
function preservePrevSync(
  record: DataSourceRecord,
  state: DataSourceSyncState,
  staleReason: DataSourceStaleReason,
  partialResult?: ImportResult,
): DataSourceLastSync {
  const prev = record.lastSync;
  const now = Date.now();
  return {
    at: now,
    durationMs: 0,
    state,
    ...(prev?.taskId ? { taskId: prev.taskId } : {}),
    params: {
      group: record.group,
      conflictMode: record.conflictMode,
      vector: record.vector,
      chunkSize: record.chunkSize,
      chunkOverlap: record.chunkOverlap,
    },
    result: partialResult ? resultSnapshot(partialResult) : {
      files: { scanned: 0, completed: 0, unchanged: 0, skipped: 0, incomplete: 0, duplicatesSkipped: 0 },
      vectorized: 0,
      fullTextIndexed: 0,
      groups: [],
      conflicts: [],
      failures: [],
    },
    seenRels: prev?.seenRels ?? [],
    pendingDelete: {
      ...(prev?.pendingDelete ?? emptyPending(now)),
      stale: true,
      staleReason,
    },
  };
}

export async function syncDataSource(input: SyncDataSourceInput): Promise<SyncDataSourceResult> {
  const config = input.config ?? loadConfig();
  let scope: string;
  try {
    scope = resolveScope(config, input.scope);
  } catch (err) {
    return { ok: false, scope: input.scope, code: 'INVALID_SCOPE', error: (err as Error).message };
  }

  const read = readDataSource(scope);
  if (!read.ok) return { ok: false, scope, code: read.code, error: read.error };
  const record = read.record;
  const prevSeen = record.lastSync?.seenRels ?? [];
  const startedAt = Date.now();

  const dirCheck = checkSourceDir(record.dir, config, scope);
  if (!dirCheck.ok) {
    const state: DataSourceSyncState = 'failed';
    // 只有「不存在/不可读」才是目录失效；空目录/非目录等属"本次无法导入"，不误导为 missing
    const reason: DataSourceStaleReason = dirCheck.code === 'SOURCE_UNREADABLE'
      ? 'source-unreadable'
      : dirCheck.code === 'SOURCE_MISSING' ? 'source-missing' : 'not-recomputed';
    if (!input.dryRun) {
      writeDataSource(scope, { ...record, updatedAt: Date.now(), lastSync: preservePrevSync(record, state, reason) });
    }
    return { ok: false, scope, code: dirCheck.code, error: dirCheck.error };
  }

  // ── dry-run：只算不写（不导入、不落 lastSync）──
  if (input.dryRun) {
    const files = collectMarkdownFiles(record.dir, resolveImportExtensions(config, scope)).files;
    const importedGroups = [...new Set(files.map((rel) => resolveGroupForSource(record.group ?? '', rel, scope)))];
    const plan = planImportPrune({
      scope,
      group: record.group ?? '',
      scannedRels: files,
      importedGroups,
      precheck: { pruneStale: true, pickMode: 'dir', subsetRetry: false, uploadIncomplete: false, scannedCount: files.length },
      eligibleRels: prevSeen,
      emitTokenWhenOverLimit: true,
    });
    return { ok: true, scope, dryRun: true, plannedFiles: files.length, pendingDelete: pendingFromPlan(plan, Date.now()) };
  }

  // ── 真实同步：导入 + 算候选，永不删除 ──
  let scannedForBaseline: string[] = [];
  let scannedCaptured = false;
  try {
    const result = await handleDirectImport({
      scope,
      sourceDir: record.dir,
      ...(record.group ? { group: record.group } : {}),
      conflictMode: record.conflictMode,
      conflictSuffix: record.conflictSuffix,
      vector: record.vector,
      ...(record.chunkSize !== null ? { chunkSize: record.chunkSize } : {}),
      ...(record.chunkOverlap !== null ? { chunkOverlap: record.chunkOverlap } : {}),
      pickMode: 'dir',
      pruneStale: true,
      pruneEligibleRels: prevSeen,
      pruneEmitTokenWhenOverLimit: true,
      uploadIncomplete: false,
      writeSourceBlock: false,
      ...(input.taskId ? { jobId: input.taskId } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.onInterrupt ? { onInterrupt: input.onInterrupt } : {}),
      onScannedFiles: (files) => { scannedForBaseline = files; scannedCaptured = true; },
    });

    const state: DataSourceSyncState = result.cancelled === true
      ? 'cancelled'
      : result.partial ? 'partial' : 'ok';
    const success = state === 'ok' || state === 'partial';
    const now = Date.now();
    const pendingDelete = success
      ? pendingFromPlan(result.prune, now)
      : { ...(record.lastSync?.pendingDelete ?? emptyPending(now)), stale: true, staleReason: 'not-recomputed' as const };
    // 候选被闸门拦下（坐标/规模/空源）时**冻结基线**：把 seenRels 切成幸存文件会让
    // 被拦下的那批文档永久退出候选（既不在基线、也不在候选）。冻结后下次同步可重评。
    const blockedReason = result.prune?.skipReason;
    const freezeBaseline = blockedReason === 'GATE_COORD' || blockedReason === 'GATE_SCALE' || blockedReason === 'EMPTY_SOURCE';
    const seenRels = success && scannedCaptured && !freezeBaseline ? [...scannedForBaseline].sort() : prevSeen;

    const lastSync: DataSourceLastSync = {
      at: now,
      durationMs: now - startedAt,
      state,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      params: {
        group: record.group,
        conflictMode: record.conflictMode,
        vector: record.vector,
        chunkSize: record.chunkSize,
        chunkOverlap: record.chunkOverlap,
      },
      result: resultSnapshot(result),
      seenRels,
      pendingDelete,
    };
    writeDataSource(scope, { ...record, updatedAt: now, lastSync });

    return {
      ok: true,
      scope,
      dryRun: false,
      summary: { state, durationMs: lastSync.durationMs, files: lastSync.result.files, pendingDelete },
    };
  } catch (err) {
    const now = Date.now();
    writeDataSource(scope, {
      ...record,
      updatedAt: now,
      lastSync: preservePrevSync(record, 'failed', 'not-recomputed'),
    });
    return { ok: false, scope, code: 'SYNC_FAILED', error: (err as Error).message };
  }
}

/**
 * 下发给客户端前剥离内部重算基线。
 * `candidateSourcePaths` 在超限时可达数万条，只用于服务端重算，不该出现在
 * HTTP 响应 / CLI stdout（detail 与 prune 都必须用它收口）。
 */
export function toClientPending(
  pending: DataSourcePendingDelete,
): Omit<DataSourcePendingDelete, 'candidateSourcePaths'> {
  const { candidateSourcePaths: _internal, ...safe } = pending;
  return safe;
}

/** 供 CLI / HTTP 复用的错误码 → 人类可读下一步 */export function dataSourceNextStep(code: string, scope: string): string | undefined {
  switch (code) {
    case 'NOT_FOUND':
    case 'NOT_REGISTERED':
      return `先登记：ki datasource add --scope ${scope} --source <目录>`;
    case 'SOURCE_MISSING':
    case 'SOURCE_UNREADABLE':
      return '检查源目录是否存在/可读，或用 ki datasource add --force 重新登记';
    case 'NEEDS_FORCE':
      return '确认后果后加 --force 重新执行';
    default:
      return undefined;
  }
}

export type { DataSourceRecord, DataSourceLastSync, DataSourcePendingDelete, ImportConflictMode };
