/**
 * scopeReadonly.ts —— 只读 scope 的前端文案与派生工具（REQ-20261029-001）
 *
 * 文案集中在此，避免 6 处界面各写一份后漂移（尤其"导入与数据源同步仍可更新"这句
 * 最容易漏——漏了用户会认为功能坏了：只读库文档数居然还会涨）。
 */

/** 解除命令（提示条与 title 共用） */
export function scopeReadonlyUnlockHint(scope: string): string {
  return `ki scope readonly ${scope} --off`;
}

/** 徽标 / 图标 hover 说明 */
export function scopeReadonlyTitle(scope: string): string {
  return `只读知识库：禁止人工与 AI 逐条写入；ki import 与数据源同步仍可更新。解除：${scopeReadonlyUnlockHint(scope)}`;
}

/** 页面顶部提示条正文（上传导入 / 知识写入共用） */
export function scopeReadonlyNotice(scope: string): string {
  return `该库为只读：禁止人工与 AI 写入。更新请走数据源同步或 ki import；解除：${scopeReadonlyUnlockHint(scope)}`;
}

/** 进行中任务的补充说明（避免"只读了怎么还在变"的困惑） */
export const SCOPE_READONLY_INFLIGHT_HINT = '进行中的导入会继续完成，完成后不再接受新任务。';

/** 置灰按钮的 title（触屏无 hover，故页面提示条同时给出原因） */
export const SCOPE_READONLY_BLOCKED_HINT = '该知识库为只读，无法执行此操作';
