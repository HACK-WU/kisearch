/**
 * mcp-http-api.ts —— 方案 A：扩展 mcp-http 的 /api/* 路由
 *
 * 为可视化前端补齐 MCP 缺失能力（REQ-20260806-003，S-02/S-03）：
 *   GET  /api/health                ki doctor 健康报告（runHealthCheck）
 *   GET  /api/search-config          语义检索默认 timeout（仅非敏感配置）
 *   GET  /api/doc/list              Group 路径 + 文档列表（支持 q 文件名模糊搜索）
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
import { getScopeImportConfig, loadConfig, resolveScope, runWithConfigSnapshot, type KiConfig } from './config.js';
import { isLoopbackAddr } from './net-addr.js';
import { findTokenScopes, ALL_SCOPES } from './mcp-token.js';
import { runHealthCheck, healthCheckWorstCaseMs } from './health-check.js';
import { getRelationsCachePath, getAssetsDir, getKbDir } from './scope.js';
import {
  ASSET_EXTENSIONS,
  DEFAULT_EXTENSIONS,
  DEFAULT_MAX_ASSET_SIZE,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  handleDirectImport,
  type HandleDirectImportArgs,
  type ImportResult,
} from './import.js';
import { preflightImportDuplicates, DEFAULT_PREFLIGHT_MAX_DETAIL } from './import-preflight.js';
// S-02/S-03：两级完成口径 —— 整理等待/状态 + A11 就绪判据
import {
  whenIndexMaintenanceIdle,
  getIndexMaintenanceState,
  readIndexReadiness,
  type IndexReadiness,
} from './index-maintenance.js';
import type { ImportConflictMode } from './import-conflict.js';
import { readImportIncompleteStatus } from './import-retry.js';
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
import { DocumentEditError, readDocumentForEdit, saveDocumentEdit } from './document-editor.js';
import { createTaskReporter, getTaskRecord, listTaskRecords, TASK_TTL_MS, type TaskReporter } from './task-registry.js';
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

interface UploadSession {
  scope: string;
  updatedAt: number;
  state: 'uploading' | 'importing' | 'done' | 'failed';
  batchCount?: number;
  completedBatches?: number[];
  jobId?: string;
  errors?: { name: string; error: string }[];
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
  indexReadiness?: IndexReadiness;
}

const jobs = new Map<string, Job>();
const MAX_JOBS = 50;
const JOB_TTL_MS = 60 * 60 * 1000; // 1h

function createJob(scope: string, operation: Job['operation'], config: KiConfig): Job {
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
    taskReporter = createTaskReporter(config, { id, source: 'web', operation, scope });
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
  docs: { name: string; group: string; path?: string; tags?: string[]; vectorized: boolean; fullTextIndexed: boolean }[];
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
    && (p === '/tags' || p === '/doc/list' || p === '/doc/edit' || p === '/asset' || p === '/import/config' || p === '/vector/status')) {
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
      // 附件复制与 scope delete 可能同时操作 assets 目录；读请求也要经过
      // 同一 scope 队列，避免读到半写文件或已删除目录。
      const scopeRaw = url.searchParams.get('scope') ?? '';
      const effectiveScope = resolveScope(requestConfig, scopeRaw);
      await getSharedOperationCoordinator().submit(
        { operation: 'asset-read-api', params: { scope: effectiveScope } },
        () => runWithConfigSnapshot(requestConfig, () => handleAsset(res, url)),
        [effectiveScope],
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
    extensions: importConfig?.extensions ?? DEFAULT_EXTENSIONS,
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
  sendJson(res, 200, { ok: true, tasks, total: tasks.length, retainedForMs: TASK_TTL_MS });
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

// ─── GET /api/doc/list ────────────────────────────────

async function handleDocList(res: http.ServerResponse, url: URL): Promise<void> {
  const scopeRaw = url.searchParams.get('scope') ?? '';
  const scope = resolveScope(loadConfig(), scopeRaw);
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
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
  const matchQuery = (d: { name: string; path?: string }): boolean =>
    !q || d.name.toLowerCase().includes(q) || (d.path ?? '').toLowerCase().includes(q);

  // 指定 group 时按 [offset, offset+limit) 分页返回该 group 文档（S0-2 修复：
  // 旧行为 slice 后以截断长度冒充 total 且恒 truncated:false，单 Group >500 篇静默丢失）
  if (groupRaw) {
    const groupMatched = all
      .filter((d) => d.group === groupRaw && matchQuery(d) && matchTag(d));
    const docs = groupMatched.slice(offset, offset + limit);
    sendJson(res, 200, {
      ok: true,
      scope,
      docs,
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
    docs,
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
  if (!body || !Array.isArray(body.files) || body.files.length === 0) {
    sendJson(res, 400, { ok: false, error: '缺少 files 数组（{ scope, files: [{ name, content }] }）' });
    return;
  }
  const requestConfig = loadConfig();
  const scope = resolveScope(requestConfig, body.scope);
  const importConfig = getScopeImportConfig(requestConfig, scope);
  const allowedExtensions = importConfig?.extensions ?? DEFAULT_EXTENSIONS;
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
  // scope 越权校验（body.scope 必填）
  if (authScopes !== null && !scopeAllowed(authScopes, body.scope)) {
    rejectScopeViolation(res, body.scope, '/import/run');
    return;
  }
  const scope = resolveScope(requestConfig, body.scope);
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
  const MAX_ONLY_REL_PATHS = 50000;
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
  if (session.jobId && !isSubsetRetry) {
    if (!jobs.has(session.jobId)) {
      sendJson(res, 409, { ok: false, error: '导入任务状态已失效，请重新上传' });
      return;
    }
    sendJson(res, 202, { ok: true, jobId: session.jobId, scope });
    return;
  }
  if (session.batchCount !== undefined && session.completedBatches?.length !== session.batchCount) {
    sendJson(res, 409, { ok: false, error: '仍有批次未上传，不能启动导入' });
    return;
  }
  if (Date.now() - session.updatedAt >= UPLOAD_IDLE_TTL_MS) {
    sendJson(res, 410, { ok: false, error: '上传任务已过期，请重新上传' });
    return;
  }

  const job = createJob(scope, 'import', requestConfig);
  session = { ...session, state: 'importing', jobId: job.id, updatedAt: Date.now() };
  try { writeUploadSession(sourceDir, session); } catch (error) {
    job.taskReporter.finish('failed', { error: '上传任务状态登记失败' });
    jobs.delete(job.id);
    throw error;
  }
  void runImportJob(job, {
    scope,
    sourceDir,
    // group 缺省 → undefined → handleDirectImport 按推断落点（与 CLI 语义一致，REQ-01）；
    // 不再用 scope 兜底（子目录会落 <scope>/<sub>，与 CLI 缺省落 <sub> 不一致）
    group: body.group?.trim() || retryParams?.group || undefined,
    chunkSize: body.chunkSize ?? retryParams?.chunkSize,
    chunkOverlap: body.chunkOverlap ?? retryParams?.chunkOverlap,
    vector: body.vector ?? retryParams?.vector,
    tags: body.tags ?? retryParams?.tags,
    conflictMode: body.conflictMode ?? (retryParams?.conflictMode as ImportConflictMode | undefined),
    conflictSuffix: body.conflictSuffix ?? retryParams?.conflictSuffix,
    // R2：「重试未完成 N 篇」只处理名单内文件（已完成文件不重传/不重算 embedding）
    ...(isSubsetRetry ? { onlyRelPaths: retryOnly } : {}),
    // S0-3：Web 端不提供预算覆盖（预算来自 scope 配置/默认值）；
    // 超限时 IMPORT_BUDGET_EXCEEDED 经 job 终态 error 透出
    budget: undefined,
  }, requestConfig);

  sendJson(res, 202, { ok: true, jobId: job.id, scope });
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
  /** S0-3：Web 端预算覆盖入口（当前不暴露给前端，预留保持 CLI/Web 同构） */
  budget?: HandleDirectImportArgs['budget'];
}

async function runImportJob(job: Job, args: RunImportArgs, requestConfig: KiConfig): Promise<void> {
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
        budget: args.budget,
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
    job.indexState = maint?.scheduled ? 'indexing' : (args.vector === false ? 'skipped' : 'available');
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
        if (settled) job.indexMaintenanceDegraded = { degraded: settled.degraded, reason: settled.reason };
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
    });
  } catch (err) {
    job.state = (err as Error & { code?: string }).code === 'IMPORT_CANCELLED' ? 'cancelled' : 'failed';
    job.error = (err as Error).message;
    const details = err as Error & { code?: string; stats?: { partialCommitted?: number } };
    job.taskReporter.finish(job.state === 'cancelled' ? 'cancelled' : 'failed', {
      error: job.error,
      recoveryHint: details.code === 'VECTORIZATION_STOPPED'
        ? '检查 embedding 配置、鉴权与服务状态；确认后重试导入。'
        : undefined,
      partialCommitted: details.stats?.partialCommitted,
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
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      // ── S-02/S-03（REQ-20261009-003）：两级完成口径（纯新增字段，既有字段语义不变）──
      // 前端：`usable === true` 即渲染「已完成 · 可用」；`indexState === 'indexing'` 期间显示
      //「索引整理中…」并**继续轮询**；转为 `optimized` 显示「已优化」，`available` 显示重试引导。
      usable: job.usable,
      indexState: job.indexState,
      indexMaintenance: job.indexMaintenance,
      ...(job.indexMaintenanceDegraded ? { indexMaintenanceDegraded: job.indexMaintenanceDegraded } : {}),
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
    },
  });
}
