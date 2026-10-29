/**
 * searchHistory.ts —— 语义检索「最近检索」的本地历史归一化
 *
 * 去重身份只取「查询语句 + 标签组」，**不含检索模式（混合 / 全文）**：
 *   - 展示视角：历史 chip 只渲染 query 文本，同一 query 的两种模式会显示成两条一模一样的
 *     记录（用户看不到区别，只能靠 hover tooltip 分辨）——即「混合 + 全文搜同一句话 = 重复」；
 *   - 使用视角：同一 query 的两种模式共享同一检索意图，保留**最近一次执行**的参数即可，
 *     想换模式直接点上方模式按钮，不需要靠历史区分。
 * 标签仍参与身份（但顺序归一）：它显著改变检索范围（精确过滤 vs 默认 ki-search），
 * 丢标签会让「重跑」变成另一条检索；而后端 tags 是 OR 集合语义，顺序本身无含义。
 *
 * 这些函数是纯函数，便于单测（见 web/test/search-history-dedupe.test.mjs）。
 */

/** 参与去重身份的最小字段集（mode / threshold / limit 只是执行参数，不参与） */
export interface SearchHistoryIdentityShape {
  query: string;
  /** 空数组表示使用默认 ki-search 标签。 */
  selectedTags: string[];
}

/**
 * 去重身份键：查询语句 + 标签组。
 *
 * 标签先按字典序归一：后端 `ki_search` 的 tags 是「逗号分隔、OR 组合」的集合语义
 * （`src/lib/mcp-tools/search.ts`），勾选顺序不承载任何含义；不归一的话
 * 「先点 A 再点 B」与「先点 B 再点 A」会各留一条 chip 文本完全相同的记录，等于重复没修净。
 * 归一只用于比较，条目里仍存用户实际的勾选顺序。
 */
export function searchHistoryIdentity(entry: SearchHistoryIdentityShape): string {
  return JSON.stringify([entry.query, [...entry.selectedTags].sort()]);
}

/**
 * 插入一条新记录：同身份的旧记录被替换（保留最近一次执行），并截断到上限。
 * 返回值即为应落盘的新数组。
 */
export function upsertSearchHistory<T extends SearchHistoryIdentityShape>(
  entry: T,
  previous: readonly T[],
  limit: number,
): T[] {
  const identity = searchHistoryIdentity(entry);
  return [entry, ...previous.filter((item) => searchHistoryIdentity(item) !== identity)].slice(0, limit);
}

/** 删除一条记录：同身份的所有副本一并删除（兼容修复前遗留的跨模式重复数据）。 */
export function removeSearchHistoryEntry<T extends SearchHistoryIdentityShape>(
  target: T,
  entries: readonly T[],
): T[] {
  const identity = searchHistoryIdentity(target);
  return entries.filter((item) => searchHistoryIdentity(item) !== identity);
}

/**
 * 读取归一化：修复前落盘的老数据里，同一 query 的混合 / 全文各存一条；
 * 读取时按「先出现者胜」（数组本身按 savedAt 降序）收敛成一条，用户无需重跑即可消除重复展示。
 */
export function dedupeSearchHistory<T extends SearchHistoryIdentityShape>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of entries) {
    const identity = searchHistoryIdentity(entry);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(entry);
  }
  return result;
}
