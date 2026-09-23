/**
 * hooks.ts —— TanStack Query 数据获取 hooks
 */

import { useQuery } from '@tanstack/react-query';
import { getDocList, getHealth, getHttpReadiness, type DocListResponse, type HealthResponse, type HttpReadinessResponse } from '@/api/httpApi';
import { kiScopeList, type ScopeListResponse } from '@/api/mcpClient';

export type { ScopeListResponse, DocListResponse, HealthResponse };
export type ScopeEntry = ScopeListResponse['scopes'][number];
export { getDocList, getHealth };

/** 服务健康状态（仅加载时查一次，避免频繁触发 zvec 探活） */
export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: getHealth,
    staleTime: 60_000,
    retry: false,
  });
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

/** MCP HTTP 存活状态，与 embedding/向量诊断分离。 */
export function useHttpReadiness() {
  return useQuery<HttpReadinessResponse>({
    queryKey: ['httpReadiness'],
    queryFn: getHttpReadiness,
    staleTime: 5_000,
    retry: false,
  });
}

const VECTOR_HEALTH_CHECK_NAMES = new Set([
  'apiKey',
  'URL 连通性',
  '密钥有效性',
  '维度匹配',
]);

export function isVectorHealthCheck(name: string): boolean {
  return VECTOR_HEALTH_CHECK_NAMES.has(name);
}

export type VectorAvailability = {
  status: 'checking' | 'available' | 'unavailable' | 'unknown';
  reason?: string;
};

function queryErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : undefined;
}

/** Embedding 诊断和向量 Collection 探测都通过后才允许使用向量功能。 */
export function useVectorAvailability(): VectorAvailability {
  const health = useHealth();
  const scopeList = useScopeList();
  const healthItems = health.data?.report?.items ?? [];
  const vectorHealthItems = healthItems.filter((item) => isVectorHealthCheck(item.name));
  const failedVectorHealthItem = vectorHealthItems.find((item) => item.status !== 'pass');
  const vectorUnavailable = scopeList.data?.vectorAvailable === false || !!failedVectorHealthItem;

  if (vectorUnavailable) {
    return {
      status: 'unavailable',
      reason: scopeList.data?.vectorReason
        ?? failedVectorHealthItem?.detail
        ?? failedVectorHealthItem?.message,
    };
  }

  if (health.isError || scopeList.isError || health.data?.ok === false || scopeList.data?.ok === false) {
    return {
      status: 'unknown',
      reason: queryErrorMessage(scopeList.error) ?? queryErrorMessage(health.error),
    };
  }

  const embeddingChecksPassed = vectorHealthItems.length === VECTOR_HEALTH_CHECK_NAMES.size
    && vectorHealthItems.every((item) => item.status === 'pass');
  if (embeddingChecksPassed && scopeList.data?.vectorAvailable === true) {
    return { status: 'available' };
  }

  if (health.isPending || scopeList.isPending) {
    return { status: 'checking' };
  }

  return {
    status: 'unknown',
    reason: queryErrorMessage(scopeList.error) ?? queryErrorMessage(health.error),
  };
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

/** 指定 group 的完整文档列表（不受 500 条全量分页截断影响），可选 tag 过滤 */
export function useGroupDocs(scope: string, group: string | null, tag?: string) {
  return useQuery<DocListResponse>({
    queryKey: ['docList', scope, 'group', group ?? '', tag ?? ''],
    queryFn: () => getDocList(scope, { group: group ?? '', tag: tag }),
    enabled: !!group,
    staleTime: 30_000,
    retry: 1,
  });
}
