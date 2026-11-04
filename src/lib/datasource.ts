/**
 * 数据源（REQ-20261020-001）：持久化 + 登记 + 同步编排。
 *
 * 设计要点：
 *  - 清单落 `<kbDir>/datasource.json`（每 scope 一个），原子写、0600
 *  - **不写** `group-index.json.source`（Q-C）：wiki 写回不再指向用户源目录
 *  - 同步 = `handleDirectImport`（不写 source 块）+ 用**上一次成功同步的 seenRels**
 *    收窄候选（Q14）；**永不删除**，删除是独立动作（S-03）
 */
import crypto from 'node:crypto';
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
import {
  validateChunkParams,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MAX_CHUNK_OVERLAP,
} from './chunker.js';
import { planImportPrune, type ImportPrunePlan } from './import-prune.js';
import { ROOT_GROUP_KEY, isUserAssignableGroup, resolveGroupForSource } from './import-path.js';
// 映射（REQ-20261104-002）：归一 / 校验 / 基线分桶的唯一实现
import { mappingsOf, mappingTargetDir, normalizeMappingInput, normalizeSubdir, resolveMappings, sameMappings, splitSeenRelsByMapping, validateMappings } from './datasource-mappings.js';
// 多映射结果合并（纯函数；commit 水位与基线分桶的判据都在这里）
import { failedMappingPart, mappingParams, mergeMappingSync, type MappingSyncPart } from './datasource-sync-merge.js';
import type {
  DataSourceGitInfo,
  DataSourceGitSyncState,
  DataSourceKind,
  DataSourceLastSync,
  DataSourceMappingItem,
  DataSourcePendingDelete,
  DataSourceRecord,
  DataSourceResultSnapshot,
  DataSourceSchedule,
  DataSourceScheduleInput,
  DataSourceStaleReason,
  DataSourceSyncMode,
  DataSourceSyncState,
  DataSourceWarning,
} from './datasource-types.js';
import { collectGitChanges, prepareGitSync, probeGit, refreshManagedClone, sanitizeGitError, sanitizeRemoteUrl, type GitUpdateResult } from './datasource-git.js';
import { checkManagedSubdir, cloneManagedRepo, managedCloneDirForRepo, managedCloneDirOf, purgeManagedCloneDir } from './datasource-clone.js';
import { withScopeWriteLock } from './scope-write-lock.js';
import { defaultDataSourceSchedule, intervalMinutes, normalizeDataSourceSchedule, parseAtLocal, validateScheduleInput } from './datasource-schedule.js';

export const DATASOURCE_FILE = 'datasource.json';

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

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeGitInfo(raw: unknown): DataSourceGitInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.repoRoot !== 'string' || !v.repoRoot.trim() || !path.isAbsolute(v.repoRoot)) return null;
  const rawRel = typeof v.relativeRoot === 'string' ? v.relativeRoot : '';
  const relativeRoot = rawRel.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (relativeRoot.split('/').includes('..')) return null;
  const branch = optionalString(v.branch);
  return {
    repoRoot: path.resolve(v.repoRoot),
    relativeRoot: relativeRoot === '.' ? '' : relativeRoot,
    branch: branch === 'HEAD' ? null : branch,
    remoteUrl: sanitizeRemoteUrl(optionalString(v.remoteUrl) ?? ''),
    managed: v.managed === true,
    remoteBranch: optionalString(v.remoteBranch),
  };
}

function normalizeGitSyncState(raw: unknown): DataSourceGitSyncState | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const update = v.update === 'updated' || v.update === 'up-to-date' || v.update === 'failed' ? v.update : 'skipped';
  const fetch = v.fetch === 'ok' || v.fetch === 'failed' ? v.fetch : 'skipped';
  return {
    commit: optionalString(v.commit),
    runCommit: optionalString(v.runCommit),
    shortCommit: optionalString(v.shortCommit),
    subject: optionalString(v.subject),
    authorTime: typeof v.authorTime === 'number' && Number.isFinite(v.authorTime) ? v.authorTime : null,
    changedCount: toCount(v.changedCount),
    fullScanned: toCount(v.fullScanned),
    untrackedMarkdown: toCount(v.untrackedMarkdown),
    update,
    ...(optionalString(v.updateDetail) ? { updateDetail: optionalString(v.updateDetail) as string } : {}),
    fetch,
    ...(optionalString(v.fetchDetail) ? { fetchDetail: optionalString(v.fetchDetail) as string } : {}),
  };
}

function normalizeWarnings(raw: unknown): DataSourceWarning[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      code: typeof item.code === 'string' ? item.code : 'UNKNOWN',
      message: typeof item.message === 'string' ? item.message : '',
    }))
    .filter((item) => item.message.length > 0)
    .slice(0, 10);
  return items.length > 0 ? items : undefined;
}

function normalizeLastSync(raw: unknown): DataSourceLastSync | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const paramsRaw = s.params && typeof s.params === 'object' ? s.params as Record<string, unknown> : {};
  const resultRaw = s.result && typeof s.result === 'object' ? s.result as Record<string, unknown> : {};
  const filesRaw = resultRaw.files && typeof resultRaw.files === 'object' ? resultRaw.files as Record<string, unknown> : {};
  const scanned = toCount(filesRaw.scanned);
  const files: DataSourceResultSnapshot['files'] = {
    scanned,
    fullScanned: toCount(filesRaw.fullScanned) || scanned,
    changed: toCount(filesRaw.changed) || scanned,
    completed: toCount(filesRaw.completed),
    unchanged: toCount(filesRaw.unchanged),
    skipped: toCount(filesRaw.skipped),
    incomplete: toCount(filesRaw.incomplete),
    duplicatesSkipped: toCount(filesRaw.duplicatesSkipped),
  };
  const result: DataSourceResultSnapshot = {
    files,
    vectorized: toCount(resultRaw.vectorized),
    fullTextIndexed: toCount(resultRaw.fullTextIndexed),
    groups: Array.isArray(resultRaw.groups) ? resultRaw.groups.filter((item): item is string => typeof item === 'string') : [],
    conflicts: Array.isArray(resultRaw.conflicts) ? resultRaw.conflicts as DataSourceResultSnapshot['conflicts'] : [],
    failures: Array.isArray(resultRaw.failures) ? resultRaw.failures as DataSourceResultSnapshot['failures'] : [],
    ...(Array.isArray(resultRaw.created)
      ? {
        created: (resultRaw.created as Array<{ group?: unknown; relation?: unknown }>)
          .filter((item) => typeof item?.group === 'string' && typeof item?.relation === 'string')
          .map((item) => ({ group: String(item.group), relation: String(item.relation) })),
      }
      : {}),
    ...(typeof resultRaw.createdTotal === 'number' ? { createdTotal: Math.max(0, Math.trunc(resultRaw.createdTotal)) } : {}),
    ...(resultRaw.createdTruncated === true ? { createdTruncated: true } : {}),
    // 变更明细：旧快照没有该字段 ⇒ 保持 undefined（页面据此显示"未记录"，不能当成 0 篇）
    ...(Array.isArray(resultRaw.modified)
      ? {
        modified: (resultRaw.modified as Array<{ group?: unknown; relation?: unknown }>)
          .filter((item) => typeof item?.group === 'string' && typeof item?.relation === 'string')
          .map((item) => ({ group: String(item.group), relation: String(item.relation) })),
      }
      : {}),
    ...(typeof resultRaw.modifiedTotal === 'number' ? { modifiedTotal: Math.max(0, Math.trunc(resultRaw.modifiedTotal)) } : {}),
    ...(resultRaw.modifiedTruncated === true ? { modifiedTruncated: true } : {}),
  };
  const pendingRaw = s.pendingDelete && typeof s.pendingDelete === 'object'
    ? s.pendingDelete as DataSourcePendingDelete & { candidateSourcePaths?: unknown }
    : null;
  const now = Date.now();
  const pending = pendingRaw ?? emptyPending(now);
  // 兼容旧版快照：candidateSourcePaths 是 2026-10-21 新增，旧数据用 items 回填
  if (!Array.isArray(pending.candidateSourcePaths)) {
    pending.candidateSourcePaths = (pending.items ?? [])
      .map((item) => item.sourcePath)
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  return {
    at: typeof s.at === 'number' ? s.at : now,
    durationMs: toCount(s.durationMs),
    state: s.state === 'ok' || s.state === 'partial' || s.state === 'failed' || s.state === 'cancelled' ? s.state : 'failed',
    ...(optionalString(s.taskId) ? { taskId: optionalString(s.taskId) as string } : {}),
    params: {
      group: optionalString(paramsRaw.group),
      // 多映射快照：缺省（旧快照）不补字段 —— 页面据此区分「上次同步用了哪套映射」与「现在登记的是什么」
      ...(Array.isArray(paramsRaw.mappings) && paramsRaw.mappings.length > 0
        ? {
          mappings: (paramsRaw.mappings as Array<{ subdir?: unknown; group?: unknown }>)
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({
              subdir: normalizeSubdir(typeof item.subdir === 'string' ? item.subdir : ''),
              group: optionalString(item.group),
            })),
        }
        : {}),
      conflictMode: validateImportConflictMode(typeof paramsRaw.conflictMode === 'string' ? paramsRaw.conflictMode : undefined),
      vector: paramsRaw.vector !== false,
      chunkSize: typeof paramsRaw.chunkSize === 'number' ? paramsRaw.chunkSize : null,
      chunkOverlap: typeof paramsRaw.chunkOverlap === 'number' ? paramsRaw.chunkOverlap : null,
      mode: paramsRaw.mode === 'incremental' ? 'incremental' : 'full',
    },
    result,
    seenRels: Array.isArray(s.seenRels) ? s.seenRels.filter((item): item is string => typeof item === 'string') : [],
    pendingDelete: pending,
    ...(normalizeGitSyncState(s.git) ? { git: normalizeGitSyncState(s.git) as DataSourceGitSyncState } : {}),
    ...(normalizeWarnings(s.warnings) ? { warnings: normalizeWarnings(s.warnings) } : {}),
  };
}

function normalizeRecord(scope: string, raw: unknown): DataSourceRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.dir !== 'string' || !v.dir.trim()) return null;

  const type: DataSourceKind = v.type === 'git' ? 'git' : 'directory';
  let git: DataSourceGitInfo | undefined;
  if (type === 'git') {
    git = normalizeGitInfo(v.git) ?? undefined;
    if (!git) return null;
  }

  const conflictMode = validateImportConflictMode(typeof v.conflictMode === 'string' ? v.conflictMode : undefined);
  const groupRaw = typeof v.group === 'string' ? v.group.trim() : '';
  /**
   * 多映射迁移（REQ-20261104-002 / R1）：`mappings` 优先，旧记录由 `git.relativeRoot` + `group`
   * 合成 1 条 —— 单条映射的语义与升级前**逐字节一致**（护栏 #5）。
   *
   * ★ `group` / `git.relativeRoot` / `dir` 三个兼容位继续由 `mappings[0]` 回填，
   *   凡是在这里直接信旧字段的地方都会在多映射记录上读到"第一条"，不要再新增这种读法。
   */
  const mappings = resolveMappings({
    mappings: v.mappings,
    relativeRoot: git?.relativeRoot ?? '',
    group: groupRaw ? groupRaw : null,
  });
  const primary = mappings[0];
  return {
    version: 3,
    scope,
    type,
    dir: path.resolve(v.dir),
    ...(git ? { git } : {}),
    group: primary.group,
    mappings,
    conflictMode,
    conflictSuffix: typeof v.conflictSuffix === 'string'
      ? validateImportConflictSuffix(v.conflictSuffix)
      : DEFAULT_IMPORT_CONFLICT_SUFFIX,
    vector: v.vector !== false,
    chunkSize: typeof v.chunkSize === 'number' ? v.chunkSize : null,
    chunkOverlap: typeof v.chunkOverlap === 'number' ? v.chunkOverlap : null,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(),
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : Date.now(),
    revision: typeof v.revision === 'number' && Number.isFinite(v.revision)
      ? Math.max(0, Math.trunc(v.revision))
      : 0,
    schedule: normalizeDataSourceSchedule(v.schedule),
    lastSync: normalizeLastSync(v.lastSync),
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
  /** directory = 显式普通目录；git = 显式 Git（探测失败 fail-loud）；缺省 = 自动探测 */
  type?: DataSourceKind;
  /** S-05 托管 clone 直接注入，避免重复探测 */
  gitInfo?: DataSourceGitInfo;
  /**
   * 单值落点（兼容位）。传了 `mappings` 时忽略它（以 `mappings[0].group` 为准）。
   * ★ 不传 `mappings` 且已登记记录为多映射时，登记会被拒绝（R9 / 护栏 #4）。
   */
  group?: string | null;
  /** 「子目录 → 落点 Group」映射（页面入口专用；CLI 不传） */
  mappings?: DataSourceMappingItem[];
  conflictMode?: string;
  conflictSuffix?: string;
  vector?: boolean;
  chunkSize?: number | null;
  chunkOverlap?: number | null;
  force?: boolean;
  config?: KiConfig;
}

export type AddDataSourceResult =
  | { ok: true; scope: string; record: DataSourceRecord; created: boolean; next: string; warnings?: string[] }
  | { ok: false; scope: string; code: string; error: string };

export async function addDataSource(input: AddDataSourceInput): Promise<AddDataSourceResult> {
  const config = input.config ?? loadConfig();
  let scope: string;
  try {
    scope = resolveScope(config, input.scope);
  } catch (err) {
    return { ok: false, scope: input.scope, code: 'INVALID_SCOPE', error: (err as Error).message };
  }
  try {
    return await withScopeWriteLock(scope, 'datasource-add', () => addDataSourceUnlocked(scope, input, config));
  } catch (err) {
    return {
      ok: false,
      scope,
      code: (err as NodeJS.ErrnoException & { code?: string }).code ?? 'ADD_FAILED',
      error: (err as Error).message,
    };
  }
}

async function addDataSourceUnlocked(scope: string, input: AddDataSourceInput, config: KiConfig): Promise<AddDataSourceResult> {
  const dir = resolveSourceDirInput(input.dir);
  const conflictMode = validateImportConflictMode(input.conflictMode);
  const conflictSuffix = validateImportConflictSuffix(input.conflictSuffix);
  const chunkSize = input.chunkSize ?? null;
  const chunkOverlap = input.chunkOverlap ?? null;
  const chunkErr = validateChunkParams({ chunkSize, chunkOverlap });
  if (chunkErr) {
    return { ok: false, scope, code: 'INVALID_CHUNK', error: chunkErr.message };
  }

  const dirCheck = checkSourceDir(dir, config, scope);
  if (!dirCheck.ok) return { ok: false, scope, code: dirCheck.code, error: dirCheck.error };

  if (input.type !== undefined && input.type !== 'git' && input.type !== 'directory') {
    return { ok: false, scope, code: 'INVALID_TYPE', error: `--type 只能是 git 或 directory：${String(input.type)}` };
  }

  const warnings: string[] = [];
  let type: DataSourceKind;
  let git: DataSourceGitInfo | undefined;
  if (input.type === 'directory') {
    type = 'directory';
  } else if (input.gitInfo) {
    git = normalizeGitInfo(input.gitInfo) ?? undefined;
    if (!git) return { ok: false, scope, code: 'INVALID_GIT_INFO', error: 'gitInfo 非法（repoRoot 必须是绝对路径）' };
    type = 'git';
  } else {
    const probe = await probeGit(dir);
    if (probe.ok) {
      type = 'git';
      git = { ...probe.value, managed: false, remoteBranch: null };
    } else if (input.type === 'git') {
      return { ok: false, scope, code: probe.code, error: probe.error };
    } else {
      type = 'directory';
      warnings.push(`未识别为 Git 仓库（${probe.error}），已按普通目录登记；如需增量请使用 --type git`);
    }
  }

  // 映射（REQ-20261104-002）：传入 mappings 时它是权威，`group` 退化为 mappings[0].group
  // 的兼容位；未传（CLI / 旧调用方）则沿用「单子目录 + 单 group」合成 1 条。
  // ★ 传了 `mappings` 就走严格归一（空数组 / 全脏 → `validateMappings` 报 MAPPING_EMPTY），
  //   不能退回 `resolveMappings` 的"旧字段兜底"——那会把空数组静默当成一条根映射。
  const mappings = input.mappings !== undefined
    ? (normalizeMappingInput(input.mappings) ?? [])
    : resolveMappings({
      relativeRoot: git?.relativeRoot ?? '',
      group: (input.group ?? '').trim() || null,
    });
  const mappingIssue = validateMappings(mappings);
  if (mappingIssue) {
    return { ok: false, scope, code: mappingIssue.code, error: mappingIssue.error };
  }
  const group = mappings[0].group;
  // group 会拼进 local-kb / 分片路径：绝对路径、反斜杠、`..` 与根保留名一律拒绝
  // （与 `/api/import/run`、`/api/import/preflight` 同口径）
  if (group !== null && !isUserAssignableGroup(group)) {
    return { ok: false, scope, code: 'INVALID_GROUP', error: `非法 Group 路径：${group}（不可为绝对路径、含 .. / 反斜杠，或使用保留名 "${ROOT_GROUP_KEY}"）` };
  }
  const existing = readDataSource(scope);
  if (!existing.ok && existing.code !== 'NOT_FOUND') {
    return { ok: false, scope, code: existing.code, error: existing.error };
  }
  const prev = existing.ok ? existing.record : null;
  /**
   * 护栏 #4 / R9：CLI 写入口只有单值 `--subdir` / `--group`，覆盖多映射记录会把 N 条静默压成 1 条。
   * 入口是「页面支持、CLI 不支持」（用户 2026-11-04 拍板 Q4），这里对**未传 mappings 的调用方**
   * 一律拒绝并指向页面 —— 宁可让 CLI 报错，也不静默丢配置。
   */
  const prevMappings = prev ? mappingsOf(prev) : [];
  if (input.mappings === undefined && prevMappings.length > 1) {
    return {
      ok: false,
      scope,
      code: 'MULTI_MAPPING_UNSUPPORTED',
      error: `该数据源已有 ${prevMappings.length} 条「子目录 → Group」映射，CLI 不支持修改；请在页面「编辑数据源」里调整`,
    };
  }
  const mappingChanged = prev !== null && !sameMappings(prevMappings, mappings);
  if (prev && !input.force && ((prev.dir !== dir) || (prev.group !== group) || mappingChanged)) {
    const changes: string[] = [];
    if (prev.dir !== dir) changes.push(`--source：${prev.dir} → ${dir}（旧路径下的文档会在下次同步进入待删候选，本次不会自动删）`);
    if (mappingChanged && prev.group !== group) {
      changes.push(`--group：${prev.group ?? '(自动)'} → ${group ?? '(自动)'}（旧 group 的文档会保留并产生重复，需手动清理）`);
    }
    if (mappingChanged) changes.push('子目录 / 落点映射已变更（旧映射下的文档会在下次同步进入待删候选，改 Group 的会保留并产生重复）');
    return {
      ok: false,
      scope,
      code: 'NEEDS_FORCE',
      error: `修改 ${changes.join('；')}。确认请加 --force`,
    };
  }

  if (!prev) ensureScopeDir(scope);
  const now = Date.now();
  const gitChanged = prev !== null && (
    prev.type !== type
    || prev.git?.repoRoot !== git?.repoRoot
    || prev.git?.relativeRoot !== git?.relativeRoot
    || prev.git?.managed !== git?.managed
  );
  const changed = prev !== null && (prev.dir !== dir || prev.group !== group || mappingChanged || gitChanged);
  // 改 --source / --group / 类型 / 仓库根：保留 seenRels（旧文档下次同步仍能进候选），
  // 但清掉旧候选/token 与 commit 水位——它们属于旧目录/旧仓库。
  let lastSync = prev?.lastSync ?? null;
  if (lastSync && changed) {
    const { git: _prevGit, warnings: _prevWarnings, ...rest } = lastSync;
    lastSync = {
      ...rest,
      pendingDelete: { ...emptyPending(now), stale: true, staleReason: 'not-recomputed' as const },
    };
  }
  const record: DataSourceRecord = {
    version: 3,
    scope,
    type,
    dir,
    ...(git ? { git } : {}),
    group,
    mappings,
    conflictMode,
    conflictSuffix,
    vector: input.vector !== false,
    chunkSize,
    chunkOverlap,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    // 重新登记（add --force）也是一次配置写入：bump 修订号，让打开中的编辑表单失效
    revision: prev ? (prev.revision ?? 0) + 1 : 0,
    schedule: prev?.schedule ?? defaultDataSourceSchedule(),
    lastSync,
  };
  writeDataSource(scope, record);
  return {
    ok: true,
    scope,
    record,
    created: !prev,
    next: `ki datasource sync --scope ${scope}`,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ─── 编辑同步参数（2026-10-30）────────────────────────────

/**
 * 可编辑字段：仓库来源 / 分支仍不可改（改源需移除后重加）。
 * `mappings` 自 REQ-20261104-002 起可编辑（页面入口），其余身份字段仍只读。
 */
export interface DataSourceConfigPatch {
  /**
   * 「子目录 → Group」映射（REQ-20261104-002）：传入即整体替换（不是增量合并）。
   * 只影响**下次同步**；历史文档不回填（改 Group 会保留旧组文档并产生重复，见页面二次确认）。
   */
  mappings?: DataSourceMappingItem[];
  conflictMode?: string;
  conflictSuffix?: string;
  vector?: boolean;
  chunkSize?: number | null;
  chunkOverlap?: number | null;
}

export type UpdateDataSourceConfigResult =
  | { ok: true; scope: string; record: DataSourceRecord; changed: string[] }
  | { ok: false; scope: string; code: string; error: string; field?: string; current?: DataSourceRecord };

/**
 * 页面编辑数据源同步参数（唯一写入口）。
 * - 只覆盖传入字段，未传保持原值；全等时**不 bump** revision
 * - `baseRevision` 乐观锁（多标签页）；运行中同步由 scope 写锁直接拒绝（SCOPE_OPERATION_BUSY）
 * - 不触碰 `lastSync` / `schedule`：新参数自下次同步起生效，历史文档不回填
 */
export async function updateDataSourceConfig(input: {
  scope: string;
  baseRevision?: number;
  patch: DataSourceConfigPatch;
  config?: KiConfig;
}): Promise<UpdateDataSourceConfigResult> {
  const config = input.config ?? loadConfig();
  let scope: string;
  try {
    scope = resolveScope(config, input.scope);
  } catch (err) {
    return { ok: false, scope: input.scope, code: 'INVALID_SCOPE', error: (err as Error).message };
  }
  const patch = input.patch ?? {};
  if (patch.conflictMode !== undefined && typeof patch.conflictMode !== 'string') {
    return { ok: false, scope, code: 'INVALID_CONFLICT', error: '同名策略不合法', field: 'conflictMode' };
  }
  if (patch.conflictSuffix !== undefined && typeof patch.conflictSuffix !== 'string') {
    return { ok: false, scope, code: 'INVALID_CONFLICT', error: '同名后缀不合法', field: 'conflictSuffix' };
  }
  if (patch.vector !== undefined && typeof patch.vector !== 'boolean') {
    return { ok: false, scope, code: 'INVALID_VECTOR', error: '向量化开关不合法', field: 'vector' };
  }
  // ★ 只校验本次 patch 传入的字段（不按合并后的生效值做**范围**校验）：存量里可能存着
  // 旧版放行的超界值（此前只有 ">0" 下界、无上界），若拿合并值判范围，用户只想改「同名策略」
  // 也会被历史值拦住、整条配置改不动。合并值仍参与「overlap 必须小于段长」的关系校验（见下）。
  const chunkErr = validateChunkParams({ chunkSize: patch.chunkSize, chunkOverlap: patch.chunkOverlap });
  if (chunkErr) {
    return { ok: false, scope, code: 'INVALID_CHUNK', error: chunkErr.message, field: chunkErr.field };
  }
  try {
    return await withScopeWriteLock(scope, 'datasource-update', async (): Promise<UpdateDataSourceConfigResult> => {
      const read = readDataSource(scope);
      if (!read.ok) return { ok: false, scope, code: read.code, error: read.error };
      const prev = read.record;
      if (input.baseRevision !== undefined && input.baseRevision !== (prev.revision ?? 0)) {
        return {
          ok: false,
          scope,
          code: 'DATASOURCE_STALE',
          error: '数据源配置已在别处修改，请刷新后重试',
          current: prev,
        };
      }
      let conflictMode = prev.conflictMode;
      let conflictSuffix = prev.conflictSuffix;
      try {
        if (patch.conflictMode !== undefined) conflictMode = validateImportConflictMode(patch.conflictMode);
        if (patch.conflictSuffix !== undefined) conflictSuffix = validateImportConflictSuffix(patch.conflictSuffix);
      } catch (err) {
        return { ok: false, scope, code: 'INVALID_CONFLICT', error: (err as Error).message };
      }
      // ── 映射（REQ-20261104-002）：整体替换 + 三条硬约束 ──
      let nextMappings = mappingsOf(prev);
      if (patch.mappings !== undefined) {
        const incoming = normalizeMappingInput(patch.mappings);
        if (incoming === null) {
          return { ok: false, scope, code: 'INVALID_MAPPINGS', error: 'mappings 必须是数组（[{ subdir, group }]）', field: 'mappings' };
        }
        const issue = validateMappings(incoming);
        if (issue) {
          return { ok: false, scope, code: issue.code, error: issue.error, field: 'mappings' };
        }
        // 普通目录数据源没有「仓库内子目录」概念：只允许一条根映射
        if (prev.type !== 'git' && incoming.some((item) => normalizeSubdir(item.subdir) !== '')) {
          return {
            ok: false,
            scope,
            code: 'INVALID_SUBDIR',
            error: '普通目录数据源不支持「仓库子目录」映射，只能用一条根映射（子目录留空）',
            field: 'mappings',
          };
        }
        nextMappings = incoming;
      }
      const vector = patch.vector !== undefined ? patch.vector : prev.vector;
      const chunkSize = patch.chunkSize !== undefined ? patch.chunkSize : prev.chunkSize;
      const chunkOverlap = patch.chunkOverlap !== undefined ? patch.chunkOverlap : prev.chunkOverlap;
      // 默认值与 chunker 一致（1000 / 150）：只改其中一个也要按**生效值**校验
      if ((chunkOverlap ?? DEFAULT_CHUNK_OVERLAP) >= (chunkSize ?? DEFAULT_CHUNK_SIZE)) {
        return {
          ok: false,
          scope,
          code: 'INVALID_CHUNK',
          error: `重叠（${chunkOverlap ?? DEFAULT_CHUNK_OVERLAP}）必须小于段长（${chunkSize ?? DEFAULT_CHUNK_SIZE}）`,
          field: 'chunkOverlap',
        };
      }
      const changed: string[] = [];
      if (conflictMode !== prev.conflictMode) changed.push('conflictMode');
      if (conflictSuffix !== prev.conflictSuffix) changed.push('conflictSuffix');
      if (vector !== prev.vector) changed.push('vector');
      if (chunkSize !== prev.chunkSize) changed.push('chunkSize');
      if (chunkOverlap !== prev.chunkOverlap) changed.push('chunkOverlap');
      const mappingsChanged = !sameMappings(mappingsOf(prev), nextMappings);
      if (mappingsChanged) changed.push('mappings');
      if (changed.length === 0) return { ok: true, scope, record: prev, changed };
      const nowUpdate = Date.now();
      const primary = nextMappings[0];
      // 兼容位继续跟随首条映射：`dir` / `group` / `git.relativeRoot` 全是旧读方的入口
      const nextDir = prev.type === 'git' && prev.git
        ? mappingTargetDir(prev.git.repoRoot, primary.subdir)
        : prev.dir;
      const next: DataSourceRecord = {
        ...prev,
        dir: nextDir,
        group: primary.group,
        mappings: nextMappings,
        ...(prev.git ? { git: { ...prev.git, relativeRoot: primary.subdir } } : {}),
        conflictMode,
        conflictSuffix,
        vector,
        chunkSize,
        chunkOverlap,
        revision: (prev.revision ?? 0) + 1,
        updatedAt: nowUpdate,
        // 落点变了 ⇒ 两件事必须一起做（与 addDataSource 的 changed 分支同口径）：
        //  ① 旧候选与它的 token 作废，否则删除按钮会拿旧 token 去删新候选；
        //  ② **丢掉 commit 水位**（含 `git`），让下次同步退回全量 —— 否则新增/改动的子目录
        //     只会 diff「上次 commit 之后」的变更，**它历史上已有的文件永远导不进来**。
        // seenRels 保留：下次同步要靠它判断「库里哪些旧文档还在」。
        ...(mappingsChanged && prev.lastSync
          ? {
            lastSync: ((): DataSourceLastSync => {
              const { git: _prevGit, warnings: _prevWarnings, ...rest } = prev.lastSync as DataSourceLastSync;
              return {
                ...rest,
                pendingDelete: { ...emptyPending(nowUpdate), stale: true, staleReason: 'not-recomputed' as const },
              };
            })(),
          }
          : {}),
      };
      writeDataSource(scope, next);
      return { ok: true, scope, record: next, changed };
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException & { code?: string }).code ?? 'DATASOURCE_UPDATE_FAILED';
    return {
      ok: false,
      scope,
      code,
      error: code === 'SCOPE_OPERATION_BUSY' ? '该知识库正在同步，完成后再修改同步参数' : (err as Error).message,
    };
  }
}

// ─── 共享托管 clone（同一 remote+branch 只保留一份工作副本）────

export interface ReusableManagedClone {
  repoRoot: string;
  branch: string | null;
  remoteBranch: string;
  remoteUrl: string;
  ownerScope: string;
}

/** 读取所有已登记记录（不做源目录可达性过滤；共享 clone/引用计数/调度器必须看到它们）。 */
export function listRegisteredDataSourceRecords(config: KiConfig): { scope: string; record: DataSourceRecord }[] {
  const out: { scope: string; record: DataSourceRecord }[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(config.dataDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
    try {
      const read = readDataSource(entry.name);
      if (read.ok) out.push({ scope: entry.name, record: read.record });
    } catch {
      /* 单条损坏不影响其余记录 */
    }
  }
  return out;
}

function remoteUrlKey(url: string | null): string | null {
  const sanitized = sanitizeRemoteUrl(url ?? '');
  if (!sanitized) return null;
  return sanitized.replace(/\/+$/, '').replace(/\.git$/i, '');
}

/** 查找可复用的托管 clone：remoteUrl（已脱敏）+ 分支一致。 */
export function findReusableManagedClone(
  config: KiConfig,
  url: string,
  branch: string | null,
): ReusableManagedClone | null {
  const target = remoteUrlKey(url);
  if (!target) return null;
  const candidates: ReusableManagedClone[] = [];
  for (const { scope, record } of listRegisteredDataSourceRecords(config)) {
    const git = record.git;
    if (record.type !== 'git' || !git?.managed || !git.repoRoot || !git.remoteBranch) continue;
    // 只复用真正的托管副本（<cloneRoot>/<owner>/repo）；dataset.json 可被手工编辑，
    // managed=true 不足以证明路径受控，purge 也依赖该布局
    if (!managedCloneDirForRepo(git.repoRoot)) continue;
    if (!git.remoteUrl || remoteUrlKey(git.remoteUrl) !== target) continue;
    // 共享工作副本的身份是「远端分支」：branch 只是克隆时的 checkout 结果
    if (branch && git.remoteBranch !== branch) continue;
    try {
      if (!fs.statSync(git.repoRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    candidates.push({
      repoRoot: git.repoRoot,
      branch: git.branch,
      remoteBranch: git.remoteBranch,
      remoteUrl: git.remoteUrl,
      ownerScope: scope,
    });
  }
  if (candidates.length === 0) return null;
  // 未显式指定分支时，若已有副本分属不同分支，不能猜测默认分支，退回独立 clone
  if (!branch && new Set(candidates.map((item) => item.remoteBranch)).size > 1) return null;
  return candidates[0];
}

/** 统计引用某个托管 repoRoot 的其他数据源数量（用于 purge 前的引用计数）。 */
export function countManagedRepoRefs(
  repoRoot: string,
  config: KiConfig,
  excludeScope?: string,
): number {
  const target = path.resolve(repoRoot);
  return listRegisteredDataSourceRecords(config).filter(({ scope, record }) => (
    scope !== excludeScope
    && record.git?.managed === true
    && path.resolve(record.git.repoRoot) === target
  )).length;
}

function cloneLockScope(repoRoot: string): string {
  // 前缀含 NUL：保证不与任何合法 scope 名（[a-zA-Z0-9_-]+）产生的锁键重合
  return `\u0000clone:${crypto.createHash('sha256').update(path.resolve(repoRoot)).digest('hex').slice(0, 24)}`;
}

function remoteAddLockScope(url: string): string {
  // 只按 URL 加锁（且与复用判据同源，`repo` 与 `repo.git` 视为同一仓库）：
  // branch 为空与显式同名分支的并发 add 也走同一把锁，避免两个请求都看不到对方而各自 clone。
  const key = remoteUrlKey(url) ?? sanitizeRemoteUrl(url) ?? url;
  return `\u0000remote:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

/**
 * clone 级写锁：多个 scope 可以共享同一工作副本，scope 锁无法覆盖这种跨 scope
 * 竞争（同步/校验/删除）。锁文件仍落在 dataDir 的 scope 锁目录，键为 repoRoot 哈希。
 */
export async function withManagedCloneLock<T>(
  repoRoot: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  return withScopeWriteLock(cloneLockScope(repoRoot), operation, run);
}

function cloneBusyResult(scope: string): { ok: false; scope: string; code: string; error: string } {
  return { ok: false, scope, code: 'CLONE_BUSY', error: '该 Git 仓库正在被另一个数据源同步/校验，请稍后重试' };
}

// ─── add-remote（S-05 托管 clone）────────────────────────

export interface AddRemoteDataSourceInput {
  scope: string;
  url: string;
  branch?: string | null;
  /** 单值子目录（兼容位）。传了 `mappings` 时以 `mappings[0].subdir` 为准 */
  subdir?: string | null;
  /** 单值落点（兼容位）。传了 `mappings` 时以 `mappings[0].group` 为准 */
  group?: string | null;
  /** 「子目录 → 落点 Group」映射（页面入口专用，1..N 条） */
  mappings?: DataSourceMappingItem[];
  conflictMode?: string;
  conflictSuffix?: string;
  vector?: boolean;
  chunkSize?: number | null;
  chunkOverlap?: number | null;
  /** 仅测试：允许 file:// */
  allowFileUrl?: boolean;
  onProgress?: (progress: { phase: 'clone'; done: number; total: number }) => void;
  abortSignal?: AbortSignal;
  config?: KiConfig;
}

export type AddRemoteDataSourceResult =
  | {
    ok: true;
    scope: string;
    record: DataSourceRecord;
    created: boolean;
    clone: { repoRoot: string; dir: string; branch: string | null; headCommit: string | null };
    reused?: boolean;
    warnings?: string[];
  }
  | { ok: false; scope: string; code: string; error: string; hint?: string; cleanupWarning?: string };

/**
 * clone + 登记（同步执行，调用方决定任务边界）。
 *
 * 锁内顺序：重新检查登记/scope → clone（临时目录 + rename）→ addDataSource（同锁嵌套复用）。
 * clone 成功但登记失败时回收 clone 目录；回收失败在 `cleanupWarning` 里明示路径。
 */
export async function addRemoteDataSource(input: AddRemoteDataSourceInput): Promise<AddRemoteDataSourceResult> {
  const config = input.config ?? loadConfig();
  let scope: string;
  try {
    scope = resolveScope(config, input.scope);
  } catch (err) {
    return { ok: false, scope: input.scope, code: 'INVALID_SCOPE', error: (err as Error).message };
  }
  // 参数校验必须早于 clone：否则一次几分钟的 clone 后才失败
  // 映射是权威；单值 subdir / group 只在未传 mappings 时参与（兼容 CLI）。
  // 传了 mappings 就用严格归一：空数组必须报 MAPPING_EMPTY，而不是静默变成一条根映射。
  const mappings = input.mappings !== undefined
    ? (normalizeMappingInput(input.mappings) ?? [])
    : resolveMappings({
      relativeRoot: input.subdir,
      group: input.group,
    });
  const mappingIssue = validateMappings(mappings);
  if (mappingIssue) {
    return { ok: false, scope, code: mappingIssue.code, error: mappingIssue.error };
  }
  const group = mappings[0].group;
  const branch = (input.branch ?? '').trim() || null;
  const subdir = mappings[0].subdir;
  if (group !== null && !isUserAssignableGroup(group)) {
    return { ok: false, scope, code: 'INVALID_GROUP', error: `非法 Group 路径：${group}（不可为绝对路径、含 .. / 反斜杠，或使用保留名 "${ROOT_GROUP_KEY}"）` };
  }
  try {
    validateImportConflictMode(input.conflictMode);
    validateImportConflictSuffix(input.conflictSuffix);
  } catch (err) {
    return { ok: false, scope, code: 'INVALID_CONFLICT', error: (err as Error).message };
  }
  const chunkSize = input.chunkSize ?? null;
  const chunkOverlap = input.chunkOverlap ?? null;
  const chunkErr = validateChunkParams({ chunkSize, chunkOverlap });
  if (chunkErr) {
    return { ok: false, scope, code: 'INVALID_CHUNK', error: chunkErr.message };
  }
  const precheck = readDataSource(scope);
  if (precheck.ok) {
    return { ok: false, scope, code: 'DATASOURCE_EXISTS', error: `scope「${scope}」已登记数据源；请先 ki datasource remove --scope ${scope}` };
  }
  if (!precheck.ok && precheck.code !== 'NOT_FOUND') {
    return { ok: false, scope, code: precheck.code, error: precheck.error };
  }

  try {
    return await withScopeWriteLock(scope, 'datasource-add-remote', async () => {
      // 权威判断在锁内：快速失败检查只是减少无谓 clone
      const again = readDataSource(scope);
      if (again.ok) {
        return { ok: false, scope, code: 'DATASOURCE_EXISTS', error: `scope「${scope}」已登记数据源；请先 ki datasource remove --scope ${scope}` };
      }

      // 同一 remote 的并发 add 互斥：第一个 clone/复用，后到者返回 CLONE_BUSY，避免各自 clone
      try {
        return await withScopeWriteLock(remoteAddLockScope(input.url), 'datasource-add-remote', async () => {
          const reusable = findReusableManagedClone(config, input.url, branch);
          if (reusable) {
            try {
              return await withManagedCloneLock(reusable.repoRoot, 'datasource-add-reuse', async () => {
                // 复用前先 fetch 对齐远端：否则远端新增的子目录会被陈旧工作树判成「不存在」
                const refreshed = await refreshManagedClone(reusable.repoRoot, reusable.remoteBranch);
                // 逐条校验子目录（Q5：任一不存在 → 整源失败，并指明是第几条）
                let primaryDir = '';
                for (let i = 0; i < mappings.length; i += 1) {
                  const checkedOne = checkManagedSubdir(reusable.repoRoot, mappings[i].subdir, config, scope);
                  if (!checkedOne.ok) {
                    return {
                      ok: false,
                      scope,
                      code: checkedOne.code,
                      error: `${mappings.length > 1 ? `第 ${i + 1} 条映射：` : ''}${checkedOne.error}${refreshed.staleWarning ? `；${refreshed.staleWarning}` : ''}`,
                      ...(checkedOne.hint ? { hint: checkedOne.hint } : {}),
                    };
                  }
                  if (i === 0) primaryDir = checkedOne.dir;
                }
                const added = await addDataSource({
                  scope,
                  dir: primaryDir,
                  mappings,
                  type: 'git',
                  gitInfo: {
                    repoRoot: reusable.repoRoot,
                    relativeRoot: subdir,
                    branch: reusable.branch,
                    remoteUrl: reusable.remoteUrl,
                    managed: true,
                    remoteBranch: reusable.remoteBranch,
                  },
                  group,
                  ...(input.conflictMode ? { conflictMode: input.conflictMode } : {}),
                  ...(input.conflictSuffix ? { conflictSuffix: input.conflictSuffix } : {}),
                  ...(input.vector !== undefined ? { vector: input.vector } : {}),
                  chunkSize,
                  chunkOverlap,
                  config,
                });
                if (!added.ok) return { ok: false, scope, code: added.code, error: added.error };
                return {
                  ok: true,
                  scope,
                  record: added.record,
                  created: added.created,
                  reused: true,
                  clone: {
                    repoRoot: reusable.repoRoot,
                    dir: primaryDir,
                    branch: reusable.branch,
                    // 复用后的真实 HEAD（对齐远端失败时为本地 HEAD），此前固定为 null
                    headCommit: refreshed.headCommit,
                  },
                  ...(added.warnings && added.warnings.length > 0 ? { warnings: added.warnings } : {}),
                };
              });
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'SCOPE_OPERATION_BUSY') return cloneBusyResult(scope);
              throw err;
            }
          }

          const cloned = await cloneManagedRepo({
            scope,
            url: input.url,
            branch,
            subdir,
            config,
            allowFileUrl: input.allowFileUrl === true,
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
          if (!cloned.ok) {
            return {
              ok: false,
              scope,
              code: cloned.code,
              error: cloned.error,
              ...(cloned.hint ? { hint: cloned.hint } : {}),
            };
          }

          // 其余映射的子目录同样必须存在（Q5：任一不存在 → 整源失败，并回收 clone）
          for (let i = 1; i < mappings.length; i += 1) {
            const checkedOne = checkManagedSubdir(cloned.value.repoRoot, mappings[i].subdir, config, scope);
            if (checkedOne.ok) continue;
            const cleanup = await purgeManagedCloneDir(path.dirname(cloned.value.repoRoot));
            return {
              ok: false,
              scope,
              code: checkedOne.code,
              error: `第 ${i + 1} 条映射：${checkedOne.error}`,
              ...(checkedOne.hint ? { hint: checkedOne.hint } : {}),
              ...(cleanup.removed === false && 'error' in cleanup
                ? { cleanupWarning: `子目录校验失败且托管目录未清理：${cleanup.error}` }
                : {}),
            };
          }

          const added = await addDataSource({
            scope,
            dir: cloned.value.dir,
            mappings,
            type: 'git',
            gitInfo: {
              repoRoot: cloned.value.repoRoot,
              relativeRoot: subdir,
              branch: cloned.value.branch,
              remoteUrl: cloned.value.remoteUrl,
              managed: true,
              remoteBranch: branch ?? cloned.value.branch ?? 'HEAD',
            },
            group,
            ...(input.conflictMode ? { conflictMode: input.conflictMode } : {}),
            ...(input.conflictSuffix ? { conflictSuffix: input.conflictSuffix } : {}),
            ...(input.vector !== undefined ? { vector: input.vector } : {}),
            chunkSize,
            chunkOverlap,
            config,
          });
          if (!added.ok) {
            const cleanup = await purgeManagedCloneDir(path.dirname(cloned.value.repoRoot));
            return {
              ok: false,
              scope,
              code: added.code,
              error: added.error,
              ...(cleanup.removed === false && 'error' in cleanup
                ? { cleanupWarning: `登记失败且托管目录未清理：${cleanup.error}` }
                : {}),
            };
          }
          return {
            ok: true,
            scope,
            record: added.record,
            created: added.created,
            clone: {
              repoRoot: cloned.value.repoRoot,
              dir: cloned.value.dir,
              branch: cloned.value.branch,
              headCommit: cloned.value.headCommit,
            },
            ...(added.warnings && added.warnings.length > 0 ? { warnings: added.warnings } : {}),
          };
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'SCOPE_OPERATION_BUSY') {
          return { ok: false, scope, code: 'CLONE_BUSY', error: '该 Git 仓库正在被另一个数据源添加，请稍后重试' };
        }
        throw err;
      }
    });
  } catch (err) {
    return {
      ok: false,
      scope,
      code: (err as NodeJS.ErrnoException & { code?: string }).code ?? 'ADD_REMOTE_FAILED',
      error: (err as Error).message,
    };
  }
}

export type RemoveDataSourceResult =
  | { ok: true; scope: string; removed: boolean; /** 仅提示 */ legacySourceDir: string | null; managedCloneDir: string | null }
  | { ok: false; scope: string; code: string; error: string };

/** 取消登记：只删 datasource.json；**不碰** group-index.json.source（Q-C） */
export async function removeDataSource(scopeInput: string, config: KiConfig = loadConfig()): Promise<RemoveDataSourceResult> {
  let scope: string;
  try {
    scope = resolveScope(config, scopeInput);
  } catch (err) {
    return { ok: false, scope: scopeInput, code: 'INVALID_SCOPE', error: (err as Error).message };
  }
  try {
    return await withScopeWriteLock(scope, 'datasource-remove', async () => {
      const file = dataSourcePath(scope);
      const legacySourceDir = getSource(scope)?.dir ?? null;
      const read = readDataSource(scope);
      // 托管目录可能属于另一个 scope（共享 clone）：是否可删由引用计数决定，
      // 这里只负责把实际目录带给调用方。
      const managedCloneDir = read.ok ? managedCloneDirOf(read.record) : null;
      if (!fs.existsSync(file)) return { ok: true, scope, removed: false, legacySourceDir, managedCloneDir };
      try {
        fs.unlinkSync(file);
      } catch (err) {
        return { ok: false, scope, code: 'REMOVE_FAILED', error: `删除 datasource.json 失败：${(err as Error).message}` };
      }
      return { ok: true, scope, removed: true, legacySourceDir, managedCloneDir };
    });
  } catch (err) {
    return {
      ok: false,
      scope,
      code: (err as NodeJS.ErrnoException & { code?: string }).code ?? 'REMOVE_FAILED',
      error: (err as Error).message,
    };
  }
}

// ─── 枚举（列表 / 迁移提示） ─────────────────────────────

export interface DataSourceScopeScan {
  registered: { scope: string; record: DataSourceRecord }[];
  /** 有登记但目录不可读 */
  missing: { scope: string; reason: string }[];
  /** 有登记但 datasource.json 损坏/非法 */
  corrupt: { scope: string; reason: string }[];
}

/**
 * 扫描所有已登记数据源。
 * ⚠ 不能用 `scope.ts::listAllScopes()`：它的判据是「有 KB 数据」，会漏掉
 * 「登记了但从未同步」的 scope（而这恰恰是列表里最该出现的 `never` 状态）。
 */
export function scanDataSources(config: KiConfig = loadConfig()): DataSourceScopeScan {
  const out: DataSourceScopeScan = { registered: [], missing: [], corrupt: [] };
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
    // 未登记的 scope 直接跳过：2026-10-21 用户决定不再提示"历史导入目录"
    // （原先会扫描 group-index 的 source 块推一批"可登记"候选，页面与 CLI 都不再展示）
  }
  // 最久未同步在前；无 lastSync 的排最后
  out.registered.sort((a, b) => (a.record.lastSync?.at ?? Number.MAX_SAFE_INTEGER) - (b.record.lastSync?.at ?? Number.MAX_SAFE_INTEGER));
  return out;
}

// ─── 同步编排 ───────────────────────────────────────────

export interface SyncDataSourceInput {
  scope: string;
  dryRun?: boolean;
  /** S-02：忽略 commit diff，处理全部文件（含 untracked） */
  full?: boolean;
  taskId?: string;
  onProgress?: HandleDirectImportArgs['onProgress'];
  onPhase?: (phase: 'git-fetch' | 'git-update' | 'git-diff') => void;
  abortSignal?: AbortSignal;
  onInterrupt?: () => void;
  config?: KiConfig;
}

export interface SyncSummary {
  state: DataSourceSyncState;
  durationMs: number;
  files: DataSourceResultSnapshot['files'] | null;
  pendingDelete: DataSourcePendingDelete | null;
  mode: DataSourceSyncMode;
  git?: DataSourceGitSyncState;
  warnings: DataSourceWarning[];
  vectorized: number;
  fullTextIndexed: number;
  groups: string[];
  /** 本次新建的文档（与 `result.created` 同源；页面任务详情据此渲染「新增的文档」） */
  created?: { group: string; relation: string }[];
  createdTotal?: number;
  createdTruncated?: boolean;
  /** 本次变更（覆盖重写）的文档（与 `result.modified` 同源；渲染「变更的文档」） */
  modified?: { group: string; relation: string }[];
  modifiedTotal?: number;
  modifiedTruncated?: boolean;
  /**
   * 本次写入的候选基线（裸 rel，相对本次 sourceDir）。
   * 多映射编排据此合成分桶后的 `lastSync.seenRels`（REQ-20261104-002）——
   * 单映射路径不读它（lastSync 已直接落盘）。
   */
  seenRels?: string[];
}

export type SyncDataSourceResult =
  | {
    ok: true;
    scope: string;
    dryRun: true;
    plannedFiles: number;
    mode: DataSourceSyncMode;
    changedFiles: number;
    untrackedMarkdown: number;
    wouldFallbackFull: boolean;
    warnings: DataSourceWarning[];
    pendingDelete: DataSourcePendingDelete | null;
  }
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
      // S-02 会用 onScannedFiles 覆盖为真实全量/变更数；此处先保持向后兼容的初值
      fullScanned: result.stats.files.scanned,
      changed: result.stats.files.scanned,
      completed: result.stats.files.completed,
      unchanged: result.stats.files.unchanged,
      skipped: result.stats.files.skipped,
      incomplete: result.stats.files.incomplete,
      duplicatesSkipped: result.stats.files.duplicatesSkipped,
    },
    vectorized: result.stats.vectorized,
    fullTextIndexed: result.stats.fullTextIndexed,
    groups: result.groups ?? [],
    created: (result.created ?? []).map((item) => ({ group: item.group, relation: item.relation })),
    createdTotal: result.createdTotal ?? result.created?.length ?? 0,
    ...(result.createdTruncated ? { createdTruncated: true } : {}),
    modified: (result.modified ?? []).map((item) => ({ group: item.group, relation: item.relation })),
    modifiedTotal: result.modifiedTotal ?? result.modified?.length ?? 0,
    ...(result.modifiedTruncated ? { modifiedTruncated: true } : {}),
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
  extra?: { git?: DataSourceGitSyncState; warnings?: DataSourceWarning[] },
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
      mode: prev?.params.mode ?? 'full',
    },
    result: partialResult ? resultSnapshot(partialResult) : {
      files: { scanned: 0, fullScanned: 0, changed: 0, completed: 0, unchanged: 0, skipped: 0, incomplete: 0, duplicatesSkipped: 0 },
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
    ...(extra?.git ? { git: extra.git } : (prev?.git ? { git: prev.git } : {})),
    ...(extra?.warnings ? { warnings: extra.warnings } : (prev?.warnings ? { warnings: prev.warnings } : {})),
  };
}

/**
 * 数据源同步终态判据（S-02）。
 * `stats.errors` 包含 tag/附件/向量清理等错误；CLI 任务态已按
 * `partial || stats.errors > 0` 判 partial，数据源用 state=ok 推进 commit 水位，
 * 因此不能只看 `result.partial`。
 */
export function resolveDataSourceSyncState(
  result: Pick<ImportResult, 'cancelled' | 'partial'> & { stats: { errors: number } },
): DataSourceSyncState {
  if (result.cancelled === true) return 'cancelled';
  return result.partial || result.stats.errors > 0 ? 'partial' : 'ok';
}

function warning(code: string, message: string): DataSourceWarning {
  return { code, message };
}

function emptyFiles(fullScanned = 0, changed = 0): DataSourceResultSnapshot['files'] {
  return { scanned: 0, fullScanned, changed, completed: 0, unchanged: 0, skipped: 0, incomplete: 0, duplicatesSkipped: 0 };
}

function staleReasonOf(code: string): DataSourceStaleReason {
  if (code === 'SOURCE_UNREADABLE') return 'source-unreadable';
  if (code === 'SOURCE_MISSING') return 'source-missing';
  return 'not-recomputed';
}

/** Git 源的前置可达性：只 stat/access，不判空（空源要在自动更新后再判）。 */
function checkGitReachable(dir: string): { ok: true } | { ok: false; code: 'SOURCE_MISSING' | 'SOURCE_NOT_DIR' | 'SOURCE_UNREADABLE'; error: string } {
  try {
    const lst = fs.lstatSync(dir);
    const stat = lst.isSymbolicLink() ? fs.statSync(dir) : lst;
    if (!stat.isDirectory()) return { ok: false, code: 'SOURCE_NOT_DIR', error: `源路径不是目录：${dir}` };
  } catch {
    return { ok: false, code: 'SOURCE_MISSING', error: `源目录不存在：${dir}` };
  }
  try {
    fs.accessSync(dir, fs.constants.R_OK);
  } catch (err) {
    return { ok: false, code: 'SOURCE_UNREADABLE', error: `源目录不可读：${dir}（${(err as Error).message}）` };
  }
  return { ok: true };
}

function failSync(
  scope: string,
  input: SyncDataSourceInput,
  record: DataSourceRecord,
  code: string,
  error: string,
  staleReason: DataSourceStaleReason,
  extra?: { git?: DataSourceGitSyncState; warnings?: DataSourceWarning[] },
): SyncDataSourceResult {
  if (!input.dryRun) {
    writeDataSource(scope, {
      ...record,
      updatedAt: Date.now(),
      lastSync: preservePrevSync(record, 'failed', staleReason, undefined, extra),
    });
  }
  return { ok: false, scope, code, error };
}

function buildGitState(args: {
  update: GitUpdateResult;
  prevCommit: string | null;
  runCommit: string | null;
  changedCount: number;
  fullScanned: number;
  untrackedMarkdown: number;
  state: DataSourceSyncState;
  /**
   * 多映射编排用：水位由合并层按「全映射成功」判定（护栏 #3），
   * 不能只按 `state === 'ok'` —— partial 是允许推进的，而「任一映射 failed」必须回退。
   */
  commitOverride?: string | null;
}): DataSourceGitSyncState {
  const commit = args.commitOverride !== undefined
    ? args.commitOverride
    : args.state === 'ok' ? args.runCommit : args.prevCommit;
  return {
    commit,
    runCommit: args.runCommit,
    shortCommit: args.runCommit ? args.runCommit.slice(0, 7) : (commit ? commit.slice(0, 7) : null),
    subject: args.update.headSubject,
    authorTime: args.update.headAuthorTime,
    changedCount: args.changedCount,
    fullScanned: args.fullScanned,
    untrackedMarkdown: args.untrackedMarkdown,
    update: args.update.update,
    ...(args.update.updateDetail ? { updateDetail: args.update.updateDetail } : {}),
    fetch: args.update.fetch,
    ...(args.update.fetchDetail ? { fetchDetail: args.update.fetchDetail } : {}),
  };
}

function planFor(
  scope: string,
  record: DataSourceRecord,
  config: KiConfig,
  files: string[],
  prevSeen: string[],
): ImportPrunePlan {
  const importedGroups = [...new Set(files.map((rel) => resolveGroupForSource(record.group ?? '', rel, scope)))];
  return planImportPrune({
    scope,
    group: record.group ?? '',
    scannedRels: files,
    importedGroups,
    precheck: { pruneStale: true, pickMode: 'dir', subsetRetry: false, uploadIncomplete: false, scannedCount: files.length },
    eligibleRels: prevSeen,
    emitTokenWhenOverLimit: true,
  });
}

/**
 * 存量切分参数归一（同步路径专用）。
 *
 * `datasource.json` 里可能存着**旧版放行的超界值**（旧版只校验 ">0"、无上下限）。
 * 新校验的语义是「拦住用户新输入」，不该让历史配置的同步直接失败 —— 尤其定时同步，
 * 用户根本看不到报错。这里把超界值钳到最近边界并留可见 warning，同步照常进行；
 * 钳制后重切分与用户手动改参数同效应（本来就要重建）。
 */
export function normalizeStoredChunkParams(
  chunkSize: number | null,
  chunkOverlap: number | null,
): { chunkSize: number | null; chunkOverlap: number | null; warnings: DataSourceWarning[] } {
  const warnings: DataSourceWarning[] = [];
  let size = chunkSize;
  let overlap = chunkOverlap;
  if (size !== null && (size < MIN_CHUNK_SIZE || size > MAX_CHUNK_SIZE)) {
    const fixed = Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, Math.trunc(size)));
    warnings.push(warning(
      'CHUNK_PARAM_CLAMPED',
      `切分段长 ${size} 超出 ${MIN_CHUNK_SIZE}–${MAX_CHUNK_SIZE}，本次按 ${fixed} 执行；请在「编辑同步参数」中改成合法值`,
    ));
    size = fixed;
  }
  if (overlap !== null && (overlap < 0 || overlap > MAX_CHUNK_OVERLAP)) {
    const fixed = Math.min(MAX_CHUNK_OVERLAP, Math.max(0, Math.trunc(overlap)));
    warnings.push(warning(
      'CHUNK_PARAM_CLAMPED',
      `切分重叠 ${overlap} 超出 0–${MAX_CHUNK_OVERLAP}，本次按 ${fixed} 执行；请在「编辑同步参数」中改成合法值`,
    ));
    overlap = fixed;
  }
  // 段长被调小后可能反而不大于重叠：保底让重叠小于段长，避免同步因关系非法再次失败
  if (size !== null && overlap !== null && overlap >= size) {
    const fixed = Math.max(0, size - 1);
    warnings.push(warning(
      'CHUNK_PARAM_CLAMPED',
      `切分重叠 ${overlap} 不小于段长 ${size}，本次按 ${fixed} 执行；请在「编辑同步参数」中改成合法值`,
    ));
    overlap = fixed;
  }
  return { chunkSize: size, chunkOverlap: overlap, warnings };
}

async function importAndPersist(args: {
  scope: string;
  record: DataSourceRecord;
  input: SyncDataSourceInput;
  config: KiConfig;
  mode: DataSourceSyncMode;
  prevSeen: string[];
  startedAt: number;
  onlyRelPaths?: string[];
  pruneSubsetFullScan: boolean;
  /** 多映射编排：拿到本次**将要落盘**的完整快照（合并层需要 conflicts / failures 明细） */
  capture?: (lastSync: DataSourceLastSync) => void;
  git?: {
    update: GitUpdateResult;
    prevCommit: string | null;
    runCommit: string | null;
    untrackedMarkdown: number;
    warnings: DataSourceWarning[];
  };
}): Promise<SyncDataSourceResult> {
  const { scope, record, input, config, mode, prevSeen, startedAt, git } = args;
  let scannedForBaseline: string[] = [];
  let scannedCaptured = false;
  let result: ImportResult;
  const chunkParams = normalizeStoredChunkParams(record.chunkSize, record.chunkOverlap);
  try {
    result = await handleDirectImport({
      scope,
      sourceDir: record.dir,
      ...(record.group ? { group: record.group } : {}),
      conflictMode: record.conflictMode,
      conflictSuffix: record.conflictSuffix,
      vector: record.vector,
      ...(chunkParams.chunkSize !== null ? { chunkSize: chunkParams.chunkSize } : {}),
      ...(chunkParams.chunkOverlap !== null ? { chunkOverlap: chunkParams.chunkOverlap } : {}),
      ...(args.onlyRelPaths && args.onlyRelPaths.length > 0 ? { onlyRelPaths: args.onlyRelPaths } : {}),
      pruneSubsetFullScan: args.pruneSubsetFullScan,
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
  } catch (err) {
    const errCode = (err as { code?: string }).code ?? 'SYNC_FAILED';
    /**
     * 数据源同步**没有** `--no-vector` 这个开关（那是 `ki import` 的参数）。
     * `handleDirectImport` 的通用文案在这里会给出用户照做不了的指引，必须换成数据源的出路：
     * 页面「编辑」里关闭该源的「向量化」改走仅全文，或修好 embedding 后自动恢复。
     */
    const errMessage = errCode === 'VECTOR_UNAVAILABLE'
      ? `${(err as Error).message}（数据源同步不使用 --no-vector：请在数据源「编辑」里关闭该源的「向量化」，或修复 embedding 后重试）`
      : (err as Error).message;
    const warnings = [
      ...(git?.warnings ?? []),
      ...chunkParams.warnings,
      warning(errCode, errMessage),
    ];
    const gitState = git
      ? buildGitState({
        update: git.update, prevCommit: git.prevCommit, runCommit: git.runCommit,
        changedCount: 0, fullScanned: 0, untrackedMarkdown: git.untrackedMarkdown, state: 'failed',
      })
      : undefined;
    return failSync(
      scope, input, record,
      errCode,
      errMessage,
      'not-recomputed',
      { ...(gitState ? { git: gitState } : {}), warnings },
    );
  }

  // ★ 与 CLI 任务态同口径：stats.errors（tag/附件/向量清理等）也算未完整成功。
  //   数据源用 state=ok 推进 commit 水位，不能只看 result.partial。
  const state = resolveDataSourceSyncState(result);
  const success = state === 'ok' || state === 'partial';
  const now = Date.now();
  const pendingDelete = success
    ? pendingFromPlan(result.prune, now)
    : { ...(record.lastSync?.pendingDelete ?? emptyPending(now)), stale: true, staleReason: 'not-recomputed' as const };
  const blockedReason = result.prune?.skipReason;
  const freezeBaseline = blockedReason === 'GATE_COORD' || blockedReason === 'GATE_SCALE' || blockedReason === 'EMPTY_SOURCE';
  const seenRels = success && scannedCaptured && !freezeBaseline ? [...scannedForBaseline].sort() : prevSeen;

  const snapshot = resultSnapshot(result);
  const fullScanned = scannedCaptured ? scannedForBaseline.length : snapshot.files.scanned;
  const changed = mode === 'full'
    ? fullScanned
    : (result.retryFilter?.matched ?? args.onlyRelPaths?.length ?? 0);
  snapshot.files.fullScanned = fullScanned;
  snapshot.files.changed = changed;

  const warnings = [...(git?.warnings ?? []), ...chunkParams.warnings];
  const missing = result.retryFilter?.missing?.length ?? 0;
  if (missing > 0) warnings.push(warning('GIT_CHANGESET_MISSING_PATHS', `有 ${missing} 个变更文件在扫描前已不存在，已跳过`));

  const gitState = git
    ? buildGitState({
      update: git.update, prevCommit: git.prevCommit, runCommit: git.runCommit,
      changedCount: changed, fullScanned, untrackedMarkdown: git.untrackedMarkdown, state,
    })
    : undefined;

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
      mode,
    },
    result: snapshot,
    seenRels,
    pendingDelete,
    ...(gitState ? { git: gitState } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  args.capture?.(lastSync);
  const nextRecord = git && git.update.branch && record.git && git.update.branch !== record.git.branch
    ? { ...record, git: { ...record.git, branch: git.update.branch }, updatedAt: now, lastSync }
    : { ...record, updatedAt: now, lastSync };
  writeDataSource(scope, nextRecord);

  return {
    ok: true,
    scope,
    dryRun: false,
    summary: {
      state,
      durationMs: lastSync.durationMs,
      files: snapshot.files,
      pendingDelete,
      mode,
      seenRels,
      ...(gitState ? { git: gitState } : {}),
      warnings,
      vectorized: snapshot.vectorized,
      fullTextIndexed: snapshot.fullTextIndexed,
      groups: snapshot.groups,
      ...(snapshot.created ? { created: snapshot.created } : {}),
      ...(typeof snapshot.createdTotal === 'number' ? { createdTotal: snapshot.createdTotal } : {}),
      ...(snapshot.createdTruncated ? { createdTruncated: true } : {}),
      ...(snapshot.modified ? { modified: snapshot.modified } : {}),
      ...(typeof snapshot.modifiedTotal === 'number' ? { modifiedTotal: snapshot.modifiedTotal } : {}),
      ...(snapshot.modifiedTruncated ? { modifiedTruncated: true } : {}),
    },
  };
}

async function finalizeNoChangeGit(args: {
  scope: string;
  record: DataSourceRecord;
  input: SyncDataSourceInput;
  config: KiConfig;
  prevSeen: string[];
  prevCommit: string | null;
  startedAt: number;
  gitUpdate: GitUpdateResult;
  changes: Awaited<ReturnType<typeof collectGitChanges>>;
  warnings: DataSourceWarning[];
  runCommit: string | null;
  /** 多映射编排：拿到本次将要落盘的完整快照 */
  capture?: (lastSync: DataSourceLastSync) => void;
}): Promise<SyncDataSourceResult> {
  const files = collectMarkdownFiles(args.record.dir, resolveImportExtensions(args.config, args.scope)).files;
  const plan = planFor(args.scope, args.record, args.config, files, args.prevSeen);
  const now = Date.now();
  const blockedReason = plan.skipReason;
  const freeze = blockedReason === 'GATE_COORD' || blockedReason === 'GATE_SCALE' || blockedReason === 'EMPTY_SOURCE';
  const seenRels = freeze ? args.prevSeen : [...files].sort();
  const pendingDelete = pendingFromPlan(plan, now);
  const gitState = buildGitState({
    update: args.gitUpdate,
    prevCommit: args.prevCommit,
    runCommit: args.runCommit,
    changedCount: 0,
    fullScanned: files.length,
    untrackedMarkdown: args.changes.untrackedMarkdown,
    state: 'ok',
  });
  const lastSync: DataSourceLastSync = {
    at: now,
    durationMs: now - args.startedAt,
    state: 'ok',
    ...(args.input.taskId ? { taskId: args.input.taskId } : {}),
    params: {
      group: args.record.group,
      conflictMode: args.record.conflictMode,
      vector: args.record.vector,
      chunkSize: args.record.chunkSize,
      chunkOverlap: args.record.chunkOverlap,
      mode: 'incremental',
    },
    result: {
      files: emptyFiles(files.length, 0),
      vectorized: 0,
      fullTextIndexed: 0,
      groups: [],
      conflicts: [],
      failures: [],
      // 本轮没有任何变更 ⇒ 数据源快照也明确「变更 0 篇」（否则页面会当成旧快照的"未记录"，
      // 与任务详情的 0 篇口径打架）
      modified: [],
      modifiedTotal: 0,
    },
    seenRels,
    pendingDelete,
    git: gitState,
    ...(args.warnings.length > 0 ? { warnings: args.warnings } : {}),
  };
  args.capture?.(lastSync);
  const nextRecord = args.gitUpdate.branch && args.record.git && args.gitUpdate.branch !== args.record.git.branch
    ? { ...args.record, git: { ...args.record.git, branch: args.gitUpdate.branch }, updatedAt: now, lastSync }
    : { ...args.record, updatedAt: now, lastSync };
  writeDataSource(args.scope, nextRecord);
  return {
    ok: true,
    scope: args.scope,
    dryRun: false,
    summary: {
      state: 'ok',
      durationMs: lastSync.durationMs,
      files: lastSync.result.files,
      pendingDelete,
      mode: 'incremental',
      seenRels,
      git: gitState,
      warnings: args.warnings,
      vectorized: 0,
      fullTextIndexed: 0,
      groups: [],
      // 本轮没有任何变更 ⇒ 明确「新建 0 篇」，而不是让页面当成"没有记录"
      created: [],
      createdTotal: 0,
      // 同理：本轮无变更 ⇒ 明确「变更 0 篇」
      modified: [],
      modifiedTotal: 0,
    },
  };
}

async function syncDirectory(
  scope: string,
  record: DataSourceRecord,
  input: SyncDataSourceInput,
  config: KiConfig,
  prevSeen: string[],
  startedAt: number,
): Promise<SyncDataSourceResult> {
  const dirCheck = checkSourceDir(record.dir, config, scope);
  if (!dirCheck.ok) {
    return failSync(scope, input, record, dirCheck.code, dirCheck.error, staleReasonOf(dirCheck.code));
  }
  if (input.dryRun) {
    const files = collectMarkdownFiles(record.dir, resolveImportExtensions(config, scope)).files;
    const plan = planFor(scope, record, config, files, prevSeen);
    return {
      ok: true, scope, dryRun: true,
      plannedFiles: files.length,
      mode: 'full',
      changedFiles: files.length,
      untrackedMarkdown: 0,
      wouldFallbackFull: false,
      warnings: [],
      pendingDelete: pendingFromPlan(plan, Date.now()),
    };
  }
  return importAndPersist({
    scope, record, input, config, mode: 'full', prevSeen, startedAt,
    pruneSubsetFullScan: false,
  });
}

async function syncGit(
  scope: string,
  record: DataSourceRecord,
  input: SyncDataSourceInput,
  config: KiConfig,
  prevSeen: string[],
  prevCommit: string | null,
  startedAt: number,
  /** 多映射编排用：复用仓库级 prepare 结果 + 回传本次快照（不传 = 单映射路径原样） */
  ctx?: { gitUpdate?: GitUpdateResult; capture?: (lastSync: DataSourceLastSync) => void },
): Promise<SyncDataSourceResult> {
  if (!record.git) {
    return failSync(scope, input, record, 'INVALID_GIT_RECORD', '数据源类型为 git 但缺少 git 元信息，请重新 add', 'not-recomputed');
  }
  const reachable = checkGitReachable(record.dir);
  if (!reachable.ok) {
    return failSync(scope, input, record, reachable.code, reachable.error, staleReasonOf(reachable.code));
  }
  const extensions = resolveImportExtensions(config, scope);
  const warnings: DataSourceWarning[] = [];

  // ── dry-run：不 fetch / 不更新，只读计算 ──
  if (input.dryRun) {
    const dirCheck = checkSourceDir(record.dir, config, scope);
    if (!dirCheck.ok) return failSync(scope, input, record, dirCheck.code, dirCheck.error, staleReasonOf(dirCheck.code));
    input.onPhase?.('git-diff');
    let mode: DataSourceSyncMode = input.full || !prevCommit ? 'full' : 'incremental';
    let wouldFallbackFull = false;
    let changes = await collectGitChanges({
      repoRoot: record.git.repoRoot,
      relativeRoot: record.git.relativeRoot,
      lastCommit: mode === 'incremental' ? prevCommit : null,
      extensions,
    });
    if (mode === 'incremental' && changes.commitUnknown) {
      mode = 'full';
      wouldFallbackFull = true;
    }
    if (changes.untrackedError) warnings.push(warning('GIT_UNTRACKED_UNKNOWN', `未跟踪文件统计失败：${changes.untrackedError}`));
    if (mode === 'incremental' && changes.untrackedMarkdown > 0) {
      warnings.push(warning('GIT_UNTRACKED_SKIPPED', `检测到 ${changes.untrackedMarkdown} 个未跟踪文件不参与增量；需要同步请执行全量同步`));
    }
    const files = collectMarkdownFiles(record.dir, extensions).files;
    const plan = planFor(scope, record, config, files, prevSeen);
    return {
      ok: true, scope, dryRun: true,
      plannedFiles: files.length,
      mode,
      changedFiles: mode === 'incremental' ? changes.changedRels.length : files.length,
      untrackedMarkdown: changes.untrackedMarkdown,
      wouldFallbackFull,
      warnings,
      pendingDelete: pendingFromPlan(plan, Date.now()),
    };
  }

  // ── 真实同步：fetch → 自动更新 → 判空 → diff → 导入 ──
  // 多映射编排（`ctx.gitUpdate`）：仓库级 fetch/update/clean 只做一次，
  // 否则 N 条映射会把同一个工作树 fetch + reset 硬 N 遍（慢且互相踩工作树）。
  let gitUpdate: GitUpdateResult;
  if (ctx?.gitUpdate) {
    gitUpdate = ctx.gitUpdate;
  } else {
    try {
      gitUpdate = await prepareGitSync({
        repoRoot: record.git.repoRoot,
        managed: record.git.managed,
        branch: record.git.branch,
        onPhase: input.onPhase,
      });
    } catch (err) {
      return failSync(scope, input, record, 'GIT_UPDATE_FAILED', (err as Error).message, 'not-recomputed');
    }
  }
  if (gitUpdate.fetch === 'failed') {
    warnings.push(warning('GIT_FETCH_FAILED', `远端更新检查失败：${gitUpdate.fetchDetail ?? '未知原因'}；本次同步基于本地内容`));
  }
  if (gitUpdate.update === 'failed') {
    warnings.push(warning('GIT_UPDATE_FAILED', `自动更新失败：${gitUpdate.updateDetail ?? '未知原因'}；本地工作区未改动，本次同步本地内容`));
  }
  if (gitUpdate.clean === 'failed') {
    warnings.push(warning('GIT_CLEAN_FAILED', `托管副本清理失败：${gitUpdate.cleanDetail ?? '未知原因'}`));
    const gitState = buildGitState({
      update: gitUpdate, prevCommit, runCommit: gitUpdate.headCommit,
      changedCount: 0, fullScanned: 0, untrackedMarkdown: 0, state: 'failed',
    });
    return failSync(scope, input, record, 'GIT_CLEAN_FAILED', `托管副本清理失败：${gitUpdate.cleanDetail ?? '未知原因'}`, 'not-recomputed', { git: gitState, warnings });
  }

  // 自动更新之后才判空源/扩展名（challenger 意见1）
  const dirCheck = checkSourceDir(record.dir, config, scope);
  if (!dirCheck.ok) {
    const gitState = buildGitState({
      update: gitUpdate, prevCommit, runCommit: gitUpdate.headCommit,
      changedCount: 0, fullScanned: 0, untrackedMarkdown: 0, state: 'failed',
    });
    return failSync(scope, input, record, dirCheck.code, dirCheck.error, staleReasonOf(dirCheck.code), { git: gitState, warnings });
  }

  input.onPhase?.('git-diff');
  let mode: DataSourceSyncMode = input.full || !prevCommit ? 'full' : 'incremental';
  let changes: Awaited<ReturnType<typeof collectGitChanges>>;
  try {
    changes = await collectGitChanges({
      repoRoot: record.git.repoRoot,
      relativeRoot: record.git.relativeRoot,
      lastCommit: mode === 'incremental' ? prevCommit : null,
      extensions,
    });
  } catch (err) {
    const gitState = buildGitState({
      update: gitUpdate, prevCommit, runCommit: gitUpdate.headCommit,
      changedCount: 0, fullScanned: 0, untrackedMarkdown: 0, state: 'failed',
    });
    return failSync(
      scope, input, record,
      (err as { code?: string }).code ?? 'GIT_DIFF_FAILED',
      (err as Error).message,
      'not-recomputed',
      { git: gitState, warnings: [...warnings, warning('GIT_DIFF_FAILED', (err as Error).message)] },
    );
  }
  if (mode === 'incremental' && changes.commitUnknown) {
    mode = 'full';
    warnings.push(warning('GIT_COMMIT_UNKNOWN_FALLBACK_FULL', '上次同步的 commit 不存在（可能被 force push/rebase），本次已降级为全量同步'));
  }
  if (changes.untrackedError) warnings.push(warning('GIT_UNTRACKED_UNKNOWN', `未跟踪文件统计失败：${changes.untrackedError}`));
  if (mode === 'incremental' && changes.untrackedMarkdown > 0) {
    warnings.push(warning('GIT_UNTRACKED_SKIPPED', `检测到 ${changes.untrackedMarkdown} 个未跟踪文件不参与增量；需要同步请执行全量同步`));
  }
  const runCommit = changes.headCommit ?? gitUpdate.headCommit;

  if (mode === 'incremental' && changes.changedRels.length === 0) {
    return finalizeNoChangeGit({
      scope, record, input, config, prevSeen, prevCommit, startedAt,
      gitUpdate, changes, warnings, runCommit,
      ...(ctx?.capture ? { capture: ctx.capture } : {}),
    });
  }

  return importAndPersist({
    scope, record, input, config, mode, prevSeen, startedAt,
    ...(mode === 'incremental' ? { onlyRelPaths: changes.changedRels } : {}),
    pruneSubsetFullScan: mode === 'incremental',
    ...(ctx?.capture ? { capture: ctx.capture } : {}),
    git: {
      update: gitUpdate,
      prevCommit,
      runCommit,
      untrackedMarkdown: changes.untrackedMarkdown,
      warnings,
    },
  });
}

/**
 * 多映射同步编排（REQ-20261104-002 / 工作项 5）。
 *
 * 结构：**一次**仓库级 prepare → 逐映射跑**现有单映射链路** → 合并结果写一次。
 * 为什么不去改 import 内部（护栏 #1）：幂等 / 冲突 / 切分 / 向量 / 失败重试 / 候选计算
 * 全在 import 里，改它等于把整条链路重做一遍，且落点判据一变就会误删。
 *
 * 三条必须守住的语义：
 *  - Q5：**任一映射的子目录缺失 / 为空 → 整源失败**，错误里指明是第几条映射；
 *  - 护栏 #2：基线按映射切桶（`subdir/rel`），失败映射回退它自己的旧桶；
 *  - 护栏 #3：commit 水位**只有全部映射成功**才推进，否则保留旧值（否则失败文件永久漏同步）。
 */
async function syncGitMappings(
  scope: string,
  record: DataSourceRecord,
  input: SyncDataSourceInput,
  config: KiConfig,
  mappings: DataSourceMappingItem[],
  prevSeen: string[],
  prevCommit: string | null,
  startedAt: number,
): Promise<SyncDataSourceResult> {
  const git = record.git;
  if (!git) {
    return failSync(scope, input, record, 'INVALID_GIT_RECORD', '数据源类型为 git 但缺少 git 元信息，请重新 add', 'not-recomputed');
  }
  const reachable = checkGitReachable(record.dir);
  if (!reachable.ok) {
    return failSync(scope, input, record, reachable.code, reachable.error, staleReasonOf(reachable.code));
  }


  // ── 预检：每条映射的目录都必须存在且有可导入文件（Q5：整源失败，早于任何写入） ──
  const dirs = mappings.map((item) => mappingTargetDir(git.repoRoot, item.subdir));
  for (let i = 0; i < dirs.length; i += 1) {
    const checked = checkSourceDir(dirs[i], config, scope);
    if (checked.ok) continue;
    return failSync(
      scope, input, record,
      checked.code,
      `第 ${i + 1} 条映射（${mappings[i].subdir || '仓库根'}）：${checked.error}`,
      staleReasonOf(checked.code),
    );
  }

  const buckets = splitSeenRelsByMapping(prevSeen, mappings);
  const now = Date.now();
  const parts: (MappingSyncPart | null)[] = mappings.map(() => null);
  const warnings: DataSourceWarning[] = [];
  const seenWarnings = new Set<string>();
  const pushWarning = (item: DataSourceWarning): void => {
    const key = `${item.code}\u0000${item.message}`;
    if (seenWarnings.has(key)) return; // N 条映射会重复报同一条 fetch/update 警告
    seenWarnings.add(key);
    warnings.push(item);
  };

  /**
   * dry-run 是**只读**语义（`ki datasource sync --dry-run`）：绝不 fetch / 不更新工作树。
   * 单映射路径由 `syncGit` 自己的 dryRun 分支保证；这里必须**在 prepare 之前**拦下，
   * 否则多映射的 dry-run 会把工作树真 reset 一遍 —— 那是写操作。
   */
  if (input.dryRun) {
    let plannedFiles = 0;
    let changedFiles = 0;
    let untrackedMarkdown = 0;
    let wouldFallbackFull = false;
    let dryMode: DataSourceSyncMode = input.full || !prevCommit ? 'full' : 'incremental';
    const dryParts: (MappingSyncPart | null)[] = mappings.map(() => null);
    for (let i = 0; i < mappings.length; i += 1) {
      const mapping = mappings[i];
      const virtualRecord: DataSourceRecord = {
        ...record,
        dir: dirs[i],
        group: mapping.group,
        mappings: [mapping],
        git: { ...git, relativeRoot: mapping.subdir },
      };
      const one = await syncGit(scope, virtualRecord, input, config, buckets[i], prevCommit, startedAt);
      if (!one.ok) return one;
      if (one.dryRun !== true) return one;
      plannedFiles += one.plannedFiles;
      changedFiles += one.changedFiles;
      untrackedMarkdown += one.untrackedMarkdown;
      if (one.wouldFallbackFull) wouldFallbackFull = true;
      if (one.mode === 'full') dryMode = 'full';
      for (const item of one.warnings) pushWarning(item);
      dryParts[i] = {
        state: 'ok',
        result: {
          files: {
            scanned: 0, fullScanned: 0, changed: 0, completed: 0,
            unchanged: 0, skipped: 0, incomplete: 0, duplicatesSkipped: 0,
          },
          vectorized: 0,
          fullTextIndexed: 0,
          groups: [],
          conflicts: [],
          failures: [],
        },
        seenRels: buckets[i],
        pendingDelete: one.pendingDelete ?? {
          computedAt: now, total: 0, overLimit: false, truncated: false, items: [],
          candidateSourcePaths: [], untouchedGroups: [], unableCount: 0, eligibleCount: 0,
          stale: true, staleReason: 'not-recomputed', blocked: null,
        },
      };
    }
    const dryMerged = mergeMappingSync({
      mappings,
      parts: dryParts,
      prevBuckets: buckets,
      params: {
        group: record.group,
        conflictMode: record.conflictMode,
        vector: record.vector,
        chunkSize: record.chunkSize,
        chunkOverlap: record.chunkOverlap,
        mode: dryMode,
      },
      at: now,
      computedAt: now,
    });
    return {
      ok: true,
      scope,
      dryRun: true,
      plannedFiles,
      mode: dryMode,
      changedFiles,
      untrackedMarkdown,
      wouldFallbackFull,
      warnings,
      pendingDelete: dryMerged.pendingDelete,
    };
  }

  // 仓库级 prepare 只做一次
  let gitUpdate: GitUpdateResult;
  try {
    gitUpdate = await prepareGitSync({
      repoRoot: git.repoRoot,
      managed: git.managed,
      branch: git.branch,
      onPhase: input.onPhase,
    });
  } catch (err) {
    return failSync(scope, input, record, 'GIT_UPDATE_FAILED', (err as Error).message, 'not-recomputed');
  }
  if (gitUpdate.clean === 'failed') {
    return failSync(scope, input, record, 'GIT_CLEAN_FAILED', `托管副本清理失败：${gitUpdate.cleanDetail ?? '未知原因'}`, 'not-recomputed');
  }

  let firstFailure: { code: string; error: string } | null = null;
  let runCommit = gitUpdate.headCommit ?? prevCommit;
  let mode: DataSourceSyncMode = input.full || !prevCommit ? 'full' : 'incremental';
  // 未跟踪文件数按映射求和：它是「本次有文件没参与增量」警告的依据，漏加会让页面少报
  let untrackedMarkdown = 0;

  /**
   * 进度汇聚：单映射链路每条都会从 `done:0 / total:自身文件数` 重新报，
   * 直接透传会让页面进度条在每条映射开始时**跳回 0**。这里把已完成映射的
   * done/total 作为基数累加，保证 done 单调、total 只增不减。
   */
  const progressBase = { done: 0, total: 0 };
  type ProgressEvent = Parameters<NonNullable<SyncDataSourceInput['onProgress']>>[0];

  for (let i = 0; i < mappings.length; i += 1) {
    const mapping = mappings[i];
    let captured: DataSourceLastSync | null = null;
    let mappingTotal = 0;
    const virtualInput: SyncDataSourceInput = input.onProgress
      ? {
        ...input,
        onProgress: (event: ProgressEvent) => {
          mappingTotal = Math.max(mappingTotal, event.total);
          input.onProgress?.({ ...event, done: progressBase.done + event.done, total: progressBase.total + mappingTotal });
        },
      }
      : input;
    const virtualRecord: DataSourceRecord = {
      ...record,
      dir: dirs[i],
      group: mapping.group,
      mappings: [mapping],
      git: { ...git, relativeRoot: mapping.subdir },
    };
    const result = await syncGit(
      scope, virtualRecord, virtualInput, config, buckets[i], prevCommit, startedAt,
      { gitUpdate, capture: (lastSync) => { captured = lastSync; } },
    );
    progressBase.done += mappingTotal;
    progressBase.total += mappingTotal;
    if (!captured) {
      // 失败 / 中断：该映射回退它自己的旧桶并按失败记账；**其余映射继续跑**
      // （一条映射坏掉不该让别的子目录白等），最终状态取最差、水位不推进。
      if (!firstFailure) {
        firstFailure = { code: result.ok ? 'SYNC_FAILED' : result.code, error: result.ok ? '同步未产出快照' : result.error };
      }
      parts[i] = failedMappingPart(buckets[i], now);
      continue;
    }
    const snapshot: DataSourceLastSync = captured;
    parts[i] = {
      state: snapshot.state,
      result: snapshot.result,
      seenRels: snapshot.seenRels ?? buckets[i],
      pendingDelete: snapshot.pendingDelete,
    };
    // 本次用的是全量还是增量，以单映射链路自己算出的 mode 为准（任一映射全量 ⇒ 汇总记全量）
    if (snapshot.params.mode === 'full') mode = 'full';
    if (snapshot.git?.runCommit) runCommit = snapshot.git.runCommit;
    untrackedMarkdown += snapshot.git?.untrackedMarkdown ?? 0;
    for (const item of snapshot.warnings ?? []) pushWarning(item);
  }

  const merged = mergeMappingSync({
    mappings,
    parts,
    prevBuckets: buckets,
    params: {
      group: record.group,
      conflictMode: record.conflictMode,
      vector: record.vector,
      chunkSize: record.chunkSize,
      chunkOverlap: record.chunkOverlap,
      mode,
    },
    at: now,
    computedAt: now,
  });

  // 护栏 #3：水位只在全成功时推进
  const commit = merged.canAdvanceCommit ? runCommit : prevCommit;
  const gitState = buildGitState({
    update: gitUpdate,
    prevCommit,
    runCommit,
    changedCount: merged.files.changed,
    fullScanned: merged.files.fullScanned,
    untrackedMarkdown,
    state: merged.state,
    commitOverride: commit,
  });

  const lastSync: DataSourceLastSync = {
    at: now,
    durationMs: now - startedAt,
    state: merged.state,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    params: mappingParams({
      group: record.group,
      conflictMode: record.conflictMode,
      vector: record.vector,
      chunkSize: record.chunkSize,
      chunkOverlap: record.chunkOverlap,
      mode,
    }, mappings),
    result: {
      files: merged.files,
      vectorized: merged.vectorized,
      fullTextIndexed: merged.fullTextIndexed,
      groups: merged.groups,
      conflicts: merged.conflicts,
      failures: merged.failures,
      ...(merged.created ? { created: merged.created } : {}),
      ...(merged.createdTotal !== undefined ? { createdTotal: merged.createdTotal } : {}),
      ...(merged.createdTruncated ? { createdTruncated: true } : {}),
      ...(merged.modified ? { modified: merged.modified } : {}),
      ...(merged.modifiedTotal !== undefined ? { modifiedTotal: merged.modifiedTotal } : {}),
      ...(merged.modifiedTruncated ? { modifiedTruncated: true } : {}),
    },
    seenRels: merged.seenRels,
    pendingDelete: merged.pendingDelete,
    git: gitState,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  const nextRecord = gitUpdate.branch && record.git && gitUpdate.branch !== record.git.branch
    ? { ...record, git: { ...record.git, branch: gitUpdate.branch }, updatedAt: now, lastSync }
    : { ...record, updatedAt: now, lastSync };
  writeDataSource(scope, nextRecord);

  const summary: SyncSummary = {
    state: merged.state,
    durationMs: lastSync.durationMs,
    files: merged.files,
    pendingDelete: merged.pendingDelete,
    mode,
    seenRels: merged.seenRels,
    git: gitState,
    warnings,
    vectorized: merged.vectorized,
    fullTextIndexed: merged.fullTextIndexed,
    groups: merged.groups,
    ...(merged.created ? { created: merged.created } : {}),
    ...(merged.createdTotal !== undefined ? { createdTotal: merged.createdTotal } : {}),
    ...(merged.createdTruncated ? { createdTruncated: true } : {}),
    ...(merged.modified ? { modified: merged.modified } : {}),
    ...(merged.modifiedTotal !== undefined ? { modifiedTotal: merged.modifiedTotal } : {}),
    ...(merged.modifiedTruncated ? { modifiedTruncated: true } : {}),
  };
  if (firstFailure) {
    return { ok: false, scope, code: firstFailure.code, error: firstFailure.error, summary };
  }
  return { ok: true, scope, dryRun: false, summary };
}

export async function syncDataSource(input: SyncDataSourceInput): Promise<SyncDataSourceResult> {
  const config = input.config ?? loadConfig();
  let scope: string;
  try {
    scope = resolveScope(config, input.scope);
  } catch (err) {
    return { ok: false, scope: input.scope, code: 'INVALID_SCOPE', error: (err as Error).message };
  }

  const run = async (): Promise<SyncDataSourceResult> => {
    const read = readDataSource(scope);
    if (!read.ok) return { ok: false, scope, code: read.code, error: read.error };
    const record = read.record;
    const prevSeen = record.lastSync?.seenRels ?? [];
    const prevCommit = record.lastSync?.git?.commit ?? null;
    const startedAt = Date.now();
    // 多映射（REQ-20261104-002）：>1 条走合并编排；1 条继续走原单映射链路，
    // 保证「单条映射行为与升级前逐字节一致」（护栏 #5）。
    const mappings = mappingsOf(record);
    const execute = record.type === 'git'
      ? (mappings.length > 1
        ? () => syncGitMappings(scope, record, input, config, mappings, prevSeen, prevCommit, startedAt)
        : () => syncGit(scope, record, input, config, prevSeen, prevCommit, startedAt))
      : () => syncDirectory(scope, record, input, config, prevSeen, startedAt);
    // 托管 clone 可能被多个 scope 共享：scope 锁不足以覆盖跨 scope 的工作树竞争
    if (record.type === 'git' && record.git?.managed && record.git.repoRoot) {
      try {
        return await withManagedCloneLock(record.git.repoRoot, 'datasource-clone-sync', execute);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'SCOPE_OPERATION_BUSY') {
          return { ok: false, scope, code: 'CLONE_BUSY', error: '该 Git 仓库正在被另一个数据源同步，请稍后重试' };
        }
        throw err;
      }
    }
    return execute();
  };

  if (input.dryRun) return run();
  try {
    return await withScopeWriteLock(scope, 'datasource-sync', run);
  } catch (err) {
    return {
      ok: false,
      scope,
      code: (err as NodeJS.ErrnoException & { code?: string }).code ?? 'SYNC_FAILED',
      error: (err as Error).message,
    };
  }
}

// ─── 定时计划保存 / 运行态（S-01 / S-03）────────────────────

export type SaveDataSourceScheduleResult =
  | { ok: true; scope: string; record: DataSourceRecord; warnings: { code: string; message: string }[] }
  | { ok: false; scope: string; code: string; error: string; field?: string; current?: DataSourceSchedule };

/**
 * 页面保存定时设置（唯一写入口）。
 * 读改写全程在 scope 写锁内；`baseRevision` 用于多标签页乐观锁。
 */
export async function saveDataSourceSchedule(input: {
  scope: string;
  schedule: unknown;
  config?: KiConfig;
}): Promise<SaveDataSourceScheduleResult> {
  const config = input.config ?? loadConfig();
  let scope: string;
  try {
    scope = resolveScope(config, input.scope);
  } catch (err) {
    return { ok: false, scope: input.scope, code: 'INVALID_SCOPE', error: (err as Error).message };
  }
  const validation = validateScheduleInput(input.schedule);
  if (!validation.ok) {
    return { ok: false, scope, code: validation.code, error: validation.message, field: validation.field };
  }
  const warnings: { code: string; message: string }[] = [];
  try {
    return await withScopeWriteLock(scope, 'datasource-schedule', async (): Promise<SaveDataSourceScheduleResult> => {
      const read = readDataSource(scope);
      if (!read.ok) return { ok: false, scope, code: read.code, error: read.error };
      const prev = read.record;
      const value = validation.value;
      if (value.baseRevision !== undefined && value.baseRevision !== prev.schedule.revision) {
        return {
          ok: false,
          scope,
          code: 'SCHEDULE_STALE',
          error: '定时设置已在别处修改，请刷新后重试',
          current: prev.schedule,
        };
      }
      const atChanged = value.mode === 'at' && value.at !== prev.schedule.at;
      /**
       * 启用锚点：只在「关闭 → 开启」时写一次，之后改间隔沿用旧锚点
       * （否则每次保存都把周期起点往后推，等于永不触发）；关闭时清空，再开重新等一个周期。
       */
      const enabledAt = !value.enabled
        ? null
        : prev.schedule.enabled === false || prev.schedule.enabledAt === null
          ? Date.now()
          : prev.schedule.enabledAt;
      const schedule: DataSourceSchedule = {
        ...prev.schedule,
        enabled: value.enabled,
        mode: value.mode,
        intervalValue: value.intervalValue,
        intervalUnit: value.intervalUnit,
        at: value.at,
        repeat: value.repeat,
        revision: prev.schedule.revision + 1,
        enabledAt,
        ...(atChanged ? { lastAutoFor: null, lastAutoState: null } : {}),
      };
      if (schedule.enabled && schedule.mode === 'at' && schedule.repeat === 'once') {
        const atMs = parseAtLocal(schedule.at);
        if (atMs !== null && atMs <= Date.now()) {
          warnings.push({ code: 'SCHEDULE_AT_IN_PAST', message: '执行时间已过，保存后将立即补跑一次' });
        }
      }
      if (schedule.enabled && schedule.mode === 'interval' && prev.type === 'directory') {
        const minutes = intervalMinutes(schedule.intervalValue, schedule.intervalUnit);
        if (minutes !== null && minutes < 30) {
          warnings.push({ code: 'SCHEDULE_DIRECTORY_HIGH_FREQ', message: '普通目录间隔小于 30 分钟会频繁全量扫描，请确认' });
        }
      }
      const next: DataSourceRecord = { ...prev, schedule, updatedAt: Date.now() };
      writeDataSource(scope, next);
      return { ok: true, scope, record: next, warnings };
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException & { code?: string }).code ?? 'SCHEDULE_WRITE_FAILED';
    return {
      ok: false,
      scope,
      code,
      error: code === 'SCOPE_OPERATION_BUSY'
        ? '该知识库正在同步，完成后再修改定时设置'
        : (err as Error).message,
    };
  }
}

export type ScheduleRunOutcome = 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'skipped';

/**
 * 写回一次调度结果（S-03 调用）。
 * ★ 调用方必须已持有该 scope 写锁（调度器外层锁）；本函数不再取锁，
 *   否则会与同步/保存形成二次锁等待。不修改 `updatedAt`。
 */
export function applyScheduleRunResult(scope: string, result: {
  outcome: ScheduleRunOutcome;
  reason?: string;
  slot: number | null;
  at: number;
}): void {
  const read = readDataSource(scope);
  if (!read.ok) return;
  const prev = read.record;
  const schedule: DataSourceSchedule = { ...prev.schedule };
  if (result.outcome === 'skipped') {
    schedule.lastSkipReason = result.reason ?? 'skipped';
    schedule.lastSkipAt = result.at;
    /**
     * ★ 向量不可用是**确定性长态阻断**（key 没配/欠费，可能持续数天），与 clone-busy 这类
     * 瞬态竞态不同：必须把本次 slot 记为"已处理"，否则 `computeNextRun` 会认为仍然到期，
     * 调度器每个 tick 重复跳过 —— 每次都写一次 datasource.json + 打一条日志，
     * 一天上千次写放大。once/daily 模式正是用 `lastAutoFor` 做 slot 去重。
     * 其它 reason 保持原语义（下一 tick 立刻重试）。
     */
    if (result.reason === 'vector-unavailable' && result.slot !== null) {
      schedule.lastAutoFor = result.slot;
    }
    writeDataSource(scope, { ...prev, schedule });
    return;
  }
  schedule.lastAutoAt = result.at;
  schedule.lastAutoState = result.outcome === 'succeeded'
    ? 'ok'
    : result.outcome === 'partial'
      ? 'partial'
      : result.outcome === 'failed'
        ? 'failed'
        : 'cancelled';
  if (result.outcome !== 'cancelled') schedule.lastAutoFor = result.slot ?? schedule.lastAutoFor;
  if (result.outcome === 'failed') schedule.consecutiveFailures += 1;
  else if (result.outcome !== 'cancelled') schedule.consecutiveFailures = 0;
  schedule.lastSkipReason = null;
  schedule.lastSkipAt = null;
  // 仅一次：非跳过完成即关闭（cancelled 留给下次补跑）
  if (schedule.mode === 'at' && schedule.repeat === 'once' && result.outcome !== 'cancelled') {
    schedule.enabled = false;
    // 不变式：enabled=false ⇒ enabledAt=null（关闭的计划不留启用锚点，重新开启时由保存路径写新锚点）
    schedule.enabledAt = null;
  }
  writeDataSource(scope, { ...prev, schedule });
}

/** 手动同步成功/部分成功后清零连续失败（best-effort；锁占用时返回 false，下次自动成功再清） */
export async function resetScheduleFailures(scope: string): Promise<boolean> {
  try {
    return await withScopeWriteLock(scope, 'datasource-schedule-reset', async () => {
      const read = readDataSource(scope);
      if (!read.ok) return false;
      const schedule = read.record.schedule;
      if (schedule.consecutiveFailures === 0 && schedule.lastSkipReason === null) return false;
      writeDataSource(scope, {
        ...read.record,
        schedule: { ...schedule, consecutiveFailures: 0, lastSkipReason: null, lastSkipAt: null },
      });
      return true;
    });
  } catch {
    return false;
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
