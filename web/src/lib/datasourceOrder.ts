/**
 * 数据源列表的「冻结行序」（2026-10-30 用户定稿 D 方案）
 *
 * 背景：后端按「最久未同步在前」升序返回列表（`src/lib/datasource.ts` 的 registered.sort），
 * 于是某行同步完成后 lastSync 变成最新 → 立刻沉到最底；分页时还会跨页「消失」，
 * 用户会以为数据源跑丢了。
 *
 * 口径：首屏记下后端给的顺序，此后
 *  - 已存在的行**永不换位**（后端怎么重排都不影响）；
 *  - 新出现的 scope 追加到**末尾**；
 *  - 消失的 scope 从序列里剔除；
 *  - 刷新页面（组件重挂、序列清空）才重新按后端最新顺序排。
 */

/** 把后端本次返回的 scope 序列合并进已冻结的序列；顺序无变化时返回原引用（避免多余 re-render） */
export function mergeRowOrder(prev: readonly string[], scopes: readonly string[]): readonly string[] {
  const kept = prev.filter((scope) => scopes.includes(scope));
  const added = scopes.filter((scope) => !kept.includes(scope));
  const next = [...kept, ...added];
  const unchanged = next.length === prev.length && next.every((scope, index) => scope === prev[index]);
  return unchanged ? prev : next;
}

/**
 * 按冻结序列重排行数据。
 * ★ 不在序列里的行（列表刚返回、序列还没跟上）追加在末尾，
 *   避免整表先按后端顺序渲染一帧再突然归位。
 */
export function applyRowOrder<T extends { scope: string }>(order: readonly string[], rows: readonly T[]): T[] {
  if (order.length === 0) return rows.slice();
  const byScope = new Map(rows.map((row) => [row.scope, row] as const));
  const ordered: T[] = [];
  for (const scope of order) {
    const found = byScope.get(scope);
    if (found) ordered.push(found);
  }
  const known = new Set(order);
  for (const row of rows) {
    if (!known.has(row.scope)) ordered.push(row);
  }
  return ordered;
}
