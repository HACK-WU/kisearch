/**
 * proxy.ts —— ZvecEngineProxy（主线程侧）
 *
 * 与设计文档对齐：S-04 §3.1 / §3.4 / §4a
 *
 * 职责：
 *   - spawn dedicated worker（持有唯一 collection 句柄）
 *   - 把 async 方法调用转为 postMessage，经 id 关联 Promise
 *   - close: drain 在途 → worker closeSync → terminate
 *   - destroy: 委托 worker 执行（closeSync → ZVecDestroy → terminate）
 *   - crash: error/exit 事件 → reject 在途 + 标记不可用
 */

import { Worker } from 'node:worker_threads';

// Node worker_threads 的 Transferable 类型（@types/node 未全局导出）
type Transferable = ArrayBuffer | MessagePort | import('node:worker_threads').MessagePort;
import {
  CloseTimeoutError,
  WorkerCrashedError,
  WorkerProtocolError,
  WorkerSpawnError,
  WorkerUnavailableError,
} from './errors.js';
import type { PersistedSchema, ZvecEngineConfig, ZvecEngineOpenConfig } from './types.js';
import {
  collectTransferables,
  deserializeError,
  newMessageId,
  type InfoResultPayload,
  type WorkerRequest,
  type WorkerResponse,
} from './worker-protocol.js';

type State = 'init' | 'opening' | 'open' | 'closing' | 'closed' | 'crashed' | 'failed';

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 5000;
/** opening 状态下 close 前等待 open 落定的窗口（避免 terminate 掉已持锁的 worker） */
const OPENING_SETTLE_GRACE_MS = 1500;

export class ZvecEngineProxy {
  private worker: Worker | null = null;
  private state: State = 'init';
  private pending = new Map<string, PendingEntry>();
  private persistedSchema: PersistedSchema | null = null;
  private crashListeners: Array<(err: Error) => void> = [];
  private readyResolve: ((s: PersistedSchema) => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;

  /**
   * spawn worker 并等待 ready（create/open 完成）
   */
  async spawn(
    config: ZvecEngineConfig | ZvecEngineOpenConfig,
    mode: 'create' | 'open',
  ): Promise<PersistedSchema> {
    if (this.state !== 'init') {
      throw new WorkerSpawnError(`proxy already spawned (state=${this.state})`);
    }
    this.state = 'opening';

    const workerUrl = new URL('./worker.js', import.meta.url);
    try {
      // ESM 由 package.json type:module + .js 后缀自动识别，无需显式 type 字段
      this.worker = new Worker(workerUrl);
    } catch (err) {
      this.state = 'failed';
      throw new WorkerSpawnError(
        `failed to spawn worker: ${(err as Error).message}`,
        { cause: err },
      );
    }

    this.worker.on('message', (msg: WorkerResponse) => this.onMessage(msg));
    this.worker.on('error', (err: Error) => this.handleCrash(err));
    this.worker.on('exit', (code) => {
      if (this.state !== 'closed' && this.state !== 'closing') {
        this.handleCrash(new Error(`worker exited with code ${code}`));
      }
    });

    const readyPromise = new Promise<PersistedSchema>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // 发 create/open 消息
    const payload = mode === 'create'
      ? { config: stripEmbedding(config as ZvecEngineConfig) }
      : {
          dbPath: (config as ZvecEngineOpenConfig).dbPath,
          collectionName: (config as ZvecEngineOpenConfig).collectionName,
          readOnly: (config as ZvecEngineOpenConfig).readOnly ?? false,
        };

    this.post({ id: newMessageId(), kind: mode, payload } as WorkerRequest);

    try {
      this.persistedSchema = await readyPromise;
      this.state = 'open';
      // open 完就进入空闲态：调用方若不再发请求，不该被 worker 拖着不退（见 unrefWhenIdle）
      this.unrefWhenIdle();
      return this.persistedSchema;
    } catch (err) {
      this.state = 'failed';
      throw err;
    }
  }

  /**
   * 发送任意消息并等待响应
   */
  send<T>(kind: WorkerRequest['kind'], payload: unknown, transfer?: Transferable[]): Promise<T> {
    if (this.state !== 'open') {
      return Promise.reject(
        new WorkerUnavailableError(`worker not open (state=${this.state})`),
      );
    }
    // 有在途请求时必须 ref：否则「空闲 unref + 最后一个请求」会让进程在写操作完成前退出
    this.refWorker();
    const id = newMessageId();
    const req = { id, kind, payload } as WorkerRequest;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.post(req, transfer);
      } catch (err) {
        // post 失败必须回收 pending：条目永久残留会让 unrefWhenIdle 永远判「有在途请求」，
        // 进程重新变成挂住不退（与 #109 要修的现象同源），且调用方拿到的是永不 settle 的 Promise
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /**
   * close: drain 在途 → worker closeSync → terminate
   */
  async close(drainTimeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.state === 'closed' || this.state === 'crashed' || this.state === 'failed') {
      return;
    }
    // 收尾期间必须保活：drain/closeSync 的等待若只剩 unref 句柄，进程会先退出（锁靠 OS 回收）
    this.refWorker();
    if (this.state !== 'open') {
      // opening 中调 close：原生 ZVecOpen 可能已经拿到 flock，直接 terminate 会让
      // `<dbPath>/LOCK` 永久滞留在本进程（"幽灵占用"：此后连本进程自己 probe 都判 locked）。
      // 先给 open 一个有限收敛窗口，落定即走正常 close（worker closeSync 真正释放 LOCK）。
      if (this.state === 'opening') {
        await this.waitForOpenSettled(OPENING_SETTLE_GRACE_MS);
        // 经方法读取状态：等待期间 spawn() 的后续逻辑会改状态，TS 对 this.state 的旧收窄不适用
        if (this.currentState() === 'open') return this.close(drainTimeoutMs);
      }
      await this.terminate();
      this.state = 'closed';
      return;
    }
    this.state = 'closing';

    const drainPromise = this.waitForDrain(drainTimeoutMs);
    let drained = true;
    try {
      await drainPromise;
    } catch {
      drained = false;
    }

    // 发 close 消息（worker 内 closeSync 释放 LOCK）
    if (this.worker && drained) {
      try {
        await this.sendRaw('close', { drainTimeoutMs });
      } catch { /* worker 可能已死 */ }
    }

    await this.terminate();
    this.state = 'closed';
  }

  /**
   * 强制 terminate（不等 drain，用于 destroy/crash 场景）
   */
  async terminate(): Promise<void> {
    // terminate 本身也是异步收尾：先 ref，避免进程在 worker 真正终止前退出
    this.refWorker();
    // 状态必须**先**落定再 await：unrefWhenIdle 的回调是延迟执行的，若此刻仍是 'open'
    // 且 pending 已清空，它会把正在 terminate 的 worker unref 掉 —— 主线程随即没有 ref
    // 句柄，进程（或 node:test 的事件循环）会在 terminate 落定前判定为空并退出。
    this.state = 'closed';
    this.rejectAllPending(new WorkerUnavailableError('worker terminated'));
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch { /* ignore */ }
      this.worker = null;
    }
  }

  isOpen(): boolean {
    return this.state === 'open';
  }

  /**
   * 等待「open 落定」（成功 → open / 失败 → failed / 崩溃 → crashed）。
   * 用于避免在 opening 状态下 terminate：原生 open 一旦拿到 flock 后被杀，
   * 文件锁会永久泄漏在进程内。返回是否已落定（false = 超时仍在 opening）。
   */
  async waitForOpenSettled(timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    while (this.state === 'opening' && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.state !== 'opening';
  }

  /** 读取当前状态（经方法读取可绕过调用点的控制流收窄；等待/异步后判断状态时使用） */
  currentState(): State {
    return this.state;
  }

  /**
   * 让 worker 不再阻塞进程退出（unref）。
   * 仅用于"已登记为孤儿、仍在等原生 open 收束"的 probe worker：
   * 这类 worker 不能 terminate（会泄漏 flock），但也不能把短命令的进程吊住不退出——
   * unref 后：进程退出时由 OS 释放其全部 fd/锁；进程继续存活时它照常完成 close 并回收。
   */
  unrefWorker(): void {
    try { this.worker?.unref(); } catch { /* ignore */ }
  }

  getPersistedSchema(): PersistedSchema | null {
    return this.persistedSchema;
  }

  onCrash(cb: (err: Error) => void): void {
    this.crashListeners.push(cb);
  }

  // ─── 内部 ───

  /** 有在途请求时重新 ref，避免进程在写操作中途退出 */
  private refWorker(): void {
    try { this.worker?.ref(); } catch { /* ignore */ }
  }

  /**
   * 空闲时 unref worker（不再阻塞进程退出）。
   *
   * 背景（事件 #109）：worker 历来是 ref 的，短命令 / 调试脚本忘记 `closeEngine()` 时，
   * 进程会永久挂住并持续持有该 collection 的 LOCK（实测一个只读脚本 87s 不退、30 个 fd，
   * 另一个脚本挂 3 天）。改为「send 时 ref、pending 清空且 open 时 unref」后：有在途
   * 请求仍保活，空闲则允许进程自然结束（fd 与 flock 由 OS 回收）；daemon 有 HTTP server
   * 句柄、CLI 有显式 closeEngine，都不依赖 worker 兜底。
   *
   * 用 setImmediate 延后一拍：onMessage 里 resolve 之后调用方续体才执行，立刻 unref 会让
   * 「续体」与「退出判定」赛跑；延后一拍保证续体先跑完（本拍仍由 setImmediate 自己保活）。
   *
   * 不改变 close/terminate 语义：两者入口已 ref，收尾期间不会因 unref 被截断。
   */
  private unrefWhenIdle(): void {
    if (this.state !== 'open' || this.pending.size > 0) return;
    setImmediate(() => {
      if (this.state !== 'open' || this.pending.size > 0) return;
      try { this.worker?.unref(); } catch { /* ignore */ }
    });
  }

  private post(req: WorkerRequest, transfer?: Transferable[]): void {
    if (!this.worker) {
      throw new WorkerUnavailableError('worker not spawned');
    }
    const t = transfer ?? collectTransferables((req as { payload?: unknown }).payload);
    try {
      if (t.length > 0) {
        this.worker.postMessage(req, t);
      } else {
        this.worker.postMessage(req);
      }
    } catch (err) {
      throw new WorkerProtocolError(
        `failed to postMessage: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  private sendRaw(kind: WorkerRequest['kind'], payload: unknown): Promise<unknown> {
    this.refWorker();
    const id = newMessageId();
    const req = { id, kind, payload } as WorkerRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.post(req);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private onMessage(msg: WorkerResponse): void {
    if ('kind' in msg && msg.kind === 'ready') {
      const m = msg as { persistedSchema?: PersistedSchema };
      if (this.readyResolve && m.persistedSchema) {
        this.readyResolve(m.persistedSchema);
      }
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    const { id } = msg as { id: string };
    const entry = this.pending.get(id);
    if (!entry) {
      // 未知 id（协议异常/晚到的重复响应）：同样要重新评估空闲态，
      // 否则 worker 会被上一轮请求永久 ref 住（#109 的挂住现象会从这条缝隙复现）
      this.unrefWhenIdle();
      return;
    }
    this.pending.delete(id);
    if ((msg as { ok: boolean }).ok) {
      entry.resolve((msg as { result?: unknown }).result);
    } else {
      const errMsg = msg as unknown as { error: import('./worker-protocol.js').SerializedError };
      entry.reject(deserializeError(errMsg.error));
    }
    // 本批在途请求已全部完成 → 允许进程退出（有后续 send 会立刻 ref 回来）
    this.unrefWhenIdle();
  }

  private handleCrash(err: Error): void {
    if (this.state === 'crashed') return;
    this.state = 'crashed';
    const wrapped = new WorkerCrashedError(`worker crashed: ${err.message}`, { cause: err });
    this.rejectAllPending(wrapped);
    if (this.readyReject) {
      this.readyReject(wrapped);
      this.readyResolve = null;
      this.readyReject = null;
    }
    for (const cb of this.crashListeners) {
      try { cb(wrapped); } catch { /* ignore */ }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
  }

  private async waitForDrain(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (this.pending.size > 0) {
      if (Date.now() - start > timeoutMs) {
        throw new CloseTimeoutError(
          `drain timeout after ${timeoutMs}ms (${this.pending.size} pending)`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

// ─── 工具 ───

function stripEmbedding(config: ZvecEngineConfig): Omit<ZvecEngineConfig, 'embedding'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { embedding: _ignored, ...rest } = config;
  return rest;
}
