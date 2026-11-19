/**
 * 步骤耗时的统一显示口径（2026-11-19 用户要求：「大于 1 秒时用秒为单位」）。
 *
 * 之前三处各写一份 `\`${ms}ms\``：分析过程区、AI 查找过程区、工具调用行 ——
 * 于是预取跑了 39 秒，界面写的是 `19999ms`，没人愿意在脑子里做除法。
 *
 * 口径：
 *   · ≤0 → `<1ms`（后端不夹到 1ms，否则就是面板上编数字）
 *   · <1000ms → 原样毫秒（`337ms`），此时秒的小数位没有信息量
 *   · ≥1000ms → 秒；<10s 保留 1 位小数（`2.5s`），≥10s 取整（`39s`）
 *     —— 40 秒这一档的 0.1s 精度对用户没有意义，反而让数字抖。
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  const text = seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1).replace(/\.0$/, '');
  return `${text}s`;
}
