/**
 * recall/engine-search.ts —— 召回内核的生产检索适配器。
 *
 * 为什么不直接用 `events/refs-search.ts::createSearchAdapter`：
 *   那个适配器把 `mode` **写死成 `'hybrid'`**（它是给「AI 查找」用的，不需要备路全文检索），
 *   而召回内核的第 ④ 步要在命中过少时用 `fulltext` 补一轮。硬套会让备路静默变成主路。
 *
 * 与它保持一致的部分（别各写一套）：
 *   · `limit` = `executeSearch` 的 `topK`；
 *   · 缺 `group`/`relation` 的命中丢弃（辅助通道命中反查不到文件级 relation）；
 *   · 失败一律**抛异常**（不返回 `ok:false`），由内核按"该库失败"记账。
 */

import { executeSearch } from '../../search.js';
import type { RecallSearchFn } from './fast-recall.js';

export const engineRecallSearch: RecallSearchFn = async ({ scope, query, topK, mode }) => {
  const result = await executeSearch({
    scope,
    query,
    limit: topK,
    ...(mode ? { mode } : {}),
  });
  if (!result.ok) throw new Error(result.error);
  return {
    hits: result.results
      .filter((hit) => hit.group !== undefined && hit.relation !== undefined)
      .map((hit) => ({
        group: hit.group as string,
        name: hit.relation as string,
        score: hit.score,
      })),
    mode: result.mode ?? 'hybrid',
  };
};
