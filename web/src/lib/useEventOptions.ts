/**
 * 事件候选（筛选面板「事件」字段的取值来源）。
 *
 * 为什么不能只调一次 `listEvents(scope)`：
 *  - 治理端点的事件**按库归属**，`GET /governance/events?scope=视图名` 拿不到成员库的事件
 *    （治理页的读端点没有视图逻辑）；
 *  - 因此视图模式下要**逐成员**取，再按成员库分组给面板展示。
 *
 * 失败隔离：单个成员失败只让该组显示"加载失败"，不禁用其余库的候选。
 */
import { useQuery } from '@tanstack/react-query';
import { listEvents } from '@/api/governanceApi';

/** 单库最多拉多少条（超出靠关键字搜索：面板会把关键字透传给 `listEvents(q)`） */
const PER_SCOPE_LIMIT = 100;
/** 视图下并发上限：成员可能有很多，避免一次打爆 */
const CONCURRENCY = 4;

export interface EventOption {
  id: string;
  shortId: number;
  title: string;
  stage: string;
  closed: boolean;
}

export interface EventOptionGroup {
  scope: string;
  options: EventOption[];
  error?: string;
}

export type EventStatusFilter = 'all' | 'open' | 'closed';

async function fetchOne(scope: string, keyword: string, status: EventStatusFilter): Promise<EventOption[]> {
  const res = await listEvents(scope, {
    status: status === 'all' ? 'all' : status === 'open' ? 'open' : 'closed',
    limit: PER_SCOPE_LIMIT,
    ...(keyword ? { q: keyword } : {}),
  });
  return (res.events ?? []).map((event) => ({
    id: event.id,
    shortId: event.shortId,
    title: event.title,
    stage: event.stage?.name ?? '',
    closed: event.closedAt !== null,
  }));
}

/**
 * @param scope 当前库名或视图名
 * @param memberScopes 视图的成员库；单库模式传空数组（等于 `[scope]`）
 * @param keyword 面板搜索框里的关键字（服务端 `q`，避免只能在前 100 条里找）
 */
export function useEventOptions(
  scope: string,
  memberScopes: string[],
  keyword = '',
  options: { enabled?: boolean } = {},
) {
  const targets = memberScopes.length > 0 ? memberScopes : [scope];
  const key = [...targets].sort().join(',');
  return useQuery<EventOptionGroup[]>({
    queryKey: ['eventOptions', key, keyword],
    queryFn: async () => {
      const groups: EventOptionGroup[] = [];
      // 小批并发：保持顺序稳定，同时避免 N 个请求同时打出去
      for (let i = 0; i < targets.length; i += CONCURRENCY) {
        const batch = targets.slice(i, i + CONCURRENCY);
        const settled = await Promise.all(batch.map(async (member) => {
          try {
            return { scope: member, options: await fetchOne(member, keyword, 'all') };
          } catch (err) {
            return { scope: member, options: [], error: (err as Error).message || '事件加载失败' };
          }
        }));
        groups.push(...settled);
      }
      return groups;
    },
    // 默认开；工具栏只需要「已选事件」的标题时可传 enabled=false 避免无谓请求
    enabled: options.enabled !== false && Boolean(scope),
    staleTime: 60_000,
    retry: 0,
  });
}
