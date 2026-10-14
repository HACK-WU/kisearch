/**
 * 浏览页阅读态 ⇄ URL 查询串。
 *
 * 为什么需要：阅读中的文档（BrowsePage 的 viewing）与全屏阅读态都是组件内 state，刷新即丢。
 * URL 是唯一能跨刷新的载体 —— 既有实现只有「URL → 页面」的深链接读取方向
 * （契约见 lib/kiLinks.ts::deepLink：`/browse?scope=..&group=..&relation=..[&anchor=..]`），
 * 本模块补上「页面 → URL」的写出方向，两者共用同一份参数名。
 *
 * `reader=1` 为全屏阅读标记（深链接契约的扩展，仅随文档一起写出）。
 */

import type { ScopedDocumentView } from '@/lib/documentLinks';
import { CHAT_OPEN_PARAM } from '@/lib/chatOpenUrl';

/** URL 查询串中标记全屏阅读的参数名 */
export const FULLSCREEN_PARAM = 'reader';

/** 写出的查询串（不含 `?`）；没有可复现的文档目标时返回空串（URL 即 /browse 浏览入口）。 */
export function browseSearch(view: ScopedDocumentView | null, fullscreen: boolean): string {
  // 深链接读取侧要求 scope + group + relation 齐备才认作文档目标；
  // 缺 group 的阅读态（理论上只可能来自脏数据）不排出半截链接，退化为浏览入口。
  if (!view || !view.group) return '';
  const params = new URLSearchParams({
    scope: view.scope,
    group: view.group,
    relation: view.module,
  });
  if (view.anchor) params.set('anchor', view.anchor);
  if (fullscreen) params.set(FULLSCREEN_PARAM, '1');
  return params.toString();
}

/** 从查询串读取全屏标记（缺省/非 `1` 一律为否）。 */
export function browseFullscreenFromSearch(search: string): boolean {
  return new URLSearchParams(search).get(FULLSCREEN_PARAM) === '1';
}

/**
 * 深链接判定的比较键：剔除 AI 面板标记（`chat=1`）。
 *
 * 面板开合由 AppShell 镜像到当前地址（lib/chatOpenUrl.ts）⇒ **每次开关面板都会改动查询串**。
 * 但面板标记不属于阅读态：若让它参与「URL 目标是否变化」的比较，开关一次面板就会让深链接
 * effect 重放一遍阅读态 —— 把右栏从「搜索结果」切回文档、并清掉列表过滤词。
 */
export function browseLinkKey(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(CHAT_OPEN_PARAM);
  return params.toString();
}

/**
 * 「这个查询串是页面自己写的」标记（sessionStorage，标签页内跨刷新有效）。
 *
 * 用途：刷新与外部深链接在客户端看起来一样（都是首次挂载 + URL 带文档参数），
 * 但页面处理不同 —— 刷新应按本地记忆保持目录布局，外部深链接要展开左列并把目录定位到目标文档。
 * 用 sessionStorage（而非 localStorage）正是为了让「新标签页打开链接」落到外部深链接一侧。
 */
const SELF_WRITTEN_KEY = 'ki.browseUrlSelfWritten';

export function markBrowseUrlSelfWritten(search: string): void {
  try {
    sessionStorage.setItem(SELF_WRITTEN_KEY, search);
  } catch {
    // 隐私模式 / 存储被禁用：退化为「按外部深链接处理」，即改动前的行为
  }
}

export function isBrowseUrlSelfWritten(search: string): boolean {
  try {
    return sessionStorage.getItem(SELF_WRITTEN_KEY) === search;
  } catch {
    return false;
  }
}
