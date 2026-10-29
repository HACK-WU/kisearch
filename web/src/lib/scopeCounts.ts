import type { DocListResponse } from '@/api/httpApi';

export interface ScopeOverviewCounts {
  /** 文档总数 */
  docTotal: number;
  /** 分组总数 */
  groupCount: number;
}

/**
 * 总览「当前知识库」两张计数卡的取值。
 *
 * ★ 不能用 `docs.length`：`/api/doc/list` 不带 group 时按 `DOC_LIST_LIMIT=500` 截断
 *   （ai-docs 实测 docs=500 / total=1882），拿截断后的长度当总数会少报；按它去重得到的分组数
 *   同样不完整（实测 200 / 634）。`total` 与 `groups` 由后端按全量统计、不受分页影响。
 * ★ 旧 daemon 不返回 `groups` 时回退到列表去重（保持原展示，不报错）。
 */
export function scopeOverviewCounts(
  data?: Pick<DocListResponse, 'docs' | 'total' | 'groups'> | null,
): ScopeOverviewCounts {
  if (!data) return { docTotal: 0, groupCount: 0 };
  const docs = data.docs ?? [];
  return {
    docTotal: typeof data.total === 'number' ? data.total : docs.length,
    groupCount: data.groups ? data.groups.length : new Set(docs.map((d) => d.group)).size,
  };
}
