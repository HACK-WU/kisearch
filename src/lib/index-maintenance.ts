/**
 * index-maintenance.ts —— 索引整理（optimize）编排：**进程内单飞** + 状态 + 等待原语
 *
 * S-01（REQ-20261009-003；Q2/Q4 已拍板）：
 *   - 触发点：导入收尾（由 CLI / HTTP job 调用 `scheduleIndexMaintenance`）
 *   - 并发：**进程内**同时只跑一个 scope（全局 ≤1）。同 scope 的跨进程并发已被 collection
 *     flock 排除；**不同 scope 的跨进程并发**为已知限制（父文档 G9，非正确性问题），
 *     仅当出现"两进程同时整理"的实测证据时才补跨进程锁。
 *   - 队列语义：经 `getSharedOperationCoordinator().submit(..., 'engine-only')` 入队
 *     ⇒ 与写任务互斥、被 read 旁路（不阻塞页面）；
 *     ★ kind **显式传参**（不依赖 `kindForOperation` 推导，那里只认 `import`）。
 *   - 失败/超时：只记录降级结果，**不判任务失败**；重试入口见 `ki index-optimize`。
 */
import { getSharedOperationCoordinator } from './operation-coordinator.js';
import { loadConfig } from './config.js';
import { optimizeVectorIndex, vectorCollectionDiagnostics, type OptimizeIndexOutcome } from './vector-client.js';

export interface IndexMaintenanceLast {
  scope: string;
  at: number;
  ok: boolean;
  wallMs: number;
  degraded?: 'timeout' | 'unavailable' | 'error';
  reason?: string;
  /** 执行进程 pid：用于事后识别"是否出现跨进程并发整理"（G9 的重评判据） */
  pid: number;
}

export interface IndexMaintenanceState {
  running: string | null;
  queued: string[];
  last?: IndexMaintenanceLast;
  /** 配置口径（便于诊断） */
  config: { enabled: boolean; concurrency?: number; timeoutMs: number };
}

/** 配置读取（缺省：enabled=true / concurrency 未指定=引擎自动 / timeoutMs=600s） */
function readOptimizeConfig(): IndexMaintenanceState['config'] {
  try {
    const raw = loadConfig() as unknown as {
      vector?: { optimize?: { enabled?: boolean; concurrency?: number; timeoutMs?: number } };
    };
    const o = raw.vector?.optimize;
    return {
      enabled: o?.enabled !== false,
      ...(o?.concurrency !== undefined ? { concurrency: Number(o.concurrency) } : {}),
      timeoutMs: o?.timeoutMs !== undefined ? Number(o.timeoutMs) : 600_000,
    };
  } catch {
    // 配置加载失败不应阻断整理：按缺省口径继续（loadConfig 自身会在别处 fail-loud）
    return { enabled: true, timeoutMs: 600_000 };
  }
}

let running: string | null = null;
const queued: string[] = [];
let last: IndexMaintenanceLast | undefined;

/**
 * 入队一次索引整理（幂等合并）。
 * @returns `accepted` 是否接受（enabled=false 时为 false）；`merged` 是否与已有任务合并
 */
export function scheduleIndexMaintenance(
  scope: string,
  _opts: { reason?: 'import' | 'manual' } = {},
): { accepted: boolean; merged: boolean } {
  const config = readOptimizeConfig();
  if (!config.enabled) return { accepted: false, merged: false };
  if (running === scope) return { accepted: true, merged: true };
  if (queued.includes(scope)) return { accepted: true, merged: true };
  if (running !== null) {
    queued.push(scope);
    return { accepted: true, merged: false };
  }
  void runOne(scope, config);
  return { accepted: true, merged: false };
}

async function runOne(scope: string, config: IndexMaintenanceState['config']): Promise<void> {
  running = scope;
  const startedAt = Date.now();
  let outcome: OptimizeIndexOutcome;
  try {
    // ★ kind 显式传 'engine-only'：与写互斥、被 read 旁路。
    const res = await getSharedOperationCoordinator().submit(
      { operation: 'vector-optimize', params: { scope } },
      () => optimizeVectorIndex(scope, {
        ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
        timeoutMs: config.timeoutMs,
      }),
      [scope],
      'engine-only',
    );
    outcome = res.result as OptimizeIndexOutcome;
  } catch (err) {
    outcome = { ok: false, degraded: 'error', reason: (err as Error).message, waitedMs: Date.now() - startedAt };
  }
  last = {
    scope,
    at: Date.now(),
    ok: outcome.ok,
    wallMs: outcome.ok ? outcome.wallMs : outcome.waitedMs,
    ...(outcome.ok ? {} : { degraded: outcome.degraded, reason: outcome.reason }),
    pid: process.pid,
  };
  running = null;
  const next = queued.shift();
  if (next) void runOne(next, config);
}

/** 当前单飞状态（HTTP `/api/import/status` 与控制台诊断共用） */
export function getIndexMaintenanceState(): IndexMaintenanceState {
  return {
    running,
    queued: [...queued],
    ...(last ? { last } : {}),
    config: readOptimizeConfig(),
  };
}

/** 等待当前与排队中的整理全部落定（CLI 等待 / 测试用；超时到点即返回，不中断整理） */
export async function whenIndexMaintenanceIdle(timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((running !== null || queued.length > 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * S-03 / A11：索引就绪判据 —— **索引实体（dense 实体 ≥ 1）为主**，引擎信号仅作参考。
 *
 * 为什么必须交叉：`indexCompleteness`（引擎自报信号）在实际数据上恒为 0（Q7 已核定），
 * 只看它会把"索引其实已建"误判成"从未建"；只看实体则无法发现"实体是旧的"。
 * 故两者一并给出，由调用方（任务 / 任务中心 / doctor）交叉判断。
 *
 * **永不抛错**：读取失败一律 `unknown: true`（诊断不得阻断业务，也不得被当作"未建"）。
 */
export interface IndexReadiness {
  /** 主判据：dense 索引实体是否已存在 */
  denseIndexed: boolean;
  /** 参考信号：引擎自报完整度（**不可单独作判据**） */
  completeness?: { dense?: number; fts?: number; scalar?: number };
  /** 读取失败/超时：判据未知（≠ 未建） */
  unknown?: boolean;
  reason?: string;
}

/** 见 `IndexReadiness` 说明。`timeoutMs` 默认 5s（诊断级读取，超时即 unknown）。 */
export async function readIndexReadiness(
  scope: string,
  opts: { timeoutMs?: number } = {},
): Promise<IndexReadiness> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  try {
    let timer: NodeJS.Timeout | undefined;
    const diag = await Promise.race([
      vectorCollectionDiagnostics(scope),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`索引就绪读取超时（${timeoutMs}ms）`)), timeoutMs);
        timer.unref?.();
      }),
    ]) as { indexCompleteness?: { dense?: number; fts?: number; scalar?: number } };
    clearTimeout(timer);
    const c = diag?.indexCompleteness;
    return {
      denseIndexed: (c?.dense ?? 0) >= 1,
      ...(c ? { completeness: c } : {}),
    };
  } catch (err) {
    return { denseIndexed: false, unknown: true, reason: (err as Error).message };
  }
}

/** 仅供测试：清空内部状态（防止跨用例串扰） */
export function __resetIndexMaintenanceForTest(): void {
  running = null;
  queued.length = 0;
  last = undefined;
}
