/**
 * AI 对话面板开合态 ⇄ URL 查询串（`chat=1`）。
 *
 * ═══ 为什么是 URL（2026-10-14 用户裁决，取代 localStorage）═══
 * 原实现把开合态写进 localStorage（同源**跨标签页共享**）⇒ 两个标签页各自全屏 + 开着对话时，
 * 其中一个关掉对话，另一个**刷新后也被关掉**（用户报的 Bug，运行时已复现）。
 * localStorage 只会在刷新那一刻被读一次，两个标签页无法各持一份。
 * 面板开合是「这一页正在用哪个面板」的一部分，与全屏阅读标记 `reader=1`（lib/browseUrl.ts）同类：
 * 放进 URL 后每个标签页各持一份，刷新按自己的地址恢复，互不影响。
 *
 * ═══ 与 store 的分工 ═══
 * 渲染态仍驻留 chatStore（D15：关闭 = 隐藏不卸载，不丢对话态），URL 是它的**镜像 + 跨刷新载体**：
 * · 站内跳转（导航链接不带参数）不会关掉面板 —— AppShell 会把标记补回当前地址；
 * · 首次挂载（刷新 / 新标签页打开带 `chat=1` 的链接）以 URL 为准。
 *
 * ═══ 降级约定 ═══
 * 只有 `'1'` 视为打开；缺失 / 其它值（手改的脏 URL）一律按关闭，与「面板默认关闭」口径一致。
 */

/** URL 查询串中标记「AI 对话面板打开」的参数名 */
export const CHAT_OPEN_PARAM = 'chat';

/** 从查询串读取开合标记（缺省 / 非 `1` 一律为否）。 */
export function chatOpenFromSearch(search: string): boolean {
  return new URLSearchParams(search).get(CHAT_OPEN_PARAM) === '1';
}

/**
 * 把开合标记并入查询串：打开写 `chat=1`，关闭移除（不写 `chat=0`，与 `reader` 一样保持 URL 干净）。
 *
 * **必须保留其它参数**（浏览页的 scope/group/relation/anchor、全屏的 `reader` 等）——
 * 面板开合与页面定位无关，合并写才不会把当前页面的地址抹掉。
 */
export function withChatOpenParam(search: URLSearchParams | string, open: boolean): URLSearchParams {
  const next = new URLSearchParams(search);
  if (open) next.set(CHAT_OPEN_PARAM, '1');
  else next.delete(CHAT_OPEN_PARAM);
  return next;
}
