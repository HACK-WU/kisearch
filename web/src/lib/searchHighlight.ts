/**
 * 检索结果的「文档内高亮」决策（REQ-20261014-003）。
 *
 * 判据一律基于**结果属性**：`resultMode`（产生当前结果的模式）与 `degraded`
 * （本次是否因向量失败降级为 BM25 全文）。**不得使用 `fullTextOnly`** —— 它是模式按钮的
 * 选择态（点了就变、不触发检索），会让"搜完混合 → 点全文不重搜"时开关与列表错位：
 * 那时列表仍是混合结果，却按全文把开关禁用并恒开高亮。
 *
 * | 情形 | 列表高亮 | 文档内高亮 | 打开时自动滚动 | 开关 |
 * | --- | --- | --- | --- | --- |
 * | 全文 | ✅ | ✅（恒开） | ✅（保持"定位到命中"语义） | 禁用 |
 * | 混合（未降级） | ❌ | 由开关决定 | ❌（Q8 裁决） | 可用 |
 * | 降级（混合 + 向量失败） | ✅（= 全文待遇） | 由开关决定（**不看降级**，Q2 裁决） | ❌ | 可用 |
 * | 未检索（`null`） | ❌ | —（无结果可打开） | — | **可用**（偏好可先设） |
 */

export type SearchResultMode = 'hybrid' | 'fulltext' | null;

export interface DocHighlightDecision {
  /** 结果列表摘要是否高亮（全文 **或** 降级） */
  listHighlight: boolean;
  /** 传给文档查看器的 `highlightQuery`：有值 = 打开即高亮；`undefined` = 不高亮 */
  docHighlightQuery: string | undefined;
  /** 开关是否禁用灰掉（全文 / 未检索时开关无意义） */
  switchDisabled: boolean;
  /** 打开文档时是否自动滚动到首个命中（全文 = 是；混合与降级 = 否） */
  autoScroll: boolean;
}

export function decideDocHighlight(params: {
  resultMode: SearchResultMode;
  /** 本次结果是否降级（`degradeReason !== null`） */
  degraded: boolean;
  /** 用户开关（默认开，见 `searchPrefs.ts`） */
  switchOn: boolean;
  /** 产生当前结果的查询词 */
  query: string;
}): DocHighlightDecision {
  const isFulltext = params.resultMode === 'fulltext';
  // 降级的结果其实全部来自 BM25 字面召回 ⇒ 列表按全文待遇高亮，"误标精确命中"的顾虑不成立
  const listHighlight = isFulltext || params.degraded;
  // 文档内高亮：全文恒开；混合（含降级）由开关决定 —— 开关只针对混合检索
  const wantHighlight = isFulltext || params.switchOn;
  return {
    listHighlight,
    docHighlightQuery: wantHighlight && params.query ? params.query : undefined,
    // **只有"当前结果是全文"时开关才无意义**（全文恒高亮）。未检索（`null`）不禁用 ——
    // 开关是用户偏好，应随时可设；2026-10-14 用户实测反馈：刚进页面时开关是灰的、
    // 且 title 显示"全文检索（含降级）…始终开启"，与眼前选中的「混合」模式对不上 ⇒ 被当成 bug。
    switchDisabled: params.resultMode === 'fulltext',
    autoScroll: isFulltext,
  };
}
