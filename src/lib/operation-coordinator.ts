import os from 'node:os';

export interface OperationRequest {
  operation: string;
  params: unknown;
}

/**
 * 任务类型（REQ-20261009-003 S-01 队列分层）：
 * - `write`（默认）：普通任务（含短写与其它引擎操作），与同 scope 的其它任务互斥。
 * - `engine-only`：**长引擎任务**（如导入），其元数据写入全部包在 `runMetadataCommit`
 *   窗口内。它仍与其它 write/engine-only 互斥，但 **不阻塞 `read` 任务**——
 *   这正是"导入期间仍可浏览"的关键。
 *   ⚠️ 只有真正满足"元数据写全在提交窗口内"的任务才能用它；否则读会与元数据写并发。
 * - `read`：**纯元数据读**（不打开 zvec），与同 scope 的 `write` 任务、以及
 *   「元数据提交窗口」互斥，但可旁路 `engine-only` 长任务。仅当确知不触碰引擎时使用；
 *   `/tags` 这类会打开 zvec 的读仍须用 `write`。
 */
export type TaskKind = 'write' | 'read' | 'engine-only';

/**
 * 按 operation 名推导任务类型（S-01 的**默认规则**，kind 的唯一真相）。
 * - `import` → `engine-only`：导入的元数据写全部包在 `runMetadataCommit` 窗口内，
 *   其向量化长尾不应阻塞同 scope 的纯元数据读（`/doc/list`、`/doc/edit` GET）。
 * - 其余 → `write`（保守：未见"元数据写全部入窗"的操作一律不得旁路读，
 *   如 rebuild-vector / restore-snapshot / sync-relation）。
 *
 * ★ 为什么 `submit` 的缺省值走本函数、而不是硬编码 `'write'`：真实入口有两个 ——
 *   `daemon-rpc` 与 `mcp-http-api` 的 `runImportJob`。靠"每个入口记得传 kind"已经
 *   出过一次事故：daemon 入口标了 engine-only，HTTP 入口漏标，而现场报障链路
 *   （`/api/doc/list` 25s 超时）正是 HTTP。改为按 operation 推导后，任何入口
 *   （含未来新增）漏传参数都不会退回"读被导入阻塞"的旧语义。
 * 回归锚点：`test/coordinator-read-lane.test.ts` 用例 ⑨。
 */
export function kindForOperation(operation: string | undefined): TaskKind {
  // S-01/S-04（REQ-20261009-003 评审 #1）：**必须在此登记**新 operation，
  // 否则它会缺省落到 `write`（与 read 互斥）——索引整理会把刚放开的读又挡回去。
  // 登记依据：该类任务的元数据写全部包在提交窗口内（import），或本就不碰元数据
  //（vector-optimize 只调引擎 optimize）。
  return operation === 'import' || operation === 'vector-optimize' ? 'engine-only' : 'write';
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
   * - GLOBAL_SCOPE：需要独占全部 scope 的操作（如全量一致性快照）
   * - 空数组：只读通道，不与任何 scope 互斥（如 scope 枚举，自带 fastFail 降级）
   */
  scopes: string[];
  /** 任务类型：`read` = 纯元数据读，只与「元数据提交窗口」互斥（S-01） */
  kind: TaskKind;
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
   * 新普通任务，持续写流量会让它永远等不到窗口（饥饿）—— 而客户端对全局等
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
  /**
   * scope → 其中 `engine-only`（长引擎任务）的在跑数（REQ-20261009-003 S-01）。
   * `read` 任务可旁路这部分占用，但仍须等待非 engine-only 的写任务与提交窗口。
   */
  private readonly runningEngineOnly = new Map<string, number>();
  /**
   * 正在提交元数据的 scope → 嵌套深度（REQ-20261009-003 S-01）。
   * 只有 `read` 类型任务在该窗口内等待；窗口由 `runMetadataCommit`（异步）与
   * `withMetadataCommitSync`（同步，用于回滚等路径）包裹，通常秒级。
   * 用计数而非 Set：窗口可嵌套（Phase 4 的异步窗口内含同步窗口），内层退出不得提前放开。
   */
  private readonly committing = new Map<string, number>();
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
    // 缺省 kind 按 operation 名推导（见 `kindForOperation`）——不依赖调用点记得传参；
    // 需要 read 语义的调用点（`/doc/list` 等）仍须显式传 `'read'`。
    kind: TaskKind = kindForOperation(request.operation),
  ): Promise<OperationResult> {
    const normalized = normalizeScopes(scopes);
    return new Promise((resolve, reject) => {
      this.queue.push({ request, handler, scopes: normalized, kind, enqueuedAt: Date.now(), resolve, reject });
      this.pump();
    });
  }

  /**
   * **元数据提交窗口**（REQ-20261009-003 S-01）：窗口内同 scope 的 `read` 任务等待到窗口结束，
   * 避免读到"多文件半新半旧"的跨文件中间态；引擎类长任务（向量化/索引整理）既不占用
   * 该窗口、也不受它影响 —— 这是"导入期间仍可浏览"的关键。
   * 可重入：嵌套调用按深度计数，内层退出不提前放开。
   */
  async runMetadataCommit<T>(scope: string, run: () => Promise<T> | T): Promise<T> {
    this.enterCommit(scope);
    try {
      return await run();
    } finally {
      this.exitCommit(scope);
    }
  }

  /**
   * 同步版提交窗口：包裹**同步**的元数据写（如失败回滚路径里的 `restoreLocalKb` /
   * `persistTouchedGroups`）。这些写虽短，但若不入窗口，读就会与"删 KB / 重落分片"并发 —
   * 正是"列表里在、点开 404"的来源（challenger 质疑 C1）。
   */
  withMetadataCommitSync<T>(scope: string, run: () => T): T {
    this.enterCommit(scope);
    try {
      return run();
    } finally {
      this.exitCommit(scope);
    }
  }

  private enterCommit(scope: string): void {
    this.committing.set(scope, (this.committing.get(scope) ?? 0) + 1);
  }

  private exitCommit(scope: string): void {
    const left = (this.committing.get(scope) ?? 1) - 1;
    if (left > 0) this.committing.set(scope, left);
    else this.committing.delete(scope);
    this.pump();
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
    // S-01（REQ-20261009-003）→ S-04 I4（REQ-20261009-003 / Q6 拍板）：纯元数据读
    //   ① 与「元数据提交窗口」互斥（避免跨文件"半新半旧"）；
    //   ② **与其它一切在跑任务并行**（写任务、engine-only 长任务、任何挂住的请求）——
    //      现场二"一个挂住的请求把整库读挡死 >10 分钟"即由此消除；
    //   ③ 并发安全的前提是**写侧不变量 I1**（分片可见 ⇒ KB 可取）：
    //      新增/更新 = KB 先写、分片后写；**删除 = 分片先删、KB 后删**（`delete-relation.ts`
    //      与 `manage-index.ts` 已按此顺序修复），且两次写紧邻、整段在提交窗口内（I2）。
    //      回归：`test/read-write-concurrency.test.ts`（含旧顺序对照臂，必须检出 DIR E）。
    if (item.kind === 'read') {
      return item.scopes.some((scope) => (this.committing.get(scope) ?? 0) > 0);
    }
    return item.scopes.some((scope) => (this.running.get(scope) ?? 0) > 0);
  }

  private acquire(item: Pending): void {
    this.activeWorkers++;
    if (item.scopes.includes(GLOBAL_SCOPE)) {
      this.globalRunning = true;
      return;
    }
    for (const scope of item.scopes) {
      this.running.set(scope, (this.running.get(scope) ?? 0) + 1);
      if (item.kind === 'engine-only') {
        this.runningEngineOnly.set(scope, (this.runningEngineOnly.get(scope) ?? 0) + 1);
      }
    }
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
      if (item.kind === 'engine-only') {
        const leftEngine = (this.runningEngineOnly.get(scope) ?? 0) - 1;
        if (leftEngine > 0) this.runningEngineOnly.set(scope, leftEngine);
        else this.runningEngineOnly.delete(scope);
      }
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
 * 操作才归入 GLOBAL_SCOPE。
 */
export function scopesOf(params: any, operation = ''): string[] {
  if (typeof params?.scope === 'string' && params.scope.trim()) {
    return normalizeScopes(params.scope.split(','));
  }
  if (Array.isArray(params?.scopes)) {
    const list = normalizeScopes(params.scopes);
    if (list.length > 0) return list;
  }
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
