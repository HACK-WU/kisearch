import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { configFingerprint } from './scope-collection.js';
import { getDaemonSocketPath, DAEMON_PROTOCOL_VERSION } from './daemon-protocol.js';

let startup: Promise<void> | null = null;

/**
 * setTimeout 的 delay 是 32 位有符号整数：超过 2147483647 会被 Node 钳制为 1ms
 *（并抛 TimeoutOverflowWarning）。因此“很大”的超时上限必须显式钳到该值，
 * 不能传 Number.MAX_SAFE_INTEGER（实测会被钳为 1ms → 立即超时）。
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * ping 超时必须不低于 daemon 侧 removeStaleSocket 的陈旧判定窗口（2000ms）：
 * daemon 执行同步 tar 备份/还原时事件循环会被阻塞超过 1s，若客户端用更短的
 * 窗口就会把“正忙”误判为“不存在”并拉起第二实例，而第二实例又会因 Socket
 * 仍活而报 DAEMON_ALREADY_RUNNING —— 用户看到自相矛盾的失败。
 */
const PING_TIMEOUT_MS = 3_000;

/**
 * 指纹不匹配的出路文案。
 *
 * 注意：loadConfig 改为 mtime 热失效后，daemon **不再**持有启动快照（scope/token 类
 * 变更已实时生效），且 ping 两侧读同一份文件 —— 因此旧文案“daemon 持有启动那一刻的
 * 配置快照，请重启以加载新配置”已成事实错误，会把用户推向无效动作（重启后仍不匹配）。
 * 现在走到 mismatch 只剩两种真因：客户端用了不同的 --config，或 daemon 自身身份漂移。
 */
const FINGERPRINT_MISMATCH_HINT =
  'daemon 配置指纹不匹配：客户端解析出的配置与 daemon 当前配置不一致。'
  + '常见原因是 --config（或 KI_CONFIG_PATH）指向了另一份配置，请用匹配的 --config 重试；'
  + '若确认两边用的是同一份文件，则说明 daemon 已发生身份漂移'
  + '（可用 GET /healthz 的 identityDrift 字段确认），需执行 ki mcp stop && ki mcp --http --daemon 重启。';

/**
 * 指纹不匹配错误。带 code 以便上层区分“配置不匹配 / daemon 不可用 / 版本不兼容 /
 * 队列超时”四类失败（需求 §4.6 要求可区分）；文案仍保留“配置指纹不匹配”子串，
 * 因为 ensureDaemon/startDaemon 的 catch 靠它区分“该重抛”与“该自动拉起”。
 */
function fingerprintMismatchError(): Error {
  return Object.assign(new Error(FINGERPRINT_MISMATCH_HINT), { code: 'DAEMON_CONFIG_MISMATCH' });
}

export function isDaemonOwner(): boolean {
  return process.env.KI_DAEMON_OWNER === '1';
}

/** 仅由 bin/ki.mjs 标记的真实 CLI 客户端走 daemon；单元测试直接调用 execute 函数时保持本地语义。 */
export function shouldUseDaemonClient(): boolean {
  return !isDaemonOwner() && process.env.KI_DAEMON_CLIENT === '1';
}

export interface DaemonProgressEvent {
  jobId: string;
  eventSeq: number;
  progress: {
    jobId?: string;
    operation?: string;
    scope?: string;
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
}

export interface CallDaemonOptions {
  /** 长任务启用多帧进度；jobId 必须由客户端在提交前生成。 */
  streamProgress?: boolean;
  jobId?: string;
  onProgress?: (event: DaemonProgressEvent) => void;
  abortSignal?: AbortSignal;
}

export function createDaemonJobId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

export interface DaemonCancelResponse {
  state: 'pending' | 'cancelling' | 'already_finished' | 'not_found';
  jobId: string;
}

export interface DaemonJobStatus {
  jobId: string;
  operation: string;
  scope: string;
  state: 'queued' | 'running' | 'draining' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
  cancelRequested: boolean;
  eventSeq: number;
  progress?: DaemonProgressEvent['progress'];
  result?: unknown;
  error?: { code?: string; message: string };
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export async function callDaemon<T>(
  operation: string,
  params: unknown,
  timeoutMs = 120_000,
  options: CallDaemonOptions = {},
): Promise<T> {
  if (isDaemonOwner()) throw new Error('daemon owner 进程不能通过 RPC 回调自身');
  await ensureDaemon();
  const socketPath = getDaemonSocketPath();
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const jobId = options.streamProgress ? (options.jobId ?? createDaemonJobId()) : options.jobId;
  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    let cancelSent = false;
    let lastEventSeq = 0;
    // timeoutMs <= 0 表示不设客户端超时，靠 socket 生命周期结束。
    // 长任务（import/restore/rebuild-vector）的内部预算可达
    // 60s + N*10s（100 chunk ≈ 17 分钟），远超任何固定客户端超时；超时后
    // daemon 侧任务并不会取消，用户看到失败后重跑会撞 import.lock 进入死路。
    // 注意不能把“不超时”写成 setTimeout(fn, 0)（下一 tick 即触发）或
    // Number.MAX_SAFE_INTEGER（超 32 位被钳为 1ms），两者实测都在 ~3ms 超时。
    let timer: NodeJS.Timeout | null = null;
    const clearTimer = (): void => { if (timer) clearTimeout(timer); };
    const onAbort = (): void => {
      if (!jobId || cancelSent || settled) return;
      cancelSent = true;
      void cancelDaemonJob(jobId).catch((err) => {
        process.stderr.write(`请求取消 daemon job 失败（${jobId}）：${(err as Error).message}\n`);
      });
    };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (options.abortSignal?.aborted) onAbort();
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      options.abortSignal?.removeEventListener('abort', onAbort);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish();
        socket.destroy();
        reject(new Error(
          `daemon RPC 超时（${operation}，${Math.min(timeoutMs, MAX_TIMEOUT_MS)}ms）。`
          + '任务可能仍在 daemon 侧继续执行：请勿清理 import.lock 或重复提交，'
          + '可用 ki mcp --status 查看队列状态，或对该任务传 timeoutMs=0 取消客户端超时。',
        ));
      }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    }
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method: 'execute', operation, params, jobId, streamProgress: options.streamProgress === true })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        let payload: { ok: boolean; type?: string; result?: T; queue?: { scope: string; queuedMs: number; runMs?: number; activeWorkers: number; maxWorkers: number }; error?: { message?: string; code?: string; hint?: string }; jobId?: string; eventSeq?: number; progress?: { phase?: string; done: number; total: number }; final?: boolean };
        try { payload = JSON.parse(line) as typeof payload; }
        catch (err) { finish(); socket.destroy(); reject(err); return; }
        if (payload.type === 'progress') {
          if (payload.progress && payload.jobId && payload.eventSeq !== undefined && payload.eventSeq > lastEventSeq) {
            lastEventSeq = payload.eventSeq;
            try { options.onProgress?.({ jobId: payload.jobId, eventSeq: payload.eventSeq, progress: payload.progress }); } catch { /* UI 回调不得破坏 RPC */ }
          }
          continue;
        }
        finish();
        socket.end();
        if (payload.ok) {
          if (payload.queue && payload.queue.queuedMs > 0) {
            const running = payload.queue.runMs !== undefined ? `，执行 ${payload.queue.runMs}ms` : '';
            process.stderr.write(`daemon 已排队执行（scope=${payload.queue.scope}，等待 ${payload.queue.queuedMs}ms${running}；并发上限 ${payload.queue.maxWorkers}）。\n`);
          }
          resolve(payload.result as T);
        }
        else {
          const message = payload.error?.hint
            ? `${payload.error.message ?? 'daemon RPC 失败'}；恢复建议：${payload.error.hint}`
            : (payload.error?.message ?? 'daemon RPC 失败');
          reject(Object.assign(new Error(message), { code: payload.error?.code }));
        }
        return;
      }
    });
    socket.on('error', (err) => {
      finish();
      // 无客户端超时的长任务靠这里感知 daemon 死亡：不能只说“无法连接”，
      // 否则用户不知道已提交的任务是否还在跑。
      reject(new Error(
        `无法连接 daemon：${err.message}；请检查 ki mcp --status。`
        + (timer === null ? '本次为无超时任务，连接中断前提交的操作可能已部分执行，重试前请先核对目标 scope 的当前状态。' : ''),
      ));
    });
    socket.on('close', () => {
      if (settled) return;
      finish();
      reject(new Error(
        `daemon RPC 连接已关闭（${operation}）；请检查 ki mcp --status。`
        + (timer === null ? '连接中断前任务可能已部分执行，重试前请先核对目标 scope 的当前状态。' : ''),
      ));
    });
  });
}

async function callDaemonControl<T>(method: 'cancel' | 'status', jobId: string): Promise<T> {
  if (!jobId.trim()) throw new Error(`daemon ${method} 需要 jobId`);
  if (isDaemonOwner()) throw new Error('daemon owner 进程不能通过 RPC 回调自身');
  await ensureDaemon();
  const socketPath = getDaemonSocketPath();
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`daemon ${method} 超时（jobId=${jobId}）`));
    }, PING_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, jobId })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const payload = JSON.parse(buffer.slice(0, idx)) as { ok: boolean; state?: string; jobId?: string; job?: T; error?: { code?: string; message?: string } };
        if (payload.ok) resolve((method === 'status' ? payload.job : { state: payload.state, jobId: payload.jobId }) as T);
        else reject(Object.assign(new Error(payload.error?.message ?? `daemon ${method} 失败`), { code: payload.error?.code }));
      } catch (err) { reject(err); }
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

export function cancelDaemonJob(jobId: string): Promise<DaemonCancelResponse> {
  return callDaemonControl<DaemonCancelResponse>('cancel', jobId);
}

export function getDaemonJobStatus(jobId: string): Promise<DaemonJobStatus> {
  return callDaemonControl<DaemonJobStatus>('status', jobId);
}

export async function ensureDaemon(): Promise<void> {
  if (isDaemonOwner()) return;
  try {
    const pong = await pingDaemon(PING_TIMEOUT_MS);
    if (pong === 'ok') return;
    if (pong === 'mismatch') throw fingerprintMismatchError();
  } catch (err) {
    const e = err as Error & { code?: string };
    // 用结构化 code 判定而非中文子串：文案一旦调整，字符串判定会静默失效 →
    // mismatch 被当成“daemon 不存在”而触发自动拉起，最终撞 DAEMON_ALREADY_RUNNING，
    // 回到“刚说不可用、又说已在运行”的矛盾失败。
    if (e.code === 'DAEMON_CONFIG_MISMATCH') throw err;
    // 超时不等于 daemon 不存在：它可能正被同步的 tar 备份/还原阻塞事件循环。
    // 此时拉起第二实例只会在 removeStaleSocket 撞上 DAEMON_ALREADY_RUNNING，
    // 造成“刚说不可用、又说已在运行”的矛盾失败，故直接 fail-loud 并给出路。
    if (e.message.includes('ping timeout')) {
      throw new Error(
        `daemon 在 ${PING_TIMEOUT_MS}ms 内无响应（可能正在执行同步备份/还原等阻塞操作）；`
        + '请稍后重试，或用 ki mcp --status 查看队列与在跑操作。',
      );
    }
    // ENOENT / ECONNREFUSED：socket 不存在或无监听者 → 自动拉起
  }
  if (!startup) startup = startDaemon().finally(() => { startup = null; });
  await startup;
}

async function pingDaemon(timeoutMs: number): Promise<'ok' | 'mismatch' | null> {
  const socketPath = getDaemonSocketPath();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('ping timeout')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'ping', method: 'ping' })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer); socket.end();
      try {
        const p = JSON.parse(buffer.slice(0, idx)) as { ok?: boolean; daemon?: { protocol?: number; fingerprint?: string } };
        const config = loadConfig();
        if (p.ok !== true || p.daemon?.protocol !== DAEMON_PROTOCOL_VERSION) return resolve(null);
        resolve(p.daemon.fingerprint === configFingerprint(config) ? 'ok' : 'mismatch');
      } catch { resolve(null); }
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function startDaemon(): Promise<void> {
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/ki.mjs');
  const child = spawn(process.execPath, [bin, 'mcp', '--http', '--daemon'], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    env: { ...process.env },
  });
  child.unref();
  // 预检失败、端口冲突或配置错误时，daemon 子进程会很快退出。
  // 不能只轮询 socket 到 30s：CLI 应立即拿到 fail-loud 错误，而不是把启动
  // 失败伪装成网络类慢失败。只记录退出状态，不在成功启动后保留 reject Promise，
  // 避免 daemon 后续正常停止触发未处理 rejection。
  let startupError: Error | undefined;
  child.once('error', (err) => {
    startupError = new Error(`daemon 子进程启动失败：${err.message}`);
  });
  child.once('exit', (code, signal) => {
    // bin/ki.mjs 是后台化包装器：3s 存活探测窗口内子进程未退出就 unref 并
    // process.exit(0)，daemon 真身（detached grandchild）仍在继续启动。因此
    // exit 0 是**成功路径的必然结果**，不能当失败；而 socket 由真身在健康预检
    //（含一次真实 embedding 请求，8s×2 重试）之后创建，实测晚于包装器退出，
    // 旧逻辑据此报“预检阶段退出（exit 0）”，使 CLI/stdio 首次自动拉起假失败。
    // 只有非 0 退出或被信号杀死才是真失败（token 缺失、参数非法、端口冲突、
    // 预检 ❌ 等 fail-loud 都发生在该 3s 窗口内，能被正确捕获）。
    if (signal || (code !== null && code !== 0)) {
      startupError = new Error(
        `daemon 子进程在预检阶段退出（${signal ? `signal ${signal}` : `exit ${code}`}）`,
      );
    }
  });
  const startedAt = Date.now();
  const deadline = startedAt + 30_000;
  let lastError = '未就绪';
  while (Date.now() < deadline) {
    if (startupError) {
      throw new Error(`${startupError.message}；请前台执行 ki mcp --http --daemon 查看具体错误`);
    }
    try {
      const pong = await pingDaemon(PING_TIMEOUT_MS);
      if (startupError) {
        throw startupError;
      }
      if (pong === 'ok') return;
      if (pong === 'mismatch') throw fingerprintMismatchError();
    } catch (err) {
      // 回调异步写入 startupError，TS 的控制流分析无法观察该外部 mutation。
      const currentStartupError = startupError as Error | undefined;
      if (currentStartupError) {
        throw new Error(`${currentStartupError.message}；请前台执行 ki mcp --http --daemon 查看具体错误`);
      }
      if ((err as Error & { code?: string }).code === 'DAEMON_CONFIG_MISMATCH') throw err;
      lastError = (err as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (startupError) {
    throw new Error(`${startupError.message}；请前台执行 ki mcp --http --daemon 查看具体错误`);
  }
  throw new Error(
    `daemon 自动启动失败：${lastError}；已等待 ${Math.round((Date.now() - startedAt) / 1000)}s 仍未就绪。`
    + '请前台执行 ki mcp --http --daemon 查看启动日志（启动预检会发一次真实 embedding 请求，'
    + '网络异常时可能耗时十余秒；包装进程 exit 0 后其失败不再可见，只能靠前台日志定位）。',
  );
}
