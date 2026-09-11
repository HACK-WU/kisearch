import os from 'node:os';

export interface OperationRequest {
  operation: string;
  params: unknown;
}

export interface OperationResult<T = unknown> {
  result: T;
  queue: { scope: string; queuedMs: number; runMs: number; activeWorkers: number; maxWorkers: number };
}

type Handler = (params: any) => Promise<unknown> | unknown;
interface Pending {
  request: OperationRequest;
  handler: Handler;
  /**
   * 本任务占用的 scope 集合。
   * - 普通任务：其触及的 scope 列表（多 scope 检索 = 涉及的全部分片）
   * - GLOBAL_SCOPE：需要独占全部 scope 的操作（如存量迁移）
   * - 空数组：只读通道，不与任何 scope 互斥（如 scope 枚举，自带 fastFail 降级）
   */
  scopes: string[];
  enqueuedAt: number;
  resolve: (value: OperationResult) => void;
  reject: (reason: unknown) => void;
}

/**
 * 需要独占全部 scope 的哨兵。
 * 注意：它同时是 validateScope 的保留字（见 lib/scope.ts），用户 scope 不得同名，
 * 否则该 scope 的请求会被误判为全局独占操作，与所有其他 scope 互相阻塞。
 */
export const GLOBAL_SCOPE = '__global__';

/**
 * 业务级调度器：同 scope 串行、不同 scope 有界并行。
 *
 * 互斥判据是「scope 集合是否相交」，而不是「是否存在等待中的全局任务」：
 * 一个待执行的全局任务只阻止新的全局任务与新的分片任务启动条件成立，
 * 不会冻结与它无关的 scope。此前实现用 `if (activeWorkers > 0) return` 冻结
 * 整个 pump，导致一次 scope 枚举就能把无关 scope 的 30ms 短写拖到 4.5s
 *（实测 149 倍），违反「不同 scope 在资源允许时可重叠执行」。
 */
export class OperationCoordinator {
  readonly maxWorkers: number;
  /**
   * 全局独占任务的防饥饿宽限期（ms）。
   *
   * 全局任务要求 activeWorkers === 0 才能启动。若在它排队期间仍无限制地启动
   * 新普通任务，持续写流量会让它永远等不到窗口（饥饿）—— 而客户端对迁移等
   * 长任务已取消超时，饥饿会表现为命令永久挂起，比队头阻塞更糟。
   * 宽限期内不冻结普通 scope（保住“无关 scope 不被拖慢”），超期后停止启动
   * 新的普通任务，让在跑任务自然收敛，全局任务随后独占执行。
   * 可经构造函数调小以便测试。
   */
  readonly globalGraceMs: number;
  /** 单一 FIFO 队列；按 enqueuedAt 顺序取第一个「与在跑任务不冲突」的项。 */
  private readonly queue: Pending[] = [];
  /** scope → 在跑任务数。同一 scope 计数 >0 时该 scope 的新任务不得启动。 */
  private readonly running = new Map<string, number>();
  private globalRunning = false;
  private activeWorkers = 0;

  constructor(
    maxWorkers = Math.max(1, Math.min(4, os.cpus().length)),
    globalGraceMs = 5_000,
  ) {
    this.maxWorkers = maxWorkers;
    this.globalGraceMs = globalGraceMs;
  }

  submit(
    request: OperationRequest,
    handler: Handler,
    scopes: string | string[] = scopesOf(request.params, request.operation),
  ): Promise<OperationResult> {
    const normalized = normalizeScopes(scopes);
    return new Promise((resolve, reject) => {
      this.queue.push({ request, handler, scopes: normalized, enqueuedAt: Date.now(), resolve, reject });
      this.pump();
    });
  }

  snapshot(): { activeWorkers: number; maxWorkers: number; queues: Record<string, number> } {
    const queues: Record<string, number> = {};
    for (const item of this.queue) {
      const key = item.scopes.length > 0 ? item.scopes.join(',') : '(readonly)';
      queues[key] = (queues[key] ?? 0) + 1;
    }
    return { activeWorkers: this.activeWorkers, maxWorkers: this.maxWorkers, queues };
  }

  /** 待执行任务是否与在跑任务冲突（互斥即需继续排队）。 */
  private conflicts(item: Pending): boolean {
    // 全局独占任务在跑时，任何新任务都不得启动。
    if (this.globalRunning) return true;
    // 全局独占任务要求所有分片空闲；只读任务（空集合）无需等待，可与之并行前的窗口执行。
    if (item.scopes.includes(GLOBAL_SCOPE)) return this.activeWorkers > 0;
    // 只读通道不与任何 scope 互斥，仅受 maxWorkers 上限约束。
    if (item.scopes.length === 0) return false;
    return item.scopes.some((scope) => (this.running.get(scope) ?? 0) > 0);
  }

  private acquire(item: Pending): void {
    this.activeWorkers++;
    if (item.scopes.includes(GLOBAL_SCOPE)) {
      this.globalRunning = true;
      return;
    }
    for (const scope of item.scopes) this.running.set(scope, (this.running.get(scope) ?? 0) + 1);
  }

  private release(item: Pending): void {
    this.activeWorkers--;
    if (item.scopes.includes(GLOBAL_SCOPE)) {
      this.globalRunning = false;
      return;
    }
    for (const scope of item.scopes) {
      const left = (this.running.get(scope) ?? 0) - 1;
      if (left > 0) this.running.set(scope, left);
      else this.running.delete(scope);
    }
  }

  private pump(): void {
    while (this.activeWorkers < this.maxWorkers) {
      // 防饥饿：找到排队中的全局独占任务，判定它是否已等超宽限期。
      const pendingGlobal = this.queue.find((item) => item.scopes.includes(GLOBAL_SCOPE));
      const frozen = pendingGlobal !== undefined
        && Date.now() - pendingGlobal.enqueuedAt >= this.globalGraceMs;
      // 取「最早的、不与在跑任务冲突」的任务：同 scope 的后继任务因冲突被跳过，
      // 天然保持该 scope 内的 FIFO；不同 scope 之间无顺序约束，可并行。
      // 冻结期内只放行全局任务本身（否则 activeWorkers 归零后仍无法启动 → 死锁）。
      const index = this.queue.findIndex((item) => {
        if (this.conflicts(item)) return false;
        if (frozen && !item.scopes.includes(GLOBAL_SCOPE)) return false;
        return true;
      });
      if (index < 0) return;
      const [next] = this.queue.splice(index, 1);
      this.acquire(next);
      void this.run(next);
    }
  }

  private async run(item: Pending): Promise<void> {
    const queuedMs = Date.now() - item.enqueuedAt;
    const startedAt = Date.now();
    let result: unknown;
    let failure: unknown;
    let failed = false;
    try {
      result = await item.handler(item.request.params);
    } catch (err) {
      failed = true;
      failure = err;
    }
    // 先释放占用再计算指标：回传的 activeWorkers 不包含自己，
    // 否则客户端看到的并发数恒虚高 1，且语义无处声明。
    this.release(item);
    const queue = {
      scope: item.scopes.length > 0 ? item.scopes.join(',') : '(readonly)',
      queuedMs,
      runMs: Date.now() - startedAt,
      activeWorkers: this.activeWorkers,
      maxWorkers: this.maxWorkers,
    };
    if (failed) item.reject(failure);
    else item.resolve({ result, queue });
    this.pump();
  }
}

let shared: OperationCoordinator | null = null;
export function getSharedOperationCoordinator(): OperationCoordinator {
  return shared ??= new OperationCoordinator();
}

function normalizeScopes(scopes: string | string[]): string[] {
  const list = Array.isArray(scopes) ? scopes : [scopes];
  const cleaned = list
    .filter((scope): scope is string => typeof scope === 'string')
    .map((scope) => scope.trim())
    .filter(Boolean);
  // 去重保序：重复 scope 会让占用计数虚增，释放时无法归零。
  return [...new Set(cleaned)];
}

/**
 * 从请求参数推导任务占用的 scope 集合。
 *
 * 与旧的单值 scopeOf 的区别：多 scope 请求返回其**涉及的全部分片**而非全局哨兵，
 * 因此只与这些分片互斥，不再冻结无关 scope。只有真正需要跨全部 scope 独占的
 * 操作（存量迁移）才归入 GLOBAL_SCOPE。
 */
export function scopesOf(params: any, operation = ''): string[] {
  if (typeof params?.scope === 'string' && params.scope.trim()) {
    return normalizeScopes(params.scope.split(','));
  }
  if (Array.isArray(params?.scopes)) {
    const list = normalizeScopes(params.scopes);
    if (list.length > 0) return list;
  }
  // 存量迁移会创建/读取所有 scope 的 Collection，必须独占。
  if (operation === 'migrate-vector') return [GLOBAL_SCOPE];
  // scope 枚举只读，且自带 fastFail 撞锁降级（不应因向量锁挂起十余秒）；
  // 归入只读通道，不与任何 scope 的写操作互相阻塞。
  if (operation === 'scope-list') return [];
  return ['default'];
}

/** 兼容旧调用方（日志、单值场景）：多 scope 以逗号连接，只读通道返回 GLOBAL_SCOPE。 */
export function scopeOf(params: any, operation = ''): string {
  const scopes = scopesOf(params, operation);
  return scopes.length > 0 ? scopes.join(',') : GLOBAL_SCOPE;
}
