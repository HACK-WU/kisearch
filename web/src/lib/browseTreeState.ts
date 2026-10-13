/**
 * browseTreeState.ts —— 浏览页左树（知识目录）状态的本地持久化。
 *
 * 为什么需要：目录的展开/折叠、选中的 Group、左列是否收起此前只存在于组件 state，
 * 刷新即回到默认（一级展开 + 第一个有文档的 Group）。
 *
 * 为什么放 localStorage 而不是 URL：这属于**个人阅读偏好**（布局 + 浏览位置），
 * URL 承载的是可分享的文档定位（见 lib/browseUrl.ts）——把展开态塞进 URL 会让链接变得又长又脆，
 * 且「展开全部」在大型知识库里可能产生数百个路径。
 *
 * 按 scope 分桶：不同知识库的目录结构互不相干。
 */

import { collectOpenPaths, type GroupTreeNode } from '@/lib/groupTree';

export interface BrowseTreeState {
  /** 左列知识目录是否收起为窄条 */
  collapsed: boolean;
  /** 当前选中的 Group 路径（空串表示尚未选择） */
  activeGroup: string;
  /** 展开的 Group 路径；`null` 表示从未保存过（此时沿用默认展开策略，而不是「全部折叠」） */
  openPaths: string[] | null;
}

/** 无持久化记录时的默认值：与改动前的页面初始态一致 */
export function defaultBrowseTreeState(): BrowseTreeState {
  return { collapsed: false, activeGroup: '', openPaths: null };
}

/** 展开路径上限：点过「展开全部」的大型知识库可能产生数百条，截断防止 localStorage 膨胀 */
export const MAX_OPEN_PATHS = 500;

export function browseTreeStateKey(scope: string): string {
  return `ki.browseTree:${encodeURIComponent(scope)}`;
}

/** 读取失败（无记录 / 损坏 / 被禁用）一律退回默认值，不让坏数据把目录变成「全折叠」。 */
export function readBrowseTreeState(scope: string): BrowseTreeState {
  try {
    const raw = localStorage.getItem(browseTreeStateKey(scope));
    if (!raw) return defaultBrowseTreeState();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultBrowseTreeState();
    const value = parsed as Partial<BrowseTreeState>;
    return {
      collapsed: value.collapsed === true,
      activeGroup: typeof value.activeGroup === 'string' ? value.activeGroup : '',
      openPaths: Array.isArray(value.openPaths)
        ? value.openPaths.filter((path): path is string => typeof path === 'string').slice(0, MAX_OPEN_PATHS)
        : null,
    };
  } catch {
    return defaultBrowseTreeState();
  }
}

export function writeBrowseTreeState(scope: string, state: BrowseTreeState): boolean {
  try {
    localStorage.setItem(browseTreeStateKey(scope), JSON.stringify({
      ...state,
      openPaths: state.openPaths === null ? null : state.openPaths.slice(0, MAX_OPEN_PATHS),
    }));
    return true;
  } catch {
    // 隐私模式 / 配额耗尽：目录状态丢失不影响浏览与阅读，静默降级
    return false;
  }
}

/** 由当前树与布局构造待写入状态（展开路径从树里现收，避免两处维护同一份集合）。 */
export function treeStateFromTree(
  tree: GroupTreeNode[],
  collapsed: boolean,
  activeGroup: string,
): BrowseTreeState {
  return {
    collapsed,
    activeGroup,
    openPaths: collectOpenPaths(tree).slice(0, MAX_OPEN_PATHS),
  };
}
