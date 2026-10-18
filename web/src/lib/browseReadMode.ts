/**
 * browseReadMode.ts —— 浏览页「结果态 / 阅读态」判定的单一来源（REQ-20261018-001）。
 *
 * 背景：全库搜索结果默认由内联查看器的正文槽承载，结果与正文互斥；结果行新增
 * 「在页内打开」后，检索词非空也可能处于阅读态。原 `showingResults = isSearching`
 * 的单条件无法表达该状态，故把判定与状态迁移抽成纯函数，供页面与单测共用。
 *
 * 这里只负责**页面级视图状态**：不涉及文档内容、不涉及 URL。
 */

/** 主区形态：结果列表 / 文档正文 / 空态 */
export type BrowseReadMode = 'results' | 'reading' | 'empty';

/** 文档呈现形态：内联阅读区 / 右侧抽屉 */
export type BrowseViewMode = 'inline' | 'drawer';

export interface BrowseViewState {
  /** 用户用「在页内打开」显式隐藏了结果列表 */
  resultsHidden: boolean;
  viewMode: BrowseViewMode;
}

export const initialBrowseView: BrowseViewState = {
  resultsHidden: false,
  viewMode: 'inline',
};

export type BrowseViewAction =
  /** 主区切正文（树点击 / 深链接 / 页内打开），不改变结果可见性 */
  | { type: 'open-inline' }
  /** 结果行默认点击：抽屉 + 结果列表保持可见 */
  | { type: 'open-drawer' }
  /** 页内打开：结果列表让位 */
  | { type: 'hide-results' }
  /** 检索条件变化 / 关闭文档 / 切 scope：结果列表复位 */
  | { type: 'show-results' }
  /** 关闭抽屉但保留文档（只切形态） */
  | { type: 'close-drawer' };

export function browseViewReducer(state: BrowseViewState, action: BrowseViewAction): BrowseViewState {
  switch (action.type) {
    case 'open-inline':
      return state.viewMode === 'inline' ? state : { ...state, viewMode: 'inline' };
    case 'open-drawer':
      // 抽屉必须伴随结果列表可见：否则同一篇正文会同时由内联查看器与抽屉渲染（护栏 #5）。
      // 这是**有意的不对称**，不是两个正交维度混在一个 action 里。
      return { resultsHidden: false, viewMode: 'drawer' };
    case 'hide-results':
      return state.resultsHidden ? state : { ...state, resultsHidden: true };
    case 'show-results':
      return state.resultsHidden ? { ...state, resultsHidden: false } : state;
    case 'close-drawer':
      return state.viewMode === 'inline' ? state : { ...state, viewMode: 'inline' };
    default:
      return state;
  }
}

/** 结果列表是否可见：有检索词且未被「在页内打开」显式隐藏 */
export function resultsVisible(isSearching: boolean, resultsHidden: boolean): boolean {
  return isSearching && !resultsHidden;
}

/**
 * 主区形态：
 * - results：结果列表（文档若存在，由内联查看器承载结果，正文不可见）
 * - reading：文档正文
 * - empty：无结果、无文档
 */
export function deriveBrowseMode(input: {
  isSearching: boolean;
  resultsHidden: boolean;
  hasViewing: boolean;
}): BrowseReadMode {
  if (resultsVisible(input.isSearching, input.resultsHidden)) return 'results';
  return input.hasViewing ? 'reading' : 'empty';
}
