/**
 * hooks.ts —— TanStack Query 数据获取 hooks
 */

import { useQuery } from '@tanstack/react-query';
import { getDocList, getHealth, type DocListResponse, type HealthResponse } from '@/api/httpApi';
import { kiScopeList, type ScopeListResponse } from '@/api/mcpClient';

export type { ScopeListResponse };
export type ScopeEntry = ScopeListResponse['scopes'][number];

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

/** 文档列表（一次拉取当前 scope 全量，文件名/路径过滤由前端内存完成） */
export function useDocList(scope: string) {
  return useQuery<DocListResponse>({
    queryKey: ['docList', scope],
    queryFn: () => getDocList(scope),
    staleTime: 30_000,
    retry: 1,
  });
}
