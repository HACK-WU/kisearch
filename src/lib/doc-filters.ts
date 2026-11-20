/**
 * `/api/doc/list` 的过滤参数：解析 + 匹配（纯函数，供 handler 与单测共用）。
 *
 * 横切约定（改这里之前先对齐）：
 *  - 时间一律**毫秒**时间戳；`since` 的 `now` 取**服务端**时钟（客户端时钟只用于展示相对时间）。
 *  - 非法 `since` / `sort` → 抛 `BadFilterError`（handler 转 400），**不静默按"不过滤"处理**。
 *  - `tags` 以**重复参数** `?tags=a&tags=b` 为主（tag 名可能含逗号，逗号拆分会产生歧义），
 *    同时兼容旧的逗号串写法；多个 tag 之间是 **OR**。
 *  - 分页口径：`total` / `truncated` 一律是**过滤后**的计数。
 *
 * 视图安全性：本模块**只读 URL**，不读"当前 scope 上下文"——视图请求对每个成员库用同一个
 * URL 各跑一次，这样过滤才能自动逐成员生效。
 */
import { matchDocQuery, normalizeSearchQuery, type SearchableDoc } from './doc-path.js';

/** 时间窗口档位（与前端 `BrowseFilters.since` 一一对应） */
export const SINCE_WINDOWS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
} as const;

export type SinceKey = keyof typeof SINCE_WINDOWS;

export type DocSort = 'default' | 'recent';

export interface DocFilters {
  /** 归一化后的检索词（名称 / 逻辑路径） */
  q: string;
  /** 指定 Group（分页分支用）；null = 跨组 */
  group: string | null;
  /** 自定义标签（已小写归一）；空数组 = 不过滤 */
  tags: string[];
  /** 时间窗口；undefined = 不过滤 */
  since?: { key: SinceKey; fromMs: number };
  /** `evt_xxx` = 该事件成员；`none` = 未关联任何事件 */
  event?: string;
  sort: DocSort;
}

/** 过滤参数非法（handler 据此返回 400，而不是静默降级） */
export class BadFilterError extends Error {
  constructor(
    public readonly code: 'INVALID_SINCE' | 'INVALID_SORT',
    message: string,
  ) {
    super(message);
    this.name = 'BadFilterError';
  }
}

/** 带时间与事件元数据的最小文档形状（`buildDocList` 的条目满足它） */
export interface FilterableDoc extends SearchableDoc {
  tags?: string[];
  createdAt?: number;
  updatedAt?: number;
  eventId?: string;
}

/**
 * 从 URL 解析过滤参数。
 * - `tags` 优先取重复参数（`getAll`），无则回退逗号串；再并上兼容参数 `tag`；
 * - `since` / `sort` 非法直接抛 `BadFilterError`。
 */
export function parseDocFilters(url: URL, now = Date.now()): DocFilters {
  // ★ 必须复用 doc-path 的归一函数：它多做了「分隔符归一（含全角/反斜杠）→ 去前导/尾部 `/`」，
  //   自写一份会让 `q=/api` 这类输入搜不到（归一不一致 ⇒ 与候选路径永远比不中）。
  const q = normalizeSearchQuery(url.searchParams.get('q') ?? '');
  const groupRaw = url.searchParams.get('group');
  const group = groupRaw && groupRaw.trim() ? groupRaw : null;

  const repeated = url.searchParams.getAll('tags').flatMap((raw) => raw.split(','));
  const legacyTag = url.searchParams.get('tag');
  if (legacyTag !== null && legacyTag !== '') repeated.push(legacyTag);
  const tags = dedupeLower(repeated);

  const sinceRaw = (url.searchParams.get('since') ?? '').trim();
  let since: DocFilters['since'];
  if (sinceRaw) {
    const key = sinceRaw as SinceKey;
    if (!(key in SINCE_WINDOWS)) {
      throw new BadFilterError(
        'INVALID_SINCE',
        `since 仅支持 ${Object.keys(SINCE_WINDOWS).join(' | ')}，收到 "${sinceRaw}"`,
      );
    }
    since = { key, fromMs: now - SINCE_WINDOWS[key] };
  }

  const sortRaw = (url.searchParams.get('sort') ?? '').trim() || 'default';
  if (sortRaw !== 'default' && sortRaw !== 'recent') {
    throw new BadFilterError('INVALID_SORT', `sort 仅支持 default | recent，收到 "${sortRaw}"`);
  }

  const eventRaw = (url.searchParams.get('event') ?? '').trim();
  return {
    q,
    group,
    tags,
    ...(since ? { since } : {}),
    ...(eventRaw ? { event: eventRaw } : {}),
    sort: sortRaw as DocSort,
  };
}

function dedupeLower(values: string[]): string[] {
  const set = new Set<string>();
  for (const raw of values) {
    const v = raw.trim().toLowerCase();
    if (v) set.add(v);
  }
  return [...set];
}

/** 文档最近一次"新增或修改"的时间（缺任一字段则取另一个） */
export function latestDocTime(doc: FilterableDoc): number | undefined {
  const c = doc.createdAt;
  const u = doc.updatedAt;
  if (typeof c === 'number' && typeof u === 'number') return Math.max(c, u);
  if (typeof c === 'number') return c;
  if (typeof u === 'number') return u;
  return undefined;
}

/** 是否为"有时间记录"的文档（老数据两个字段都缺 → false） */
export function hasDocTime(doc: FilterableDoc): boolean {
  return latestDocTime(doc) !== undefined;
}

/**
 * 时间窗口匹配。
 * ★ 缺时间字段一律**不命中**（老数据不臆造、不兜底成 now），由 `undatedExcluded` 单独计数供 UI 提示。
 */
export function matchSince(doc: FilterableDoc, since?: DocFilters['since']): boolean {
  if (!since) return true;
  const t = latestDocTime(doc);
  return t !== undefined && t >= since.fromMs;
}

/** 标签匹配：任一命中即可（OR）；空数组 = 不过滤 */
export function matchTags(doc: FilterableDoc, tags: string[]): boolean {
  if (tags.length === 0) return true;
  const own = (doc.tags ?? []).map((t) => t.toLowerCase());
  return tags.some((t) => own.includes(t));
}

/** 事件匹配：`none` = 未关联任何事件；其余按 `eventId` 精确相等 */
export function matchEvent(doc: FilterableDoc, event?: string): boolean {
  if (!event) return true;
  if (event === 'none') return !doc.eventId;
  return doc.eventId === event;
}

/** 检索词匹配（名称 / 逻辑路径） */
export function matchQuery(doc: FilterableDoc, q: string): boolean {
  return !q || matchDocQuery(doc, q) !== null;
}

/** 按"最近新增/修改"倒序；时间相同按 group + name 稳定排序（无时间的排最后） */
export function sortByRecent<T extends FilterableDoc>(docs: T[]): T[] {
  return [...docs].sort((a, b) => {
    const ta = latestDocTime(a) ?? Number.NEGATIVE_INFINITY;
    const tb = latestDocTime(b) ?? Number.NEGATIVE_INFINITY;
    if (tb !== ta) return tb - ta;
    const ga = `${a.group}\u0000${a.name}`;
    const gb = `${b.group}\u0000${b.name}`;
    return ga.localeCompare(gb);
  });
}
