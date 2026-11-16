/**
 * writeTabs.ts —— 「上传导入 / 手动写入」合并页的纯函数（REQ-20261116-002）。
 *
 * 为什么抽出来：合并后有三个判据同时存在且互相耦合，写在 `AppShell.tsx` 的 JSX 与
 * `ImportPage.tsx` 的 effect 里就没法测（`web/test` 只覆盖 `src/lib` 纯函数，见
 * `importPhase.ts` 文件头同款说明）：
 *   1) 当前是哪个 tab —— 由 URL 决定（`/import` / `/write`），刷新与深链才不会串；
 *   2) 侧栏那一项什么时候算激活 —— 两条路径都要亮，且 `/write` 不能顺手点亮别的项；
 *   3) 什么时候清空导入页的「本批暂存」—— **只在离开合并页时**，切 tab 不清（拍板②）。
 *
 * 判据 3 是本次最容易写错的一条：改造前它按 `pathname === '/import'` 判定，切到 `/write`
 * 等于"离开页面"，于是用户在写入 tab 手写完回来，导入 tab 的选择与预检结果全被清掉。
 */

import { isBusyPhase, type ImportPhase } from './importPhase';

/** 合并页的两个 tab（顺序即渲染顺序） */
export type WriteTab = 'import' | 'write';

export const WRITE_TABS: readonly WriteTab[] = ['import', 'write'];

/** tab → 路径。**tab 由路径承载**，不用 `?tab=` 之类的 search 参数 —— 两条旧路径都要继续可用 */
export const WRITE_TAB_PATH: Readonly<Record<WriteTab, string>> = {
  import: '/import',
  write: '/write',
};

/** tab 文案：手段（上传导入 / 手动写入），页面名（知识写入）留给顶栏 H1 */
export const WRITE_TAB_LABEL: Readonly<Record<WriteTab, string>> = {
  import: '上传导入',
  write: '手动写入',
};

/** 合并页的页面名（顶栏 H1 / 侧栏项文案） */
export const MERGED_WRITE_LABEL = '知识写入';

/** 路径 → tab；非合并页返回 null */
export function writeTabFromPath(pathname: string): WriteTab | null {
  if (pathname === WRITE_TAB_PATH.import) return 'import';
  if (pathname === WRITE_TAB_PATH.write) return 'write';
  return null;
}

/** 是否处于合并页（两条路径之一） */
export function isMergedWritePath(pathname: string): boolean {
  return writeTabFromPath(pathname) !== null;
}

/** 侧栏项的最小形状（`NAV_MAIN` 的子集） */
export interface NavItemShape {
  to: string;
  /** 精确匹配（只有 `/` 这类根路径用） */
  end?: boolean;
  /** 额外算作激活的路径（合并项：`/import` 之外还有 `/write`） */
  also?: readonly string[];
}

/**
 * 路径是否命中该导航项。
 *
 * 用「分段边界」而不是裸 `startsWith`：`/import` 不该命中 `/imports`；`/tasks` 又必须命中
 * `/tasks/:id`（任务详情抽屉是同一页）。改造前 `currentLabel` 用的是裸 `startsWith`，
 * 语义上略宽，但当前没有任何一对导航项互为前缀，收敛成精确语义不会改变现有页面的高亮结果。
 */
function pathMatches(target: string, pathname: string, end?: boolean): boolean {
  if (pathname === target) return true;
  if (end) return false;
  return pathname.startsWith(`${target}/`);
}

/** 导航项是否激活：`to` 与 `also` 任一命中即激活（合并项在 `/write` 上必须仍高亮） */
export function navItemActive(item: NavItemShape, pathname: string): boolean {
  if (pathMatches(item.to, pathname, item.end)) return true;
  return (item.also ?? []).some((path) => pathMatches(path, pathname));
}

/**
 * 回到合并页时是否要执行「本批暂存」清理。
 *
 * 只在**从别处回到合并页**（false → true）时清理；tab 之间来回切换不清。
 * 清理分支体本身沿用改造前的实现（含 `partial` / `uploadErrors` 保留分支），本函数只决定时机。
 */
export function shouldCleanupOnMergedEntry(prevOnMerged: boolean, nextOnMerged: boolean): boolean {
  return nextOnMerged && !prevOnMerged;
}

/**
 * 切回导入 tab 时是否需要重新确认目标 Scope（拍板②）。
 *
 * 只在**终态**重新确认：进行中的任务（scanning/uploading/awaiting-confirm/importing）
 * 若把 `scopeConfirmed` 抹掉，页头会显示"请选择并确认本次导入的 Scope"，而右轨正在跑，
 * 观感自相矛盾；`unknown`（状态待确认）同样不动——它需要用户读错误信息而不是重新选库。
 */
export function shouldReconfirmScopeOnImportReturn(phase: ImportPhase): boolean {
  return phase === 'idle' || phase === 'done' || phase === 'failed' || phase === 'cancelled';
}

/**
 * 导入 tab 上的进度徽标是否可见。
 *
 * **仅在导入 tab 未激活时显示**：激活时右侧任务轨已经给出完整进度（百分比 + 阶段 + 取消入口），
 * tab 上再放一份是同一个页面里的第二份进度，属噪音。
 */
export function tabBadgeVisible(activeTab: WriteTab | null, phase: ImportPhase): boolean {
  if (activeTab === 'import') return false;
  // 复用「忙」判据而不是手抄阶段清单：新增阶段时不会在这里悄悄漏掉
  return isBusyPhase(phase);
}

/** 徽标百分比文案：未知进度（刚起步）返回 null，由调用方只渲染脉冲点 */
export function tabBadgePercentText(percent: number | null): string | null {
  return percent === null ? null : `${percent}%`;
}
