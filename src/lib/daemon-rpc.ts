import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadConfig, runWithConfigSnapshot } from './config.js';
import { configFingerprint, ensureVectorLayout, VECTOR_LAYOUT_VERSION, assertDaemonIdentityCurrent, isDaemonIdentityDrifted } from './scope-collection.js';
import { getDaemonSocketPath, DAEMON_PROTOCOL_VERSION } from './daemon-protocol.js';
import { getSharedOperationCoordinator, scopesOf, scopeOf, type OperationRequest, type OperationCoordinator } from './operation-coordinator.js';
import { dispatchOperation, supportedOperations } from './daemon-dispatch.js';
import { getVectorizationMetrics } from './vector-client.js';
import { readKiVersion } from './version-guard.js';

export interface DaemonRpcOptions {
  onShutdown?: () => void;
}

interface RpcRequest {
  id?: string | number;
  method: 'ping' | 'execute' | 'queue' | 'cancel' | 'status';
  operation?: string;
  params?: unknown;
  jobId?: string;
  streamProgress?: boolean;
}

function send(socket: net.Socket, payload: unknown): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(`${JSON.stringify(payload)}\n`);
}

interface DaemonJob {
  id: string;
  owner: string;
  operation: string;
  scope: string;
  state: 'queued' | 'running' | 'draining' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
  cancelRequested: boolean;
  abortController: AbortController;
  eventSeq: number;
  progress?: {
    jobId: string;
    operation: string;
    scope: string;
    phase?: string;
    done: number;
    total: number;
    persisted?: number;
    metadataPending?: number;
    failed?: number;
    cancelled?: number;
    inFlight?: number;
    bufferedBytes?: number;
  };
  result?: unknown;
  error?: { code?: string; message: string };
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  subscribers: Set<net.Socket>;
  emitProgress?: (progress: { phase: string; done: number; total: number; persisted?: number; metadataPending?: number; failed?: number; cancelled?: number }) => void;
}

const daemonJobs = new Map<string, DaemonJob>();
const pendingCancels = new Map<string, { owner: string; expiresAt: number }>();
const JOB_TTL_MS = 60 * 60 * 1000;
const PENDING_CANCEL_TTL_MS = 30_000;
const PENDING_CANCEL_LIMIT = 1_000;

function requestOwner(): string {
  return `uid:${process.getuid?.() ?? 'unknown'}`;
}

function cleanupJobs(): void {
  const now = Date.now();
  for (const [id, job] of daemonJobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) daemonJobs.delete(id);
  }
  for (const [id, tombstone] of pendingCancels) {
    if (tombstone.expiresAt <= now) pendingCancels.delete(id);
  }
}

function jobSummary(job: DaemonJob): Record<string, unknown> {
  return {
    jobId: job.id,
    operation: job.operation,
    scope: job.scope,
    state: job.state,
    cancelRequested: job.cancelRequested,
    eventSeq: job.eventSeq,
    progress: job.progress,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function classifyJobState(result: unknown, cancelled: boolean, failed: boolean): DaemonJob['state'] {
  if (cancelled) return 'cancelled';
  if (failed) return 'failed';
  const value = result as {
    partial?: boolean;
    errors?: unknown[];
    stats?: { errors?: number; failed?: number };
    rebuildVector?: {
      partial?: boolean;
      ok?: boolean;
      errors?: unknown[];
      stats?: { errors?: number; failed?: number };
    };
  } | undefined;
  const hasErrors = (value?.errors?.length ?? 0) > 0
    || (value?.stats?.errors ?? 0) > 0
    || (value?.stats?.failed ?? 0) > 0
    || (value?.rebuildVector?.errors?.length ?? 0) > 0
    || (value?.rebuildVector?.stats?.errors ?? 0) > 0
    || (value?.rebuildVector?.stats?.failed ?? 0) > 0;
  if (value?.partial || value?.rebuildVector?.partial || hasErrors) return 'partial';
  return 'succeeded';
}

function safeLogValue(value: unknown, max = 500): string {
  return String(value ?? '-').replace(/[\r\n]/g, ' ').slice(0, max);
}

/** daemon 侧非操作类事件日志（连接异常、服务器级错误）；与 logOperationFailure 同前缀便于过滤。 */
function logDaemon(message: string): void {
  process.stderr.write(`[kisearch-daemon] ${safeLogValue(message)}\n`);
}

function recoveryHint(code?: string): string {
  switch (code) {
    case 'COLLECTION_LOCKED':
    case 'LOCKED':
      return '确认仅由当前 daemon 持有 Collection；不要绕过 daemon 直接运行向量写入。';
    case 'DAEMON_OPERATION_UNSUPPORTED':
      return '检查 CLI 与 daemon 版本是否一致，必要时重启 ki mcp --http --daemon。';
    case 'DAEMON_IDENTITY_DRIFT':
      // 不重复 assertDaemonIdentityCurrent 已给出的重启命令（客户端会把 message 与
      // hint 拼接）；只补充诊断入口与一个易错点。
      return '可用 GET /healthz 的 identityDrift 确认；kill -HUP 只刷新授权类配置，不能代替重启。';
    case 'CORRUPTED':
      return '检查最近备份，并按 scope 执行 ki restore <scope> --from-snapshot --yes。';
    case 'IMPORT_CANCELLED':
      return '任务已在当前批次完成后停止，可用原 uploadId 重新导入。';
    case 'RESTORE_CANCELLED':
    case 'REBUILD_CANCELLED':
      return '任务已在当前 restore/rebuild 批次完成后停止；请查询对应 job 状态确认已写入阶段，必要时重新提交。';
    default:
      return '检查 daemon stderr 与 healthz 队列状态，确认配置指纹一致后重试。';
  }
}

function logOperationFailure(req: RpcRequest | undefined, error: { code?: string; message?: string }, hint: string): void {
  const params = req?.params as { jobId?: unknown } | undefined;
  const operation = req?.operation ?? '-';
  const scope = req ? scopeOf(req.params, req.operation) : '-';
  const requestId = req?.id ?? '-';
  const jobId = typeof params?.jobId === 'string' && params.jobId.trim() ? params.jobId : requestId;
  process.stderr.write(
    `[kisearch-daemon] operation=${safeLogValue(operation)} scope=${safeLogValue(scope)} `
    + `jobId=${safeLogValue(jobId)} code=${safeLogValue(error.code ?? 'DAEMON_OPERATION_FAILED')} `
    + `reason=${safeLogValue(error.message)} hint=${safeLogValue(hint)}\n`,
  );
}

/**
 * 单条 RPC 请求的体积上限。
 * 协议以 '\n' 分帧，未收到换行前 buffer 会无限累加；一个不发换行的客户端
 *（或 bug）即可让唯一 owner 进程 OOM，进而拖垮 CLI/stdio/HTTP 全部入口。
 */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

export async function startDaemonRpcServer(opts: DaemonRpcOptions = {}): Promise<net.Server> {
  const config = loadConfig();
  ensureVectorLayout(config);
  const socketPath = getDaemonSocketPath();
  const isWindows = process.platform === 'win32';
  if (!isWindows) {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(socketPath), 0o700); } catch { /* 权限设置失败由后续连接错误暴露 */ }
    await removeStaleSocket(socketPath);
  }
  const coordinator = getSharedOperationCoordinator();
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let rejected = false;
    // 客户端在 RPC/ping 超时时会主动 destroy 连接；缺少 error 监听时该异常
    // 无处落地（跨 Node 版本行为无保证），且服务端后续 write 失败也无日志。
    socket.on('error', (err) => {
      logDaemon(`客户端连接异常：${err.message}`);
    });
    socket.on('close', () => {
      for (const job of daemonJobs.values()) job.subscribers.delete(socket);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES && !rejected) {
        rejected = true;
        const hint = '拆小请求后重试（例如 bulk-store 分批提交）';
        logOperationFailure(undefined, { code: 'DAEMON_REQUEST_TOO_LARGE', message: `RPC 请求超过 ${MAX_REQUEST_BYTES} 字节上限` }, hint);
        send(socket, { id: null, ok: false, error: { code: 'DAEMON_REQUEST_TOO_LARGE', message: `RPC 请求超过 ${MAX_REQUEST_BYTES} 字节上限`, hint } });
        socket.destroy();
        return;
      }
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        void handleRpcLine(socket, line, coordinator).catch((err) => {
          const error = err as Error;
          let request: RpcRequest | undefined;
          try { request = JSON.parse(line) as RpcRequest; } catch { /* handleRpcLine 已覆盖 bad JSON */ }
          const hint = recoveryHint('DAEMON_INTERNAL_ERROR');
          logOperationFailure(request, { code: 'DAEMON_INTERNAL_ERROR', message: error.message }, hint);
          send(socket, { id: request?.id ?? null, ok: false, error: { code: 'DAEMON_INTERNAL_ERROR', message: error.message, hint } });
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error) => reject(err);
    server.once('error', onListenError);
    server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
      // listen 成功后必须摘掉这个一次性 reject：否则后续的服务器级错误
      //（EMFILE、socket 文件被外部删除等）会被一个已 settle 的 reject 静默吞掉。
      server.removeListener('error', onListenError);
      resolve();
    });
  });
  server.on('error', (err) => {
    logDaemon(`daemon RPC 服务器错误：${err.message}`);
  });
  if (!isWindows) {
    try { fs.chmodSync(socketPath, 0o600); } catch { /* 权限设置失败由启动检查暴露 */ }
  }
  const cleanup = () => {
    opts.onShutdown?.();
    // Named pipes are released by Windows when their server handle closes.
    if (!isWindows) {
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    }
  };
  server.once('close', cleanup);
  return server;
}

/**
 * 仅清理确认已失效的 Socket。不能无条件 unlink：同一 vectorDir 可能被不同
 * HTTP 端口的启动命令同时拉起，覆盖活动 Socket 会制造两个 zvec owner。
 */
async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!fs.existsSync(socketPath)) return;
  const active = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    // 仅一次短 connect 失败不足以证明 owner 已失效：daemon 可能正被同步
    // 的 zvec/备份操作暂时阻塞事件循环。延长窗口，避免误删活动 Socket 后
    // 启动第二个 owner；真正失效的 Socket 仍会立即收到 ECONNREFUSED。
    setTimeout(() => finish(false), 2_000).unref();
  });
  if (active) {
    throw Object.assign(new Error(`daemon 已在运行并占用 Socket：${socketPath}`), { code: 'DAEMON_ALREADY_RUNNING' });
  }
  try { fs.unlinkSync(socketPath); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function handleRpcLine(socket: net.Socket, line: string, coordinator: OperationCoordinator): Promise<void> {
  let req: RpcRequest;
  try { req = JSON.parse(line) as RpcRequest; } catch {
    const hint = recoveryHint('DAEMON_BAD_REQUEST');
    logOperationFailure(undefined, { code: 'DAEMON_BAD_REQUEST', message: 'RPC 请求不是合法 JSON' }, hint);
    send(socket, { id: null, ok: false, error: { code: 'DAEMON_BAD_REQUEST', message: 'RPC 请求不是合法 JSON', hint } });
    return;
  }
  if (req.method === 'ping') {
    const config = loadConfig();
    send(socket, {
      id: req.id ?? null,
      ok: true,
      // ping 必须在漂移时仍可用（否则运维无法诊断）；因此只上报标记，不在此 fail-loud。
      daemon: { protocol: DAEMON_PROTOCOL_VERSION, version: readKiVersion(), pid: process.pid, fingerprint: configFingerprint(config), layoutVersion: VECTOR_LAYOUT_VERSION, identityDrift: isDaemonIdentityDrifted(config), operations: supportedOperations(), queue: coordinator.snapshot() },
    });
    return;
  }
  if (req.method === 'queue') {
    send(socket, { id: req.id ?? null, ok: true, queue: coordinator.snapshot() });
    return;
  }
  cleanupJobs();
  const owner = requestOwner();
  if (req.method === 'status') {
    const jobId = req.jobId?.trim() ?? '';
    const job = daemonJobs.get(jobId);
    if (!job || job.owner !== owner) {
      send(socket, { id: req.id ?? null, ok: false, error: { code: 'JOB_NOT_FOUND', message: `daemon job 不存在：${jobId}` } });
      return;
    }
    send(socket, { id: req.id ?? null, ok: true, job: jobSummary(job) });
    return;
  }
  if (req.method === 'cancel') {
    const jobId = req.jobId?.trim() ?? '';
    const job = daemonJobs.get(jobId);
    if (!job) {
      // execute 尚未到达事件循环时先登记短 TTL tombstone，消除“cancel 赢在 execute
      // 注册前却返回 not_found”的竞态。execute 注册时会消费它并直接完成为 cancelled。
      if (jobId && pendingCancels.size < PENDING_CANCEL_LIMIT) {
        pendingCancels.set(jobId, { owner, expiresAt: Date.now() + PENDING_CANCEL_TTL_MS });
        send(socket, { id: req.id ?? null, ok: true, state: 'pending', jobId });
      } else {
        if (jobId) {
          send(socket, { id: req.id ?? null, ok: false, error: { code: 'PENDING_CANCEL_LIMIT', message: 'pending-cancel tombstone 已达上限，请稍后重试或确认 jobId' } });
        } else {
          send(socket, { id: req.id ?? null, ok: true, state: 'not_found', jobId });
        }
      }
      return;
    }
    if (job.owner !== owner) {
      send(socket, { id: req.id ?? null, ok: false, error: { code: 'JOB_NOT_FOUND', message: `daemon job 不存在：${jobId}` } });
      return;
    }
    if (job.finishedAt) {
      send(socket, { id: req.id ?? null, ok: true, state: 'already_finished', jobId, job: jobSummary(job) });
      return;
    }
    job.cancelRequested = true;
    job.state = 'draining';
    job.abortController.abort();
    send(socket, { id: req.id ?? null, ok: true, state: 'cancelling', jobId });
    return;
  }
  if (req.method !== 'execute' || !req.operation) {
    const hint = recoveryHint('DAEMON_BAD_REQUEST');
    logOperationFailure(req, { code: 'DAEMON_BAD_REQUEST', message: '需要 method=execute 和 operation' }, hint);
    send(socket, { id: req.id ?? null, ok: false, error: { code: 'DAEMON_BAD_REQUEST', message: '需要 method=execute 和 operation', hint } });
    return;
  }
  const stream = req.streamProgress === true;
  const jobId = (req.jobId ?? '').trim();
  let job: DaemonJob | undefined;
  if (stream) {
    if (!jobId) {
      send(socket, { id: req.id ?? null, ok: false, error: { code: 'DAEMON_JOB_ID_REQUIRED', message: 'streamProgress=true 必须提供 jobId' } });
      return;
    }
    if (daemonJobs.has(jobId)) {
      send(socket, { id: req.id ?? null, ok: false, error: { code: 'DAEMON_JOB_EXISTS', message: `daemon job 已存在：${jobId}` } });
      return;
    }
    const scope = scopeOf(req.params, req.operation);
    job = {
      id: jobId,
      owner,
      operation: req.operation,
      scope,
      state: 'queued',
      cancelRequested: false,
      abortController: new AbortController(),
      eventSeq: 0,
      createdAt: Date.now(),
      subscribers: new Set([socket]),
    };
    daemonJobs.set(jobId, job);
    const tombstone = pendingCancels.get(jobId);
    if (tombstone && tombstone.owner === owner && tombstone.expiresAt > Date.now()) {
      pendingCancels.delete(jobId);
      job.cancelRequested = true;
      job.state = 'cancelled';
      job.finishedAt = Date.now();
      job.result = { cancelled: true, jobId, reason: 'cancel requested before execute registration' };
      send(socket, { id: req.id ?? null, ok: true, result: job.result, jobId, eventSeq: ++job.eventSeq });
      return;
    }
    const emitProgress = (progress: { phase: string; done: number; total: number; persisted?: number; metadataPending?: number; failed?: number; cancelled?: number }): void => {
      if (!job) return;
      const metrics = getVectorizationMetrics();
      job.progress = {
        jobId: job.id,
        operation: job.operation,
        scope: job.scope,
        phase: progress.phase,
        done: progress.done,
        total: progress.total,
        persisted: progress.persisted ?? 0,
        metadataPending: progress.metadataPending ?? 0,
        failed: progress.failed ?? 0,
        cancelled: progress.cancelled ?? 0,
        inFlight: metrics.inFlightRequests,
        bufferedBytes: metrics.bufferedVectorBytes,
      };
      job.eventSeq++;
      for (const subscriber of job.subscribers) {
        send(subscriber, { id: req.id ?? null, type: 'progress', jobId: job.id, eventSeq: job.eventSeq, progress: job.progress });
      }
    };
    job.emitProgress = emitProgress;
    emitProgress({ phase: 'queued', done: 0, total: 1 });
  }
  const operation: OperationRequest = { operation: req.operation, params: req.params };
  try {
    // 身份漂移必须在**入队之前**拒绝：漂移后 daemon 的路径解析与内存句柄不一致，
    // 排队执行只会把数据写到错误位置。放在 try 内以复用统一的错误响应与失败日志。
    const requestConfig = loadConfig();
    // 身份检查与快照必须基于同一次读取；否则配置恰好在两次 loadConfig 之间
    // 变化时，可能出现“用旧配置做守卫、用新配置执行”的裂缝。
    assertDaemonIdentityCurrent(requestConfig);
    // 快照必须捕获在入队时，并在真正出队执行时重新建立上下文；否则排队期间
    // loadConfig 的热失效会让同一个长操作前后半段使用不同路径/授权。
    const outcome = await coordinator.submit(
      operation,
      (params) => {
        if (job) {
          if (job.cancelRequested) {
            job.state = 'cancelled';
            return { cancelled: true, jobId: job.id, reason: 'cancelled before handler started' };
          }
          job.state = 'running';
          job.startedAt = Date.now();
        }
        return runWithConfigSnapshot(
          requestConfig,
          () => dispatchOperation(
            { operation: req.operation!, params },
            job ? { jobId: job.id, abortSignal: job.abortController.signal, onProgress: (p: any) => job.emitProgress?.(p) } : {},
          ),
        );
      },
      scopesOf(req.params, req.operation),
    );
    if (job) {
      job.result = outcome.result;
      const value = outcome.result as { cancelled?: boolean; ok?: boolean; errors?: Array<{ type?: string }> } | undefined;
      const cancelled = job.cancelRequested || value?.cancelled === true || value?.errors?.some((e) => e.type === 'cancelled') === true;
      job.state = classifyJobState(outcome.result, cancelled, value?.ok === false);
      job.finishedAt = Date.now();
      job.eventSeq++;
      send(socket, { id: req.id ?? null, ok: true, result: outcome.result, queue: outcome.queue, jobId: job.id, eventSeq: job.eventSeq, final: true });
    } else {
      send(socket, { id: req.id ?? null, ok: true, result: outcome.result, queue: outcome.queue });
    }
  } catch (err) {
    const error = err as Error & { code?: string };
    const hint = recoveryHint(error.code);
    logOperationFailure(req, error, hint);
    if (job) {
      job.error = { code: error.code, message: error.message };
      job.state = job.cancelRequested || error.code === 'IMPORT_CANCELLED' || error.code === 'RESTORE_CANCELLED' || error.code === 'REBUILD_CANCELLED'
        ? 'cancelled'
        : 'failed';
      job.finishedAt = Date.now();
    }
    send(socket, {
      id: req.id ?? null,
      ok: false,
      error: { code: error.code ?? 'DAEMON_OPERATION_FAILED', message: error.message, hint },
      ...(job ? { jobId: job.id, eventSeq: ++job.eventSeq, final: true } : {}),
    });
  }
}
