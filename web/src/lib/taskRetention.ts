/**
 * 任务记录保留期的展示文案（前端唯一来源）。
 *
 * 为什么单独一个模块：保留期由后端唯一常量 `TASK_TTL_MS` 决定，经 `/api/tasks` 的
 * `retainedForMs` 下发。前端**不得**再硬编码「1 小时 / 7 天」——2026-11-02 把保留期
 * 从 1 小时调到 7 天时，散落在任务页、详情抽屉、详情模型里的硬编码文案全部变成了谎话，
 * 而接口里的 `retainedForMs` 当时**零消费方**。
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * 把保留期（毫秒）格式化为中文可读时长。
 *
 * 返回 `null` 表示「拿不到权威口径」（接口未返回 / 旧 daemon / 非法值）——
 * 调用方据此**省略**具体数值，而不是落一个猜出来的「1 小时」。
 */
export function formatRetention(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} 天`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} 小时`;
  if (ms < MINUTE_MS) return '不足 1 分钟';
  return `${Math.round(ms / MINUTE_MS)} 分钟`;
}
