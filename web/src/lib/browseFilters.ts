/**
 * 浏览页筛选条件（时间 / 标签 / 事件）。
 *
 * 与后端 `src/lib/doc-filters.ts` 的 `DocFilters` 是同一份契约的两个投影：
 * 前端只负责**档位枚举**，时间换算与非法值校验都在服务端（客户端时钟不参与判定）。
 */

export type SinceKey = '1h' | '6h' | '24h' | '7d';

export const SINCE_OPTIONS: Array<{ key: SinceKey; label: string }> = [
  { key: '1h', label: '最近 1 小时' },
  { key: '6h', label: '最近 6 小时' },
  { key: '24h', label: '最近 24 小时' },
  { key: '7d', label: '最近 7 天' },
];

export interface BrowseFilters {
  /** 时间窗档位；undefined = 不限 */
  since?: SinceKey;
  /** 自定义标签（OR）；空数组 = 不过滤 */
  tags: string[];
  /** `evt_xxx` = 该事件成员；`none` = 未关联任何事件 */
  event?: string;
}

export const EMPTY_FILTERS: BrowseFilters = { tags: [] };

export function isFilterEmpty(f: BrowseFilters): boolean {
  return !f.since && !f.event && f.tags.length === 0;
}

/** 生效条件条数（用于「筛选 · N」徽标与「清空」按钮可用态） */
export function filterCount(f: BrowseFilters): number {
  return (f.since ? 1 : 0) + (f.tags.length > 0 ? 1 : 0) + (f.event ? 1 : 0);
}

export function sinceLabel(key?: SinceKey): string {
  return SINCE_OPTIONS.find((o) => o.key === key)?.label ?? '';
}

/**
 * 转成 `/api/doc/list` 查询参数。
 * ★ `tags` 用**重复参数**（`tags=a&tags=b`）而不是逗号串：tag 名可能含逗号。
 * ★ 只在有筛选时才带 `sort=recent`，避免改变无筛选时的既有顺序。
 */
export function toDocListParams(f: BrowseFilters, extra: { q?: string } = {}): {
  tags?: string[];
  since?: SinceKey;
  event?: string;
  sort?: 'recent';
  q?: string;
} {
  return {
    ...(extra.q ? { q: extra.q } : {}),
    ...(f.tags.length > 0 ? { tags: f.tags } : {}),
    ...(f.since ? { since: f.since } : {}),
    ...(f.event ? { event: f.event } : {}),
    ...(isFilterEmpty(f) ? {} : { sort: 'recent' as const }),
  };
}

/** 稳定的缓存键片段（tags 排序后拼接，避免顺序不同产生两套缓存） */
export function filterKey(f: BrowseFilters): string {
  return [f.since ?? '', [...f.tags].sort().join(','), f.event ?? ''].join('|');
}

/**
 * 汇总 `undatedExcluded`（被「未知时间」排除的老文档条数）：
 * 单库取顶层；视图模式下后端按成员桶返回，这里累加成一句提示要用的总数。
 */
export function sumUndated(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  const p = payload as { undatedExcluded?: number; buckets?: Array<{ undatedExcluded?: number }> };
  if (Array.isArray(p.buckets)) {
    return p.buckets.reduce((sum, bucket) => sum + (bucket?.undatedExcluded ?? 0), 0);
  }
  return p.undatedExcluded ?? 0;
}

/** 相对时间（列表行展示；与事件页 `relTime` 同口径） */
export function relTime(ts: number | undefined, now = Date.now()): string {
  if (ts === undefined) return '';
  const diff = Math.max(now - ts, 0);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return `${Math.round(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} 小时前`;
  return `${Math.round(diff / DAY)} 天前`;
}

/** 文档「新增 / 更新」判定：老数据无 createdAt = 未知 → 按更新展示（不得冒充新增） */
export function docChangeKind(doc: { createdAt?: number; updatedAt?: number }): 'new' | 'updated' {
  if (typeof doc.createdAt !== 'number' || typeof doc.updatedAt !== 'number') return 'updated';
  return doc.updatedAt - doc.createdAt < 60_000 ? 'new' : 'updated';
}

/** 文档最近一次变更时间（用于行内相对时间） */
export function docLatestTime(doc: { createdAt?: number; updatedAt?: number }): number | undefined {
  if (typeof doc.createdAt === 'number' && typeof doc.updatedAt === 'number') {
    return Math.max(doc.createdAt, doc.updatedAt);
  }
  return doc.updatedAt ?? doc.createdAt;
}
