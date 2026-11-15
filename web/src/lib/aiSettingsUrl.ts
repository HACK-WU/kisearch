/**
 * AI 设置页的 URL 口径（2026-11-15）
 *
 * 为什么单独一处：这条路径有 **4 个写入方**（顶栏 toggle / 对话面板「配置」/ 事件页两处就近深链）
 * 和 **2 个读取方**（设置页的「←」、顶栏再次点击关闭）。各自拼字符串必然漂移 ——
 * 典型症状是"从面板进来能返回、从事件页进来回不去"，或者 `from` 嵌套成 `.from 里套 from`。
 *
 * `from` 只接受**站内绝对路径**：挡掉 `//host`（协议相对）与外部地址，
 * 否则返回按钮就成了开放重定向。
 */

export const AI_SETTINGS_PATH = '/settings/ai';

/** 无 `from` 时的返回目标（用户从地址栏直接进入 / 刷新后的兜底） */
export const AI_SETTINGS_DEFAULT_BACK = '/governance/events';

/** 能力分组（与页面左栏、`?cap=` 取值同源） */
export type AiCapability = 'chat' | 'analysis' | 'find';

export function isAiSettingsPath(pathname: string): boolean {
  return pathname === AI_SETTINGS_PATH || pathname.startsWith(`${AI_SETTINGS_PATH}/`);
}

/** 拼进入设置页的地址；`from` 由调用方传当前地址 */
export function aiSettingsHref(opts: { from?: string; cap?: AiCapability } = {}): string {
  const q = new URLSearchParams();
  if (opts.cap) q.set('cap', opts.cap);
  if (opts.from) q.set('from', opts.from);
  const search = q.toString();
  return search ? `${AI_SETTINGS_PATH}?${search}` : AI_SETTINGS_PATH;
}

/** 返回目标解析：只放行站内绝对路径，其余一律回默认页 */
export function resolveAiSettingsBack(from: string | null): string {
  if (!from) return AI_SETTINGS_DEFAULT_BACK;
  if (!from.startsWith('/') || from.startsWith('//')) return AI_SETTINGS_DEFAULT_BACK;
  return from;
}
