/**
 * 分页通用算法（客户端分页共用）
 *
 * 从任务页本地实现抽到此处（2026-11-16 分类页需要同样的页码直达）：
 * 行为与原实现完全一致——首页 / 次页 / 末页前一页 / 末页恒在，当前页 ±1 恒在，
 * 其余中段折叠成 `…`。>7 页时折叠是为保证分页条不换行（窄屏尤其明显）。
 *
 * 每页条数不在此处定义：数据源页 / 任务页默认 10、分类页默认 20，
 * 三者的行高与信息密度不同，默认值属于各页面口径。
 */
export function pageNumbers(page: number, pageCount: number): Array<number | '…'> {
  const items: Array<number | '…'> = [];
  for (let i = 1; i <= pageCount; i += 1) {
    if (pageCount > 7 && i > 2 && i < pageCount - 1 && Math.abs(i - page) > 1) {
      if (items[items.length - 1] !== '…') items.push('…');
      continue;
    }
    items.push(i);
  }
  return items;
}
