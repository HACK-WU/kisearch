/**
 * refs-search.ts —— 「AI 查找」的检索适配器（REQ-20261113-004 · S-05 §3.2）
 *
 * 为什么单独成文件：
 *   1. `refs-service` 只声明窄接口（不 import `search.ts`，避免循环依赖 + 测试要拖起整条检索栈）；
 *   2. 适配器里有**错误翻译**（引擎异常 → `SEARCH_UNAVAILABLE` 503），是可独立断言的逻辑，
 *      塞在 `governance-http.ts` 里就只能靠起 HTTP 服务验证；
 *   3. 注入 `exec` 后测试不需要真实 embedding / 向量库。
 *
 * 三条口径：
 *   · `topK` 传成 `executeSearch` 的 `limit`（chunk 级召回上限；文档级去重在 refs-service 做）；
 *   · **缺 `group` / `relation` 的命中丢弃** —— `ki-relation` / `ki-path` 辅助通道命中的 docId
 *     按设计不写 relations-cache，反查不到文件级 relation，给不出可加入的 (group, name)；
 *   · `ok:false` 与**抛异常**都翻成 `SEARCH_UNAVAILABLE`：`executeSearchLocal` 内部有 catch，
 *     但 daemon 通道（`callDaemon`）与引擎侧仍可能抛 —— 不接住就会漏成 500 无码错误。
 */

import { GovernanceError } from '../governance-errors.js';

/** 适配器需要的最小结果形状（`SearchHit` 结构化兼容） */
export interface AdapterHit {
  group?: string;
  /** relations-cache 反查出的文件级 relation 名，= refs.json 的 `name` */
  relation?: string;
  score: number;
  /**
   * 命中所属库（REQ-20261116-005）：多库 / 视图检索时 `executeSearch` 用它标注来源。
   * **必须保留** —— 丢掉它，跨库候选就无法回指源库（排序、可见性、引用写入全都会错）。
   */
  scope?: string;
}

export type AdapterSearchResult =
  | {
      ok: true;
      results: readonly AdapterHit[];
      /** 缺省按 hybrid（与 `executeSearch` 的语义一致：未标 fulltext 即 hybrid） */
      mode?: 'hybrid' | 'fulltext';
      degraded?: boolean;
      degradedReason?: string;
    }
  | { ok: false; error: string };

export type ExecuteSearchLike = (args: {
  scope?: string;
  query: string;
  limit?: number;
  mode?: 'hybrid' | 'fulltext';
}) => Promise<AdapterSearchResult>;

/** refs-service 的 `RefSearchDeps.search` 形状（本文件不 import 它，保持薄） */
export type RefSearchFn = (args: {
  scope: string;
  query: string;
  topK: number;
}) => Promise<{
  hits: Array<{ group: string; name: string; score: number }>;
  mode: 'hybrid' | 'fulltext';
  degraded?: boolean;
  degradedReason?: string;
}>;

export function createSearchAdapter(exec: ExecuteSearchLike): RefSearchFn {
  return async ({ scope, query, topK }) => {
    let result: AdapterSearchResult;
    try {
      result = await exec({ scope, query, limit: topK, mode: 'hybrid' });
    } catch (err) {
      throw new GovernanceError(
        'SEARCH_UNAVAILABLE',
        `向量检索不可用：${(err as Error).message}`,
      );
    }
    if (!result.ok) {
      throw new GovernanceError('SEARCH_UNAVAILABLE', `向量检索不可用：${result.error}`);
    }
    return {
      hits: result.results
        .filter((h) => h.group !== undefined && h.relation !== undefined)
        .map((h) => ({
          group: h.group as string,
          name: h.relation as string,
          score: h.score,
          // 视图检索时是成员库；单库时不带该字段（由调用方按 target 归一）
          ...(h.scope !== undefined ? { scope: h.scope } : {}),
        })),
      // mode / degraded 原样透出：面板据此显示"语义+全文 / 仅全文（已降级）"
      mode: result.mode ?? 'hybrid',
      ...(result.degraded ? { degraded: true } : {}),
      ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
    };
  };
}
