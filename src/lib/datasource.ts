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
import { planImportPrune, type ImportPrunePlan } from './import-prune.js';
import { isSafeGroupPath, resolveGroupForSource } from './import-path.js';
import type {
  DataSourceGitInfo,
  DataSourceGitSyncState,
  DataSourceKind,
  DataSourceLastSync,
  DataSourcePendingDelete,
  DataSourceRecord,
  DataSourceResultSnapshot,
  DataSourceStaleReason,
  DataSourceSyncMode,
  DataSourceSyncState,
  DataSourceWarning,
} from './datasource-types.js';
import { collectGitChanges, prepareGitSync, probeGit, sanitizeGitError, sanitizeRemoteUrl, type GitUpdateResult } from './datasource-git.js';
import { checkManagedSubdir, cloneManagedRepo, managedCloneDirForRepo, managedCloneDirOf, purgeManagedCloneDir } from './datasource-clone.js';
import { withScopeWriteLock } from './scope-write-lock.js';

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
  return {
    version: 2,
    scope,
    type,
    dir: path.resolve(v.dir),
    ...(git ? { git } : {}),
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
  const gitChanged = prev !== null && (
    prev.type !== type
    || prev.git?.repoRoot !== git?.repoRoot
    || prev.git?.relativeRoot !== git?.relativeRoot
    || prev.git?.managed !== git?.managed
  );
  const changed = prev !== null && (prev.dir !== dir || prev.group !== group || gitChanged);
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
    version: 2,
    scope,
    type,
    dir,
    ...(git ? { git } : {}),
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
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ─── 共享托管 clone（同一 remote+branch 只保留一份工作副本）────

export interface ReusableManagedClone {
  repoRoot: string;
  branch: string | null;
  remoteBranch: string;
  remoteUrl: string;
  ownerScope: string;
}

/** 读取所有已登记记录（不做源目录可达性过滤；共享 clone/引用计数必须看到它们）。 */
function listRegisteredDataSourceRecords(config: KiConfig): { scope: string; record: DataSourceRecord }[] {
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
  subdir?: string | null;
  group?: string | null;
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
  const group = (input.group ?? '').trim() || null;
  const branch = (input.branch ?? '').trim() || null;
  const subdir = (input.subdir ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (group !== null && !isSafeGroupPath(group)) {
    return { ok: false, scope, code: 'INVALID_GROUP', error: `非法 Group 路径：${group}（不可为绝对路径，或含 .. / 反斜杠）` };
  }
  try {
    validateImportConflictMode(input.conflictMode);
    validateImportConflictSuffix(input.conflictSuffix);
  } catch (err) {
    return { ok: false, scope, code: 'INVALID_CONFLICT', error: (err as Error).message };
  }
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
                const checked = checkManagedSubdir(reusable.repoRoot, subdir, config, scope);
                if (!checked.ok) {
                  return {
                    ok: false,
                    scope,
                    code: checked.code,
                    error: checked.error,
                    ...(checked.hint ? { hint: checked.hint } : {}),
                  };
                }
                const added = await addDataSource({
                  scope,
                  dir: checked.dir,
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
                    dir: checked.dir,
                    branch: reusable.branch,
                    headCommit: null,
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

          const added = await addDataSource({
            scope,
            dir: cloned.value.dir,
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
}): DataSourceGitSyncState {
  const commit = args.state === 'ok' ? args.runCommit : args.prevCommit;
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
  try {
    result = await handleDirectImport({
      scope,
      sourceDir: record.dir,
      ...(record.group ? { group: record.group } : {}),
      conflictMode: record.conflictMode,
      conflictSuffix: record.conflictSuffix,
      vector: record.vector,
      ...(record.chunkSize !== null ? { chunkSize: record.chunkSize } : {}),
      ...(record.chunkOverlap !== null ? { chunkOverlap: record.chunkOverlap } : {}),
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
    const warnings = [...(git?.warnings ?? []), warning((err as { code?: string }).code ?? 'SYNC_FAILED', (err as Error).message)];
    const gitState = git
      ? buildGitState({
        update: git.update, prevCommit: git.prevCommit, runCommit: git.runCommit,
        changedCount: 0, fullScanned: 0, untrackedMarkdown: git.untrackedMarkdown, state: 'failed',
      })
      : undefined;
    return failSync(
      scope, input, record,
      (err as { code?: string }).code ?? 'SYNC_FAILED',
      (err as Error).message,
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

  const warnings = [...(git?.warnings ?? [])];
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
      ...(gitState ? { git: gitState } : {}),
      warnings,
      vectorized: snapshot.vectorized,
      fullTextIndexed: snapshot.fullTextIndexed,
      groups: snapshot.groups,
      ...(snapshot.created ? { created: snapshot.created } : {}),
      ...(typeof snapshot.createdTotal === 'number' ? { createdTotal: snapshot.createdTotal } : {}),
      ...(snapshot.createdTruncated ? { createdTruncated: true } : {}),
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
    },
    seenRels,
    pendingDelete,
    git: gitState,
    ...(args.warnings.length > 0 ? { warnings: args.warnings } : {}),
  };
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
      git: gitState,
      warnings: args.warnings,
      vectorized: 0,
      fullTextIndexed: 0,
      groups: [],
      // 本轮没有任何变更 ⇒ 明确「新建 0 篇」，而不是让页面当成"没有记录"
      created: [],
      createdTotal: 0,
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
  let gitUpdate: GitUpdateResult;
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
    });
  }

  return importAndPersist({
    scope, record, input, config, mode, prevSeen, startedAt,
    ...(mode === 'incremental' ? { onlyRelPaths: changes.changedRels } : {}),
    pruneSubsetFullScan: mode === 'incremental',
    git: {
      update: gitUpdate,
      prevCommit,
      runCommit,
      untrackedMarkdown: changes.untrackedMarkdown,
      warnings,
    },
  });
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
    const execute = record.type === 'git'
      ? () => syncGit(scope, record, input, config, prevSeen, prevCommit, startedAt)
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
