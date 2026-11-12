/**
 * scopeUsageTable.ts —— 总览 scope 表的行构建与排序（REQ-20261112-001 S-03）。
 *
 * 全部是纯函数：排序/过滤的口径集中在这里，组件只负责渲染，
 * 便于单测直接断言「默认排序 = 冷热降序 → 文档数降序 → 名字升序」。
 */

import type { ScopeHeat, ScopeInfo, ScopeUsageWindowInfo, ScopeWikiStatusInfo } from '@/api/mcpClient';

export type WindowDays = 7 | 30 | 90;
export type SortKey = 'heat' | 'query' | 'write' | 'docs';
export type SortDir = 'asc' | 'desc';

/** 冷热档位的排序权重（降序时热在前） */
export const HEAT_RANK: Record<ScopeHeat, number> = { hot: 3, warm: 2, cold: 1, unused: 0 };

/**
 * 档位文案。
 *
 * ★ 零调用档刻意写「无调用」而不是「未使用」：判据是「**本窗口内** 0 次」，
 *   而 162 行里 100+ 行都会命中该档 —— 「未使用」会被读成「从来没被用过」，
 *   是诱发批量误删的最短路径（REQ-20261112-001 challenger 意见 3）。
 */
export const HEAT_TEXT: Record<ScopeHeat, string> = {
  hot: '热',
  warm: '温',
  cold: '冷',
  unused: '无调用',
};

/** 渲染用的行视图模型 */
export interface ScopeRow {
  scope: string;
  kb: boolean;
  vector: boolean;
  readonly: boolean;
  ftsOnlyDocCount: number;
  wikiCount: number;
  /** null = 无统计（usage 缺失或该窗口无数据） */
  usage: ScopeUsageWindowInfo | null;
  /** null = 无统计；`'unused'` 是有效值（窗口内 0 次调用） */
  heat: ScopeHeat | null;
  /** 窗口覆盖天数；null = 无统计 */
  coveredDays: number | null;
  /** Wiki 回写状态（仅第二张「显示注册 scope」表用，主表不渲染） */
  wikiSync: ScopeWikiStatusInfo | null;
}

export interface BuildRowsOptions {
  keyword: string;
  windowDays: WindowDays;
  sortKey: SortKey;
  sortDir: SortDir;
}

const DEFAULTS: BuildRowsOptions = { keyword: '', windowDays: 7, sortKey: 'heat', sortDir: 'desc' };

/** 默认排序（需求 D6）：冷热降序 → 文档数降序 → scope 名升序 */
export const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: 'heat', dir: 'desc' };

export function windowKey(days: WindowDays): 'd7' | 'd30' | 'd90' {
  return `d${days}` as 'd7' | 'd30' | 'd90';
}

function toRow(item: ScopeInfo, days: WindowDays): ScopeRow {
  const win = item.usage ? item.usage[windowKey(days)] : null;
  return {
    scope: item.scope,
    kb: item.kb,
    vector: item.vector,
    readonly: item.readonly === true,
    ftsOnlyDocCount: item.ftsOnlyDocCount ?? 0,
    wikiCount: item.wikiCount ?? 0,
    usage: win ?? null,
    heat: win ? win.heat : null,
    coveredDays: win ? win.coveredDays : null,
    wikiSync: item.wikiSync ?? null,
  };
}

/** 排序主键；null 表示「无统计」，一律排到末尾 */
function primaryValue(row: ScopeRow, key: SortKey): number | null {
  if (key === 'heat') return row.heat ? HEAT_RANK[row.heat] : null;
  if (key === 'query') return row.usage ? row.usage.read : null;
  if (key === 'write') return row.usage ? row.usage.write : null;
  return row.wikiCount; // 文档数恒有值，不会是 null
}

export function buildScopeRows(list: ScopeInfo[], opts: Partial<BuildRowsOptions> = {}): ScopeRow[] {
  const { keyword, windowDays, sortKey, sortDir } = { ...DEFAULTS, ...opts };
  const kw = keyword.trim().toLowerCase();

  const rows: ScopeRow[] = [];
  for (const item of list) {
    if (kw && !item.scope.toLowerCase().includes(kw)) continue;
    rows.push(toRow(item, windowDays));
  }

  const mul = sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const va = primaryValue(a, sortKey);
    const vb = primaryValue(b, sortKey);
    // 空值恒末尾：不随升序/降序翻转（需求 R4 验收项）
    if (va === null && vb === null) {
      // 都无统计 → 交给次键
    } else if (va === null) {
      return 1;
    } else if (vb === null) {
      return -1;
    } else if (va !== vb) {
      return (va < vb ? -1 : 1) * mul;
    }
    // 次键：文档数降序（方向固定，不跟随主键翻转）
    if (sortKey !== 'docs') {
      const diff = b.wikiCount - a.wikiCount;
      if (diff !== 0) return diff;
    }
    // 三级键：名字升序，保证同值行在多次渲染间不换位
    return a.scope.localeCompare(b.scope);
  });
  return rows;
}

/** 点表头：同列切换升降序，换列重置为降序 */
export function nextSort(current: { key: SortKey; dir: SortDir }, clicked: SortKey): { key: SortKey; dir: SortDir } {
  if (current.key === clicked) {
    return { key: clicked, dir: current.dir === 'desc' ? 'asc' : 'desc' };
  }
  return { key: clicked, dir: 'desc' };
}

/**
 * 本地日期（`YYYY-MM-DD`）距今的天数，含当天（今天 = 1）；非法输入返回 null。
 *
 * 用途：判断统计是否已覆盖满最大窗口（90 天）。未满时在卡头统一提示一次
 * 「统计自 X 起」，而不是给 172 行的每个数字都加角标。
 */
export function daysSinceLocalDate(day: string, now: number = Date.now()): number | null {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return null;
  const start = new Date(y, m - 1, d).getTime();
  const today = new Date(now);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((todayStart - start) / 86_400_000) + 1;
}

/** 统计覆盖满「最大窗口」所需的天数（90） */
export const USAGE_FULL_WINDOW_DAYS = 90;

/** 千分位（1,284）；不引入 Intl 依赖，行为在浏览器/测试里一致 */
export function formatCount(n: number): string {
  const value = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
