/**
 * util.ts —— MCP 工具层公共辅助（NEG-14）
 *
 * MCP 是长驻进程：单个工具调用若因向量库撞锁、embedding provider 挂起、
 * 超大文件同步读等原因长时间不返回，会阻塞该 server 的后续请求且无反馈。
 *
 * withTimeout 为工具处理器包裹一个超时上界：超时即以可读错误返回，
 * 避免请求无限期挂起（底层任务仍可能在后台完成，但调用方不再被阻塞）。
 */

/** 超时错误：便于上层区分「超时」与「业务失败」 */
export class ToolTimeoutError extends Error {
  code = 'TOOL_TIMEOUT' as const;
  constructor(label: string, ms: number) {
    super(`工具 ${label} 执行超过 ${ms}ms 超时。若向量库被占用或 embedding 服务无响应，请稍后重试或检查服务状态`);
    this.name = 'ToolTimeoutError';
  }
}

/**
 * 为 Promise 附加超时上界。超时后 reject（ToolTimeoutError），
 * 并清理定时器避免长驻进程句柄泄漏。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeoutError(label, ms)), ms);
    // 不阻止进程退出
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** 工具超时预设（毫秒） */
export const TOOL_TIMEOUT = {
  /** 只读/轻量查询 */
  READ: 30_000,
  /** 单条写入 / 语义检索（含一次 embedding） */
  WRITE: 60_000,
  /** 批量写入（多条 embedding + 向量批写） */
  BULK: 300_000,
  /**
   * 一次性问答（`ki_ask`，REQ-20261113-001）。
   *
   * 取值依据：内部硬预算 45s（`ASK_HARD_BUDGET_MS`）+ 序列化/网络余量。
   * ⚠️ **不得**提高到接近或超过 60s —— MCP 客户端的 `tools/call` 硬超时就是 60s
   *   （SDK `DEFAULT_REQUEST_TIMEOUT_MSEC`），超过后客户端先失败、服务端仍在烧 token。
   * ⚠️ **不得**沿用 `READ`（30s）：正常 6 轮问答可达 25~30s，会被误杀。
   */
  ASK: 50_000,
} as const;
