/**
 * searchUrl.ts —— 语义检索页检索态 ⇄ URL 查询串。
 *
 * 与浏览页的文档深链接同理：查询词、模式、标签、阈值、条数与结果都是组件 state，刷新即丢。
 * 这里只把「最近一次**已执行**的检索」写进 URL —— 刷新后按同一组参数自动重跑，链接可复制分享。
 *
 * 约定：
 * - `q` 是唯一必填参数；缺 `q` 视为「非检索态」（浏览入口），解析返回 null。
 * - `hybrid`、`threshold=0`、`limit=10`、空 tags 都是默认值，写出时省略，URL 保持简短。
 * - `scope` 参数不属于检索态：跨页深链用它切 scope，写入时原样保留 / 清空由调用方决定。
 */

export interface SearchUrlState {
  query: string;
  mode: 'hybrid' | 'fulltext';
  tags: string[];
  threshold: number;
  limit: number;
}

export const DEFAULT_SEARCH_LIMIT = 10;

/** 解析 URL 上的检索态；无查询词 / 参数不可用时返回 null（调用方不自动检索）。 */
export function parseSearchUrl(search: string): SearchUrlState | null {
  const params = new URLSearchParams(search);
  const query = (params.get('q') ?? '').trim();
  if (!query) return null;
  const rawThreshold = Number(params.get('threshold'));
  const rawLimit = Number(params.get('limit'));
  return {
    query,
    mode: params.get('mode') === 'fulltext' ? 'fulltext' : 'hybrid',
    tags: parseTags(params.get('tags')),
    // 阈值与条数是检索参数而非定位信息：非法值一律退回默认，避免脏 URL 触发一次莫名查询
    threshold: Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 0,
    limit: Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 1000 ? rawLimit : DEFAULT_SEARCH_LIMIT,
  };
}

/** 逗号分隔 tags：去空、去重（与后端 tags 的 OR 集合语义一致，顺序无含义）。 */
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((tag) => tag.trim()).filter(Boolean))];
}

/**
 * 由检索态构造查询串（不含 `?`）。
 * `state` 为 null → 产出空串（调用方据此清掉检索参数）；`scopeParam` 非空时原样带上。
 */
export function searchUrlSearch(state: SearchUrlState | null, scopeParam?: string | null): string {
  const params = new URLSearchParams();
  if (state) {
    params.set('q', state.query);
    if (state.mode === 'fulltext') params.set('mode', 'fulltext');
    if (state.tags.length > 0) params.set('tags', state.tags.join(','));
    if (state.threshold > 0) params.set('threshold', String(state.threshold));
    if (state.limit !== DEFAULT_SEARCH_LIMIT) params.set('limit', String(state.limit));
  }
  if (scopeParam) params.set('scope', scopeParam);
  return params.toString();
}
