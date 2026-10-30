/**
 * hooks.ts —— TanStack Query 数据获取 hooks
 */

import { useQuery } from '@tanstack/react-query';
import {
  getDocList, fetchGroupDocsAll, getHealth, getDataSourceList, getDataSourceDetail, getHealthz,
  type DocListResponse, type HealthResponse, type DataSourceListResponse, type DataSourceDetailResponse,
  type HealthzInfo,
} from '@/api/httpApi';
import { kiScopeList, type ScopeListResponse } from '@/api/mcpClient';
import {
  getVectorDimensionStatus,
  refreshVectorDimensionStatus,
  type VectorDimensionStatusResponse,
} from '@/api/tasksApi';
import { resolveMcpPort } from './daemonPort';
import { isLoopbackHost } from './resourcesPage';
import { hasSearchTerm } from './browseSearchGroups';
import { resolveVectorAvailability, type VectorAvailability } from './vectorAvailability';

export type { ScopeListResponse, DocListResponse, HealthResponse };
export type ScopeEntry = ScopeListResponse['scopes'][number];
export { getDocList, fetchGroupDocsAll, getHealth };

/** 服务健康状态（仅加载时查一次，避免频繁触发 zvec 探活） */
export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: getHealth,
    staleTime: 60_000,
    retry: false,
  });
}

// ── 健康判据（REQ-20261016-003 起独立成 lib/healthSummary.ts）──
// 徽标 / 横幅 / 总览卡 / 明细面板共用同一判据；本文件只做 re-export，保持既有 import 路径不变
// （`summarizeHealth` 等仍可从 '@/lib/hooks' 取用）。纯逻辑独立成文件是为了可零依赖单测。
export {
  summarizeHealth,
  toHealthIssues,
  healthIssueCopyText,
  humanizeHealthError,
  isVectorHealthCheck,
  vectorOnlyFailureLabel,
  VECTOR_HEALTH_CHECK_NAMES,
} from './healthSummary';
export type { HealthLevel, HealthIssue, HealthSummary } from './healthSummary';
// 向量可用性判据同样独立成纯逻辑（lib/vectorAvailability.ts），可零依赖单测
export { resolveVectorAvailability, vectorAvailabilityHint, vectorBadgeLabel } from './vectorAvailability';
export type { VectorAvailability, VectorAvailabilityStatus } from './vectorAvailability';

/**
 * daemon 实际监听信息（`/healthz`）：**端口** + 版本，供侧栏页脚等展示。
 *
 * 用户 2026-10-27 反馈：页脚写死 `MCP 7423`，换端口（如 7433）后仍显示 7423，
 * 等于指着一个不存在的 MCP 地址。口径见 `lib/daemonPort.ts`：
 * 回环访问以 `/healthz.port` 为准（proxy 目标），其他设备以地址栏为准，逐级回落。
 *
 * `staleTime` 5 分钟：端口/版本运行期不会变，不值得反复探活；失败不重试，
 * 展示层各有回落（端口回落到地址栏，版本回落到本包 version）。
 */
export function useServerInfo(): { port: string; version?: string } {
  const { data } = useQuery<HealthzInfo>({
    queryKey: ['healthz'],
    queryFn: getHealthz,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const port = resolveMcpPort({
    healthzPort: data?.port,
    locationPort: window.location.port,
    protocol: window.location.protocol,
    isLoopback: isLoopbackHost(window.location.hostname),
  });
  return { port, version: data?.version };
}

/** scope 列表 */
export function useScopeList() {
  return useQuery<ScopeListResponse>({
    queryKey: ['scopeList'],
    queryFn: kiScopeList,
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * 该 scope 是否只读（REQ-20261029-001）。
 *
 * - 与 `useScopeList` 共用同一个 query key（`scopeList`）：全局 `ScopeSelect` 常驻已预热，
 *   阅读抽屉等深层组件调用本 hook **不会产生额外请求**。
 * - 列表未就绪 / 旧版 daemon 不返回 `readonly` 时一律按**可写**处理（前端只做体验保护，
 *   真正的边界在后端门禁）：保守放行不会把用户卡死，越权由后端 409 兜底。
 */
export function useScopeReadonly(scope: string | undefined): boolean {
  const { data } = useScopeList();
  if (!scope) return false;
  const entry = data?.scopes?.find((item) => item.scope === scope);
  return entry?.readonly === true;
}

/**
 * 向量能力是否可用 —— 顶栏徽标与「导入 / 检索 / 写入」三处动作层保护**共用同一判据**。
 *
 * ★ 来源：windows 4e9d624 的 `useVectorAvailability`。2026-10-29 合并 66c3c19 时随 hooks.ts
 *   整取 master 版丢失，现以「纯函数（lib/vectorAvailability.ts）+ 本 hook 仅做 query 装配」接回。
 * ★ 不引入独立的 `/healthz` 存活探针（windows 版曾用 `useHttpReadiness`）：master 已有
 *   `useHealth` + `summarizeHealth` 区分 unreachable / slow，再加一套会让"服务活没活"出现两个答案。
 * ★ 两路 query 都是既有 key（`health` / `scopeList`）：本 hook 不产生额外请求，也不会因挂载
 *   顺序变化触发额外取数（`useHealth` 的 staleTime 60s、`useScopeList` 30s）。
 */
export function useVectorAvailability(): VectorAvailability {
  const health = useHealth();
  const scopeList = useScopeList();
  return resolveVectorAvailability({
    health: { data: health.data, error: health.error, isPending: health.isPending },
    scopeList: { data: scopeList.data, error: scopeList.error, isPending: scopeList.isPending },
  });
}

/**
 * 文档列表（服务端一次最多返回 500 条，`total` / `groups` 才是完整口径）。
 *
 * 完整列表**不是**全量：需要"按名称/路径找某篇"时用 `useDocSearch`（服务端检索），
 * 需要完整计数时用响应里的 `total` / `groups.length`（见 `lib/scopeCounts.ts`）。
 */
export function useDocList(scope: string) {
  return useQuery<DocListResponse>({
    queryKey: ['docList', scope],
    queryFn: () => getDocList(scope),
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * 跨组文档搜索（服务端 `q`：名称 / 逻辑路径模糊匹配，最多 2000 条）。
 *
 * ★ 不能在前端过滤 `useDocList` 的 500 条：超过 500 篇的 scope 里，靠后的文档永远搜不到
 *   （ai-docs 实测 1882 篇）。消费方：ReaderLinkComposer 的文档选择搜索。
 * ★ `enabled` 用 `hasSearchTerm`：只由分隔符/空白组成（`/`、` `）不算检索词（N1），
 *   否则服务端会把空检索词当成"不过滤"返回全库。
 */
export function useDocSearch(scope: string, query: string) {
  const q = query.trim();
  return useQuery<DocListResponse>({
    // 挂在 `docList` 前缀下：导入 / 写入完成时既有 `invalidateQueries(['docList', scope])` 能一并失效
    queryKey: ['docList', scope, 'search', q],
    queryFn: () => getDocList(scope, { q }),
    enabled: hasSearchTerm(q),
    staleTime: 30_000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });
}

/**
 * 当前 scope 的向量维度状态（REQ-20261016-002 起由 AppShell 与总览页共用）。
 *
 * ★ 与 AppShell 原内联实现**逐项等价**：快照 unknown 且已过期时补一次 refresh；真正检查失败
 *   的近期快照留给用户手动重试（守既有 "不引入自动轮询 / 重试" 口径）；staleTime 0、
 *   不随窗口聚焦 / 重连重取、`retry:false`。
 * ★ 两个消费方共用**同一 queryKey** ⇒ 总览页读的是 AppShell 已建立的缓存，不产生额外请求；
 *   也避免同 key 两套 queryFn 造成的语义漂移。
 * ★ `refetchOnMount: false` 是**行为等价性的必要项**（challenger 2026-10-16 质疑 #1）：本 hook
 *   有两个观察者，而 AppShell 的观察者一次挂载后长期在树（切路由不重挂）——改动前只有它会触发
 *   取数，故"每次进入总览页"不会取数。若用默认 true，每次进总览都会因 `staleTime: 0` 补一次
 *   GET；更关键的是当快照 unknown+已过期时，queryFn 会走 **POST refresh**，而该 operation 在
 *   coordinator 里按缺省 `write` 入队，长导入期间反复进出总览会堆积刷新请求。
 *   置 false 后：AppShell 首挂（无数据）照常取数、任务完成后的 invalidate 照常重取、
 *   手动「重新检查」照常生效 —— 与改动前完全一致。
 */
export function useVectorDimensionStatus(scope: string) {
  return useQuery<VectorDimensionStatusResponse>({
    queryKey: ['vectorDimensionStatus', scope],
    queryFn: async () => {
      const current = await getVectorDimensionStatus(scope);
      const { checkedAt, staleAfterMs, state } = current.status;
      // 快照缺失或过期时检查一次；真正检查失败的近期快照留给用户手动重试。
      if (state === 'unknown' && (checkedAt === undefined || Date.now() - checkedAt >= staleAfterMs)) {
        return refreshVectorDimensionStatus(scope);
      }
      return current;
    },
    staleTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

/** 指定 group 的完整文档列表（S0-2：服务端分页翻页取全，单 Group >500 篇不漏），可选 tag 过滤 */
export function useGroupDocs(scope: string, group: string | null, tag?: string) {
  return useQuery<DocListResponse>({
    queryKey: ['docList', scope, 'group', group ?? '', tag ?? ''],
    queryFn: () => fetchGroupDocsAll(scope, group ?? '', tag),
    enabled: !!group,
    staleTime: 30_000,
    retry: 1,
  });
}

// ─── 数据源（REQ-20261020-001） ─────────────────────────

/** 数据源列表（跨 scope；页面只读）。固定 15s 轮询：CLI 在别处启动同步时页面也能感知 */
export function useDataSourceList() {
  return useQuery<DataSourceListResponse>({
    queryKey: ['dataSourceList'],
    queryFn: () => getDataSourceList(),
    staleTime: 15_000,
    retry: 1,
    refetchInterval: 15_000,
  });
}

/** 单个数据源详情（含完整 lastSync + 待删候选）；同步进行中 3s，否则 15s 兜底 */
export function useDataSourceDetail(scope: string | null) {
  return useQuery<DataSourceDetailResponse>({
    queryKey: ['dataSourceDetail', scope],
    queryFn: () => getDataSourceDetail(scope as string),
    enabled: !!scope,
    staleTime: 5_000,
    retry: 1,
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : 15_000),
  });
}
