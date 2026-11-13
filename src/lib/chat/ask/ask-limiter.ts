/**
 * ask-limiter.ts —— `ki_ask` 的准入限流（REQ-20261113-001 · S-02 §3.2 / §4a.4）
 *
 * ═══ 为什么需要 ═══
 * 一次问答会消耗上游 LLM 额度（实测 36 轮可达 20~45 万 input tokens）。外部 AI 客户端
 * 完全可能循环调用 —— 没有上限就等于把额度控制权交给调用方。
 *
 * ═══ 两个维度，语义不同 ═══
 * | 维度 | 键 | 超限码 | 为什么 |
 * |---|---|---|---|
 * | **频率**（滑动窗口） | `(principalKey, scope)` | `ASK_RATE_LIMITED` | 防同一调用方把额度刷光；按 scope 分开，避免一个库的问答挤掉另一个库 |
 * | **并发**（全局在途） | 无 | `ASK_BUSY` | 单进程 daemon 的上游连接数有限；并发过高会拖慢**全站**（含对话与检索） |
 *
 * ═══ 为什么超限是"立即拒绝"而不是排队 ═══
 * 排队会把等待时间叠加到 45s 硬预算之上 —— 必然超过 MCP 客户端的 60s 硬超时，
 * 调用方拿到的是"超时"而不是"限流"，反而更难排查。
 *
 * ═══ 语义边界 ═══
 * · **窗口计数不回滚**：`releaseAskSlot()` 只减并发在途数。已发生的调用就该占额度，
 *   否则"调用失败就免费"会变成绕过限流的手段。
 * · **状态在进程内**：daemon 重启即清零（人为可接受，见 S-02 §6）。
 * · 阈值先硬编码为常量；需要运维调整时再提 `llm.askRateLimit` 配置项。
 */

/** 滑动窗口长度 */
const ASK_RATE_WINDOW_MS = 60_000;
/** 窗口内允许的问答次数（按 `principalKey + scope`） */
const ASK_RATE_MAX = 10;
/** 全局并发上限（daemon 单进程） */
const ASK_CONCURRENT_MAX = 2;
/** 并发满时的建议重试间隔（秒）：一次问答通常 7~30s，给 5s 避免调用方立刻打满 */
const ASK_BUSY_RETRY_SEC = 5;

/** 运行时阈值（测试可覆盖，生产用上面的常量） */
interface LimiterConfig {
  windowMs: number;
  rateMax: number;
  concurrentMax: number;
}

let config: LimiterConfig = {
  windowMs: ASK_RATE_WINDOW_MS,
  rateMax: ASK_RATE_MAX,
  concurrentMax: ASK_CONCURRENT_MAX,
};

/** `(principalKey, scope)` → 窗口内的时间戳 */
const windows = new Map<string, number[]>();
/** 全局在途计数 */
let inFlight = 0;
/** 每 N 次准入顺带清扫一次其它 key，避免 Map 随调用方数量无界增长 */
let sinceSweep = 0;
const SWEEP_EVERY = 50;

export type AskLimitDecision =
  | { ok: true }
  | { ok: false; code: 'ASK_RATE_LIMITED' | 'ASK_BUSY'; retryAfterSec: number };

function keyOf(principalKey: string, scope: string): string {
  return `${principalKey}\u0000${scope}`;
}

/** 丢弃窗口外的戳（原地裁剪） */
function prune(list: number[], now: number): void {
  const cutoff = now - config.windowMs;
  let i = 0;
  while (i < list.length && list[i]! <= cutoff) i += 1;
  if (i > 0) list.splice(0, i);
}

/** 清扫所有 key 的空窗口（Map 无界增长的兜底） */
function sweep(now: number): void {
  for (const [key, list] of windows) {
    prune(list, now);
    if (list.length === 0) windows.delete(key);
  }
}

/**
 * 申请一个问答槽位。
 *
 * ⚠️ 成功返回后**必须**在 `finally` 里调用 `releaseAskSlot()` —— 否则并发计数泄漏，
 *    最终所有调用都会被判 `ASK_BUSY`（S-02 §8 有专门的异常路径用例）。
 */
export function acquireAskSlot(principalKey: string, scope: string): AskLimitDecision {
  const now = Date.now();

  // ① 并发闸门优先：并发满时不必再看窗口（避免给调用方错误归因）
  if (inFlight >= config.concurrentMax) {
    return { ok: false, code: 'ASK_BUSY', retryAfterSec: ASK_BUSY_RETRY_SEC };
  }

  // ② 频率闸门
  const key = keyOf(principalKey, scope);
  const list = windows.get(key) ?? [];
  prune(list, now);
  if (list.length >= config.rateMax) {
    windows.set(key, list);
    const oldest = list[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + config.windowMs - now) / 1000));
    return { ok: false, code: 'ASK_RATE_LIMITED', retryAfterSec };
  }

  list.push(now);
  windows.set(key, list);
  inFlight += 1;

  sinceSweep += 1;
  if (sinceSweep >= SWEEP_EVERY) {
    sinceSweep = 0;
    sweep(now);
  }
  return { ok: true };
}

/** 释放并发槽位（**窗口计数不回滚**：已发生的调用就该占额度） */
export function releaseAskSlot(): void {
  if (inFlight > 0) inFlight -= 1;
}

/** 当前在途数（供审计与单测断言） */
export function askInFlight(): number {
  return inFlight;
}

/**
 * 单测用：重置窗口与并发计数，并可覆盖阈值。
 * ⚠️ 生产代码**不得**调用 —— 它会让限流形同虚设。
 */
export function resetAskLimiterForTest(override?: Partial<LimiterConfig>): void {
  windows.clear();
  inFlight = 0;
  sinceSweep = 0;
  config = {
    windowMs: override?.windowMs ?? ASK_RATE_WINDOW_MS,
    rateMax: override?.rateMax ?? ASK_RATE_MAX,
    concurrentMax: override?.concurrentMax ?? ASK_CONCURRENT_MAX,
  };
}
