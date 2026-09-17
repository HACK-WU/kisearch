/**
 * 语义检索 query embedding 超时参数的统一契约。
 *
 * 对外的 CLI / MCP / Web 参数 `timeout` 使用秒；provider 内部继续使用毫秒。
 * 交互式 MCP 工具整体超时为 60s，因此 query embedding 超时也限制在 60s 内，
 * 避免预计算阶段可以无限期阻塞请求。
 */

export const DEFAULT_QUERY_EMBED_TIMEOUT_MS = 3_000;
export const MAX_QUERY_EMBED_TIMEOUT_MS = 60_000;

/** 秒级外部参数 → 毫秒级内部参数。 */
export function timeoutSecondsToMs(value: unknown, label = 'timeout'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} 必须是大于 0 的有限数字（单位：秒）`);
  }
  if (value < 0.001) {
    throw new Error(`${label} 必须是至少 0.001 秒的有限数字`);
  }
  const timeoutMs = Math.round(value * 1000);
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new Error(`${label} 必须不超过 ${MAX_QUERY_EMBED_TIMEOUT_MS / 1000} 秒`);
  }
  if (timeoutMs > MAX_QUERY_EMBED_TIMEOUT_MS) {
    throw new Error(`${label} 必须不超过 ${MAX_QUERY_EMBED_TIMEOUT_MS / 1000} 秒`);
  }
  return timeoutMs;
}

/** 配置字段校验：单位为毫秒，必须为 1–60000 的整数。 */
export function validateQueryTimeoutMs(value: unknown, path: string, add: (path: string, message: string) => void): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_QUERY_EMBED_TIMEOUT_MS) {
    add(path, `应为 1-${MAX_QUERY_EMBED_TIMEOUT_MS} 之间的正整数（单位：ms）`);
  }
}
