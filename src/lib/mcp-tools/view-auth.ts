/**
 * view-auth.ts —— 视图可见性过滤的**唯一事实源**（REQ-20261104-004 D3 / R-02）。
 *
 * 为什么必须是公共函数：`ki_scope_list` 与 `ki_view_list` 都要输出视图清单，
 * 两处各写一份过滤就会漂移 —— 只要有一处放宽成「或」，视图立刻变成越权通道
 * （给一个视图授权就等于给了它全部成员的内容）。
 *
 * 语义（**全有或全无，不做部分可见**）：**授权视图 ∧ 授权全部成员**，
 * 缺任一则整个视图不出现。
 *
 * ⚠️ 成员列表本身仍不过滤（看得到视图 = 看得到它的全部成员名）：
 *    隐藏库名会让前端的「来源库标记」无法解释，也会让浏览页拿不到成员的只读态。
 */

import { isScopeAuthorized } from '../mcp-token.js';
import type { ViewInfo } from '../../scope.js';

/**
 * 按授权集合过滤视图清单。
 *
 * @param views      视图全集（`buildViews()` 的产出）
 * @param authScopes 当前会话授权 scope 集合；`null` = 免鉴权 / 全量授权，不过滤
 * @returns 过滤后的清单；入参为 `undefined` 时原样返回 `undefined`
 *          （调用方据此区分「没有视图定义」与「有视图但被过滤光」，不得压成 `[]`）
 */
export function filterAuthorizedViews(
  views: ViewInfo[] | undefined,
  authScopes: string[] | null,
): ViewInfo[] | undefined {
  if (views === undefined) return undefined;
  if (authScopes === null) return views;
  return views.filter((v) =>
    isScopeAuthorized(authScopes, v.view)
    && v.members.every((m) => isScopeAuthorized(authScopes, m)));
}
