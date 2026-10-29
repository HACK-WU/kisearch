/**
 * 语义检索页的地址栏清理（**本页不再用 URL 记录检索态**）。
 *
 * ═══ 为什么只剩清理（2026-10-14 用户裁决）═══
 * 此前这里是「检索态 ⇄ URL」双向同步（`q`/`mode`/`tags`/`threshold`/`limit`）：检索后写入、
 * 刷新按同一组参数自动重跑、链接可复制分享。用户裁决改为：
 * **语义检索页不需要 `q` 参数，刷新就重置为干净的当页页面，不记录状态。**
 * 于是写出与恢复两条通路一并删除，只留下面这条**旧链接清理**：
 * 老书签 / 历史记录里仍带着 `?q=...`，不清掉地址栏与输入框会长期不一致
 * （用户最初报的现象就是「输入框已清空，URL 里 q 还在」）。
 *
 * `scope` 不属检索态：它是导入页等入口用的**跨页深链**参数（页面自己读取并切 scope）。
 */

/** 旧版检索态参数名：本页已不再消费，进页时从地址栏清掉 */
export const LEGACY_SEARCH_PARAMS = ['q', 'mode', 'tags', 'threshold', 'limit'] as const;

/**
 * 清理地址栏里「本页不再消费」或「已失效」的参数。
 *
 * 需要改动时返回**新的查询串**（不含 `?`），无需改动时返回 `null`（调用方据此跳过写回，
 * 避免每次进页都产生一次无谓的 replace 导航）。
 *
 * · 旧版检索参数（`q`/`mode`/`tags`/`threshold`/`limit`）：本页已不再消费 → 清掉；
 * · `scope` 与当前 scope **不一致**（用户手动切过 scope）→ 清掉，否则刷新会被切回旧 scope；
 *   与当前 scope 一致（跨页深链的有效入口）→ 保留；
 * · 其它参数（如 AI 面板的 `chat=1`）一律原样保留。
 */
export function cleanSearchUrl(search: string, scope: string): string | null {
  const params = new URLSearchParams(search);
  let changed = false;
  for (const key of LEGACY_SEARCH_PARAMS) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  const urlScope = params.get('scope');
  if (urlScope !== null && urlScope !== scope) {
    params.delete('scope');
    changed = true;
  }
  return changed ? params.toString() : null;
}
