/**
 * mcp-http-api.ts —— 方案 A：扩展 mcp-http 的 /api/* 路由
 *
 * 为可视化前端补齐 MCP 缺失能力（REQ-20260806-003，S-02/S-03）：
 *   GET  /api/health                ki doctor 健康报告（runHealthCheck）
 *   GET  /api/search-config          语义检索默认 timeout（仅非敏感配置）
 *   GET  /api/doc/list              Group 路径 + 文档列表（支持 q 名称 / 路径模糊搜索）
 *   POST /api/import/upload         上传文件落盘受控目录（~/.ki/import-uploads/<uploadId>/）
 *   POST /api/import/run            触发导入（幂等追加，异步 job）
 *   GET  /api/import/status         轮询导入进度/结果
 *   POST /api/import/cancel         请求在当前批次完成后取消导入
 *   POST /api/restore/run           提交 restore/rebuild-vector 长任务
 *   GET  /api/restore/status        轮询 restore/rebuild 进度/结果
 *   POST /api/restore/cancel        请求在当前 restore/rebuild 批次完成后取消
 *
 * 设计要点：
 *   - 延迟加载（mcp-http.ts 动态 import），避免初始化拉重依赖
 *   - 上传仅接受文件内容，不接受服务器路径（受控目录防路径注入）
 *   - 导入通过 daemon 进程内的 OperationCoordinator 调度后调 handleDirectImport
 *   - job 状态内存 Map，服务重启即清空（低频操作可接受）
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getScopeImportConfig, loadConfig, resolveScope, runWithConfigSnapshot, setScopeReadonlyInConfigFile, type KiConfig } from './config.js';
import { isLoopbackAddr } from './net-addr.js';
import { findTokenScopes, ALL_SCOPES } from './mcp-token.js';
import { runHealthCheck, healthCheckWorstCaseMs } from './health-check.js';
import { getRelationsCachePath, getAssetsDir, getKbDir } from './scope.js';
import {
  ASSET_EXTENSIONS,
  DEFAULT_MAX_ASSET_SIZE,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  handleDirectImport,
  collectMarkdownFiles,
  type HandleDirectImportArgs,
  type ImportResult,
} from './import.js';
import { resolveImportExtensions } from './config.js';
import { validateChunkParams } from './chunker.js';
import { preflightImportDuplicates, DEFAULT_PREFLIGHT_MAX_DETAIL } from './import-preflight.js';
// REQ-20261030-001：资源页「向量模型」只读摘要（纯读文件，不发 embedding / zvec 请求）
import { buildEmbeddingSummary } from './embedding-summary.js';
import {
  assertHttpChannelWritable,
  isScopeReadonlyError,
  scopeReadonlyBody,
} from './scope-policy.js';
// S-02/S-03：两级完成口径 —— 整理等待/状态 + A11 就绪判据
import {
  whenIndexMaintenanceIdle,
  getIndexMaintenanceState,
  readIndexReadiness,
  type IndexReadiness,
} from './index-maintenance.js';
import type { ImportConflictMode } from './import-conflict.js';
import { readImportIncompleteStatus, summarizeImportIncomplete, uploadIdFromSourceDir } from './import-retry.js';
// Group 路径校验：preflight 与 run 同口径（debug 2026-10-19 的 R1 行动项）
import { isSafeGroupPath, resolveGroupForSource } from './import-path.js';
// REQ-20261019-001：清理候选（与 import.ts 同源计算，保证「看到的 = 删掉的」）
import { planImportPrune, verifyPruneToken } from './import-prune.js';
import { executeBatchDelete } from '../delete-relation.js';
import { executeDatasourcePrune } from './datasource-prune.js';
// upstream 侧新增「定时同步」（resetScheduleFailures / saveDataSourceSchedule），
// 本地侧新增「移除登记」（removeDataSource / countManagedRepoRefs / purgeManagedCloneDir）—— 两边都要
import { addRemoteDataSource, checkSourceReachable, countManagedRepoRefs, findReusableManagedClone, readDataSource, removeDataSource, resetScheduleFailures, saveDataSourceSchedule, scanDataSources, syncDataSource, toClientPending, updateDataSourceConfig, withManagedCloneLock, type DataSourceConfigPatch, type SyncDataSourceResult } from './datasource.js';
import { checkManagedSubdir, isSafeRelativeSubdir, purgeManagedCloneDir, validateBranchName, validateGitUrl } from './datasource-clone.js';
import type { DataSourceRecord } from './datasource-types.js';
import { pickActiveDatasourceSync, type DataSourceActiveSync } from './datasource-runtime.js';
import { computeSyncAvailability } from './datasource-policy.js';
import { toScheduleView } from './datasource-schedule.js';
import { datasourceSyncMode, datasourceSyncParams, toDatasourceSyncResultSnapshot } from './datasource-task.js';
import { isDataSourceSchedulerDisabled, refreshDataSourceScheduler } from './datasource-scheduler.js';
import { rebuildScopeVectors, type RebuildVectorOptions, type RebuildVectorResult } from './rebuild-vector.js';
import { restoreSnapshotLocal, type RestoreSnapshotResult } from './restore-snapshot.js';
import { executeTagList, type TagListResult } from '../tag.js';
import { getSharedOperationCoordinator } from './operation-coordinator.js';
// chat 模块（REQ-20260924-001）—— 单行挂载，见下方 if 链末尾
import { handleChatRoutes } from './chat/chat-routes.js';
import { vectorCollectionDimension, vectorCountScope, optimizeVectorIndex } from './vector-client.js';
import { DEFAULT_QUERY_EMBED_TIMEOUT_MS } from './query-timeout.js';
import { isFtsOnlyIndexedRelation } from './scoring.js';
import { getRelationsCacheIdentity, readAllGroupCaches, onScopeRelationsInvalidated } from './group-cache.js';
// 路径检索：检索词归一 + 逻辑路径（group 与 sourcePath 重叠合并）见 doc-path.ts
import { logicalDocPath, matchDocQuery, normalizeSearchQuery, type SearchableDoc } from './doc-path.js';
import { DocumentEditError, readDocumentForEdit, saveDocumentEdit } from './document-editor.js';
// 读详情（浏览页正文）：noVectorFallback 精确读，使 /api/doc/get 可安全走 read 通道
import { executeGetModuleInfoLocal } from '../get-module-info.js';
import { createTaskReporter, getTaskRecord, listTaskRecords, TASK_TTL_MS, type TaskParamSnapshot, type TaskReporter, type TaskResultSnapshot } from './task-registry.js';
// REQ-20261019-004：任务台账的参数快照 / 结果摘要（与 CLI、daemon 同一实现）
import { MAX_SNAPSHOT_CREATED, toParamSnapshot, toResultSnapshot } from './task-snapshot.js';
import { withScopeWriteLock } from './scope-write-lock.js';
import { readVectorDimensionSnapshot, refreshVectorDimensionSnapshot } from './vector-dimension-snapshot.js';
import { withTimeoutFallback } from './timeout.js';

// ─── 常量 ─────────────────────────────────────────────

/** 请求体上限（对齐 mcp-http readJsonBody 的 16MB） */
const MAX_BODY = 16 * 1024 * 1024;
/** /api/doc/list 默认分页上限 */
const DOC_LIST_LIMIT = 500;
/**
 * /api/health 的 embedding 探测预算：单次 4s、不重试。
 * 该模型慢的形态是悬挂而非瞬时抖动，重试几乎不增加成功率，只会顶破请求 deadline。
 */
const HEALTH_PROBE = { timeoutMs: 4_000, retries: 0 };
/**
 * /api/health 整体 deadline：由探测预算推导最坏耗时再加本地检查余量。
 * 必须经 healthCheckWorstCaseMs 派生——写死数值曾让外层 10s < 内层 17s，
 * 一个慢子检查就能把整份健康报告换成一条 400。
 */
const HEALTH_TIMEOUT_MS = healthCheckWorstCaseMs(HEALTH_PROBE.timeoutMs, HEALTH_PROBE.retries) + 3_000;

/**
 * 辅助读超时上限（R8，REQ-20261009-003）：引擎繁忙时应尽快给出"未知/陈旧"，
 * 而不是让请求无限挂住 —— 现场二就是一个挂住的辅助请求把该 scope 的队列槽占死 >10 分钟。
 */
const VECTOR_STATUS_REFRESH_TIMEOUT_MS = 5_000;

/**
 * `/api/tags` 的超时上限（R8 二期，REQ-20261009-003）：tag 列表要打开/扫描 zvec
 * Collection，与 refresh 同属"可失败的辅助读" —— 同值但保持独立常量（口径可各自调整）。
 */
const TAG_LIST_TIMEOUT_MS = 5_000;

/** 上传根目录：~/.ki/import-uploads/ */
function getUploadsRoot(): string {
  return path.join(os.homedir(), '.ki', 'import-uploads');
}

const UPLOAD_SCOPE_FILE = '.scope';
const UPLOAD_SESSION_FILE = '.upload-session.json';
const UPLOAD_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * 子集重试（`onlyRelPaths`）的条数上限 —— `/api/import/run` 与 `/api/import/retry-incomplete`
 * **共用同一真相**（2026-10-13 评审：两入口判据不得漂移）。超限 fail-loud：
 * 该数组会整批进入净化/去重，且 `retryFilter.missing` 会全量物化后随 job 结果回传。
 */
const MAX_ONLY_REL_PATHS = 50_000;

interface UploadSession {
  scope: string;
  updatedAt: number;
  state: 'uploading' | 'importing' | 'done' | 'failed';
  batchCount?: number;
  completedBatches?: number[];
  jobId?: string;
  errors?: { name: string; error: string }[];
  /**
   * run 参数快照（仅存影响后续判定的最小集合）。
   *
   * - REQ-20261019-002：`skipDuplicates` 影响「同一 uploadId 能否幂等复用」；
   *   缺失时视为 `{ skipDuplicates: false }`（兼容升级前的旧 session）。
   * - REQ-20261019-001：`pickMode` / `group` 是 `/api/import/prune` 重算候选的**同源输入**。
   *   `group` 必须在 run 时落盘（设计 S02 N-2）：prune 若取前端表单实时值，用户导入后
   *   改过输入框就会让作用域漂移 → 重算候选偏离 → 恒 409。
   *   `group: ''` 是合法值（= 不带 group 前缀），与「快照里没有该键」语义不同。
   */
  params?: { skipDuplicates?: boolean; pickMode?: 'dir' | 'files' | 'mixed'; group?: string };
}

function readUploadSession(dir: string): UploadSession | null {
  const file = path.join(dir, UPLOAD_SESSION_FILE);
  if (!fs.existsSync(file)) return null;
  if (!fs.lstatSync(file).isFile()) throw new Error('非法上传任务元数据');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as UploadSession;
  if (!value || typeof value.scope !== 'string' || !Number.isFinite(value.updatedAt)) {
    throw new Error('上传任务元数据损坏');
  }
  return value;
}

function writeUploadSession(dir: string, session: UploadSession): void {
  const file = path.join(dir, UPLOAD_SESSION_FILE);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(session), 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

const activeUploadRequests = new Map<string, number>();
let uploadCleanupRunning = false;

/** 新上传触发一次惰性清理；先原子移出受控目录，再异步删除，避免阻塞请求。 */
async function cleanupExpiredUploads(): Promise<void> {
  if (uploadCleanupRunning) return;
  uploadCleanupRunning = true;
  try {
    const root = getUploadsRoot();
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (entry.isDirectory() && /^\.expired-[0-9a-f-]{36}-[0-9a-f-]{36}$/i.test(entry.name)) {
        try { await fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true }); } catch { /* retry later */ }
        continue;
      }
      if (!entry.isDirectory() || !UPLOAD_ID_RE.test(entry.name) || activeUploadRequests.has(entry.name)) continue;
      const dir = path.join(root, entry.name);
      try {
        const scopeFile = path.join(dir, UPLOAD_SCOPE_FILE);
        const scopeStat = fs.lstatSync(scopeFile);
        if (!scopeStat.isFile()) continue;
        const session = readUploadSession(dir);
        // 完成导入后，此目录会登记为 source.dir，后续编辑/同步仍需读取原文件。
        if (session?.jobId) continue;
        const updatedAt = session?.updatedAt ?? scopeStat.mtimeMs;
        if (now - updatedAt < UPLOAD_IDLE_TTL_MS) continue;
        // rename 与状态复核之间无 await；同一进程内的上传/导入无法插入。
        const quarantine = path.join(root, `.expired-${entry.name}-${crypto.randomUUID()}`);
        fs.renameSync(dir, quarantine);
        await fs.promises.rm(quarantine, { recursive: true, force: true });
      } catch {
        // 清理失败不阻断新上传；下次新上传再尝试。
      }
    }
  } catch {
    // 暂存根目录不存在或不可读时不影响上传接口的正常错误处理。
  } finally {
    uploadCleanupRunning = false;
  }
}

function bindUploadScope(dir: string, scope: string): boolean {
  const scopeFile = path.join(dir, UPLOAD_SCOPE_FILE);
  if (fs.existsSync(scopeFile)) {
    if (!fs.lstatSync(scopeFile).isFile()) return false;
    return fs.readFileSync(scopeFile, 'utf8').trim() === scope;
  }
  fs.writeFileSync(scopeFile, scope, 'utf8');
  return true;
}

// ─── job 管理（内存 Map） ─────────────────────────────

interface Job {
  id: string;
  scope: string;
  operation: 'import' | 'restore-snapshot' | 'rebuild-vector';
  state: 'running' | 'done' | 'failed' | 'cancelled';
  phase?: 'scan' | 'vectorize' | 'persist' | 'restore' | 'rebuild' | 'indexing' | 'optimized' | 'available';
  progress?: { done: number; total: number };
  result?: ImportResult | RestoreSnapshotResult | RebuildVectorResult | Record<string, unknown>;
  error?: string;
  /**
   * REQ-20261019-002：可判别错误码（如 `ALL_FILES_DUPLICATES` / `IMPORT_BUDGET_EXCEEDED`）。
   * 前端据此把"全部重复"渲染成可纠正提示，而不是失败红态（不得靠文案匹配）。
   */
  errorCode?: string;
  startedAt: number;
  finishedAt?: number;
  cancelRequested: boolean;
  abortController: AbortController;
  taskReporter: TaskReporter;
  /**
   * S-02/S-03（REQ-20261009-003）：两级完成口径（纯新增字段，既有契约不变）。
   *   - `usable`：元数据提交那一刻即 true —— **「可用」不被索引整理推迟**（护栏 2）；
   *   - `indexState`：`indexing` →（`optimized` | `available` | `skipped`），前端在
   *     `indexing` 期间**继续轮询**（`state` 仍在导入结果可用那一刻置 'done'，不改契约）；
   *   - `indexReadiness`：A11 交叉判据（索引实体 ∨ 引擎信号），整理落定后核对。
   */
  usable?: boolean;
  indexState?: 'indexing' | 'optimized' | 'available' | 'skipped';
  indexMaintenance?: { scheduled: boolean; merged: boolean };
  indexMaintenanceDegraded?: { degraded?: string; reason?: string };
  /**
   * 整理**结果未落定**（等待窗口结束时 `last` 属于其他 scope / 本 scope 尚未落定）。
   * ★ 与 `indexMaintenanceDegraded` 区分：后者是"确定失败/超时"，本字段是"不知道"。
   *   前端据此显示「结果未落定」而不是「整理未完成（error）」，也不引导重跑命令。
   */
  indexMaintenanceUnknown?: boolean;
  indexReadiness?: IndexReadiness;
}

const jobs = new Map<string, Job>();
const MAX_JOBS = 50;
const JOB_TTL_MS = 60 * 60 * 1000; // 1h

function createJob(
  scope: string,
  operation: Job['operation'],
  config: KiConfig,
  /** REQ-20261019-004：重试血缘（`/api/import/retry-incomplete` 传入原任务 ID） */
  extras?: { retryOf?: string },
): Job {
  // 清理过期 job，防止 Map 无界增长
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.finishedAt && now - j.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
  if (jobs.size >= MAX_JOBS) {
    // 优先淘汰最早完成的
    const oldest = [...jobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!)[0];
    if (oldest) jobs.delete(oldest.id);
  }
  const id = crypto.randomUUID();
  let taskReporter: TaskReporter;
  try {
    taskReporter = createTaskReporter(config, {
      id, source: 'web', operation, scope,
      ...(extras?.retryOf ? { retryOf: extras.retryOf } : {}),
    });
  } catch {
    throw Object.assign(new Error('后台任务状态登记失败，任务未启动。请检查数据目录权限后重试。'), {
      code: 'TASK_REGISTRY_UNAVAILABLE', status: 503,
    });
  }
  const job: Job = {
    id,
    scope,
    operation,
    state: 'running',
    startedAt: now,
    cancelRequested: false,
    abortController: new AbortController(),
    taskReporter,
  };
  jobs.set(job.id, job);
  return job;
}

// ─── 工具 ─────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * 第一段只读门禁（REQ-20261029-001）：**Web 用户通道**的写接口在只读 scope 上直接 409。
 *
 * 为什么不能只靠 `withScopeWriteLock` 内的第二段：`import` op 被 CLI、Web、数据源同步
 * 三方共用（`lib/datasource.ts:1222` / `lib/mcp-http-api.ts:3046` / `src/import.ts:187`），
 * 第二段必须放行它以保住数据源同步；Web 侧只能在这里挡。
 *
 * 返回 true = 已响应（调用方直接 return）。
 */
function rejectIfScopeReadonly(res: http.ServerResponse, scope: string, action: string): boolean {
  try {
    assertHttpChannelWritable(scope, action);
    return false;
  } catch (err) {
    if (isScopeReadonlyError(err)) {
      sendJson(res, 409, scopeReadonlyBody(err));
      return true;
    }
    throw err;
  }
}

/** 读取 JSON 请求体（复用 mcp-http readJsonBody 逻辑） */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8').trim();
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request aborted')));
  });
}

/** 常量时间比较 Bearer Token（与 mcp-http 一致） */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 判断 scope 是否在授权集合内（'all' 通配全部） */
function scopeAllowed(scopes: string[], scope: string): boolean {
  return scopes.includes(ALL_SCOPES) || scopes.includes(scope);
}

/**
 * scope 越权拒绝：服务端记日志（含具体 scope 便于排查），响应体脱敏（不下发 scope 名，防枚举探测）。
 */
function rejectScopeViolation(res: http.ServerResponse, scope: string, via: string): void {
  process.stderr.write(
    `[kisearch] scope 越权拦截（/api${via}）：请求 scope "${scope}" 不在该 Token 授权范围内。\n`,
  );
  sendJson(res, 403, { ok: false, error: 'Forbidden: 无权访问该 scope' });
}

function sanitizeFileName(name: string): string {
  // 仅允许相对路径文件名（支持子目录），拒绝绝对路径与穿越
  const normalized = path.normalize(name);
  if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new Error(`非法的文件名（拒绝路径穿越）：${name}`);
  }
  return normalized;
}

// ─── /api/doc/list 缓存 ───────────────────────────────

interface DocListCache {
  scope: string;
  /** vectorized：KB 层登记的向量 ID 是否非空（供前端区分已/未向量化文档） */
  docs: {
    name: string; group: string; path?: string; tags?: string[];
    vectorized: boolean; fullTextIndexed: boolean;
    /** 落点来源（REQ-20261021-001）：仅兜底写入时下发；缺省 = 用户显式指定 Group */
    groupSource?: 'scope-fallback';
  }[];
  mtimeMs: number;
  size: number;
  /** 批次 2（R7）：布局感知身份三元组的 revision 成员（新布局 manifest revision / 旧布局 -1） */
  revision: number;
  builtAt: number;
}

const docListCache = new Map<string, DocListCache>();

// 批次 2（D3）写后主动失效：写路径落盘即丢弃本 scope 列表缓存（跨进程由身份三元组兜底）
onScopeRelationsInvalidated((scope) => {
  docListCache.delete(scope);
});

/**
 * 读取 relations-cache 并聚合文件级文档（Group 路径 + 文档名）。
 *
 * 前提：本列表只读 relations-cache，**不按 ID 去向量/FTS 索引取内容**，因此不需要复用
 * `hiddenEditIndexIds` 的编辑中间态过滤——草稿期间 KB 原文不变、cache 要么是发布前要么
 * 是发布后的自洽状态，这里展示的就是该 Relation 的已发布状态（也本就应当可见）。
 * 若将来这里要展示“索引内实际条目数”或按 ID 探活，必须同时接入隐藏集过滤。
 */
function buildDocList(scope: string): DocListCache['docs'] {
  // 批次 2（R7）：身份与数据均布局感知——旧实现锚定旧单文件，新布局下恒空（Browse
  // 列表静默丢失全部文档）。现身份 = 布局感知三元组（manifest/旧文件任一），数据 =
  // readAllGroupCaches 双轨聚合。
  const identity = getRelationsCacheIdentity(scope);
  if (!identity) return [];
  const cached = docListCache.get(scope);
  if (
    cached
    && cached.mtimeMs === identity.mtimeMs
    && cached.size === identity.size
    && cached.revision === identity.revision
  ) {
    return cached.docs;
  }

  const groups = readAllGroupCaches(scope);
  const docs: DocListCache['docs'] = [];
  const seen = new Set<string>();
  for (const [group, groupData] of groups) {
    for (const rel of groupData.hot_relations ?? []) {
      if (!rel.text) continue;
      const key = `${group}\u0000${rel.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ftsOnlyIndexed = isFtsOnlyIndexedRelation(rel);
      docs.push({
        name: rel.text,
        group,
        // 已向量化判据：KB 层登记的向量 ID 非空（文件级导入为多值 memoryIds，旧链路为单值 memoryId）。
        // 只读同一份 relations-cache，故不引入额外 I/O，缓存失效条件（mtime+size）也不变。
        // 显式 memoryIds 优先：空数组代表 FTS-only/无 dense，即使旧 memoryId 残留也不能误判。
        vectorized: Array.isArray(rel.memoryIds) ? rel.memoryIds.length > 0 : !!rel.memoryId,
        fullTextIndexed: ftsOnlyIndexed,
        ...(rel.sourcePath ? { path: rel.sourcePath } : {}),
        ...(rel.tags && rel.tags.length > 0 ? { tags: rel.tags } : {}),
        // 落点来源留痕（REQ-20261021-001）：只在兜底时下发，避免给绝大多数条目加字段
        ...(rel.groupSource ? { groupSource: rel.groupSource } : {}),
      });
    }
  }

  docListCache.set(scope, { scope, docs, mtimeMs: identity.mtimeMs, size: identity.size, revision: identity.revision, builtAt: Date.now() });
  return docs;
}

// ─── 路由分发 ─────────────────────────────────────────

export interface ApiRequestCtx {
  authEnabled: boolean;
  token?: string;
  /** 客户端来源地址（由 mcp-http.ts 按 resolveClientAddr 解析传入；缺省用 req.socket.remoteAddress） */
  clientAddr?: string;
  /** 按 Token 明文查询授权 scope（缺省走多 Token 存储；测试可注入覆盖） */
  resolveTokenScopes?: (token: string) => string[] | undefined;
}

/**
 * 处理 /api/* 请求（由 mcp-http.ts handleRequest 动态 import 调用）。
 * 注意：调用方已确保 pathname.startsWith('/api/')。
 */
export async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: ApiRequestCtx,
): Promise<void> {
  // 直接调用测试/嵌入方也要在入口捕获快照；生产 HTTP 调用由 mcp-http 外层
  // 再建立同一快照，避免队列出队后回到磁盘最新配置。
  const requestConfig = loadConfig();
  // 鉴权（与 /mcp 一致）：对外绑定（authEnabled）时，本地回环来源免鉴权，远程来源需 Bearer Token。
  // 同时解析该 Token 的授权 scope 集合（全权临时 Token → ['all']；否则查多 Token 存储），
  // 供后续 handler 做 scope 越权校验。authScopes 为 null 表示免鉴权（不限）。
  // clientAddr 由 mcp-http.ts 的 resolveClientAddr 解析传入（支持测试注入模拟远程来源）
  let authScopes: string[] | null = null;
  if (ctx.authEnabled && !isLoopbackAddr(ctx.clientAddr ?? req.socket.remoteAddress)) {
    const auth = req.headers['authorization'];
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length).trim()
      : '';
    let scopes: string[] | undefined;
    if (bearer && ctx.token && tokenMatches(bearer, ctx.token)) {
      scopes = [ALL_SCOPES];
    } else if (bearer) {
      scopes = ctx.resolveTokenScopes
        ? ctx.resolveTokenScopes(bearer)
        : findTokenScopes(bearer);
    }
    if (!scopes) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized: invalid or missing Bearer token' });
      return;
    }
    authScopes = scopes;
  }

  const p = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';

  // query scope 越权校验：对带 scope 参数的只读接口（tags / doc/list / asset）生效；
  // effective scope = query scope 或 'default'（与工具缺省值一致，防止缺省时绕过授权）
  // 新增带 scope 参数的只读接口时必须同步加入本列表，否则该接口不受越权拦截
  if (authScopes !== null && req.method === 'GET'
    && (p === '/tags' || p === '/doc/list' || p === '/doc/get' || p === '/doc/edit' || p === '/asset' || p === '/import/config' || p === '/import/incomplete' || p === '/vector/status')) {
    const queryScope = url.searchParams.get('scope');
    const effectiveScope = queryScope && queryScope.trim() ? queryScope.trim() : 'default';
    if (!scopeAllowed(authScopes, effectiveScope)) {
      rejectScopeViolation(res, effectiveScope, p);
      return;
    }
  }

  try {
    if (p === '/tasks' && req.method === 'GET') {
      const requestedLimit = Number(url.searchParams.get('limit') ?? 50);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, Math.floor(requestedLimit))) : 50;
      const visible = listTaskRecords(requestConfig)
        .filter((task) => authScopes === null || scopeAllowed(authScopes, task.scope));
      sendJson(res, 200, { ok: true, tasks: visible.slice(0, limit), total: visible.length, retainedForMs: 60 * 60 * 1000 });
      return;
    }
    if (p.startsWith('/tasks/') && req.method === 'GET') {
      const id = decodeURIComponent(p.slice('/tasks/'.length));
      const task = getTaskRecord(requestConfig, id);
      if (!task || (authScopes !== null && !scopeAllowed(authScopes, task.scope))) {
        sendJson(res, 404, { ok: false, code: 'TASK_NOT_FOUND', error: '任务不存在或已过期' });
        return;
      }
      sendJson(res, 200, { ok: true, task });
      return;
    }
    if (p === '/vector/status' && req.method === 'GET') {
      const scope = resolveScope(requestConfig, url.searchParams.get('scope') ?? '');
      sendJson(res, 200, { ok: true, status: readVectorDimensionSnapshot(requestConfig, scope) });
      return;
    }
    // REQ-20261030-001：资源页「向量模型」只读摘要。
    // ★ 不带 scope 参数 ⇒ 不进上面的越权白名单；也刻意不碰 zvec / embedding 网络。
    if (p === '/embedding/summary' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...buildEmbeddingSummary(requestConfig) });
      return;
    }
    if (p === '/vector/status/refresh' && req.method === 'POST') {
      const body = await readJsonBody(req) as { scope?: string } | undefined;
      const scope = resolveScope(requestConfig, body?.scope ?? '');
      if (authScopes !== null && !scopeAllowed(authScopes, scope)) {
        rejectScopeViolation(res, scope, p);
        return;
      }
      const result = await getSharedOperationCoordinator().submit(
        { operation: 'vector-status-refresh', params: { scope } },
        // ★ R8：超时必须在 **handler 内部** 完成 —— coordinator 的 release() 在 handler
        //   返回之后才执行；若只在 HTTP 响应层超时，submit 不会 resolve，该 scope 的
        //   队列槽仍被占死（现场二即此形态），元数据读会继续排队。
        () => runWithConfigSnapshot(requestConfig, async () => {
          const outcome = await withTimeoutFallback(
            refreshVectorDimensionSnapshot(requestConfig, scope),
            () => readVectorDimensionSnapshot(requestConfig, scope),
            VECTOR_STATUS_REFRESH_TIMEOUT_MS,
          );
          if (!outcome.timedOut) return { status: outcome.value };
          process.stderr.write(
            `[kisearch][api:/vector/status/refresh] 引擎未在 ${VECTOR_STATUS_REFRESH_TIMEOUT_MS / 1000}s 内响应`
            + `（等待 ${outcome.waitedMs}ms），已返回上次快照并放行该 scope 队列；底层探测仍在后台继续。\n`,
          );
          // ★ 降级必须"语义诚实"：把 state 置为 unknown —— 本次并未确认成功。
          //   若原样返回上次的 compatible，前端（只读 state）会把它当成"刚刚刷新成功"。
          //   其余字段（checkedAt / persisted / indexCompleteness）保留，表示"上次已知"。
          return {
            status: { ...outcome.value, state: 'unknown' as const },
            degraded: { reason: 'timeout' as const, waitedMs: outcome.waitedMs },
          };
        }),
        [scope],
      );
      const payload = result.result as { status: unknown; degraded?: { reason: string; waitedMs: number } };
      sendJson(res, 200, { ok: true, ...payload });
      return;
    }
    if (p === '/health' && req.method === 'GET') return void (await handleHealth(res));
    if (p === '/search-config' && req.method === 'GET') {
      return void handleSearchConfig(res, requestConfig);
    }
    if (p === '/tags' && req.method === 'GET') {
      // /api/tags 会打开/读取 zvec Collection，必须与同 scope 的写操作共用
      // coordinator；否则 API 读请求会绕过 daemon 的单写者调度。
      // 队列占用必须用**解析后**的 scope：前端不传时 query 为空串，直接入队会落
      // 'default'，而 handler 内部 resolveScope 在 strict 模式下可能解析为其他值或
      // fail-loud，两者不一致会让读请求排到错误队列、绕过同 scope 串行约束。
      const scopeRaw = url.searchParams.get('scope') ?? '';
      const effectiveScope = resolveScope(requestConfig, scopeRaw);
      await getSharedOperationCoordinator().submit(
        { operation: 'tag-list', params: { scope: effectiveScope } },
        () => runWithConfigSnapshot(requestConfig, () => handleTags(res, url)),
        [effectiveScope],
      );
      return;
    }
    if (p === '/doc/list' && req.method === 'GET') {
      // 文档列表不打开 zvec，只读 relations-cache/local KB。
      // REQ-20261009-003 S-01：以 `read` 类型入队——只与「元数据提交窗口」互斥，
      // 不再被同 scope 的导入/向量化长任务拖住（现场：导入期间 25s 超时 → 恢复后 22ms）。
      const scopeRaw = url.searchParams.get('scope') ?? '';
      const effectiveScope = resolveScope(requestConfig, scopeRaw);
      await getSharedOperationCoordinator().submit(
        { operation: 'doc-list-api', params: { scope: effectiveScope } },
        () => runWithConfigSnapshot(requestConfig, () => handleDocList(res, url)),
        [effectiveScope],
        'read',
      );
      return;
    }
    if (p === '/doc/get' && req.method === 'GET') {
      // 浏览页阅读器专用正文读取（2026-10-13 缺陷修复）。
      // 此前浏览页走 MCP `ki_get_module_info`，而 MCP 请求按缺省 `write` 入队
      //（mcp-http.ts）⇒ 导入/向量化长任务期间同 scope 的正文读取被排到队尾
      //（隔离实测：`/api/doc/list` 3ms 时该请求等了 8745ms）。
      // 本接口与 /doc/list 同款：handler 只读 relations-cache 分片 + local KB 正文、
      // 不做向量模糊兜底（noVectorFallback）⇒ 不打开 zvec ⇒ 可安全走 `read` 通道，
      // 只与「元数据提交窗口」短互斥，导入期间照样秒回。
      const scope = resolveScope(requestConfig, url.searchParams.get('scope') ?? '');
      await getSharedOperationCoordinator().submit(
        { operation: 'doc-get-api', params: { scope } },
        () => runWithConfigSnapshot(requestConfig, () => handleDocGet(res, url)),
        [scope],
        'read',
      );
      return;
    }
    if (p === '/doc/edit' && req.method === 'GET') {
      // REQ-20261009-003 S-01：读取待编辑原文同样不打开 zvec，走 read 通道。
      const scope = resolveScope(requestConfig, url.searchParams.get('scope') ?? '');
      const group = url.searchParams.get('group') ?? '';
      const relation = url.searchParams.get('relation') ?? '';
      await getSharedOperationCoordinator().submit(
        { operation: 'doc-edit-read', params: { scope } },
        () => runWithConfigSnapshot(requestConfig, () => {
          try {
            sendJson(res, 200, readDocumentForEdit({ scope, group, relation }));
          } catch (error) {
            sendDocEditError(res, error);
          }
        }),
        [scope],
        'read',
      );
      return;
    }
    if (p === '/doc/edit' && req.method === 'POST') {
      const body = await readJsonBody(req) as Record<string, unknown> | undefined;
      const scope = resolveScope(requestConfig, typeof body?.scope === 'string' ? body.scope : '');
      if (authScopes !== null && !scopeAllowed(authScopes, scope)) {
        rejectScopeViolation(res, scope, p);
        return;
      }
      // 只读门禁（REQ-20261029-001）：阅读页「编辑文档 / 添加链接」的保存入口
      if (rejectIfScopeReadonly(res, scope, 'http:/api/doc/edit')) return;
      await getSharedOperationCoordinator().submit(
        { operation: 'doc-edit-write', params: { scope } },
        () => runWithConfigSnapshot(requestConfig, async () => withScopeWriteLock(scope, 'doc-edit-write', async () => {
          try {
            if (typeof body?.group !== 'string' || typeof body.relation !== 'string'
              || typeof body.content !== 'string' || typeof body.expectedRevision !== 'string') {
              sendJson(res, 400, { ok: false, code: 'DOC_EDIT_INVALID', error: '缺少编辑参数' });
              return;
            }
            const result = await saveDocumentEdit({
              scope, group: body.group, relation: body.relation,
              content: body.content, expectedRevision: body.expectedRevision,
              expectedSourceRevision: typeof body.expectedSourceRevision === 'string' ? body.expectedSourceRevision : undefined,
              vectorize: body.vectorize === true,
              editId: typeof body.editId === 'string' ? body.editId : undefined,
            });
            docListCache.delete(scope);
            sendJson(res, 200, result);
          } catch (error) {
            docListCache.delete(scope);
            sendDocEditError(res, error);
          }
        })),
        [scope],
      );
      return;
    }
    if (p === '/asset' && req.method === 'GET') {
      // 附件读取改走 `read` 通道（2026-10-13）：导入的附件复制已原子化
      //（临时文件 + rename，见 import.ts::collectAndCopyAssets）⇒ 并发读要么见旧文件、
      // 要么见新文件，不会读到半写；目录被 scope/group 删除时读侧得 404（fail-loud 可接受）。
      // 此前按 write 入队 ⇒ 导入/向量化长任务期间浏览页图片同样排在队尾（同类缺陷一并修）。
      const scopeRaw = url.searchParams.get('scope') ?? '';
      const effectiveScope = resolveScope(requestConfig, scopeRaw);
      await getSharedOperationCoordinator().submit(
        { operation: 'asset-read-api', params: { scope: effectiveScope } },
        () => runWithConfigSnapshot(requestConfig, () => handleAsset(res, url)),
        [effectiveScope],
        'read',
      );
      return;
    }
    if (p === '/import/config' && req.method === 'GET') {
      const scope = resolveScope(requestConfig, url.searchParams.get('scope') ?? '');
      await getSharedOperationCoordinator().submit(
        { operation: 'import-config', params: { scope } },
        () => runWithConfigSnapshot(requestConfig, () => handleImportConfig(res, url, requestConfig)),
        [scope],
      );
      return;
    }
    if (p === '/import/upload' && req.method === 'POST') return void (await handleImportUpload(req, res, authScopes));
    if (p === '/import/upload-status' && req.method === 'GET') return void handleImportUploadStatus(res, url, authScopes);
    if (p === '/import/run' && req.method === 'POST') return void (await handleImportRun(req, res, authScopes));
    if (p === '/import/preflight' && req.method === 'POST') return void handleImportPreflight(req, res, authScopes);
    if (p === '/import/status' && req.method === 'GET') return void (await handleImportStatus(res, url, authScopes));
    if (p === '/import/cancel' && req.method === 'POST') return void (await handleImportCancel(req, res, authScopes));
    if (p === '/import/incomplete' && req.method === 'GET') {
      // 任务中心「重试未完成」入口的只读判据（2026-10-13）：只读清单文件 + 源目录存在性，
      // 不打开引擎、不写元数据 ⇒ 走 `read` 通道（导入/向量化期间不被排队，与 /doc/get 同口径）。
      const incompleteScope = resolveScope(requestConfig, url.searchParams.get('scope') ?? '');
      await getSharedOperationCoordinator().submit(
        { operation: 'import-incomplete-api', params: { scope: incompleteScope } },
        () => runWithConfigSnapshot(requestConfig, () => handleImportIncomplete(res, incompleteScope)),
        [incompleteScope],
        'read',
      );
      return;
    }
    if (p === '/import/retry-incomplete' && req.method === 'POST') return void (await handleImportRetryIncomplete(req, res, authScopes, requestConfig));
    if (p === '/datasource/list' && req.method === 'GET') return void handleDatasourceList(res, url, requestConfig, authScopes);
    if (p === '/datasource/detail' && req.method === 'GET') return void handleDatasourceDetail(res, url, requestConfig, authScopes);
    if (p === '/datasource/sync' && req.method === 'POST') return void (await handleDatasourceSync(req, res, authScopes, requestConfig));
    if (p === '/datasource/schedule' && req.method === 'POST') return void (await handleDatasourceSchedule(req, res, authScopes, requestConfig));
    if (p === '/datasource/add-remote' && req.method === 'POST') return void (await handleDatasourceAddRemote(req, res, authScopes, requestConfig));
    if (p === '/datasource/update' && req.method === 'POST') return void (await handleDatasourceUpdate(req, res, authScopes, requestConfig));
    if (p === '/datasource/remove' && req.method === 'POST') return void (await handleDatasourceRemove(req, res, authScopes, requestConfig));
    if (p === '/import/prune' && req.method === 'POST') return void (await handleImportPrune(req, res, authScopes, requestConfig));
    if (p === '/datasource/prune' && req.method === 'POST') return void (await handleDatasourcePrune(req, res, authScopes, requestConfig));
    if (p === '/restore/run' && req.method === 'POST') return void (await handleRestoreRun(req, res, authScopes, requestConfig));
    if (p === '/restore/status' && req.method === 'GET') return void (await handleJobStatus(res, url, authScopes));
    if (p === '/restore/cancel' && req.method === 'POST') return void (await handleJobCancel(req, res, authScopes));
    if (p === '/tasks' && req.method === 'GET') return void handleTaskList(res, url, requestConfig, authScopes);
    if (p.startsWith('/tasks/') && req.method === 'GET') return void handleTaskDetail(res, p.slice('/tasks/'.length), requestConfig, authScopes);
    if (p === '/vector/status' && req.method === 'GET') return void handleVectorStatus(res, url, requestConfig);
    if (p === '/vector/status/refresh' && req.method === 'POST') return void (await handleVectorStatusRefresh(req, res, requestConfig));
    if (p === '/vector/optimize' && req.method === 'POST') return void (await handleVectorOptimize(req, res, authScopes, requestConfig));
    // ════════ chat 模块（REQ-20260924-001 · SR-01 独占挂载点）════════
    // 单行挂载：/api/chat/* 全部路由由 chat-routes.ts 内部处理（本文件已 1065 行，不再逐条加分支）
    // 越权白名单：API-02/04/14（带 scope 参数的 GET）仍须登记在上方只读接口列表
    if (await handleChatRoutes(req, res, url, { authScopes, configSnapshot: requestConfig })) return;
    sendJson(res, 404, { ok: false, error: `Not Found: /api${p}` });
  } catch (err) {
    // status 允许 handler 表达「服务在、但这个检查暂时给不出结果」（503），
    // 而不是一律压成 400 客户端错误。
    const e = err as Error & { code?: string; status?: number };
    sendJson(res, e.status ?? 400, { ok: false, error: e.message, code: e.code ?? 'API_ERROR' });
  }
}

function sendDocEditError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof DocumentEditError) {
    sendJson(res, error.status, { ok: false, code: error.code, error: error.message,
      ...(error.details ? { details: error.details } : {}) });
    return;
  }
  sendJson(res, 500, { ok: false, code: 'DOC_EDIT_FAILED', error: (error as Error).message });
}

// ─── GET /api/import/config ──────────────────────────

async function handleImportConfig(res: http.ServerResponse, url: URL, requestConfig: KiConfig): Promise<void> {
  const scope = resolveScope(requestConfig, url.searchParams.get('scope') ?? '');
  const importConfig = getScopeImportConfig(requestConfig, scope);
  let vectorDimension: { configured: number; persisted?: number; compatible: boolean | null; error?: string };
  try {
    const snapshot = await refreshVectorDimensionSnapshot(requestConfig, scope);
    vectorDimension = {
      configured: snapshot.configured,
      ...(snapshot.persisted !== undefined ? { persisted: snapshot.persisted } : {}),
      compatible: snapshot.state === 'unknown' ? null : snapshot.state === 'compatible',
      ...(snapshot.error ? { error: snapshot.error } : {}),
    };
  } catch (error) {
    vectorDimension = { configured: requestConfig.embedding.dimension, compatible: null, error: (error as Error).message };
  }
  sendJson(res, 200, {
    ok: true,
    scope,
    extensions: resolveImportExtensions(requestConfig, scope),
    maxFileSize: importConfig?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    assets: importConfig?.assets !== false,
    assetExtensions: ASSET_EXTENSIONS,
    maxAssetSize: importConfig?.maxAssetSize ?? DEFAULT_MAX_ASSET_SIZE,
    maxRequestBody: MAX_BODY,
    vectorDimension,
  });
}

// ─── GET /api/health ──────────────────────────────────

async function handleHealth(res: http.ServerResponse): Promise<void> {
  const config = loadConfig();
  let timer: NodeJS.Timeout | undefined;
  // 不复用 mcp-tools/util 的 withTimeout：它抛 ToolTimeoutError，文案面向 MCP 工具调用，
  // 原样进 API 响应会让前端显示「工具 … 执行超过 …」。定时器仍需显式清理，否则每次
  // 探活都会在 daemon 里留一个挂到 deadline 的句柄。
  const report = await Promise.race([
    // 高频轮询接口：批大小探测（一次真实批量 embedding 请求）与预算都不适合放在这里。
    runHealthCheck(config, { embeddingFailure: 'warn', embeddingProbe: HEALTH_PROBE, checkCollectionDimensions: false, checkEmbeddingBatchSize: false }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(
          new Error(`健康检查未在 ${HEALTH_TIMEOUT_MS / 1000}s 内完成`),
          { code: 'HEALTH_CHECK_TIMEOUT', status: 503 },
        )),
        HEALTH_TIMEOUT_MS,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  sendJson(res, 200, { ok: true, report });
}

// ─── GET /api/tasks ───────────────────────────────────

/**
 * 任务记录列表（task-registry 落盘的任务文件）。
 * 前端顶栏任务徽标、任务页、总览健康项共用；按 scope 授权过滤。
 */
function handleTaskList(res: http.ServerResponse, url: URL, config: KiConfig, authScopes: string[] | null): void {
  const raw = Number(url.searchParams.get('limit') ?? '100');
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, Math.floor(raw)), 500) : 100;
  let tasks = listTaskRecords(config, limit);
  if (authScopes !== null) tasks = tasks.filter((task) => scopeAllowed(authScopes, task.scope));
  /**
   * 列表只回计数，不回明细（code-review P1-3）：`AppShell` 每 3–15s 拉 200 条，
   * 每条最多 20+20 条明细（~4KB），而列表行只用 `result.files` 的计数。
   * 明细由 `/api/tasks/:id` 单独提供。
   */
  const summarized = tasks.map((task) => {
    if (!task.result || (!task.result.duplicates && !task.result.conflicts)) return task;
    const { duplicates: _duplicates, conflicts: _conflicts, ...rest } = task.result;
    return { ...task, result: rest };
  });
  sendJson(res, 200, { ok: true, tasks: summarized, total: summarized.length, retainedForMs: TASK_TTL_MS });
}

/** 单个任务详情；记录已被 TTL 清理时返回 404，由前端提示重新发起。 */
function handleTaskDetail(res: http.ServerResponse, id: string, config: KiConfig, authScopes: string[] | null): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    sendJson(res, 400, { ok: false, error: '任务 id 非法' });
    return;
  }
  const task = getTaskRecord(config, id);
  if (!task) {
    sendJson(res, 404, { ok: false, error: 'task not found（记录可能已过期清理）' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, task.scope)) {
    rejectScopeViolation(res, task.scope, '/tasks');
    return;
  }
  sendJson(res, 200, { ok: true, task });
}

// ─── POST /api/vector/optimize（S-01，REQ-20261009-003）──────────────────────

/**
 * 触发索引整理（optimize）= **重试入口**。
 *
 * 语义要点：
 *   - 在 **daemon 进程内**执行 ⇒ 不受"daemon 持锁导致 CLI 无法整理"的影响（与 `ki index-optimize` 互补）；
 *   - 经 coordinator 以 **`engine-only`** 入队（`kindForOperation('vector-optimize')` 已登记，
 *     且此处**显式传参**双保险）⇒ 与写任务互斥、**被 read 旁路**（不阻塞页面）；
 *   - 超时 = **中断**：由 `optimizeVectorIndex` 内部判定并返回 `degraded`，handler 照常 resolve
 *     ⇒ 队列槽不会被整理占死（R8 的教训：超时必须包在 handler 内的**同一 promise 链**上）；
 *   - 失败返回 `ok:false` + `degraded`（不判失败任务、不引导重建/清库）。
 */
async function handleVectorOptimize(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
  config: KiConfig,
): Promise<void> {
  const body = (await readJsonBody(req)) as
    | { scope?: string; concurrency?: number; timeoutMs?: number }
    | undefined;
  // scope 越权校验：鉴权模式下校验 body.scope（缺省 'default'，与工具缺省一致）
  if (authScopes !== null) {
    const rawScope = body?.scope;
    const effectiveScope = rawScope && rawScope.trim() ? rawScope.trim() : 'default';
    if (!scopeAllowed(authScopes, effectiveScope)) {
      rejectScopeViolation(res, effectiveScope, '/vector/optimize');
      return;
    }
  }
  const scope = resolveScope(config, typeof body?.scope === 'string' ? body.scope : '');
  const result = await getSharedOperationCoordinator().submit(
    { operation: 'vector-optimize', params: { scope } },
    () => runWithConfigSnapshot(config, () => optimizeVectorIndex(scope, {
      ...(typeof body?.concurrency === 'number' ? { concurrency: body.concurrency } : {}),
      ...(typeof body?.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
    })),
    [scope],
    // ★ 显式传 kind：不依赖 `kindForOperation` 推导（评审 #1：新 operation 缺省落 write 会把读挡回去）
    'engine-only',
  );
  const outcome = result.result as Awaited<ReturnType<typeof optimizeVectorIndex>>;
  // outcome 自身含 ok（联合类型），勿再重复声明
  sendJson(res, 200, { action: 'vector-optimize', scope, ...outcome });
}

// ─── GET/POST /api/vector/status ──────────────────────

/** 只读最近一次确认的向量维度快照（不打开 zvec）；缺失/过期返回 unknown，由前端决定是否刷新。 */
function handleVectorStatus(res: http.ServerResponse, url: URL, config: KiConfig): void {
  const scope = resolveScope(config, url.searchParams.get('scope') ?? '');
  sendJson(res, 200, { ok: true, status: readVectorDimensionSnapshot(config, scope) });
}

/** 真实探测 zvec 集合维度并落盘快照（前端「重新检查」或快照过期时调用）。 */
async function handleVectorStatusRefresh(req: http.IncomingMessage, res: http.ServerResponse, config: KiConfig): Promise<void> {
  const body = (await readJsonBody(req)) as { scope?: string } | undefined;
  const scope = resolveScope(config, typeof body?.scope === 'string' ? body.scope : '');
  const status = await refreshVectorDimensionSnapshot(config, scope);
  sendJson(res, 200, { ok: true, status });
}

// ─── GET /api/search-config ──────────────────────────

/** 只暴露前端初始化语义检索控件所需的非敏感默认值。 */
function handleSearchConfig(res: http.ServerResponse, config: KiConfig): void {
  sendJson(res, 200, {
    ok: true,
    timeout: (config.embedding.queryTimeoutMs ?? DEFAULT_QUERY_EMBED_TIMEOUT_MS) / 1000,
  });
}

// ─── GET /api/tags ──────────────────────────────────────

async function handleTags(res: http.ServerResponse, url: URL): Promise<void> {
  const scopeRaw = url.searchParams.get('scope') ?? '';
  const scope = resolveScope(loadConfig(), scopeRaw);
  // ★ R8 二期（REQ-20261009-003）：tag 列表要打开/扫描 zvec Collection，属"可失败的辅助读"——
  //   引擎被占（残留进程持 flock）时会长时间挂住，把该 scope 的队列槽占死。
  //   超时上界必须包在**本 handler 内部**：coordinator 的 release() 在 handler 返回后才执行，
  //   只在 HTTP 响应层超时的话 submit 不会 resolve，队列槽照旧占死（等于没修）。
  //
  //   ⚠️ 超时的**覆盖面**（勿夸大）：只覆盖"handler 开始执行后引擎不响应"。
  //   本任务按 `kindForOperation('tag-list') = 'write'` 入队（tags 要打开 zvec，不得与写并发），
  //   因此**导入/向量化长任务期间请求会排在队尾**——排队段不计入这 5s（那属 R9 的占比/kind 议题）。
  //
  //   ⚠️ 降级形态与 /vector/status/refresh **有意相反**（勿"统一"）：
  //   - refresh 有"上次快照"可给 → `ok:true` + 陈旧数据 + degraded 标记；
  //   - tags 没有可信快照（返回 `tags:[]` 会冒充"查询结果为空"）→ 必须 `ok:false`
  //     （与既有失败路径同形）。前端三处调用点（SearchPage / ImportPage / WritePage）
  //     均以 `if (res.ok)` 守卫：不 ok 时**保留现有标签、静默不刷新**——
  //     符合 N9（呈现为"未知"而非"故障"，不触发重建/清库引导）。
  //
  //   ⚠️ 两个 `degraded` 不同形状，勿混：响应体的 `degraded` 是 `{reason:'timeout',waitedMs}`
  //   （与 refresh 对齐）；`TagListResult.degraded` 是 **boolean**（"向量服务不可用"，见 tag.ts），
  //   **不得** `{...result}` 直接透传，否则前端按对象读 `degraded.reason` 会得到 undefined。
  const timeoutError = `引擎未在 ${TAG_LIST_TIMEOUT_MS / 1000}s 内响应，本次未取到 tag 列表（状态未知，非故障）`;
  const outcome = await withTimeoutFallback(
    executeTagList({ scope }),
    // 超时时 value 一定来自本 fallback（哨兵以 race 实际结果为准）→ 下方 timedOut 分支据此必然 ok:false；
    // 这里不再返回 `degraded: true`：响应标记只由 timedOut 决定，避免与工具层 boolean 同名混淆。
    (): TagListResult => ({ ok: false, error: timeoutError }),
    TAG_LIST_TIMEOUT_MS,
  );
  if (outcome.timedOut) {
    process.stderr.write(
      `[kisearch][api:/tags] 引擎未在 ${TAG_LIST_TIMEOUT_MS / 1000}s 内响应（等待 ${outcome.waitedMs}ms），`
      + '已按"本次未取到"返回并放行该 scope 队列；底层扫描仍在后台继续。\n',
    );
    sendJson(res, 200, {
      ok: false,
      error: timeoutError,
      tags: [],
      scope,
      degraded: { reason: 'timeout' as const, waitedMs: outcome.waitedMs },
    });
    return;
  }
  const result = outcome.value;
  if (!result.ok) {
    // 既有失败路径（如"向量服务暂不可用"）：按原样返回，**不**透传 `result.degraded`（boolean）
    sendJson(res, 200, { ok: false, error: result.error, tags: [], scope });
    return;
  }
  // 过滤内部保留 tag（ki-search/ki-relation/ki-path）
  const reserved = new Set(['ki-search', 'ki-relation', 'ki-path']);
  const tags = result.tags.filter(t => !reserved.has(t.tag));
  sendJson(res, 200, { ok: true, tags, scope });
}

// ─── GET /api/asset ──────────────────────────────────

/** 附件 MIME 映射（REQ-20260904-001；后缀集合与 import.ts ASSET_EXTENSIONS 对应） */
const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/**
 * GET /api/asset?scope=&group=&path= —— 读取 group 级 assets 目录下的附件（REQ-20260904-001）
 *
 * 纯文件读取（不经过向量引擎），导入后无需重启即可生效（与 /api/doc/list 同模式）。
 * 安全：path 经 decodeURIComponent + normalize 后必须仍落在该 group 的 assets 目录内（防路径穿越）；
 * scope 越权由 handleApiRequest 统一校验（authScopes）。
 * 404 返回 JSON：/api/* 不走 SPA fallback，避免把缺失附件伪装成 200 + index.html（REQ 层 2 缺陷）。
 */
async function handleAsset(res: http.ServerResponse, url: URL): Promise<void> {
  const scopeRaw = url.searchParams.get('scope') ?? '';
  const scope = resolveScope(loadConfig(), scopeRaw);
  const group = (url.searchParams.get('group') ?? '').trim();
  const rawPath = url.searchParams.get('path') ?? '';
  if (!group || !rawPath.trim()) {
    sendJson(res, 400, { ok: false, error: 'Bad Request: group and path are required' });
    return;
  }
  // group 穿越校验：group 原样进 path.join 会搬移下方前缀校验的锚点 → 跨 scope 越权 / KB 外宿主机文件读取。
  // 拒绝绝对路径与含 .. / . / 空段的 group（合法 group 为干净相对路径段序列）。
  if (path.isAbsolute(group) || group.split(/[\\/]/).some((s) => s === '..' || s === '.' || s === '')) {
    sendJson(res, 400, { ok: false, error: 'Bad Request: invalid group' });
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // 与导入侧“解码失败按原样”对称：文件名含裸 % （如 50%.png）时不至永远 404
    decoded = rawPath;
  }
  // 双锚点校验：assetsDir 必须落在该 scope 的 KB 根内（不可搬移），resolved 必须落在 assetsDir 内（防穿越）
  const kbRoot = path.resolve(getKbDir(scope));
  const assetsDir = path.resolve(getAssetsDir(scope, group));
  if (assetsDir !== kbRoot && !assetsDir.startsWith(kbRoot + path.sep)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }
  const resolved = path.normalize(path.join(assetsDir, decoded));
  if (resolved !== assetsDir && !resolved.startsWith(assetsDir + path.sep)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }
  // 后缀白名单（与导入侧 ASSET_EXTENSIONS 对齐）：assets 目录内非图片文件不予服务
  const ext = path.extname(resolved).toLowerCase();
  if (!ASSET_MIME[ext]) {
    sendJson(res, 404, { ok: false, error: `Not Found: 不支持的附件类型 ${ext || '(无后缀)'}` });
    return;
  }
  let content: Buffer;
  try {
    content = fs.readFileSync(resolved);
  } catch (err) {
    // 仅 ENOENT 映射为 404；EISDIR/EACCES/EMFILE 等真实故障向上抛（fail-loud，不伪装成“未导入”）
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    sendJson(res, 404, {
      ok: false,
      error: `Not Found: 附件 ${rawPath} 未随文档导入（导入时未开启附件收集、源文件缺失，或该引用为不支持的形态）`,
    });
    return;
  }
  res.writeHead(200, {
    'Content-Type': ASSET_MIME[ext],
    // 幂等重导会覆盖同名附件 → 不做强缓存，每次向服务器协商
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    // SVG 可内嵌脚本：sandbox 使其成为独立 origin，防外部 wiki 的 SVG 在本应用同源执行
    ...(ext === '.svg' ? { 'Content-Security-Policy': 'sandbox' } : {}),
  });
  res.end(content);
}

// ─── GET /api/doc/get ─────────────────────────────────
/**
 * 读单篇文档正文（浏览页阅读器）。
 *
 * 与 MCP `ki_get_module_info` 的差异（有意为之）：
 *   - **不做** group 路径 / relation 名的向量语义兜底（`noVectorFallback`）——
 *     浏览页的 group/relation 来自 /api/doc/list 或深链接，本就精确；不打开 zvec
 *     才能以 `read` 入队（read 契约见 operation-coordinator.ts 的 TaskKind）。
 *   - 未命中时 fail-loud 返回 404 + hint（沿用读详情既有文案），不静默回退。
 * 评分回写（recordUse）与 MCP 路径同源：仍在 `withMetadataCommitSync` 窗口内。
 */
async function handleDocGet(res: http.ServerResponse, url: URL): Promise<void> {
  const scope = resolveScope(loadConfig(), url.searchParams.get('scope') ?? '');
  const group = url.searchParams.get('group') ?? '';
  const relation = url.searchParams.get('relation') ?? '';
  if (!group.trim() || !relation.trim()) {
    sendJson(res, 400, { ok: false, error: '缺少 group/relation 参数' });
    return;
  }
  const result = await executeGetModuleInfoLocal({ scope, group, relation }, { noVectorFallback: true });
  sendJson(res, result.ok ? 200 : 404, result);
}

// ─── GET /api/doc/list ────────────────────────────────

async function handleDocList(res: http.ServerResponse, url: URL): Promise<void> {
  const scopeRaw = url.searchParams.get('scope') ?? '';
  const scope = resolveScope(loadConfig(), scopeRaw);
  // 路径检索（2026-10-20）：检索词归一化后与「逻辑路径」（Group 路径 + 导入源 sourcePath，
  // 按最长重叠段合并，见 doc-path.ts）比较。归一处后为空 = 无有效检索词（纯空格 / 纯 `/`），
  // 按「不过滤」处理 —— 不能当成"搜不到任何文档"。
  const q = normalizeSearchQuery(url.searchParams.get('q') ?? '');
  const groupRaw = url.searchParams.get('group');
  // 按自定义 tag 过滤（relation.tags 精确匹配；缺省不过滤）
  const tagRaw = (url.searchParams.get('tag') ?? '').toLowerCase();
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 0, 1), DOC_LIST_LIMIT) : DOC_LIST_LIMIT;
  // S0-2（REQ-20260930-002）：服务端分页 offset（与 limit 组合翻页；非法/负值按 0）
  const offsetRaw = url.searchParams.get('offset');
  const offset = Math.max(parseInt(offsetRaw ?? '0', 10) || 0, 0);

  const all = buildDocList(scope);
  // Group 树需要完整 group 集合 + 每组文档数量，不受 docs 分页 limit 影响
  // （否则后写入的独立 group 如 tag 若排在前 500 条 docs 之外，前端 Group 树会缺失该节点）
  const groupCounts = new Map<string, number>();
  const tagSet = new Set<string>();
  for (const d of all) {
    groupCounts.set(d.group, (groupCounts.get(d.group) ?? 0) + 1);
    for (const t of d.tags ?? []) tagSet.add(t);
  }
  const groups = Array.from(groupCounts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
  // 全部文档的自定义 tag 去重列表（供前端 tag 过滤下拉使用）
  const tags = Array.from(tagSet).sort();

  // tag 过滤辅助：tagRaw 为空则不过滤；否则匹配 relation.tags 中的某个 tag
  const matchTag = (d: { tags?: string[] }): boolean =>
    !tagRaw || (d.tags ?? []).some((t) => t.toLowerCase() === tagRaw);
  // 检索过滤：文档名 **或** 逻辑路径（含 Group 路径）命中即保留。
  // 旧实现只比 name + sourcePath，而 sourcePath 是"导入源目录相对路径"、与界面展示的
  // group/文件名不同源 ⇒ 照着页头路径搜恒为 0；无 sourcePath 的文档（MCP/CLI 写入）更无从命中。
  const matchQuery = (d: SearchableDoc): boolean => !q || matchDocQuery(d, q) !== null;
  /**
   * 检索态给命中文档补两个展示字段（**非检索态不补**，不给既有消费方凭空加字段）：
   *   - `matchedBy`：命中来源 `name` / `path` —— 前端据此分「名称命中」「路径命中」两个分区；
   *   - `logicalPath`：Group 与 sourcePath 合并后的完整路径 —— 前端据此展示并高亮命中片段。
   * 路径只此一处拼装，避免各端各自拼出"看到的路径 ≠ 能搜到的路径"。
   */
  type ListedDoc = DocListCache['docs'][number] & { matchedBy?: 'name' | 'path'; logicalPath?: string };
  const withSearchMeta = (docs: DocListCache['docs']): ListedDoc[] =>
    q
      ? docs.map((d) => ({ ...d, matchedBy: matchDocQuery(d, q) ?? 'path', logicalPath: logicalDocPath(d) }))
      : docs;

  // 指定 group 时按 [offset, offset+limit) 分页返回该 group 文档（S0-2 修复：
  // 旧行为 slice 后以截断长度冒充 total 且恒 truncated:false，单 Group >500 篇静默丢失）
  if (groupRaw) {
    const groupMatched = all
      .filter((d) => d.group === groupRaw && matchQuery(d) && matchTag(d));
    const docs = groupMatched.slice(offset, offset + limit);
    sendJson(res, 200, {
      ok: true,
      scope,
      docs: withSearchMeta(docs),
      offset,
      total: groupMatched.length,
      truncated: offset + docs.length < groupMatched.length,
      groups,
      tags,
    });
    return;
  }

  // 不带 group 参数时：
  //   - 有搜索词(q)：返回跨组模糊匹配的文档（全局搜索场景，limit 放宽到 2000）
  //   - 无搜索词(q)：返回前 limit 条全部 docs（兼容既有 API 契约；BrowsePage 前端已改用 useGroupDocs 按组精确拉取）
  const SEARCH_LIMIT = 2000;
  const filtered = all.filter(matchQuery).filter(matchTag);
  const searchLimit = q ? Math.min(SEARCH_LIMIT, filtered.length) : Math.min(limit, filtered.length);
  const docs = filtered.slice(offset, offset + searchLimit);
  sendJson(res, 200, {
    ok: true,
    scope,
    docs: withSearchMeta(docs),
    offset,
    total: filtered.length,
    truncated: offset + docs.length < filtered.length,
    groups,
    tags,
  });
}

// ─── POST /api/import/upload ──────────────────────────

async function handleImportUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
): Promise<void> {
  const headerId = req.headers['x-ki-upload-id'];
  const activeId = typeof headerId === 'string' && UPLOAD_ID_RE.test(headerId) ? headerId : null;
  if (activeId) activeUploadRequests.set(activeId, (activeUploadRequests.get(activeId) ?? 0) + 1);
  try {
    await processImportUpload(req, res, authScopes, activeId);
  } finally {
    if (activeId) {
      const remaining = (activeUploadRequests.get(activeId) ?? 1) - 1;
      if (remaining > 0) activeUploadRequests.set(activeId, remaining);
      else activeUploadRequests.delete(activeId);
    }
  }
}

async function processImportUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
  headerId: string | null,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    scope?: string;
    uploadId?: string;
    batchIndex?: number;
    batchCount?: number;
    finalize?: Omit<RunImportArgs, 'scope' | 'sourceDir'>;
    files?: { name?: string; content?: string; size?: number }[];
  } | undefined;
  // scope 越权校验：鉴权模式下校验 body.scope（缺省 'default'，与工具缺省值一致）
  if (authScopes !== null) {
    const rawScope = body?.scope;
    const effectiveScope = rawScope && rawScope.trim() ? rawScope.trim() : 'default';
    if (!scopeAllowed(authScopes, effectiveScope)) {
      rejectScopeViolation(res, effectiveScope, '/import/upload');
      return;
    }
  }
  // 只读门禁（REQ-20261029-001）：上传暂存也拒——否则文件先落到 `~/.ki/import-uploads`，
  // 到 run 才被拒，留下无人清理的残留
  if (rejectIfScopeReadonly(res, resolveScope(loadConfig(), body?.scope), 'http:/api/import/upload')) return;
  if (!body || !Array.isArray(body.files) || body.files.length === 0) {
    sendJson(res, 400, { ok: false, error: '缺少 files 数组（{ scope, files: [{ name, content }] }）' });
    return;
  }
  const requestConfig = loadConfig();
  const scope = resolveScope(requestConfig, body.scope);
  const importConfig = getScopeImportConfig(requestConfig, scope);
  const allowedExtensions = resolveImportExtensions(requestConfig, scope);
  const allowedExt = new Set(allowedExtensions.map((extension) => extension.toLowerCase()));
  const assetExt = new Set(ASSET_EXTENSIONS);
  const assetsEnabled = importConfig?.assets !== false;
  const maxFileSizeBytes = importConfig?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const maxAssetSizeBytes = importConfig?.maxAssetSize ?? DEFAULT_MAX_ASSET_SIZE;

  const requestedUploadId = body.uploadId?.trim() ?? '';
  const uploadId = requestedUploadId || crypto.randomUUID();
  if ((requestedUploadId && !UPLOAD_ID_RE.test(requestedUploadId)) || (headerId && headerId !== uploadId)) {
    sendJson(res, 400, { ok: false, error: '非法 uploadId' });
    return;
  }
  const batched = body.batchIndex !== undefined || body.batchCount !== undefined || body.finalize !== undefined;
  if (batched && (!requestedUploadId || !Number.isSafeInteger(body.batchIndex)
    || !Number.isSafeInteger(body.batchCount) || body.batchCount! < 1 || body.batchCount! > 10_000
    || body.batchIndex! < 0 || body.batchIndex! >= body.batchCount!
    || (body.finalize !== undefined && (typeof body.finalize !== 'object' || body.finalize === null
      || body.batchIndex !== body.batchCount! - 1)))) {
    sendJson(res, 400, { ok: false, error: '非法上传批次或最终提交参数' });
    return;
  }
  const uploadsRoot = path.resolve(getUploadsRoot());
  const dir = path.resolve(uploadsRoot, uploadId);
  if (!dir.startsWith(uploadsRoot + path.sep)) {
    sendJson(res, 400, { ok: false, error: '非法 uploadId' });
    return;
  }
  const exists = fs.existsSync(dir);
  if (requestedUploadId && !batched && (!exists || !fs.statSync(dir).isDirectory())) {
    sendJson(res, 400, { ok: false, error: `uploadId 不存在（${uploadId}）` });
    return;
  }
  if (batched && !exists && body.batchIndex !== 0) {
    sendJson(res, 400, { ok: false, error: '上传任务不存在；请从第一批重新上传' });
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.lstatSync(dir).isDirectory()) {
    sendJson(res, 400, { ok: false, error: '非法 uploadId' });
    return;
  }
  if (!bindUploadScope(dir, scope)) {
    sendJson(res, 400, { ok: false, error: 'uploadId 与当前 scope 不匹配' });
    return;
  }
  if (!exists) void cleanupExpiredUploads();
  let session = readUploadSession(dir) ?? { scope, updatedAt: Date.now(), state: 'uploading' as const };
  if (session.scope !== scope || (session.batchCount !== undefined && session.batchCount !== body.batchCount)) {
    sendJson(res, 400, { ok: false, error: '上传任务参数与已有批次不一致' });
    return;
  }
  if (Date.now() - session.updatedAt >= UPLOAD_IDLE_TTL_MS && exists && session.state === 'uploading') {
    sendJson(res, 410, { ok: false, error: '上传任务已过期，请重新选择文件上传' });
    return;
  }
  if (session.jobId) {
    sendJson(res, 200, { ok: true, uploadId, scope, jobId: session.jobId, total: 0, errors: session.errors });
    return;
  }
  if (batched && session.batchCount === undefined) session.batchCount = body.batchCount;

  const saved: { name: string; path: string; size: number }[] = [];
  const errors: { name: string; error: string }[] = [];
  const requestPaths = new Set<string>();

  for (const f of body.files) {
    const name = f.name ?? '';
    const content = f.content ?? '';
    try {
      if (!name) throw new Error('缺少文件名');
      const ext = path.extname(name).toLowerCase();
      const isDocument = allowedExt.has(ext);
      const isAsset = assetsEnabled && assetExt.has(ext);
      if (!isDocument && !isAsset) {
        const assetHint = assetsEnabled ? `；附件允许 ${[...assetExt].join('/')}` : '';
        throw new Error(`不支持的扩展名（${ext || '(无)'}），文档仅允许 ${[...allowedExt].join('/')}${assetHint}`);
      }
      const buf = Buffer.from(content, 'base64');
      const maxBytes = isAsset ? maxAssetSizeBytes : maxFileSizeBytes;
      if (buf.length > maxBytes) {
        throw new Error(`文件超过大小上限（${Math.round(maxBytes / 1024)}KB）`);
      }
      const safeName = sanitizeFileName(name);
      if (requestPaths.has(safeName)) {
        throw new Error(`当前请求包含重复相对路径：${safeName}`);
      }
      const abs = path.join(dir, safeName);
      if (!abs.startsWith(dir + path.sep)) {
        throw new Error('非法路径');
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (fs.existsSync(abs)) {
        const existing = fs.readFileSync(abs);
        if (!requestedUploadId || !existing.equals(buf)) {
          throw new Error(`暂存文件已存在且内容不同：${safeName}；请使用新的 uploadId，或重试同一批次的相同内容`);
        }
        // 同一 uploadId 的相同内容重试是幂等操作，不重复覆盖已有文件。
      } else {
        fs.writeFileSync(abs, buf);
      }
      requestPaths.add(safeName);
      saved.push({ name: safeName, path: abs, size: buf.length });
    } catch (err) {
      errors.push({ name: name || '(未命名)', error: (err as Error).message });
    }
  }

  // 全部失败则清理目录
  if (saved.length === 0) {
    if (!requestedUploadId) fs.rmSync(dir, { recursive: true, force: true });
    sendJson(res, 400, {
      ok: false,
      error: '所有文件均校验失败',
      uploadId: requestedUploadId ? uploadId : undefined,
      errors,
      scope,
    });
    return;
  }

  session.updatedAt = Date.now();
  if (errors.length > 0) {
    const known = new Set((session.errors ?? []).map((item) => `${item.name}\0${item.error}`));
    const unique = errors.filter((item) => {
      const key = `${item.name}\0${item.error}`;
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    session.errors = [...(session.errors ?? []), ...unique];
  }
  if (batched) {
    session.completedBatches = [...new Set([...(session.completedBatches ?? []), body.batchIndex!])];
  }
  writeUploadSession(dir, session);

  let jobId: string | undefined;
  if (body.finalize) {
    if (session.completedBatches?.length !== session.batchCount) {
      sendJson(res, 409, { ok: false, error: '仍有批次未上传，不能启动导入', uploadId });
      return;
    }
    const job = createJob(scope, 'import', requestConfig);
    session = { ...session, state: 'importing', jobId: job.id, updatedAt: Date.now() };
    try { writeUploadSession(dir, session); } catch (error) {
      job.taskReporter.finish('failed', { error: '上传任务状态登记失败' });
      jobs.delete(job.id);
      throw error;
    }
    void runImportJob(job, {
      scope,
      sourceDir: dir,
      group: body.finalize.group,
      chunkSize: body.finalize.chunkSize,
      chunkOverlap: body.finalize.chunkOverlap,
      vector: body.finalize.vector,
      tags: body.finalize.tags,
      conflictMode: body.finalize.conflictMode,
      conflictSuffix: body.finalize.conflictSuffix,
    }, requestConfig);
    jobId = job.id;
  }

  sendJson(res, 200, {
    ok: true,
    uploadId,
    scope,
    files: saved,
    total: saved.length,
    jobId,
    errors: errors.length > 0 ? errors : undefined,
  });
}

/** 仅供页面重开后找回已经由后端接受的导入任务；未完成上传不提供续传。 */
function handleImportUploadStatus(res: http.ServerResponse, url: URL, authScopes: string[] | null): void {
  const uploadId = url.searchParams.get('uploadId') ?? '';
  const scope = url.searchParams.get('scope') ?? '';
  if (!UPLOAD_ID_RE.test(uploadId) || !scope) {
    sendJson(res, 400, { ok: false, error: '缺少或非法 scope/uploadId' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, scope)) {
    rejectScopeViolation(res, scope, '/import/upload-status');
    return;
  }
  const dir = path.join(getUploadsRoot(), uploadId);
  const scopeFile = path.join(dir, UPLOAD_SCOPE_FILE);
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory() || !fs.existsSync(scopeFile)
    || !fs.lstatSync(scopeFile).isFile() || fs.readFileSync(scopeFile, 'utf8').trim() !== scope) {
    sendJson(res, 404, { ok: false, error: '上传任务不存在' });
    return;
  }
  const session = readUploadSession(dir);
  if (!session || session.scope !== scope) {
    sendJson(res, 404, { ok: false, error: '上传任务不存在' });
    return;
  }
  sendJson(res, 200, {
    ok: true, uploadId, scope, state: session.state,
    jobId: session.jobId, active: activeUploadRequests.has(uploadId), errors: session.errors ?? [],
  });
}

// ─── POST /api/import/run ─────────────────────────────

/**
 * 净化 `onlyRelPaths`（「只重试未完成」子集）：只接受相对源目录的常规路径。
 * `/api/import/run` 与 `/api/import/preflight` 共用同一实现，避免两端口径漂移。
 */
function sanitizeOnlyRelPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'));
}

// ─── POST /api/import/preflight ─────────────────────
/**
 * 重复导入预检（REQ-20261010-001 R6 / A10）：只读，不产生任何写入。
 * 返回「本次 N 篇与库中已有文档内容一致、但 sourcePath 不同」的清单，供前端确认后再调
 * `/api/import/run`。前置校验与 run 完全一致（scope 越权 / uploadId / 暂存目录绑定）。
 */
function handleImportPreflight(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
): void {
  void (async () => {
    const body = (await readJsonBody(req)) as {
      scope?: string;
      uploadId?: string;
      onlyRelPaths?: string[];
      /** 本次导入的 Group（与 run 同参数）：判据需要按「group + rel」的落点比较，见 duplicate-index */
      group?: string;
    } | undefined;
    if (!body || !body.scope || !body.uploadId) {
      sendJson(res, 400, { ok: false, error: '缺少 scope/uploadId' });
      return;
    }
    const requestedGroup = typeof body.group === 'string' ? body.group.trim() : '';
    // 只读预检不接受可疑路径（`..` / 反斜杠 / 绝对路径）：避免拿它拼出奇怪落点参与比较
    if (!isSafeGroupPath(requestedGroup)) {
      sendJson(res, 400, { ok: false, error: '非法 group（不可为绝对路径或含 .. / 反斜杠）' });
      return;
    }
    const uploadId = body.uploadId.trim();
    if (!UPLOAD_ID_RE.test(uploadId)) {
      sendJson(res, 400, { ok: false, error: '非法 uploadId' });
      return;
    }
    if (authScopes !== null && !scopeAllowed(authScopes, body.scope)) {
      rejectScopeViolation(res, body.scope, '/import/preflight');
      return;
    }
    const scope = resolveScope(loadConfig(), body.scope);
    const sourceDir = path.join(getUploadsRoot(), uploadId);
    const root = path.normalize(getUploadsRoot());
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()
      || !path.normalize(sourceDir).startsWith(root + path.sep)) {
      sendJson(res, 400, { ok: false, error: `uploadId 不存在（${uploadId}）` });
      return;
    }
    if (!bindUploadScope(sourceDir, scope)) {
      sendJson(res, 400, { ok: false, error: 'uploadId 与当前 scope 不匹配' });
      return;
    }
    const sanitizedOnly = sanitizeOnlyRelPaths(body.onlyRelPaths);
    const onlyRelPaths = Array.isArray(body.onlyRelPaths) ? sanitizedOnly : undefined;
    if (Array.isArray(body.onlyRelPaths) && body.onlyRelPaths.length > 0 && onlyRelPaths!.length === 0) {
      sendJson(res, 400, { ok: false, error: 'onlyRelPaths 非法（必须是相对源目录的路径，不可含 .. 或绝对路径）' });
      return;
    }
    try {
      sendJson(res, 200, preflightImportDuplicates({
        scope,
        sourceDir,
        onlyRelPaths,
        ...(requestedGroup ? { group: requestedGroup } : {}),
        maxDetail: DEFAULT_PREFLIGHT_MAX_DETAIL,
      }));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `预检失败：${(err as Error).message}` });
    }
  })();
}

async function handleImportRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
): Promise<void> {
  const requestConfig = loadConfig();
  const body = (await readJsonBody(req)) as {
    scope?: string;
    uploadId?: string;
    /** 目标 Group 落点（如 "wiki/我的文档"）；缺省用 scope */
    group?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    vector?: boolean;
    /** 文档级自定义标签（逗号分隔多个），对本次导入全部文件生效 */
    tags?: string;
    conflictMode?: ImportConflictMode;
    conflictSuffix?: string;
    /**
     * R2（REQ-20261009-001）：只重试这些文件（相对源目录 = 暂存目录的路径）。
     * 前端「重试未完成 N 篇」用同一 `uploadId` 重跑，不必重新上传。
     */
    onlyRelPaths?: string[];
    /**
     * REQ-20261019-002：跳过「内容一致但 sourcePath 不同」的疑似重复文档。
     * 缺省 false（行为与改前一致）。真实判定在 `handleDirectImport` 内完成（此处只透传）。
     */
    skipDuplicates?: boolean;
  } | undefined;
  if (!body || !body.scope || !body.uploadId) {
    sendJson(res, 400, { ok: false, error: '缺少 scope/uploadId' });
    return;
  }
  const uploadId = body.uploadId.trim();
  if (!UPLOAD_ID_RE.test(uploadId)) {
    sendJson(res, 400, { ok: false, error: '非法 uploadId' });
    return;
  }
  // Group 合法性：与 `/api/import/preflight` 同口径（否则会出现"预检 400 而 run 放行"的分叉）
  const requestedGroup = typeof body.group === 'string' ? body.group.trim() : '';
  if (!isSafeGroupPath(requestedGroup)) {
    sendJson(res, 400, { ok: false, error: '非法 group（不可为绝对路径或含 .. / 反斜杠）' });
    return;
  }
  // 切分参数范围：与 `handleDirectImport` 内的校验同口径，但**提前到建 job 之前**——
  // 否则用户要等任务跑起来才看到 INVALID_CHUNK，任务台账里还白占一条失败记录。
  // 只校验本次显式传入的值；重试回落的历史参数由 handleDirectImport 兜底。
  const chunkErr = validateChunkParams({ chunkSize: body.chunkSize, chunkOverlap: body.chunkOverlap });
  if (chunkErr) {
    sendJson(res, 400, { ok: false, error: chunkErr.message, field: chunkErr.field });
    return;
  }
  // scope 越权校验（body.scope 必填）
  if (authScopes !== null && !scopeAllowed(authScopes, body.scope)) {
    rejectScopeViolation(res, body.scope, '/import/run');
    return;
  }
  const scope = resolveScope(requestConfig, body.scope);
  // 只读门禁（REQ-20261029-001）：在上传导入页发起导入前拒绝，**不创建 job**
  // （避免任务列表里出现一个必然失败的导入任务）
  if (rejectIfScopeReadonly(res, scope, 'http:/api/import/run')) return;
  const sourceDir = path.join(getUploadsRoot(), uploadId);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    sendJson(res, 400, { ok: false, error: `uploadId 不存在（${uploadId}）` });
    return;
  }
  // 安全：确认 sourceDir 在受控目录内
  const root = path.normalize(getUploadsRoot());
  if (!path.normalize(sourceDir).startsWith(root + path.sep)) {
    sendJson(res, 400, { ok: false, error: '非法 uploadId' });
    return;
  }
  if (!bindUploadScope(sourceDir, scope)) {
    sendJson(res, 400, { ok: false, error: 'uploadId 与当前 scope 不匹配' });
    return;
  }

  let session = readUploadSession(sourceDir) ?? { scope, updatedAt: Date.now(), state: 'uploading' as const };
  if (session.scope !== scope) {
    sendJson(res, 400, { ok: false, error: 'uploadId 与当前 scope 不匹配' });
    return;
  }
  // R2：只重试未完成子集时**不复用**上次 job（它已终态）——同一 uploadId 开新 job；
  // 常规路径保持原语义（幂等返回既有 jobId / 任务失效提示）
  // P2（review）：条数上限——避免超大数组进入过滤/去重与 JSON 响应
  // （常量已提升到模块级 `MAX_ONLY_REL_PATHS`，与 /import/retry-incomplete 共用同一真相）
  if (Array.isArray(body.onlyRelPaths) && body.onlyRelPaths.length > MAX_ONLY_REL_PATHS) {
    sendJson(res, 400, { ok: false, error: `onlyRelPaths 条数超限（${body.onlyRelPaths.length} > ${MAX_ONLY_REL_PATHS}）` });
    return;
  }
  const retryOnly = sanitizeOnlyRelPaths(body.onlyRelPaths);
  // 声明了 onlyRelPaths 但过滤后为空 = 调用方请求非法 → fail-loud；
  // 否则会静默落回「复用既有 job」分支，调用方以为重试已启动（复审 P2）
  if (Array.isArray(body.onlyRelPaths) && body.onlyRelPaths.length > 0 && retryOnly.length === 0) {
    sendJson(res, 400, { ok: false, error: 'onlyRelPaths 非法（必须是相对源目录的路径，不可含 .. 或绝对路径）' });
    return;
  }
  const isSubsetRetry = retryOnly.length > 0;
  // 并发闸门不在此处：统一放到 `createJob` 之前（幂等复用分支之后），
  // 让常规导入与子集重试走**同一判据**（评审 P2：此前只盖住子集重试，另两个入口存在缝）。
  // R2 复审 P1：子集重试时请求未显式给出的参数回落到该 scope 的未完成清单（上次导入的实际
  // 口径），避免「刷新页面后重试」用前端表单默认值改写 group/切分/标签/向量化口径
  // P2（review）：清单「损坏」与「没有清单」必须区分——损坏时 fail-loud，
  // 否则会静默退化成"用前端表单参数重试"，与上次口径不符且用户无感知。
  const retryStatus = isSubsetRetry ? readImportIncompleteStatus(scope) : null;
  if (retryStatus?.corrupted) {
    sendJson(res, 400, {
      ok: false,
      error: '未完成清单损坏（.ki-import-incomplete.json 无法解析）：请删除该文件后重新导入，或重新上传整批再导入',
    });
    return;
  }
  const retryParams = retryStatus?.record?.params;
  // REQ-20261019-002：同一 uploadId 的幂等复用必须尊重「跳过重复」决策——
  // 参数一致才复用；运行中且参数不同 → 409；已终态且参数不同 → 起新 job（用户被拦截后改选「仍然导入」）。
  if (body.skipDuplicates !== undefined && typeof body.skipDuplicates !== 'boolean') {
    sendJson(res, 400, { ok: false, error: 'skipDuplicates 必须是布尔值' });
    return;
  }
  const requestedSkipDuplicates = body.skipDuplicates === true;
  // ── REQ-20261019-001：清理候选参数 ────────────────────────────
  // body 的既有内联类型未声明这三个字段（避免为向后兼容大改），统一按 unknown 收窄。
  const bodyExtra = body as unknown as Record<string, unknown>;
  const rawPickMode = bodyExtra.pickMode;
  if (rawPickMode !== undefined && rawPickMode !== 'dir' && rawPickMode !== 'files' && rawPickMode !== 'mixed') {
    sendJson(res, 400, { ok: false, code: 'PRUNE_MISSING_PARAM', error: "pickMode 必须是 'dir' / 'files' / 'mixed'" });
    return;
  }
  // 缺省回落到上传时写入的参数快照（刷新恢复路径拿不到前端表单值）
  const requestedPickMode = (rawPickMode ?? session.params?.pickMode) as 'dir' | 'files' | 'mixed' | undefined;
  const requestedPruneStale = bodyExtra.pruneStale === true;
  if (requestedPruneStale && requestedPickMode !== 'dir') {
    sendJson(res, 400, {
      ok: false,
      code: 'PRUNE_NOT_DIR_MODE',
      error: '仅「选择目录」上传时可用清理功能（目录与文件混合选择也不支持）',
    });
    return;
  }
  // 路径型入参复用既有净化（拒绝绝对路径 / `..` / 超长），与 onlyRelPaths 同口径
  const requestedPreserveRels = sanitizeOnlyRelPaths(bodyExtra.preserveRels);
  // R11 硬门槛：上传会话有失败记录或批次不全 —— 说明「本次目录里的文件」不完整，
  // 此时任何差集都可能把"没传上来"误判成"本地已删"。
  const uploadIncomplete = (session.errors?.length ?? 0) > 0
    || (session.batchCount !== undefined && (session.completedBatches?.length ?? 0) < session.batchCount);
  if (session.jobId && !isSubsetRetry) {
    const previousJob = jobs.get(session.jobId);
    if (!previousJob) {
      sendJson(res, 409, { ok: false, error: '导入任务状态已失效，请重新上传' });
      return;
    }
    const previousSkipDuplicates = session.params?.skipDuplicates === true;
    if (previousSkipDuplicates === requestedSkipDuplicates) {
      sendJson(res, 202, { ok: true, jobId: session.jobId, scope });
      return;
    }
    if (previousJob.state === 'running') {
      sendJson(res, 409, {
        ok: false,
        code: 'IMPORT_JOB_PARAMS_MISMATCH',
        error: '该批次已在导入中（与本次「跳过重复」设置不同），请到任务中心查看或等待完成后再试',
      });
      return;
    }
    // 已终态 + 参数不同：落到下方新建 job（并覆盖 session 参数快照）
  }
  if (session.batchCount !== undefined && session.completedBatches?.length !== session.batchCount) {
    sendJson(res, 409, { ok: false, error: '仍有批次未上传，不能启动导入' });
    return;
  }
  if (Date.now() - session.updatedAt >= UPLOAD_IDLE_TTL_MS) {
    sendJson(res, 410, { ok: false, error: '上传任务已过期，请重新上传' });
    return;
  }

  // ── 并发闸门（2026-10-13 用户反馈：重复点重试各起一个 job）──────────────
  // ★ 位置在「同一 uploadId 幂等复用 jobId」分支之后：复用是幂等读，不该被拦。
  // 覆盖常规导入与子集重试两条路径（CLI 来源的在跑任务也计入，避免排队后撞 import.lock 白失败）。
  // ⚠️ 未覆盖 `/api/import/upload` 的 finalize 分支——前端已不再走该路径（上传一律不带 finalize，
  //    导入改由「预检 → 确认 → run」显式启动）；若将来恢复该用法需同样调用本闸门。
  if (rejectIfImportBusy(res, requestConfig, scope)) return;

  const job = createJob(scope, 'import', requestConfig);
  // 本次**实际生效**的 group（显式值 > 子集重试的上次快照 > 空）；只算一处，
  // 既用于 run 入参，也写进 session 快照供 `/api/import/prune` 同源重算（设计 S02 N-2）。
  const effectiveGroup = requestedGroup || retryParams?.group || '';
  // REQ-20261019-002：写入参数快照，供后续 run 判断"是否可幂等复用"；
  // REQ-20261019-001：`pickMode` / `group` 供 prune 重算候选时对齐口径。
  session = {
    ...session,
    state: 'importing',
    jobId: job.id,
    params: { skipDuplicates: requestedSkipDuplicates, pickMode: requestedPickMode, group: effectiveGroup },
    updatedAt: Date.now(),
  };
  try { writeUploadSession(sourceDir, session); } catch (error) {
    job.taskReporter.finish('failed', { error: '上传任务状态登记失败' });
    jobs.delete(job.id);
    throw error;
  }
  void runImportJob(job, {
    scope,
    sourceDir,
    skipDuplicates: requestedSkipDuplicates,
    // group 缺省 → undefined → handleDirectImport 按推断落点（与 CLI 语义一致，REQ-01）；
    // 不再用 scope 兜底（子目录会落 <scope>/<sub>，与 CLI 缺省落 <sub> 不一致）
    group: effectiveGroup || undefined,
    chunkSize: body.chunkSize ?? retryParams?.chunkSize,
    chunkOverlap: body.chunkOverlap ?? retryParams?.chunkOverlap,
    vector: body.vector ?? retryParams?.vector,
    tags: body.tags ?? retryParams?.tags,
    conflictMode: body.conflictMode ?? (retryParams?.conflictMode as ImportConflictMode | undefined),
    conflictSuffix: body.conflictSuffix ?? retryParams?.conflictSuffix,
    // R2：「重试未完成 N 篇」只处理名单内文件（已完成文件不重传/不重算 embedding）
    ...(isSubsetRetry ? { onlyRelPaths: retryOnly } : {}),
    // REQ-20261019-001：清理候选（子集重试场景由 import.ts 的 precheck 再拦一次）
    pickMode: requestedPickMode,
    pruneStale: requestedPruneStale && !isSubsetRetry,
    preserveRels: requestedPreserveRels.length > 0 ? requestedPreserveRels : undefined,
    uploadIncomplete,
    // S0-3：Web 端不提供预算覆盖（预算来自 scope 配置/默认值）；
    // 超限时 IMPORT_BUDGET_EXCEEDED 经 job 终态 error 透出
    budget: undefined,
  }, requestConfig);

  sendJson(res, 202, { ok: true, jobId: job.id, scope });
}

// ─── POST /api/import/prune（REQ-20261019-001）──────────────────
/**
 * 删除「库中存在、本次目录已没有」的候选文档。
 *
 * 关键约束：
 *  - **服务端重算**：不信任前端清单。`uploadId` 优先（重扫同一暂存目录，与 run 完全同源），
 *    缺省回退到净化后的 `scannedRels`。两种来源都会重算 `pruneToken`，对不上即 409。
 *  - **`selected` 必填**：删除类接口不得用「缺省 = 全删」（fail-safe）。
 *  - **候选已空 → 200 allDone**：重复点击 / 上一次已删完不是错误。
 *  - `dryRun` 为查询语义：只重算并返回新清单与 token，不删除；闸门不通过也返回 200 + skipReason。
 *  - 删除复用 `executeBatchDelete`（自带 scope 写锁、草稿卫兵）；wiki 源文件按 `sourcePath`
 *    物理删除，**无回收站**。
 *
 * 与 run 必须同源的**三个输入**（任一不同源 → 候选集漂移 → token 恒失配，或误判「本地已删」）：
 *  1. `scannedRels`：run 用 scope 配置的 `import.extensions` 扫描，这里必须传同一白名单；
 *  2. `group`：取 run 时写入的 `session.params.group`（设计 S02 N-2），**不用前端表单实时值**
 *     —— 用户可能在导入后改过输入框，用表单值会让作用域漂移；
 *  3. `preserveRels`：上传失败的文件要并入有效集合。
 */
async function handleImportPrune(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
  requestConfig: KiConfig,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
  const scopeRaw = typeof body?.scope === 'string' ? body.scope : '';
  if (!scopeRaw) {
    sendJson(res, 400, { ok: false, code: 'PRUNE_MISSING_PARAM', error: '缺少 scope' });
    return;
  }
  // 越权判据与全站其余 handler 一致：`scopeAllowed` 含 `ALL_SCOPES` 通配
  //（全权 `--token` / `KI_MCP_TOKEN` 的授权集合就是 `['all']`）。直接 `includes(scope)`
  // 会把这类 Token 全判成越权 → 恒 403（code review Q1）。
  if (authScopes !== null && !scopeAllowed(authScopes, scopeRaw)) {
    rejectScopeViolation(res, scopeRaw, '/import/prune');
    return;
  }
  const scope = resolveScope(requestConfig, scopeRaw);
  const dryRun = body?.dryRun === true;
  // 只读门禁（REQ-20261029-001）：dryRun 是查询语义（只列候选、不删除）⇒ 放行；
  // 真正删除时拒绝（只读库不允许经 Web 删除文档）。
  if (!dryRun && rejectIfScopeReadonly(res, scope, 'http:/api/import/prune')) return;
  const token = typeof body?.token === 'string' ? body.token : '';
  const selectedRaw = body?.selected;
  if (!dryRun && !token) {
    sendJson(res, 400, { ok: false, code: 'PRUNE_MISSING_PARAM', error: '缺少 token' });
    return;
  }
  // `dryRun` 是查询语义，不需要勾选清单；真正删除时 `selected` 必填（fail-safe）
  if (!dryRun && !Array.isArray(selectedRaw)) {
    sendJson(res, 400, { ok: false, code: 'PRUNE_MISSING_PARAM', error: '缺少 selected（删除类接口不允许缺省为全部候选）' });
    return;
  }
  const selected: { group: string; relation: string }[] = [];
  const selectedSeen = new Set<string>();
  for (const item of Array.isArray(selectedRaw) ? selectedRaw : []) {
    const entry = item as { group?: unknown; relation?: unknown } | null;
    const group = typeof entry?.group === 'string' ? entry.group.trim() : '';
    const relation = typeof entry?.relation === 'string' ? entry.relation.trim() : '';
    if (!group || !relation) continue;
    const key = `${group}\u0000${relation}`;
    if (selectedSeen.has(key)) continue;
    selectedSeen.add(key);
    selected.push({ group, relation });
  }

  // ── 还原「本次目录有哪些文件」：uploadId 优先，其次净化后的 scannedRels ──
  const uploadId = typeof body?.uploadId === 'string' ? body.uploadId.trim() : '';
  let scannedRels: string[] = sanitizeOnlyRelPaths(body?.scannedRels);
  /** run 时写入的上传会话参数快照（`group` / `pickMode`）——与 body 同名字段并存时**以快照为准** */
  let sessionParams: UploadSession['params'];
  if (uploadId) {
    // 与 `/api/import/run` 同口径：UUID 先过格式校验，避免把任意子路径当 uploadId
    if (!UPLOAD_ID_RE.test(uploadId)) {
      sendJson(res, 400, { ok: false, code: 'PRUNE_MISSING_PARAM', error: '非法 uploadId' });
      return;
    }
    const dir = path.join(getUploadsRoot(), uploadId);
    const root = path.normalize(getUploadsRoot());
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory() || !path.normalize(dir).startsWith(root + path.sep)) {
      sendJson(res, 400, {
        ok: false,
        code: 'PRUNE_SOURCE_UNAVAILABLE',
        error: '上次导入的暂存目录已清理（或 uploadId 非法），请重新导入一次后重试',
      });
      return;
    }
    if (!bindUploadScope(dir, scope)) {
      sendJson(res, 400, { ok: false, error: 'uploadId 与当前 scope 不匹配' });
      return;
    }
    // 会话快照损坏（JSON 结构不对）不应让删除接口 500：降级为「无快照」，由 body 兜底
    try { sessionParams = readUploadSession(dir)?.params; } catch { sessionParams = undefined; }
    // ★ 与 run 同源：run 是 `collectMarkdownFiles(sourceDir, extensions)`，白名单来自
    //   `scopes.<scope>.import.extensions`。这里若用默认 `.md`，放宽过扩展名（如 `.mdx`）
    //   的 scope 会把**仍在本地**的那批文件全判成「已删除」（code review Q2）。
    const extensions = resolveImportExtensions(requestConfig, scope);
    scannedRels = collectMarkdownFiles(dir, extensions).files;
  }

  // group 口径（设计 S02 N-2）：优先 run 时的快照；仅快照缺失（升级前的旧会话 / 脚本调用）时回落 body。
  const bodyGroup = typeof body?.group === 'string' ? body.group.trim() : '';
  const group = typeof sessionParams?.group === 'string' ? sessionParams.group : bodyGroup;
  if (!isSafeGroupPath(group)) {
    sendJson(res, 400, { ok: false, code: 'PRUNE_MISSING_PARAM', error: '非法 group（不可为绝对路径或含 .. / 反斜杠）' });
    return;
  }

  if (scannedRels.length === 0) {
    sendJson(res, 400, {
      ok: false,
      code: 'PRUNE_SOURCE_UNAVAILABLE',
      error: '缺少本次扫描的文件集合（uploadId 已失效且未提供 scannedRels），请重新导入一次后重试',
    });
    return;
  }

  const importedGroups = [...new Set(scannedRels.map((rel) => resolveGroupForSource(group, rel, scope)))];
  // ★ 必须与 run 时同口径：run 用 preserveRels 把「上传失败的文件」并入有效集合，
  //   重算若漏掉它，候选集必然变大 → token 恒失配（code reviewed #1）。
  const preserveRels = sanitizeOnlyRelPaths(body?.preserveRels);

  try {
    const plan = planImportPrune({
      scope,
      group,
      scannedRels,
      preserveRels,
      importedGroups,
      precheck: { pruneStale: true, pickMode: 'dir', subsetRetry: false, uploadIncomplete: false, scannedCount: scannedRels.length },
    });

    if (dryRun) {
      sendJson(res, 200, { ok: true, scope, dryRun: true, plan });
      return;
    }
    if (plan.skipReason) {
      sendJson(res, 400, {
        ok: false,
        code: 'PRUNE_CHECK_DISABLED',
        error: plan.skipDetail ?? '清理条件不满足',
        skipReason: plan.skipReason,
        skipDetail: plan.skipDetail,
      });
      return;
    }
    if (plan.total === 0) {
      sendJson(res, 200, { ok: true, scope, allDone: true, requested: 0, selected: 0, deleted: 0, skipped: [], failed: [] });
      return;
    }
    if (plan.overLimit) {
      sendJson(res, 400, {
        ok: false,
        code: 'PRUNE_OVER_LIMIT',
        error: `候选 ${plan.total} 篇，超过单次上限：请用 CLI 清理，或先在本地恢复部分文件后重新导入`,
      });
      return;
    }
    if (!verifyPruneToken(plan, token)) {
      sendJson(res, 409, {
        ok: false,
        code: 'PRUNE_TOKEN_STALE',
        error: '库在这期间发生了变化，请刷新候选清单后重试',
      });
      return;
    }

    // 只删「重算后仍在候选集内」的项；其余归入 skipped（幂等，不报错）
    const candidateKeys = new Set(plan.items.map((item) => `${item.group}\u0000${item.relation}`));
    const toDelete: { group: string; relation: string }[] = [];
    const skipped: { group: string; relation: string; reason: string }[] = [];
    for (const item of selected) {
      if (candidateKeys.has(`${item.group}\u0000${item.relation}`)) toDelete.push(item);
      else skipped.push({ ...item, reason: 'not-in-candidates' });
    }
    if (toDelete.length === 0) {
      sendJson(res, 200, { ok: true, scope, requested: plan.total, selected: 0, deleted: 0, skipped, failed: [] });
      return;
    }

    const batch = await executeBatchDelete(scope, toDelete);
    const failed = batch.results
      .filter((item) => !item.deleted)
      .map((item) => ({ group: item.group, relation: item.relation, reason: item.reason ?? '删除失败' }));
    sendJson(res, 200, {
      ok: true,
      scope,
      requested: plan.total,
      selected: toDelete.length,
      deleted: batch.results.filter((item) => item.deleted).length,
      skipped,
      failed,
    });
  } catch (err) {
    sendJson(res, 500, { ok: false, code: 'PRUNE_FAILED', error: `清理失败：${(err as Error).message}` });
  }
}

// ─── POST /api/datasource/prune（设计 S-03）──────────────

/**
 * 数据源待删候选的删除接口（唯一写接口）。
 *
 * 安全边界：
 *  - 鉴权与 `/import/prune` 同款（`scopeAllowed` 含 `all` 通配）
 *  - 服务端按**当前源目录**重算候选，不信任前端清单；token 失配 409
 *  - `selected` 必填且 ≤500；只删「可见 items ∩ selected」
 *  - 强制 `wikiDelete:false`：只删知识库记录，不动源目录文件
 */
async function handleDatasourcePrune(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
  requestConfig: KiConfig,
): Promise<void> {
  const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
  const scopeRaw = typeof body?.scope === 'string' ? body.scope.trim() : '';
  if (!scopeRaw) {
    sendJson(res, 400, { ok: false, code: 'PRUNE_MISSING_PARAM', error: '缺少 scope' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, scopeRaw)) {
    rejectScopeViolation(res, scopeRaw, '/datasource/prune');
    return;
  }
  const dryRun = body?.dryRun === true;
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!dryRun && !token) {
    sendJson(res, 400, { ok: false, code: 'PRUNE_MISSING_PARAM', error: '缺少 token' });
    return;
  }
  const selectedRaw = Array.isArray(body?.selected) ? body.selected : [];
  const selected: { group: string; relation: string }[] = [];
  for (const item of selectedRaw) {
    const entry = item as { group?: unknown; relation?: unknown } | null;
    const group = typeof entry?.group === 'string' ? entry.group.trim() : '';
    const relation = typeof entry?.relation === 'string' ? entry.relation.trim() : '';
    if (group && relation) selected.push({ group, relation });
  }
  if (!dryRun && selected.length === 0) {
    sendJson(res, 400, {
      ok: false,
      code: 'PRUNE_EMPTY_SELECTION',
      error: 'selected 为空（删除类接口不允许缺省为全部候选）',
    });
    return;
  }

  let scope: string;
  try {
    scope = resolveScope(requestConfig, scopeRaw);
  } catch (err) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SCOPE', error: (err as Error).message });
    return;
  }

  const result = await executeDatasourcePrune({ scope, token, selected, dryRun, config: requestConfig });
  if (result.ok) {
    if (result.dryRun) {
      // allCandidateSourcePaths 只在超限时存在，是服务端持久化用的内部字段（可达数万条），
      // 不下发给页面
      const { allCandidateSourcePaths, ...planForClient } = result.plan;
      sendJson(res, 200, { ok: true, scope, dryRun: true, plan: planForClient });
    } else {
      sendJson(res, 200, {
        ok: true,
        scope,
        deleted: result.deleted,
        failed: result.failed,
        results: result.results,
        skipped: result.skipped,
        // candidateSourcePaths 是服务端重算基线（超限时可达数万条），不下发
        pendingDelete: toClientPending(result.pendingDelete),
      });
    }
    return;
  }
  const status = result.code === 'PRUNE_TOKEN_STALE' || result.code === 'PRUNE_BLOCKED'
    ? 409
    : result.code === 'PRUNE_FAILED' ? 500 : 400;
  sendJson(res, status, {
    ok: false,
    scope,
    code: result.code,
    error: result.error,
    ...(result.plan?.skipDetail ? { skipDetail: result.plan.skipDetail } : {}),
  });
}

// ─── GET /api/datasource/list | detail（设计 S-04）────────

const DATASOURCE_STALE_MS = 24 * 60 * 60 * 1000;

/** 正在跑 datasource-sync 的 scope → 运行态（台账不可读时降级为空 Map：不能因它让列表 500） */
function activeDatasourceSyncByScope(config: KiConfig): Map<string, DataSourceActiveSync> {
  try {
    return pickActiveDatasourceSync(listTaskRecords(config));
  } catch {
    return new Map();
  }
}

/**
 * 列表（跨 scope）。
 * ★ 鉴权两段式：带 `?scope=` 时走 `scopeAllowed`；**省略 scope 时必须在 handler 内按
 *   `authScopes` 过滤**——只读白名单只约束"以 default 身份能否调用"，不限制返回范围。
 */
function handleDatasourceList(
  res: http.ServerResponse,
  url: URL,
  requestConfig: KiConfig,
  authScopes: string[] | null,
): void {
  const scopeFilter = (url.searchParams.get('scope') ?? '').trim();
  if (scopeFilter && authScopes !== null && !scopeAllowed(authScopes, scopeFilter)) {
    rejectScopeViolation(res, scopeFilter, '/datasource/list');
    return;
  }
  const visible = (scope: string): boolean => authScopes === null || scopeAllowed(authScopes, scope);
  const inFilter = (scope: string): boolean => !scopeFilter || scope === scopeFilter;
  const scan = scanDataSources(requestConfig);
  const activeSync = activeDatasourceSyncByScope(requestConfig);
  const now = Date.now();

  const sources = scan.registered
    .filter(({ scope }) => visible(scope) && inFilter(scope))
    .map(({ scope, record }) => {
      const active = activeSync.get(scope) ?? null;
      return {
        scope,
        type: record.type,
        git: record.git
          ? {
            repoRoot: record.git.repoRoot,
            relativeRoot: record.git.relativeRoot,
            branch: record.git.branch,
            managed: record.git.managed,
            shortCommit: record.lastSync?.git?.shortCommit ?? null,
            commitTime: record.lastSync?.git?.authorTime ?? null,
            untrackedMarkdown: record.lastSync?.git?.untrackedMarkdown ?? 0,
          }
          : null,
        dir: record.dir,
        group: record.group,
        conflictMode: record.conflictMode,
        vector: record.vector,
        registeredAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastSync: record.lastSync
          ? {
            at: record.lastSync.at,
            durationMs: record.lastSync.durationMs,
            state: record.lastSync.state,
            files: record.lastSync.result.files,
            pendingDelete: {
              total: record.lastSync.pendingDelete.total,
              overLimit: record.lastSync.pendingDelete.overLimit,
              stale: record.lastSync.pendingDelete.stale,
              blocked: record.lastSync.pendingDelete.blocked,
            },
          }
          : null,
        // activeState 是状态的唯一精确口径；running 保留为派生值（activeState !== null）
        running: active !== null,
        activeState: active?.state ?? null,
        activeStartedAt: active?.startedAt ?? null,
        stale: record.lastSync ? now - record.lastSync.at > DATASOURCE_STALE_MS : true,
        schedule: toScheduleView(record.schedule, record.lastSync, now),
        syncAvailability: computeSyncAvailability({
          type: record.type,
          lastSync: record.lastSync,
          active: active !== null,
          now,
        }),
      };
    });

  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    ok: true,
    total: sources.length,
    // 能力声明：旧 daemon 不返回 ⇒ 页面隐藏「编辑」与只读开关（而不是让用户填完再报错）
    capabilities: { datasourceUpdate: true, scopeReadonly: true },
    schedulerDisabled: isDataSourceSchedulerDisabled(),
    sources,
    missing: scan.missing
      .filter(({ scope }) => visible(scope) && inFilter(scope))
      .map(({ scope, reason }) => {
        const read = readDataSource(scope);
        return {
          scope,
          reason,
          ...(read.ok ? { schedule: toScheduleView(read.record.schedule, read.record.lastSync, now) } : {}),
        };
      }),
    corrupt: scan.corrupt.filter(({ scope }) => visible(scope) && inFilter(scope)),
  });
}

/** 详情（单 scope）：完整 datasource.json + running；内部重算基线不下发 */
function handleDatasourceDetail(
  res: http.ServerResponse,
  url: URL,
  requestConfig: KiConfig,
  authScopes: string[] | null,
): void {
  const scopeRaw = (url.searchParams.get('scope') ?? '').trim();
  if (!scopeRaw) {
    sendJson(res, 400, { ok: false, code: 'PRUNE_MISSING_PARAM', error: '缺少 scope' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, scopeRaw)) {
    rejectScopeViolation(res, scopeRaw, '/datasource/detail');
    return;
  }
  let scope: string;
  try {
    scope = resolveScope(requestConfig, scopeRaw);
  } catch (err) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SCOPE', error: (err as Error).message });
    return;
  }
  const read = readDataSource(scope);
  if (!read.ok) {
    sendJson(res, read.code === 'NOT_FOUND' ? 404 : 400, {
      ok: false,
      code: read.code === 'NOT_FOUND' ? 'DATASOURCE_NOT_FOUND' : read.code,
      error: read.error,
    });
    return;
  }
  const active = activeDatasourceSyncByScope(requestConfig).get(scope) ?? null;
  const running = active !== null;
  let lastSync = read.record.lastSync;
  if (lastSync) {
    // 内部字段不下发：candidateSourcePaths（重算基线，可达数万条）与 seenRels（扫描清单，页面不消费）
    const { candidateSourcePaths: _base, ...pendingSafe } = lastSync.pendingDelete;
    const { seenRels: _seen, ...syncSafe } = lastSync;
    lastSync = { ...syncSafe, pendingDelete: pendingSafe } as unknown as typeof lastSync;
  }
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    ok: true,
    running,
    activeState: active?.state ?? null,
    activeStartedAt: active?.startedAt ?? null,
    syncAvailability: computeSyncAvailability({
      type: read.record.type,
      lastSync: read.record.lastSync,
      active: running,
    }),
    schedulerDisabled: isDataSourceSchedulerDisabled(),
    source: {
      ...read.record,
      lastSync,
      schedule: toScheduleView(read.record.schedule, read.record.lastSync),
    },
  });
}

// ─── POST /api/datasource/sync（S-03）────────────────────

/**
 * 页面同步闸门：单 daemon 进程内 per-scope Map。
 * 关闭「两个并发 POST 都读到无 active」的 check-then-create 竞态；
 * 任务 finish / submit 失败都必须释放。
 */
const pageSyncGates = new Map<string, string>();

/**
 * 同步任务执行体（页面 `POST /datasource/sync` 与 add-remote 首次同步共用）。
 * ★ 终态映射必须一致：ok→succeeded / partial→partial / cancelled→cancelled。
 */
async function runDatasourceSyncTask(
  task: TaskReporter,
  taskId: string,
  scope: string,
  full: boolean,
  config: KiConfig,
): Promise<void> {
  task.update({ state: 'running', startedAt: Date.now() });
  try {
    const result = await syncDataSource({
      scope,
      full,
      taskId,
      config,
      onProgress: (progress) => task.progress(progress),
      onPhase: (phase) => task.update({ phase }),
    });
    if (!result.ok) {
      task.finish('failed', { errorCode: result.code, error: result.error });
      return;
    }
    if (result.dryRun) {
      task.finish('failed', { errorCode: 'SYNC_UNEXPECTED_DRY_RUN', error: '页面同步不应返回 dry-run' });
      return;
    }
    const state = result.summary.state;
    task.finish(
      state === 'ok' ? 'succeeded' : state === 'partial' ? 'partial' : state === 'cancelled' ? 'cancelled' : 'failed',
      {
        result: toDatasourceSyncResultSnapshot(result),
        ...(state === 'partial'
          ? { error: '部分文件未完成', recoveryHint: '修复后重试同步；未完成文件会自动重试' }
          : {}),
      },
    );
    if (state === 'ok' || state === 'partial') await resetScheduleFailures(scope);
  } catch (err) {
    task.finish('failed', { errorCode: (err as { code?: string }).code ?? 'SYNC_FAILED', error: (err as Error).message });
  } finally {
    // 手动同步完成后 nextRunAt 以新的 lastSync.at 重算
    refreshDataSourceScheduler();
  }
}

// ─── POST /api/datasource/schedule（S-01）────────────────

async function handleDatasourceSchedule(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
  requestConfig: KiConfig,
): Promise<void> {
  let body: { scope?: unknown; schedule?: unknown } = {};
  try {
    body = await readJsonBody(req) as { scope?: unknown; schedule?: unknown };
  } catch {
    sendJson(res, 400, { ok: false, code: 'INVALID_JSON', error: '请求体不是合法 JSON' });
    return;
  }
  const scopeRaw = typeof body.scope === 'string' ? body.scope.trim() : '';
  if (!scopeRaw) {
    sendJson(res, 400, { ok: false, code: 'SCHEDULE_MISSING_SCOPE', error: '缺少 scope' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, scopeRaw)) {
    rejectScopeViolation(res, scopeRaw, '/datasource/schedule');
    return;
  }
  const result = await saveDataSourceSchedule({
    scope: scopeRaw,
    schedule: body.schedule,
    config: requestConfig,
  });
  if (!result.ok) {
    const status = result.code === 'INVALID_SCOPE'
      ? 400
      : result.code === 'NOT_FOUND' || result.code === 'NOT_REGISTERED'
        ? 404
        : result.code === 'SCHEDULE_STALE' || result.code === 'SCOPE_OPERATION_BUSY'
          ? 409
          : result.code === 'CORRUPT'
            ? 400
            : result.code.startsWith('SCHEDULE_') ? 400 : 500;
    sendJson(res, status, {
      ok: false,
      scope: result.scope,
      code: result.code === 'NOT_FOUND' ? 'DATASOURCE_NOT_FOUND' : result.code,
      error: result.error,
      ...(result.field ? { details: { field: result.field } } : {}),
      ...(result.current ? { current: result.current } : {}),
    });
    return;
  }
  refreshDataSourceScheduler();
  const now = Date.now();
  const view = toScheduleView(result.record.schedule, result.record.lastSync, now);
  sendJson(res, 200, {
    ok: true,
    scope: result.scope,
    schedule: view,
    nextRunAt: view.nextRunAt,
    warnings: result.warnings,
    schedulerDisabled: isDataSourceSchedulerDisabled(),
  });
}

async function handleDatasourceSync(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
  requestConfig: KiConfig,
): Promise<void> {
  let body: { scope?: unknown; full?: unknown } = {};
  try {
    body = await readJsonBody(req) as { scope?: unknown; full?: unknown };
  } catch {
    sendJson(res, 400, { ok: false, code: 'INVALID_JSON', error: '请求体不是合法 JSON' });
    return;
  }
  const scopeRaw = typeof body.scope === 'string' ? body.scope.trim() : '';
  if (!scopeRaw) {
    sendJson(res, 400, { ok: false, code: 'DATASOURCE_SYNC_MISSING_SCOPE', error: '缺少 scope' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, scopeRaw)) {
    rejectScopeViolation(res, scopeRaw, '/datasource/sync');
    return;
  }
  let scope: string;
  try {
    scope = resolveScope(requestConfig, scopeRaw);
  } catch (err) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SCOPE', error: (err as Error).message });
    return;
  }
  const read = readDataSource(scope);
  if (!read.ok) {
    sendJson(res, read.code === 'NOT_FOUND' ? 404 : 400, {
      ok: false,
      code: read.code === 'NOT_FOUND' ? 'DATASOURCE_NOT_FOUND' : read.code,
      error: read.error,
    });
    return;
  }
  const record = read.record;
  const full = body.full === true;

  // 严格读台账：读失败必须 503，不能放行重复同步
  let tasks: ReturnType<typeof listTaskRecords>;
  try {
    tasks = listTaskRecords(requestConfig);
  } catch (err) {
    sendJson(res, 503, { ok: false, code: 'TASK_REGISTRY_UNAVAILABLE', error: `任务台账不可读，同步未启动：${(err as Error).message}` });
    return;
  }
  const activeTask = tasks.find((task) => task.scope === scope
    && task.operation === 'datasource-sync'
    && (task.state === 'queued' || task.state === 'running'));
  if (activeTask) {
    sendJson(res, 409, {
      ok: false,
      code: 'SYNC_ALREADY_RUNNING',
      error: '该数据源已有同步任务在排队或执行中',
      taskId: activeTask.id,
    });
    return;
  }
  const availability = computeSyncAvailability({ type: record.type, lastSync: record.lastSync, active: false });
  if (!availability.allowed) {
    sendJson(res, 429, {
      ok: false,
      code: 'SYNC_RATE_LIMITED',
      error: `普通目录数据源 30 分钟内只能同步一次。如需立即同步，请执行：ki datasource sync --scope ${scope}`,
      nextAvailableAt: availability.nextAvailableAt,
      retryAfterSec: availability.retryAfterSec,
    });
    return;
  }
  const reachable = checkSourceReachable(record.dir);
  if (!reachable.ok) {
    sendJson(res, 409, { ok: false, code: 'SOURCE_UNREACHABLE', error: reachable.reason });
    return;
  }
  if (pageSyncGates.has(scope)) {
    sendJson(res, 409, {
      ok: false,
      code: 'SYNC_ALREADY_RUNNING',
      error: '该数据源已有同步任务在排队或执行中',
      taskId: pageSyncGates.get(scope),
    });
    return;
  }
  const taskId = crypto.randomUUID();
  pageSyncGates.set(scope, taskId);

  // 占位后复核一次：防止在闸门外刚好完成/启动了别的同步
  const recheck = readDataSource(scope);
  const latest = recheck.ok ? recheck.record : record;
  const latestAvailability = computeSyncAvailability({ type: latest.type, lastSync: latest.lastSync, active: false });
  if (!latestAvailability.allowed) {
    pageSyncGates.delete(scope);
    sendJson(res, 429, {
      ok: false,
      code: 'SYNC_RATE_LIMITED',
      error: `普通目录数据源 30 分钟内只能同步一次。如需立即同步，请执行：ki datasource sync --scope ${scope}`,
      nextAvailableAt: latestAvailability.nextAvailableAt,
      retryAfterSec: latestAvailability.retryAfterSec,
    });
    return;
  }

  let task: TaskReporter;
  try {
    task = createTaskReporter(requestConfig, { id: taskId, source: 'web', operation: 'datasource-sync', scope });
  } catch (err) {
    pageSyncGates.delete(scope);
    sendJson(res, 503, { ok: false, code: 'TASK_REGISTRY_UNAVAILABLE', error: `后台任务状态登记失败，任务未启动：${(err as Error).message}` });
    return;
  }
  task.update({ params: datasourceSyncParams(latest, full) });

  const mode = datasourceSyncMode(latest, full);

  void getSharedOperationCoordinator().submit(
    { operation: 'datasource-sync', params: { scope, full } },
    () => runWithConfigSnapshot(requestConfig, async () => {
      try {
        await runDatasourceSyncTask(task, taskId, scope, full, requestConfig);
      } finally {
        pageSyncGates.delete(scope);
      }
    }),
    scope,
  ).catch((err) => {
    pageSyncGates.delete(scope);
    try {
      task.finish('failed', { errorCode: 'SYNC_FAILED', error: (err as Error).message });
    } catch { /* 台账写失败时只能放弃 */ }
  });

  sendJson(res, 200, { ok: true, scope, taskId, mode, state: 'queued' });
}

// ─── POST /api/datasource/add-remote（S-05）────────────────────

/**
 * add-remote 闸门：与 pageSyncGates 同源，防两个 POST 都读到「无 active」后各起一个任务。
 * 权威判据仍在 scope 锁内（登记存在性）；这里只是快速失败。
 */
const datasourceAddGates = new Map<string, string>();

/**
 * 登记成功后自动入队首次同步（必然是 full：没有 commit 水位）。
 * ★ 不 await submit：当前 add 任务还占着队列槽，await 会自死锁；
 *   submit 排在 add 之后，add 释放槽位即开始执行。
 */
function enqueueFirstDatasourceSync(scope: string, record: DataSourceRecord, config: KiConfig): string {
  const syncTaskId = crypto.randomUUID();
  const syncTask = createTaskReporter(config, {
    id: syncTaskId,
    source: 'web',
    operation: 'datasource-sync',
    scope,
  });
  syncTask.update({ params: datasourceSyncParams(record, true) });
  void getSharedOperationCoordinator().submit(
    { operation: 'datasource-sync', params: { scope, full: true } },
    () => runWithConfigSnapshot(config, () => runDatasourceSyncTask(syncTask, syncTaskId, scope, true, config)),
    scope,
  ).catch((err) => {
    try {
      syncTask.finish('failed', { errorCode: 'SYNC_ENQUEUE_FAILED', error: (err as Error).message });
    } catch { /* 台账写失败时只能放弃 */ }
  });
  return syncTaskId;
}

async function handleDatasourceAddRemote(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
  requestConfig: KiConfig,
): Promise<void> {
  let body: {
    scope?: unknown; url?: unknown; branch?: unknown; subdir?: unknown; group?: unknown;
    vector?: unknown; conflictMode?: unknown; conflictSuffix?: unknown;
    /** 新建 scope 时同时设为只读（写 config.scopeReadonly；失败降级为任务警告） */
    readonly?: unknown;
  } = {};
  try {
    body = await readJsonBody(req) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, code: 'INVALID_JSON', error: '请求体不是合法 JSON' });
    return;
  }
  const scopeRaw = typeof body.scope === 'string' ? body.scope.trim() : '';
  if (!scopeRaw) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SCOPE', error: '缺少 scope' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, scopeRaw)) {
    rejectScopeViolation(res, scopeRaw, '/datasource/add-remote');
    return;
  }
  let scope: string;
  try {
    scope = resolveScope(requestConfig, scopeRaw);
  } catch (err) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SCOPE', error: (err as Error).message });
    return;
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  // file:// 默认拒绝（本地目录请走 --source）；`KI_DATASOURCE_ALLOW_FILE_URL=1` 仅供隔离测试
  const allowFileUrl = process.env.KI_DATASOURCE_ALLOW_FILE_URL === '1';
  const urlCheck = validateGitUrl(url, { allowFile: allowFileUrl });
  if (!urlCheck.ok) {
    sendJson(res, 400, { ok: false, code: urlCheck.code, error: urlCheck.error });
    return;
  }
  const subdir = typeof body.subdir === 'string' ? body.subdir.trim().replace(/^\/+|\/+$/g, '') : '';
  if (!isSafeRelativeSubdir(subdir)) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SUBDIR', error: `非法子目录：${String(body.subdir)}` });
    return;
  }
  const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
  if (branch) {
    const branchCheck = await validateBranchName(branch);
    if (!branchCheck.ok) {
      sendJson(res, 400, { ok: false, code: 'INVALID_BRANCH', error: branchCheck.error });
      return;
    }
  }
  const group = typeof body.group === 'string' ? body.group.trim() : '';
  if (group && !isSafeGroupPath(group)) {
    sendJson(res, 400, { ok: false, code: 'INVALID_GROUP', error: `非法 Group 路径：${group}` });
    return;
  }

  const read = readDataSource(scope);
  if (read.ok) {
    sendJson(res, 409, {
      ok: false,
      code: 'DATASOURCE_EXISTS',
      error: `scope「${scope}」已登记数据源；请先取消登记（ki datasource remove --scope ${scope}${read.record.git?.managed ? ' --purge' : ''}）`,
    });
    return;
  }
  if (read.code !== 'NOT_FOUND') {
    sendJson(res, 400, { ok: false, code: read.code, error: read.error });
    return;
  }

  // 已有同 remote+branch 的托管 clone 时，子目录可立即校验（不 clone、不建任务）
  const reusable = findReusableManagedClone(requestConfig, urlCheck.url, branch || null);
  if (reusable) {
    let invalid: { code: string; error: string; hint?: string } | null = null;
    try {
      await withManagedCloneLock(reusable.repoRoot, 'datasource-add-preflight', async () => {
        const checked = checkManagedSubdir(reusable.repoRoot, subdir, requestConfig, scope);
        if (!checked.ok) invalid = { code: checked.code, error: checked.error, ...(checked.hint ? { hint: checked.hint } : {}) };
      });
    } catch (err) {
      // 正在同步时不做前置判断，交给任务内的复用校验（会返回 CLONE_BUSY 或校验结果）
      if ((err as NodeJS.ErrnoException).code !== 'SCOPE_OPERATION_BUSY') throw err;
    }
    if (invalid) {
      const detail = invalid as { code: string; error: string; hint?: string };
      sendJson(res, 400, {
        ok: false,
        code: detail.code,
        error: `${detail.error}${detail.hint ? `；${detail.hint}` : ''}`,
      });
      return;
    }
  }

  let tasks: ReturnType<typeof listTaskRecords>;
  try {
    tasks = listTaskRecords(requestConfig);
  } catch (err) {
    sendJson(res, 503, { ok: false, code: 'TASK_REGISTRY_UNAVAILABLE', error: `任务台账不可读，添加未启动：${(err as Error).message}` });
    return;
  }
  const activeTask = tasks.find((task) => task.scope === scope
    && (task.operation === 'datasource-add-remote' || task.operation === 'datasource-sync')
    && (task.state === 'queued' || task.state === 'running'));
  if (activeTask) {
    sendJson(res, 409, {
      ok: false,
      code: 'SYNC_ALREADY_RUNNING',
      error: '该 scope 已有数据源添加/同步任务在排队或执行中',
      taskId: activeTask.id,
    });
    return;
  }
  if (datasourceAddGates.has(scope)) {
    sendJson(res, 409, {
      ok: false,
      code: 'SYNC_ALREADY_RUNNING',
      error: '该 scope 已有数据源添加/同步任务在排队或执行中',
      taskId: datasourceAddGates.get(scope),
    });
    return;
  }

  const taskId = crypto.randomUUID();
  datasourceAddGates.set(scope, taskId);
  let task: TaskReporter;
  try {
    task = createTaskReporter(requestConfig, { id: taskId, source: 'web', operation: 'datasource-add-remote', scope });
  } catch (err) {
    datasourceAddGates.delete(scope);
    sendJson(res, 503, { ok: false, code: 'TASK_REGISTRY_UNAVAILABLE', error: `后台任务状态登记失败，任务未启动：${(err as Error).message}` });
    return;
  }
  if (group) task.update({ params: { group } });

  void getSharedOperationCoordinator().submit(
    { operation: 'datasource-add-remote', params: { scope, url: urlCheck.url } },
    () => runWithConfigSnapshot(requestConfig, async () => {
      task.update({ state: 'running', startedAt: Date.now(), phase: 'clone' });
      try {
        const added = await addRemoteDataSource({
          scope,
          url: urlCheck.url,
          branch: branch || null,
          subdir: subdir || null,
          group: group || null,
          ...(body.vector === false ? { vector: false } : {}),
          ...(typeof body.conflictMode === 'string' && body.conflictMode.trim() ? { conflictMode: body.conflictMode.trim() } : {}),
          ...(typeof body.conflictSuffix === 'string' && body.conflictSuffix.trim() ? { conflictSuffix: body.conflictSuffix.trim() } : {}),
          allowFileUrl,
          config: requestConfig,
          onProgress: (progress) => task.progress({ phase: 'clone', done: progress.done, total: progress.total }),
        });
        if (!added.ok) {
          const recoveryHint = [added.hint, added.cleanupWarning].filter(Boolean).join('；');
          task.finish('failed', {
            errorCode: added.code,
            error: added.error,
            ...(recoveryHint ? { recoveryHint } : {}),
          });
          return;
        }
        task.update({ phase: 'queued-sync' });
        // 只读：登记**成功后**才写配置 —— 添加失败不留"只读空库"；写失败不回滚登记（只给显式警告）
        let readonlyWarning: string | undefined;
        if (body.readonly === true) {
          // 写配置**不得**把已成功的登记判失败（否则用户重试会撞 DATASOURCE_EXISTS）
          try {
            const applied = setScopeReadonlyInConfigFile(scope, true);
            if (!applied.ok) {
              readonlyWarning = `已登记，但只读未设置成功：${applied.error}；请执行 ki scope readonly ${scope}`;
            }
          } catch (err) {
            readonlyWarning = `已登记，但只读未设置成功：${(err as Error).message}；请执行 ki scope readonly ${scope}`;
          }
        }
        let syncTaskId: string | null = null;
        let syncWarning: string | undefined;
        try {
          syncTaskId = enqueueFirstDatasourceSync(scope, added.record, requestConfig);
        } catch (err) {
          syncWarning = `登记成功，但首次同步入队失败：${(err as Error).message}`;
        }
        task.finish('succeeded', {
          result: { syncTaskId, ...(readonlyWarning ? { readonlyWarning } : {}) },
          ...(syncWarning ? { errorCode: 'SYNC_ENQUEUE_FAILED', recoveryHint: `请执行 ki datasource sync --scope ${scope}` } : {}),
        });
      } catch (err) {
        task.finish('failed', { errorCode: (err as { code?: string }).code ?? 'ADD_REMOTE_FAILED', error: (err as Error).message });
      } finally {
        datasourceAddGates.delete(scope);
      }
    }),
    scope,
  ).catch((err) => {
    datasourceAddGates.delete(scope);
    try {
      task.finish('failed', { errorCode: 'ADD_REMOTE_FAILED', error: (err as Error).message });
    } catch { /* 台账写失败时只能放弃 */ }
  });

  sendJson(res, 200, { ok: true, scope, taskId, state: 'queued' });
}

// ─── POST /api/datasource/update（2026-10-30 需求：编辑同步参数）───────

/**
 * 编辑数据源同步参数（仅配置，不触发任务）。
 * - 运行中同步 → 409（改一半会被任务覆盖；scope 写锁也会兜底拒绝）
 * - `baseRevision` 不符 → 409 DATASOURCE_STALE（多标签页）
 * - 身份字段（scope / 源目录 / Git URL / 分支 / 子目录 / 落点 Group）不可改
 */
async function handleDatasourceUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
  requestConfig: KiConfig,
): Promise<void> {
  let body: { scope?: unknown; baseRevision?: unknown; patch?: unknown } = {};
  try {
    body = await readJsonBody(req) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, code: 'INVALID_JSON', error: '请求体不是合法 JSON' });
    return;
  }
  const scopeRaw = typeof body.scope === 'string' ? body.scope.trim() : '';
  if (!scopeRaw) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SCOPE', error: '缺少 scope' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, scopeRaw)) {
    rejectScopeViolation(res, scopeRaw, '/datasource/update');
    return;
  }
  let scope: string;
  try {
    scope = resolveScope(requestConfig, scopeRaw);
  } catch (err) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SCOPE', error: (err as Error).message });
    return;
  }
  if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
    sendJson(res, 400, { ok: false, code: 'INVALID_PATCH', error: '缺少 patch（要修改的字段）' });
    return;
  }
  const active = activeDatasourceSyncByScope(requestConfig).get(scope) ?? null;
  if (active) {
    sendJson(res, 409, {
      ok: false,
      code: 'SYNC_IN_PROGRESS',
      error: '该知识库正在同步，完成后再修改同步参数',
    });
    return;
  }
  const baseRevision = typeof body.baseRevision === 'number' && Number.isFinite(body.baseRevision)
    ? body.baseRevision
    : undefined;
  const result = await updateDataSourceConfig({
    scope,
    baseRevision,
    patch: body.patch as DataSourceConfigPatch,
    config: requestConfig,
  });
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND'
      ? 404
      : result.code === 'DATASOURCE_STALE' || result.code === 'SCOPE_OPERATION_BUSY'
        ? 409
        : 400;
    sendJson(res, status, {
      ok: false,
      code: result.code,
      error: result.error,
      ...(result.field ? { field: result.field } : {}),
      ...(result.current ? { current: result.current } : {}),
    });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, {
    ok: true,
    scope,
    record: result.record,
    changed: result.changed,
    schedulerDisabled: isDataSourceSchedulerDisabled(),
  });
}

// ─── POST /api/datasource/remove（2026-10-29 用户需求）─────────────

/**
 * 取消数据源登记（等价 CLI `ki datasource remove`）：**只删 datasource.json，不删库内文档**。
 *
 * 安全边界：
 *  - 鉴权同 sync（`scopeAllowed`，含 `all` 通配）
 *  - 同步 / 添加任务排队或执行中 → 409（此时删登记会让任务写到一半的 `lastSync` 落空）
 *  - `purge` 只清**托管 clone** 目录，且带引用计数：其他 scope 仍在复用时保留并回报原因
 *  - 登记已不存在 → 404 `DATASOURCE_NOT_FOUND`（不是 500）；`removed:false` 只出现在
 *    "读到之后、unlink 之前被并发删掉"的竞态里，按成功处理
 *  - 不可解析登记（CORRUPT/INVALID）默认 400；带 `force:true` 才移除——坏文件无法解析，
 *    这是页面唯一的清理出口（CLI `remove` 同样拒绝解析）
 */
async function handleDatasourceRemove(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
  requestConfig: KiConfig,
): Promise<void> {
  let body: { scope?: unknown; purge?: unknown } = {};
  try {
    body = await readJsonBody(req) as typeof body;
  } catch {
    sendJson(res, 400, { ok: false, code: 'INVALID_JSON', error: '请求体不是合法 JSON' });
    return;
  }
  const scopeRaw = typeof body.scope === 'string' ? body.scope.trim() : '';
  if (!scopeRaw) {
    sendJson(res, 400, { ok: false, code: 'DATASOURCE_REMOVE_MISSING_SCOPE', error: '缺少 scope' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, scopeRaw)) {
    rejectScopeViolation(res, scopeRaw, '/datasource/remove');
    return;
  }
  let scope: string;
  try {
    scope = resolveScope(requestConfig, scopeRaw);
  } catch (err) {
    sendJson(res, 400, { ok: false, code: 'INVALID_SCOPE', error: (err as Error).message });
    return;
  }
  const read = readDataSource(scope);
  if (!read.ok) {
    // 不可解析的登记（CORRUPT = JSON 坏 / INVALID = 字段非法）是页面唯一能清理的出口
    // （CLI remove 同样拒绝解析坏登记）：必须 `force:true` 显式表态。removeDataSource
    // 只 unlink 不解析，故坏文件也能移除；其余错误码照常拒绝。
    const forced = (read.code === 'CORRUPT' || read.code === 'INVALID') && body.force === true;
    if (!forced) {
      sendJson(res, read.code === 'NOT_FOUND' ? 404 : 400, {
        ok: false,
        scope,
        code: read.code === 'NOT_FOUND' ? 'DATASOURCE_NOT_FOUND' : read.code,
        error: read.code === 'NOT_FOUND' ? `scope「${scope}」没有数据源登记` : read.error,
      });
      return;
    }
  }
  // 严格读台账：读失败必须 503，不能靠"看起来没任务"就删登记
  let tasks: ReturnType<typeof listTaskRecords>;
  try {
    tasks = listTaskRecords(requestConfig);
  } catch (err) {
    sendJson(res, 503, { ok: false, code: 'TASK_REGISTRY_UNAVAILABLE', error: `任务台账不可读，移除未执行：${(err as Error).message}` });
    return;
  }
  const activeTask = tasks.find((task) => task.scope === scope
    && (task.operation === 'datasource-sync' || task.operation === 'datasource-add-remote')
    && (task.state === 'queued' || task.state === 'running'));
  if (activeTask || pageSyncGates.has(scope) || datasourceAddGates.has(scope)) {
    sendJson(res, 409, {
      ok: false,
      scope,
      code: 'DATASOURCE_BUSY',
      error: '该数据源正在同步或添加，任务结束后再移除',
      taskId: activeTask?.id ?? pageSyncGates.get(scope) ?? datasourceAddGates.get(scope),
    });
    return;
  }

  const purge = body.purge === true;
  const result = await removeDataSource(scope, requestConfig);
  if (!result.ok) {
    const status = result.code === 'SCOPE_OPERATION_BUSY'
      ? 409
      : result.code === 'REMOVE_FAILED' ? 500 : 400;
    sendJson(res, status, { ok: false, scope, code: result.code, error: result.error });
    return;
  }

  const payload: Record<string, unknown> = { ok: true, scope, removed: result.removed };
  // 托管 clone 只在 purge 且确属托管源时清理；引用计数 >0 一律保留（可能被其他 scope 复用）
  if (purge && result.managedCloneDir) {
    const managedDir = result.managedCloneDir;
    const repoRoot = path.join(managedDir, 'repo');
    payload.managedCloneDir = managedDir;
    try {
      const locked = await withManagedCloneLock(repoRoot, 'datasource-purge', async () => {
        const refs = countManagedRepoRefs(repoRoot, requestConfig, scope);
        if (refs > 0) return { refs, purge: null };
        return { refs, purge: await purgeManagedCloneDir(managedDir) };
      });
      if (locked.refs > 0) {
        payload.cloneRemoved = false;
        payload.cloneRemoveSkipped = true;
        payload.cloneRemoveReason = `其他 ${locked.refs} 个 scope 仍在使用该 clone，已保留 ${managedDir}`;
      } else if (locked.purge && locked.purge.removed) {
        payload.cloneRemoved = true;
      } else {
        payload.cloneRemoved = false;
        const reason = locked.purge && 'error' in locked.purge ? locked.purge.error : '未能清理托管目录';
        if (reason) payload.cloneRemoveError = reason;
      }
    } catch (err) {
      payload.cloneRemoved = false;
      payload.cloneRemoveError = (err as Error).message;
    }
  }
  sendJson(res, 200, payload);
}

// ─── 「重试未完成」的并发闸门（2026-10-13 用户反馈）─────────────//
// 现象：连点两次重试各起一个 job（第一次 running、第二次 queued）——重复处理同一批未完成文件。
// 根因是"能否重试"只看清单，而重试 job 结束前清单不会变（`taskId` 仍是旧任务）。
// 判据与任务中心列表同源（任务台账）；★ `unknown`（心跳过期）刻意**不计入**——它可能是死任务，
// 计入会让用户在 1h TTL 内彻底无法重试。

/**
 * 同 scope 正在跑的导入任务（`queued` / `running`）。
 * 入口共用：`/import/run`（子集重试与常规导入，统一在 `createJob` 之前判）与
 * `/import/retry-incomplete`（判据不得漂移）。
 * ★ 台账不可读时**抛错**（由 `rejectIfImportBusy` 转 503），不静默放行——否则闸门形同虚设。
 */
function activeImportTasks(config: KiConfig, scope: string): ReturnType<typeof listTaskRecords> {
  return listTaskRecords(config).filter((task) => task.scope === scope
    && task.operation === 'import'
    && (task.state === 'queued' || task.state === 'running'));
}

/** 409：已有导入在跑（入口共用错误码与文案，前端按 `code` 判定） */
function sendImportBusy(res: http.ServerResponse, active: ReturnType<typeof listTaskRecords>): void {
  sendJson(res, 409, {
    ok: false,
    code: 'INCOMPLETE_IMPORT_RUNNING',
    error: `该知识库已有导入任务在跑（${active.length} 个排队 / 进行中）：请等它完成后再继续`,
    activeTaskIds: active.map((task) => task.id),
  });
}

/**
 * 导入入口的统一并发闸门：**true = 已响应**（调用方直接 return）。
 * - 台账不可读 → 503 `TASK_REGISTRY_UNAVAILABLE`（与 `/api/tasks` 的 fail-loud 口径一致；
 *   静默放行会让闸门形同虚设，而这里防的正是"重复处理上千篇文件"）；
 * - 已有导入在跑 → 409（见 `sendImportBusy`）。
 */
function rejectIfImportBusy(res: http.ServerResponse, config: KiConfig, scope: string): boolean {
  let active: ReturnType<typeof listTaskRecords>;
  try {
    active = activeImportTasks(config, scope);
  } catch (error) {
    sendJson(res, 503, {
      ok: false,
      code: 'TASK_REGISTRY_UNAVAILABLE',
      error: `任务状态暂不可读，无法确认是否已有导入在跑：${(error as Error).message}`,
    });
    return true;
  }
  if (active.length === 0) return false;
  sendImportBusy(res, active);
  return true;
}

// ─── GET /api/import/incomplete（2026-10-13）─────────────

/**
 * 未完成清单摘要 —— 任务中心「重试未完成 N 篇」入口的**只读判据**。
 *
 * 为什么要它：重试此前只挂在导入页当前会话（浏览器凭据 uploadId + 内存 job 结果），
 * 任务中心对失败 / 取消 / 中断任务没有任何出路。本接口把服务端的 scope 级清单
 * （`.ki-import-incomplete.json`，跨进程 / 跨会话存活）暴露成前端可判定的状态。
 *
 * ★ 只读：不打开引擎、不写任何文件（调用方走 `read` 通道）。
 * ★ 不回显绝对路径：只给 `sourceKind` / `sourceExists` / 计数（沿用路径脱敏惯例）。
 */
function handleImportIncomplete(res: http.ServerResponse, scope: string): void {
  sendJson(res, 200, { ok: true, scope, ...summarizeImportIncomplete(scope, { uploadsRoot: getUploadsRoot() }) });
}

// ─── POST /api/import/retry-incomplete（2026-10-13）─────

/**
 * 按 scope 清单重试未完成文件（任务中心「重试未完成 N 篇」）。
 *
 * 与 `/api/import/run` 的差别：**前端无需提供 uploadId** —— 源目录由服务端按清单解析：
 *   - `upload` 来源（Web 上传暂存目录）：反解 uploadId 并校验与 scope 的绑定；
 *   - `external` 来源（CLI `--source` 的目录）：存在性校验后直接起 job，与 CLI
 *     `--retry-incomplete` 同语义。
 * 参数一律回落清单记录的原批次口径（切分 / 向量化 / 标签 / 冲突策略），
 * 不做前端表单默认值改写。
 *
 * ★ 归属校验：清单记录了写入它的任务 ID；请求带 `taskId` 且不一致 ⇒ 清单已被后续
 *   导入覆盖，**409 fail-loud**（不得静默重试错对象）。旧清单（无该字段）放行，
 *   响应 `legacy: true` 提示归属未知。
 * ★ 并发：复用 `runImportJob`（coordinator 串行 + `handleDirectImport` 内的 scope 写锁），
 *   不在此另造并发控制。
 */
async function handleImportRetryIncomplete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
  requestConfig: KiConfig,
): Promise<void> {
  const body = (await readJsonBody(req)) as { scope?: string; taskId?: string } | undefined;
  if (!body?.scope) {
    sendJson(res, 400, { ok: false, error: '缺少 scope' });
    return;
  }
  // scope 越权校验（body.scope 必填，与 /import/run 同口径）
  if (authScopes !== null && !scopeAllowed(authScopes, body.scope)) {
    rejectScopeViolation(res, body.scope, '/import/retry-incomplete');
    return;
  }
  const scope = resolveScope(requestConfig, body.scope);
  // 只读门禁（REQ-20261029-001）：重试 = 继续一次写入。
  // 注意调用方不止上传导入页——后台任务页也提供重试，故 S04 在任务页同步置灰并给出 CLI 出路。
  if (rejectIfScopeReadonly(res, scope, 'http:/api/import/retry-incomplete')) return;
  const requestedTaskId = typeof body.taskId === 'string' && body.taskId.trim() ? body.taskId.trim() : undefined;

  const status = readImportIncompleteStatus(scope);
  if (status.corrupted) {
    sendJson(res, 400, {
      ok: false,
      code: 'INCOMPLETE_LIST_CORRUPTED',
      error: '未完成清单损坏（.ki-import-incomplete.json 无法解析）：请删除该文件后重新导入',
    });
    return;
  }
  const record = status.record;
  if (!record) {
    sendJson(res, 400, {
      ok: false,
      code: 'INCOMPLETE_LIST_MISSING',
      error: '没有待重试的未完成清单（可能已全部导入完成）：请重新导入整批',
    });
    return;
  }
  if (record.items.length === 0) {
    sendJson(res, 400, { ok: false, code: 'INCOMPLETE_LIST_EMPTY', error: '未完成清单为空，无需重试' });
    return;
  }
  if (record.taskId && requestedTaskId && record.taskId !== requestedTaskId) {
    sendJson(res, 409, {
      ok: false,
      code: 'INCOMPLETE_TASK_MISMATCH',
      error: '这份未完成清单已被后续导入覆盖（不属于该任务）：请到最新的导入任务重试，或重新导入整批',
      currentTaskId: record.taskId,
    });
    return;
  }
  const legacy = record.taskId === undefined;

  const sourceDir = path.resolve(record.sourceDir);
  const uploadId = uploadIdFromSourceDir(sourceDir, getUploadsRoot());
  if (!fs.existsSync(sourceDir)) {
    sendJson(res, 400, {
      ok: false,
      code: 'INCOMPLETE_SOURCE_MISSING',
      error: uploadId !== null
        ? '上次导入的暂存目录已不存在（可能已被清理）：请重新上传后导入'
        : '上次导入的源目录已不存在：请用当前源目录重新导入',
    });
    return;
  }
  // upload 来源：目录名必须是合法 uploadId，且与当前 scope 绑定一致（与 /import/run 同口径）
  if (uploadId !== null) {
    if (!UPLOAD_ID_RE.test(uploadId)) {
      sendJson(res, 400, { ok: false, code: 'INCOMPLETE_SOURCE_INVALID', error: '暂存目录名不是合法 uploadId，无法重试' });
      return;
    }
    if (!bindUploadScope(sourceDir, scope)) {
      sendJson(res, 400, { ok: false, error: '未完成清单的源目录与当前 scope 不匹配' });
      return;
    }
    // 批次完整性检查：与 /api/import/run 同口径（2026-10-13 评审 P2）——半上传目录不得起重试。
    // ★ 刻意**不**复制 `UPLOAD_IDLE_TTL_MS` 门禁：任务中心的事后重试正是要跨会话可用
    //  （清单本身是"还有哪些没导完"的权威来源），TTL 只用于约束"尚未开始导入的暂存目录"。
    let session: UploadSession | null = null;
    try {
      session = readUploadSession(sourceDir);
    } catch {
      sendJson(res, 400, { ok: false, code: 'INCOMPLETE_SOURCE_INVALID', error: '上传任务元数据损坏：请重新上传后导入' });
      return;
    }
    if (session?.batchCount !== undefined && (session.completedBatches?.length ?? 0) !== session.batchCount) {
      sendJson(res, 409, { ok: false, error: '仍有批次未上传，不能启动导入' });
      return;
    }
  }

  // ── 并发闸门（与 /import/run 共用同一实现、错误码与文案）──
  if (rejectIfImportBusy(res, requestConfig, scope)) return;

  // 条数上限与 /api/import/run 共用同一常量（两入口判据不得漂移）
  if (record.items.length > MAX_ONLY_REL_PATHS) {
    sendJson(res, 400, {
      ok: false,
      code: 'INCOMPLETE_LIST_TOO_LARGE',
      error: `未完成清单条数超限（${record.items.length} > ${MAX_ONLY_REL_PATHS}）：请重新导入整批`,
    });
    return;
  }

  const onlyRelPaths = record.items.map((item) => item.path).filter((item): item is string => Boolean(item));
  if (onlyRelPaths.length === 0) {
    sendJson(res, 400, { ok: false, code: 'INCOMPLETE_LIST_EMPTY', error: '未完成清单没有可用的文件路径' });
    return;
  }

  // REQ-20261019-004：血缘——本任务重试自哪个任务（清单归属，可能为 undefined 的 legacy 场景）
  const job = createJob(scope, 'import', requestConfig, { retryOf: requestedTaskId });
  void runImportJob(job, {
    scope,
    sourceDir,
    // 参数回落清单（上次导入的实际口径），与 CLI --retry-incomplete 同语义
    group: record.params.group,
    chunkSize: record.params.chunkSize,
    chunkOverlap: record.params.chunkOverlap,
    vector: record.params.vector,
    tags: record.params.tags,
    conflictMode: record.params.conflictMode as ImportConflictMode | undefined,
    conflictSuffix: record.params.conflictSuffix,
    onlyRelPaths,
    budget: undefined,
  }, requestConfig);

  sendJson(res, 202, {
    ok: true,
    jobId: job.id,
    scope,
    itemCount: onlyRelPaths.length,
    sourceKind: uploadId !== null ? 'upload' : 'external',
    ...(legacy ? { legacy: true } : {}),
  });
}

interface RunImportArgs {
  scope: string;
  sourceDir: string;
  group?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  vector?: boolean;
  tags?: string;
  conflictMode?: ImportConflictMode;
  conflictSuffix?: string;
  /** R2：只重试未完成子集（相对源目录路径） */
  onlyRelPaths?: string[];
  /** REQ-20261019-002：跳过疑似重复（真实判定在 `handleDirectImport` 内） */
  skipDuplicates?: boolean;
  /** REQ-20261019-001：本次选择方式（'dir' 才会计算清理候选） */
  pickMode?: 'dir' | 'files' | 'mixed';
  /** REQ-20261019-001：计算清理候选开关 */
  pruneStale?: boolean;
  /** REQ-20261019-001：上传失败的文件 rel（视为「本次有」） */
  preserveRels?: string[];
  /** REQ-20261019-001：上传不完整且无失败清单 —— 硬门槛 */
  uploadIncomplete?: boolean;
  /** S0-3：Web 端预算覆盖入口（当前不暴露给前端，预留保持 CLI/Web 同构） */
  budget?: HandleDirectImportArgs['budget'];
}

async function runImportJob(job: Job, args: RunImportArgs, requestConfig: KiConfig): Promise<void> {
  // REQ-20261019-004（challenger 意见 2）：参数快照必须在**进入队列之前**写入——
  // 否则「排队中」的任务点开详情参数全为空，而那正是用户想确认策略的时刻。
  // `state/startedAt` 仍留在出队后（排队 ≠ 开始执行）。
  job.taskReporter.update({ params: toParamSnapshot('import', args, getUploadsRoot()) });
  try {
    const result = await getSharedOperationCoordinator().submit(
      { operation: 'import', params: { ...args, jobId: job.id } },
      () => runWithConfigSnapshot(requestConfig, async () => {
        job.taskReporter.update({ state: 'running', startedAt: Date.now() });
        try { await refreshVectorDimensionSnapshot(requestConfig, args.scope); } catch { /* 诊断失败不阻断导入 */ }
        try {
          return await handleDirectImport({
        scope: args.scope,
        sourceDir: args.sourceDir,
        group: args.group,
        chunkSize: args.chunkSize,
        chunkOverlap: args.chunkOverlap,
        vector: args.vector,
        tags: args.tags,
        conflictMode: args.conflictMode,
        conflictSuffix: args.conflictSuffix,
        onlyRelPaths: args.onlyRelPaths,
        // REQ-20261019-002：跳过疑似重复（缺省 undefined = 不计算跳过集，行为与改前一致）
        skipDuplicates: args.skipDuplicates,
        // REQ-20261019-001：清理候选（缺省 undefined = 不计算，ImportResult 无 prune 字段）
        pickMode: args.pickMode,
        pruneStale: args.pruneStale,
        preserveRels: args.preserveRels,
        uploadIncomplete: args.uploadIncomplete,
        budget: args.budget,
        // 任务归属：写进未完成清单，供任务中心按任务校验重试归属（HTTP 路径）
        jobId: job.id,
        onProgress: (progress) => {
          job.phase = progress.phase;
          job.progress = { done: progress.done, total: progress.total };
          job.taskReporter.progress({
            phase: progress.phase,
            done: progress.done,
            total: progress.total,
            persisted: progress.persisted,
            metadataPending: progress.metadataPending,
            failed: progress.failed,
            cancelled: progress.cancelled,
          });
        },
        abortSignal: job.abortController.signal,
          });
        } finally {
          try { await refreshVectorDimensionSnapshot(requestConfig, args.scope); } catch { /* keep the operation result authoritative */ }
        }
      }),
      args.scope,
      // S-01（REQ-20261009-003）：**不传 kind** —— 由 coordinator 的 `kindForOperation`
      // 按 operation 名推导为 `engine-only`（与 daemon 入口同源、单一真相）。
      // 本入口此前漏标，导致 Web 端导入期间 `/doc/list` 仍与导入串行（现场 25s 超时）。
    ).then((outcome) => outcome.result as ImportResult);
    job.state = 'done';
    job.result = result;
    job.phase = 'persist';
    // R1（REQ-20261009-001，Q2 同口径）：部分成功 → 任务态 partial（与 CLI 同源），
    // 但 `job.state` 保持 'done'（前端按 state 分支渲染完成态；不新增状态值以守契约）。
    // 未完成清单随 result.incomplete 下发，供前端展示与"重试未完成"使用。
    const partialState = result.partial || result.stats.errors > 0 ? 'partial' : 'succeeded';
    // ── S-02/S-03（REQ-20261009-003）：两级完成口径 ──
    // ①「可用」**此刻**成立：`usable=true` + 台账立刻写终态值 + phase 进入 `indexing`；
    // ② 索引整理已在 `handleDirectImport` 内**异步入队**，job **保持存活**至整理落定
    //    （`finishedAt` 在 finally 里赋值 ⇒ 反映"整件事"的结束时刻）；
    // ③ `state` 仍在"导入结果可用"那一刻置 'done' —— **不改既有契约**，前端只要在
    //    `indexState === 'indexing'` 时继续轮询即可，无需理解新的状态值。
    const maint = result.indexMaintenance;
    job.usable = true;
    job.indexMaintenance = maint;
    /**
     * ★ 未入队整理 ≠ 整理失败（2026-10-19）：`scheduled=false` 有三种正常原因——关闭向量、
     *   本批全部「内容未变」、全部重复被跳过。它们都只表示**没有产生需要整理的写入**，
     *   与「入队了但失败/超时」完全是两回事。此前把后者也置 `available`，前端据此渲染
     *   「索引整理未完成（可重试）」，让用户以为需要执行 `ki index-optimize`——
     *   而实际上什么都没有写，根本没有要整理的东西。
     *   `available` 从此只留给 1984 行的失败/降级分支。
     */
    job.indexState = maint?.scheduled ? 'indexing' : 'skipped';
    job.taskReporter.update({ state: partialState, phase: job.indexState });
    if (maint?.scheduled) {
      await whenIndexMaintenanceIdle(getIndexMaintenanceState().config.timeoutMs);
      const st = getIndexMaintenanceState();
      // 只认**本 scope** 的结果：`last` 可能属于并发整理的其他 scope（全局串行，非错误）
      const settled = st.last?.scope === args.scope ? st.last : undefined;
      if (settled?.ok === true) {
        job.indexState = 'optimized';
        job.taskReporter.update({ phase: 'optimized' });
      } else {
        // 失败/超时/未知一律降级为「可用」——**不判失败、不丢数据、不引导重建**（护栏 3）
        job.indexState = 'available';
        if (settled) {
          job.indexMaintenanceDegraded = { degraded: settled.degraded, reason: settled.reason };
        } else {
          /**
           * 等待窗口结束时 `last` 属于**其他 scope**（全局单飞队列里排在别的 scope 后面，
           * 或本 scope 的整理还没落定）⇒ 我们**不知道**结果，不是"失败"。
           * 此前这里不写 degraded，前端 fallback 成 'error'，把未知渲染成"整理未完成（error）"
           * 并引导用户执行 `ki index-optimize`——可能根本不需要重跑。
           */
          job.indexMaintenanceUnknown = true;
        }
        job.taskReporter.update({
          phase: 'available',
          ...(settled
            ? { recoveryHint: `索引整理未完成（${settled.degraded ?? 'error'}）；文档已可用，可执行 ki index-optimize -s ${args.scope} 重试` }
            : {}),
        });
      }
      // S-03 / A11：交叉判据（索引实体 ∨ 引擎信号）——整理落定后核对"索引是否真的建了"；
      // R6：同时写入任务台账（任务中心/详情可直接核对，不必开引擎诊断）
      job.indexReadiness = await readIndexReadiness(args.scope);
      job.taskReporter.update({ indexReadiness: job.indexReadiness });
    }
    const partialFiles = result.stats?.files;
    job.taskReporter.finish(partialState, {
      error: result.partial
        ? `完成 ${partialFiles?.completed ?? '?'} / 未完成 ${partialFiles?.incomplete ?? '?'} 个文件`
        : result.stats.errors > 0 ? result.errors[0]?.error ?? `${result.stats.errors} 项导入处理有错误` : undefined,
      recoveryHint: result.partial ? '未完成文件可在修复 embedding 后重试导入；已完成部分已可用。' : undefined,
      partialCommitted: result.stats.vectorized,
      // REQ-20261019-004：文件级结果摘要（任务中心回看口径）
      result: toResultSnapshot('import', result),
    });
  } catch (err) {
    const failure = err as Error & { code?: string; stats?: { partialCommitted?: number } };
    const code = failure.code;
    // REQ-20261019-002：错码独立下发，前端按码分流（不得靠文案匹配）
    job.errorCode = code;
    job.state = code === 'IMPORT_CANCELLED' ? 'cancelled' : 'failed';
    job.error = failure.message;
    const allDuplicates = code === 'ALL_FILES_DUPLICATES';
    job.taskReporter.finish(job.state === 'cancelled' ? 'cancelled' : 'failed', {
      // 全部重复不是系统故障：台账用引导性文案，并明确"未写入"
      error: allDuplicates
        ? '本批全部为疑似重复，未写入任何文件；如需建副本请改用「仍然导入」'
        : job.error,
      recoveryHint: allDuplicates
        ? '重新点击导入并选择「仍然导入」即可建副本；跳过本身不产生任何写入。'
        : code === 'VECTORIZATION_STOPPED'
          ? '检查 embedding 配置、鉴权与服务状态；确认后重试导入。'
          : undefined,
      partialCommitted: failure.stats?.partialCommitted,
      // REQ-20261019-004（challenger 意见 1）：失败/取消路径**通常没有** `stats.files`
      // （取消错误只有 message、全部重复只有 code、VECTORIZATION_STOPPED 是 chunk 级统计），
      // 故只落可判别错误码；文件级 N/M 由 error 文案承载，不虚构数字。
      errorCode: code,
      result: toResultSnapshot('import', failure),
    });
  } finally {
    job.finishedAt = Date.now();
    try {
      const session = readUploadSession(args.sourceDir);
      if (session?.jobId === job.id) {
        writeUploadSession(args.sourceDir, {
          ...session,
          state: job.state === 'done' ? 'done' : 'failed',
          updatedAt: Date.now(),
        });
      }
    } catch { /* job 的最终结果仍保留在内存 Map，元数据下次再处理 */ }
  }
}

// ─── POST /api/import/cancel ──────────────────────────

async function handleImportCancel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
): Promise<void> {
  const body = (await readJsonBody(req)) as { jobId?: string } | undefined;
  const jobId = body?.jobId?.trim() ?? '';
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) {
    sendJson(res, 404, { ok: false, error: 'job not found（服务可能已重启，请重新导入）' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, job.scope)) {
    rejectScopeViolation(res, job.scope, '/import/cancel');
    return;
  }
  if (job.state !== 'running') {
    sendJson(res, 409, { ok: false, error: `任务已结束：${job.state}`, jobId, state: job.state });
    return;
  }
  job.cancelRequested = true;
  job.abortController.abort();
  sendJson(res, 202, { ok: true, jobId, state: 'cancelling', message: '已请求取消；当前 embedding/zvec 批次完成后停止后续写入' });
}

// ─── GET /api/import/status ───────────────────────────

async function handleImportStatus(res: http.ServerResponse, url: URL, authScopes: string[] | null): Promise<void> {
  const jobId = url.searchParams.get('jobId') ?? '';
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) {
    sendJson(res, 404, { ok: false, error: 'job not found（服务可能已重启，请重新导入）' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, job.scope)) {
    rejectScopeViolation(res, job.scope, '/import/status');
    return;
  }
  sendJson(res, 200, {
    ok: true,
    job: {
      id: job.id,
      scope: job.scope,
      state: job.state,
      phase: job.phase,
      progress: job.progress,
      cancelRequested: job.cancelRequested,
      result: job.result,
      error: job.error,
      // REQ-20261019-002：错码必须显式透传（本 handler 手工挑字段），否则前端拿不到
      errorCode: job.errorCode,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      // ── S-02/S-03（REQ-20261009-003）：两级完成口径（纯新增字段，既有字段语义不变）──
      // 前端：`usable === true` 即渲染「已完成 · 可用」；`indexState === 'indexing'` 期间显示
      //「索引整理中…」并**继续轮询**；转为 `optimized` 显示「已优化」，`available` 显示重试引导。
      usable: job.usable,
      indexState: job.indexState,
      indexMaintenance: job.indexMaintenance,
      ...(job.indexMaintenanceDegraded ? { indexMaintenanceDegraded: job.indexMaintenanceDegraded } : {}),
      // 结果未落定（未知 ≠ 失败）：显式下发，前端据此不显示 "error" 与重跑引导
      ...(job.indexMaintenanceUnknown ? { indexMaintenanceUnknown: true } : {}),
      ...(job.indexReadiness ? { indexReadiness: job.indexReadiness } : {}),
    },
  });
}

// ─── restore/rebuild job ──────────────────────────────

interface RestoreJobArgs {
  scope: string;
  timestamp?: string;
  backupDir?: string;
  snapshotFile?: string;
  rebuildVector: boolean;
  rebuildOptions?: RebuildVectorOptions;
  yes: boolean;
  rebuildOnly: boolean;
}

async function handleRestoreRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
  requestConfig: KiConfig,
): Promise<void> {
  const body = await readJsonBody(req) as {
    scope?: string;
    timestamp?: string;
    backupDir?: string;
    snapshotFile?: string;
    rebuildVector?: boolean;
    rebuildOnly?: boolean;
    yes?: boolean;
  } | undefined;
  if (!body?.scope) {
    sendJson(res, 400, { ok: false, error: '缺少 scope' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, body.scope)) {
    rejectScopeViolation(res, body.scope, '/restore/run');
    return;
  }
  const scope = resolveScope(requestConfig, body.scope);
  const rebuildOnly = body.rebuildOnly === true;
  const rebuildVector = rebuildOnly || body.rebuildVector === true;
  const job = createJob(scope, rebuildOnly ? 'rebuild-vector' : 'restore-snapshot', requestConfig);
  const args: RestoreJobArgs = {
    scope,
    timestamp: body.timestamp,
    backupDir: body.backupDir ? path.resolve(body.backupDir) : undefined,
    snapshotFile: body.snapshotFile ? path.resolve(body.snapshotFile) : undefined,
    rebuildVector,
    rebuildOnly,
    yes: body.yes === true,
    rebuildOptions: { yes: body.yes === true },
  };
  void runRestoreJob(job, args, requestConfig);
  sendJson(res, 202, {
    ok: true,
    jobId: job.id,
    scope,
    operation: job.operation,
    message: '任务已提交；取消仅在当前 restore/rebuild 批次完成后生效',
  });
}

async function runRestoreJob(job: Job, args: RestoreJobArgs, requestConfig: KiConfig): Promise<void> {
  try {
    const result = await getSharedOperationCoordinator().submit(
      { operation: args.rebuildOnly ? 'rebuild-vector' : 'restore-snapshot', params: { ...args, jobId: job.id } },
      async () => runWithConfigSnapshot(requestConfig, async () => withScopeWriteLock(args.scope, 'restore-snapshot', async () => {
        job.taskReporter.update({ state: 'running', startedAt: Date.now() });
        if (args.rebuildVector) {
          try { await refreshVectorDimensionSnapshot(requestConfig, args.scope); } catch { /* diagnostic is advisory */ }
        }
        // 复合操作必须在覆盖 KB 前拒绝未确认的跨维度迁移。
        if (!args.rebuildOnly && args.rebuildVector && !args.yes) {
          const persisted = await vectorCollectionDimension(args.scope);
          if (persisted !== undefined && persisted !== requestConfig.embedding.dimension) {
            return { ok: false, error: `Collection 维度 ${persisted} 与配置 ${requestConfig.embedding.dimension} 不一致；跨维度还原需显式 yes: true，旧 KB 尚未覆盖` };
          }
        }
        let restored: RestoreSnapshotResult | undefined;
        if (!args.rebuildOnly) {
          job.phase = 'restore';
          job.progress = { done: 0, total: 1 };
          restored = await restoreSnapshotLocal(args.scope, {
            timestamp: args.timestamp,
            backupDir: args.backupDir,
            snapshotFile: args.snapshotFile,
            abortSignal: job.abortController.signal,
            onProgress: (progress) => {
              job.phase = progress.phase;
              job.progress = { done: progress.done, total: progress.total };
              job.taskReporter.progress({ phase: progress.phase, done: progress.done, total: progress.total });
            },
          });
          if (job.abortController.signal.aborted) {
            return { restore: restored, rebuildSkipped: true, cancelled: true };
          }
        }
        if (!args.rebuildVector) return restored;
        job.phase = 'rebuild';
        job.progress = { done: 0, total: 1 };
        const rebuilt = await rebuildScopeVectors(
          args.scope,
          { countScope: vectorCountScope },
          {
            ...(args.rebuildOptions ?? {}),
            abortSignal: job.abortController.signal,
            onProgress: (progress) => {
              job.phase = progress.phase;
              job.progress = { done: progress.done, total: progress.total };
              job.taskReporter.progress({ phase: progress.phase, done: progress.done, total: progress.total });
            },
          },
        );
        return restored ? { restore: restored, rebuildVector: rebuilt } : rebuilt;
      })),
      args.scope,
    );
    const value = result.result as any;
    job.result = value;
    const cancelled = value?.cancelled === true
      || value?.errors?.some((e: any) => e.type === 'cancelled');
    const failed = value?.ok === false
      || value?.rebuildVector?.ok === false;
    job.state = cancelled ? 'cancelled' : failed ? 'failed' : 'done';
    if (failed && !job.error) {
      job.error = value?.error
        ?? value?.errors?.[0]?.error
        ?? value?.rebuildVector?.errors?.[0]?.error
        ?? 'restore/rebuild 失败';
    }
    const partialCommitted = value?.partialCommitted ?? value?.rebuildVector?.partialCommitted
      ?? (!failed ? value?.stats?.succeeded ?? value?.rebuildVector?.stats?.succeeded : undefined);
    const hasPartial = !failed && (
      (value?.errors?.length ?? 0) > 0 || (value?.rebuildVector?.errors?.length ?? 0) > 0
    );
    // ── S-02 同口径（REQ-20261009-003）：**重建收尾的索引整理**（两级口径）──
    // 入队由 `rebuildScopeVectors` 完成（daemon 即引擎持有者，整理在服务端跑）；
    // 本 job **保持存活**至整理落定，与导入 job 完全同口径：
    // 「文档可用」早已成立（`usable`），`indexState` 表达整理阶段；失败/超时只降级、不判失败。
    const rebuiltResult = (value?.rebuildVector ?? value) as
      | { indexMaintenance?: { scheduled: boolean; merged: boolean } }
      | undefined;
    const maint = rebuiltResult?.indexMaintenance;
    job.usable = true;
    job.indexMaintenance = maint;
    if (maint?.scheduled && !cancelled && !failed) {
      const terminalState = hasPartial ? 'partial' : 'succeeded';
      job.indexState = 'indexing';
      job.taskReporter.update({ state: terminalState, phase: 'indexing' });
      await whenIndexMaintenanceIdle(getIndexMaintenanceState().config.timeoutMs);
      // ★ 先按 scope 过滤再判断（2026-10-19 自查）：`last` 可能属于并发整理的其他 scope，
      //   此时旧写法 `if (settled)` 会写入一个空的 degraded 对象，前端 `?? 'error'` 又把它
      //   渲染成「整理未完成（error）」——与导入路径同一类"未知说成失败"。
      const settled = getIndexMaintenanceState().last;
      const mine = settled?.scope === args.scope ? settled : undefined;
      if (mine?.ok) {
        job.indexState = 'optimized';
        job.taskReporter.update({ phase: 'optimized' });
      } else {
        job.indexState = 'available';
        if (mine) job.indexMaintenanceDegraded = { degraded: mine.degraded, reason: mine.reason };
        else job.indexMaintenanceUnknown = true;
        job.taskReporter.update({
          phase: 'available',
          ...(settled
            ? { recoveryHint: `索引整理未完成（${settled.degraded ?? 'error'}）；文档已可用，可执行 ki index-optimize -s ${args.scope} 重试` }
            : {}),
        });
      }
      job.indexReadiness = await readIndexReadiness(args.scope);
      job.taskReporter.update({ indexReadiness: job.indexReadiness });
    }
    job.taskReporter.finish(cancelled ? 'cancelled' : failed ? 'failed' : hasPartial ? 'partial' : 'succeeded', {
      error: failed ? job.error : hasPartial ? job.error ?? '部分条目处理失败' : undefined,
      recoveryHint: failed ? '检查任务详情中的失败阶段与恢复建议，修复问题后重新执行。' : undefined,
      partialCommitted,
    });
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    job.state = code === 'RESTORE_CANCELLED' || code === 'REBUILD_CANCELLED' ? 'cancelled' : 'failed';
    job.error = (err as Error).message;
    job.taskReporter.finish(job.state === 'cancelled' ? 'cancelled' : 'failed', {
      error: job.error,
      recoveryHint: code === 'VECTORIZATION_STOPPED' ? '检查 embedding 配置、鉴权与服务状态；确认后重试。' : undefined,
      partialCommitted: (err as Error & { stats?: { partialCommitted?: number } }).stats?.partialCommitted,
    });
  } finally {
    if (args.rebuildVector) {
      try { await refreshVectorDimensionSnapshot(requestConfig, args.scope); } catch { /* task result remains authoritative */ }
    }
    job.finishedAt = Date.now();
  }
}

async function handleJobCancel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
): Promise<void> {
  const body = await readJsonBody(req) as { jobId?: string } | undefined;
  const jobId = body?.jobId?.trim() ?? '';
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) {
    sendJson(res, 404, { ok: false, error: 'job not found（服务可能已重启，请重新提交）' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, job.scope)) {
    rejectScopeViolation(res, job.scope, '/restore/cancel');
    return;
  }
  if (job.state !== 'running') {
    sendJson(res, 409, { ok: false, error: `任务已结束：${job.state}`, jobId, state: job.state });
    return;
  }
  job.cancelRequested = true;
  job.abortController.abort();
  sendJson(res, 202, {
    ok: true,
    jobId,
    state: 'cancelling',
    message: '已请求取消；当前 restore/rebuild 批次完成后停止后续写入',
  });
}

async function handleJobStatus(res: http.ServerResponse, url: URL, authScopes: string[] | null): Promise<void> {
  const jobId = url.searchParams.get('jobId') ?? '';
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) {
    sendJson(res, 404, { ok: false, error: 'job not found（服务可能已重启，请重新提交）' });
    return;
  }
  if (authScopes !== null && !scopeAllowed(authScopes, job.scope)) {
    rejectScopeViolation(res, job.scope, '/restore/status');
    return;
  }
  sendJson(res, 200, {
    ok: true,
    job: {
      id: job.id,
      scope: job.scope,
      operation: job.operation,
      state: job.state,
      phase: job.phase,
      progress: job.progress,
      cancelRequested: job.cancelRequested,
      result: job.result,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      // ── S-02/S-03（REQ-20261009-003）：两级完成口径（与 `/api/import/status` 同口径）──
      // 重建（`--rebuild-vector` / rebuildOnly）收尾同样会做索引整理：`usable` 立刻成立，
      // `indexState` 走 indexing → optimized | available，`indexReadiness` 为 A11 交叉判据。
      usable: job.usable,
      indexState: job.indexState,
      indexMaintenance: job.indexMaintenance,
      ...(job.indexMaintenanceDegraded ? { indexMaintenanceDegraded: job.indexMaintenanceDegraded } : {}),
      ...(job.indexMaintenanceUnknown ? { indexMaintenanceUnknown: true } : {}),
      ...(job.indexReadiness ? { indexReadiness: job.indexReadiness } : {}),
    },
  });
}
