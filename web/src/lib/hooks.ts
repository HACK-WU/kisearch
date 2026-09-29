/**
 * hooks.ts —— TanStack Query 数据获取 hooks
 */

import { useQuery } from '@tanstack/react-query';
import { getDocList, getHealth, type DocListResponse, type HealthResponse } from '@/api/httpApi';
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
