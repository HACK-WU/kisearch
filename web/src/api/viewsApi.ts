/**
 * viewsApi.ts —— `/api/views` 客户端（REQ-20261104-004 / R-03、R-11、R-13）
 *
 * 约定：`canEdit` / `mine` 一律用服务端返回值，**前端不比对 userId**
 * （两处口径必然漂移，见需求 §1.6）。
 */

export interface ViewMemberMeta {
  scope: string;
  kb: boolean;
  vector: boolean;
  readonly: boolean;
  /**
   * 该成员库的文档数（与 scope 列表「N 篇」同一口径）。
   * `undefined` = 未统计（计数失败时后端不给 0，避免把统计失败误标成空库）。
   */
  docCount?: number;
  /** 配了定时同步（数据源 `schedule.enabled`）；缺省 = 未配置 */
  scheduled?: boolean;
  /** 定时**上一次自动执行失败** → 页面显示「定时（上次失败）」 */
  scheduledFailed?: boolean;
  /**
   * 向量集合维度与当前 `embedding.dimension` 的比对结果：
   * `mismatch` = 已确认不一致（语义检索会直接跳过该库）；
   * `unknown` = 快照缺失/过期，状态未确认；
   * `undefined` = 无向量集合，或旧版 daemon 不下发该字段。
   *
   * ⚠ 「已确认清单」而非全量保证：没标 `mismatch` 不代表维度正常。
   */
  dimensionState?: 'ok' | 'mismatch' | 'unknown';
}

export interface ViewEntry {
  view: string;
  id: string;
  members: string[];
  memberMeta: ViewMemberMeta[];
  availableCount: number;
  missing: string[];
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
  revision: number;
  /** 服务端算：当前用户能否修改（管理员或创建者） */
  canEdit: boolean;
  /** 服务端算：是否当前用户创建 */
  mine: boolean;
  /** 服务端把 `createdBy`(userId) 翻成的显示名；旧视图可能没有 */
  createdByName?: string;
  /** 服务端算：有多少 Token 因缺成员授权看不到该视图（0 = 全部可见） */
  impactCount?: number;
}

export interface ImpactToken {
  id: string;
  label: string | null;
}

interface ApiError extends Error {
  code?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const payload = body as { code?: string; error?: string } | undefined;
    const err: ApiError = new Error(payload?.error ?? `请求失败（HTTP ${res.status}）`);
    if (payload?.code) err.code = payload.code;
    throw err;
  }
  return body as T;
}

export async function fetchViews(): Promise<ViewEntry[]> {
  const body = await request<{ views: ViewEntry[] }>('/api/views');
  return body.views ?? [];
}

export async function createView(name: string, members: string[]): Promise<ViewEntry> {
  const body = await request<{ view: ViewEntry }>('/api/views', {
    method: 'POST',
    body: JSON.stringify({ name, members }),
  });
  return body.view;
}

export async function patchView(
  id: string,
  patch: { name?: string; members?: string[]; baseRevision?: number },
): Promise<ViewEntry> {
  const body = await request<{ view: ViewEntry }>(`/api/views/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return body.view;
}

export async function removeView(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/views/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 影响面：给定候选成员，返回将失去该视图的 Token（R-05 口径，未被授权该视图的不计入） */
export async function fetchImpact(members: string[], viewId?: string): Promise<ImpactToken[]> {
  const qs = new URLSearchParams({ members: members.join(',') });
  if (viewId) qs.set('viewId', viewId);
  const body = await request<{ affected: ImpactToken[] }>(`/api/views/impact?${qs.toString()}`);
  return body.affected ?? [];
}
