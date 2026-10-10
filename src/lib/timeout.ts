/**
 * timeout.ts —— 「可降级的辅助读」超时上界（R8，REQ-20261009-003）。
 *
 * 与 `mcp-tools/util.ts` 的 `withTimeout` 分工不同：
 * - `withTimeout`：超时 = **异常**（抛 `ToolTimeoutError`，文案面向 MCP 工具调用）；
 * - 本函数：超时 = **预期结果之一**（返回 fallback + `timedOut` 标记）—— 用于"辅助读"
 *   这类可失败的操作：宁可给用户一个明确的"未知 / 陈旧"，也不能让请求无限挂住。
 *
 * ★ 三条硬约束：
 * 1. **超时不会取消底层操作**（Promise 无法取消）：底层若继续完成，其结果被忽略 ——
 *    因此只能用于**只读 / 幂等**操作，**不得用于写**（写被"放弃等待"后仍在跑，
 *    会让调用方以为已经结束）。
 * 2. **真实错误照旧上抛**：只有"超时"走降级，其它 rejection 原样抛给调用方，
 *    避免把故障掩盖成"未知"（N9）。
 * 3. **落败分支的 rejection 已由 `Promise.race` 消费**：race 会给参与的每个 promise
 *    挂 then-handler，故超时后底层再失败也不会成为 unhandledRejection（有用例覆盖）。
 *
 * ★ 判定"是否超时"用**哨兵错误实例**比较，而不是可变标志位：若用 `let timedOut = false`
 *   配合定时器回调置位，当 `work` 恰好与定时器在同一 tick 内 settle 时，会出现
 *   "**真实错误被误判为超时**"的竞争（把故障降级掩盖成未知）。哨兵以 `Promise.race`
 *   的**实际结果**为准，结构上不可能误判。
 */
export interface TimeoutFallbackResult<T> {
  value: T;
  /** true = 已超时，`value` 来自 fallback（调用方据此给出降级标记与日志） */
  timedOut: boolean;
  waitedMs: number;
}

/** 超时哨兵：只有它被 reject 才走降级（与 `work` 自身的错误严格区分） */
class TimeoutFallbackSignal extends Error {
  readonly code = 'TIMEOUT_FALLBACK';
  constructor(ms: number) {
    super(`操作未在 ${ms}ms 内完成`);
    this.name = 'TimeoutFallbackSignal';
  }
}

/**
 * 给 `work` 加超时上界：在 `ms` 内完成则返回其结果；超时则返回 `fallback()` 的结果
 * 并置 `timedOut=true`。
 *
 * - `fallback` 是**工厂函数**（惰性求值，未超时不调用）：避免"传值"与"传函数"的
 *   歧义（当 `T` 自身是函数类型时，`typeof fallback === 'function'` 会误判）。
 * - `work` 的**非超时错误**原样上抛，不降级；`fallback` 自身抛错同样上抛（调用方
 *   需保证 fallback 不会抛，例如传入的函数内部自带兜底）。
 */
export async function withTimeoutFallback<T>(
  work: Promise<T>,
  fallback: () => T,
  ms: number,
): Promise<TimeoutFallbackResult<T>> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutFallbackSignal(ms)), ms);
    // 不阻止进程退出（常驻服务里的辅助超时不应吊住事件循环）。
    // ★ 副作用：若 work 永不 settle 且进程内没有其它句柄，短命进程（CLI / 测试）
    //   会因事件循环空转而**提前退出** —— 此类调用方需自行保活（见 test/timeout.test.ts）。
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const value = await Promise.race([work, timeout]);
    return { value, timedOut: false, waitedMs: Date.now() - startedAt };
  } catch (error) {
    if (!(error instanceof TimeoutFallbackSignal)) throw error;
    return { value: fallback(), timedOut: true, waitedMs: Date.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
