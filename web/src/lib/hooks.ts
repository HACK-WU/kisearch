/**
 * hooks.ts —— TanStack Query 数据获取 hooks
 */

import { useQuery } from '@tanstack/react-query';
import { getDocList, fetchGroupDocsAll, getHealth, type DocListResponse, type HealthResponse } from '@/api/httpApi';
import { kiScopeList, type ScopeListResponse } from '@/api/mcpClient';
import {
  getVectorDimensionStatus,
  refreshVectorDimensionStatus,
  type VectorDimensionStatusResponse,
} from '@/api/tasksApi';

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

export type HealthLevel = 'checking' | 'unreachable' | 'slow' | 'fail' | 'warn' | 'ok';

export interface HealthSummary {
  level: HealthLevel;
  /** 徽标可见短文案：受 .ki-service-badge 220px + nowrap 约束，必须短 */
  label: string;
  /** 完整原因（tooltip / 页面正文），空串表示无需说明 */
  detail: string;
}

/**
 * 健康状态的唯一判据，徽标 / 横幅 / 总览卡片共用。
 * 核心区分：只要拿到了 HTTP 应答，服务就是活的——检查超时或某项失败都不能说成「未就绪」，
 * 否则用户会去重启一个本来正常的 daemon。
 */
export function summarizeHealth(
  data: HealthResponse | undefined,
  error: unknown,
  pending: boolean,
): HealthSummary {
  // TanStack Query 无错误时给的是 null 而非 undefined，只能用真值判定
  if (pending || (!data && !error)) {
    return { level: 'checking', label: '检测中…', detail: '' };
  }
  if (error) {
    const e = error as { status?: number; message?: string; body?: HealthResponse };
    // 无 status = fetch 直接 reject，才是真的连不上；有 status = 服务应答了
    if (e.status === undefined) {
      return {
        level: 'unreachable',
        label: 'MCP HTTP 不可达',
        detail: e.message ?? '无法连接服务',
      };
    }
    return {
      level: 'slow',
      label: '健康检查未完成',
      detail: e.body?.error ?? e.message ?? `HTTP ${e.status}`,
    };
  }
  const items = data?.report?.items ?? [];
  const bad = (status: 'fail' | 'warn') => items.find((i) => i.status === status);
  const failItem = bad('fail');
  if (failItem) {
    return {
      level: 'fail',
      label: `健康异常 · ${failItem.name}`,
      detail: failItem.detail ?? failItem.message ?? '',
    };
  }
  const warnItem = bad('warn');
  if (warnItem) {
    return {
      level: 'warn',
      label: `有告警 · ${warnItem.name}`,
      detail: warnItem.detail ?? warnItem.message ?? '',
    };
  }
  return { level: 'ok', label: 'MCP HTTP 已就绪', detail: '' };
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

/** 文档列表（一次拉取当前 scope 全量，文件名/路径过滤由前端内存完成） */
export function useDocList(scope: string) {
  return useQuery<DocListResponse>({
    queryKey: ['docList', scope],
    queryFn: () => getDocList(scope),
    staleTime: 30_000,
    retry: 1,
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
