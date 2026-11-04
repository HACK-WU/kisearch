/**
 * lastView.ts —— 记住「最近一次使用的视图」（REQ-20261104-003 / S-05）
 *
 * 为什么需要：库节点上的「进入 ↗」会调 `setScope()` 持久化到 localStorage。
 * 用户「进某个库看一眼」之后，下次打开 Web 会停在那个单库而不是视图。
 * 这里用 **sessionStorage** 记住最近一次视图，顶栏据此给出「↩ 回到视图」软入口——
 * 关掉标签页就忘，不污染长期偏好。
 */

const KEY = 'ki-web:lastView';

/** 切到单库前调用，记住来路 */
export function rememberView(view: string): void {
  if (!view) return;
  try {
    sessionStorage.setItem(KEY, view);
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

/** 读取最近视图；无记录返回 null */
export function getLastView(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** 视图已被删除时清除，避免顶栏给出一个点了会报错的入口 */
export function clearLastView(view: string): void {
  try {
    if (sessionStorage.getItem(KEY) === view) sessionStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}
