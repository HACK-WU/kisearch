/**
 * governanceApi.ts —— `/api/governance/*` 客户端（REQ-20261113-004 · S-07）
 *
 * 约定（与后端 `governance-http.ts` 一一对应）：
 * · 响应外壳 `{ok:true,...}` / `{ok:false,code,error,details?}`；
 * · 失败统一抛 `GovernanceApiError`，**保留 `code`** —— 页面要按码分支
 *   （`REVISION_CONFLICT` 提示刷新、`RESTORE_NAME_CONFLICT` 行内报错），
 *   只给一句 message 的化页面只能显示"操作失败"；
 * · `lifecycle` 三档与后端一致：`wiki | temp | event`；期限用**相对天数** `ttlDays`。
 */

export type LifecycleKind = 'wiki' | 'temp' | 'event';
export type Visibility = 'full' | 'fts-only' | 'hidden';
export type TrashReason = 'temp-expired' | 'event-closed' | 'event-expired' | 'manual';

export class GovernanceApiError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'GovernanceApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    // 非 JSON 响应（网关/代理错误页）按状态码报错
  }
  if (!res.ok || payload.ok === false) {
    throw new GovernanceApiError(
      String(payload.error ?? `HTTP ${res.status}`),
      res.status,
      typeof payload.code === 'string' ? payload.code : undefined,
      payload.details,
    );
  }
  return payload as T;
}

// ─── 分类 ─────────────────────────────────────────────

export interface LifecycleListResponse {
  ok: true;
  scope: string;
  group: string | null;
  kinds: Array<{ kind: LifecycleKind; label: string; ttlOptions: number[]; min?: number; max?: number }>;
  presets: Array<{ id: string; name: string; kind: LifecycleKind; ttlDays?: number }>;
  groupDefaults: Record<string, { kind: LifecycleKind; ttlDays?: number }>;
  effectiveDefault?: { kind: LifecycleKind; ttlDays?: number; source?: string };
}

export function listLifecycle(scope: string, group?: string): Promise<LifecycleListResponse> {
  const params = new URLSearchParams({ scope });
  if (group) params.set('group', group);
  return req<LifecycleListResponse>(`/api/governance/lifecycle/list?${params.toString()}`);
}

export interface ApplyLifecycleResult {
  ok: true;
  scope: string;
  lifecycle: LifecycleKind;
  source: string;
  expiresAt?: number;
  ttlDays?: number;
  eventId?: string;
}

export function applyLifecycle(
  scope: string,
  args: { group: string; name: string; lifecycle?: LifecycleKind; ttlDays?: number; eventId?: string },
): Promise<ApplyLifecycleResult> {
  return req<ApplyLifecycleResult>('/api/governance/lifecycle/apply', {
    method: 'POST',
    body: JSON.stringify({ scope, ...args }),
  });
}

// ─── 事件类型 ─────────────────────────────────────────

export interface EventStageView {
  key: string;
  name: string;
  index: number;
  visibility: Visibility;
  disabled: boolean;
  originalName?: string;
}

export interface EventTypeView {
  id: string;
  name: string;
  builtin: boolean;
  terminalAction: 'keep' | 'trash';
  fallbackDays: number | null;
  revision: number;
  stages: EventStageView[];
}

export function listEventTypes(scope: string): Promise<{ ok: true; scope: string; types: EventTypeView[] }> {
  return req(`/api/governance/event-types?${new URLSearchParams({ scope }).toString()}`);
}

export function updateEventType(
  scope: string,
  id: string,
  patch: { revision: number; name?: string; terminalAction?: 'keep' | 'trash'; fallbackDays?: number | null },
): Promise<{ ok: true; type: EventTypeView }> {
  return req(`/api/governance/event-types/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ scope, ...patch }),
  });
}

// ─── 事件 ─────────────────────────────────────────────

export interface EventView {
  id: string;
  shortId: number;
  title: string;
  typeId: string;
  typeName?: string | null;
  stageKey: string;
  stageIndex: number;
  closedAt: number | null;
  revision: number;
  stage?: { key: string; name: string; index: number; visibility: Visibility };
  memberTotal?: number;
  docsPreview?: Array<{ group: string; name: string }>;
}

export interface EventListResponse {
  ok: true;
  scope: string;
  total: number;
  hasMore: boolean;
  events: EventView[];
}

export function listEvents(
  scope: string,
  opts: { status?: 'open' | 'closed' | 'all'; type?: string; q?: string; limit?: number; offset?: number } = {},
): Promise<EventListResponse> {
  const params = new URLSearchParams({ scope, status: opts.status ?? 'open' });
  if (opts.type) params.set('type', opts.type);
  if (opts.q) params.set('q', opts.q);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  return req<EventListResponse>(`/api/governance/events?${params.toString()}`);
}

export function createEvent(scope: string, args: { title: string; typeId: string }): Promise<{ ok: true; event: EventView }> {
  return req('/api/governance/events', {
    method: 'POST',
    body: JSON.stringify({ scope, ...args }),
  });
}

export interface TransitionResult {
  ok: true;
  scope: string;
  event: EventView;
  from: { key: string; name: string; index: number };
  to: { key: string; name: string; index: number };
  closed: boolean;
  affected: { docs: number; failed: number };
  visibility: { mode: Visibility; dense: boolean; fts: boolean };
  pending: string[];
  terminalAction?: 'keep' | 'trash';
}

export function setEventStage(scope: string, event: string, stage: string, note?: string): Promise<TransitionResult> {
  return req(`/api/governance/events/${encodeURIComponent(event)}/stage`, {
    method: 'POST',
    body: JSON.stringify({ scope, stage, ...(note ? { note } : {}) }),
  });
}

export function deleteEvent(
  scope: string,
  event: string,
  docAction: 'wiki' | 'trash',
): Promise<{ ok: true; affected: { docs: number; failed: number } }> {
  return req(`/api/governance/events/${encodeURIComponent(event)}`, {
    method: 'DELETE',
    body: JSON.stringify({ scope, docAction }),
  });
}

export function reopenEvent(scope: string, event: string): Promise<{ ok: true; hint: string }> {
  return req(`/api/governance/events/${encodeURIComponent(event)}/reopen`, {
    method: 'POST',
    body: JSON.stringify({ scope }),
  });
}

// ─── 回收站 ───────────────────────────────────────────

export interface TrashItemView {
  scope: string;
  group: string;
  name: string;
  reason: TrashReason;
  deletedAt: number;
  expiresAt: number;
  ttlDays: number;
  ttlAssumed?: boolean;
  restoreCount: number;
  dirName: string;
  hasAssets: boolean;
  sizeBytes: number;
}

export interface TrashSettingsView {
  keepDays: 3 | 7 | 14 | 30;
  expireAction: 'purge' | 'notify';
}

export function listTrash(
  scope: string,
  opts: { reason?: TrashReason; limit?: number; offset?: number } = {},
): Promise<{ ok: true; scope: string; total: number; items: TrashItemView[]; settings: TrashSettingsView }> {
  const params = new URLSearchParams({ scope });
  if (opts.reason) params.set('reason', opts.reason);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  return req(`/api/governance/trash?${params.toString()}`);
}

export function restoreTrash(
  scope: string,
  args: { group: string; dirName: string; targetLifecycle?: 'wiki' | 'temp' },
): Promise<{ ok: true; lifecycle: LifecycleKind; expiresAtChanged: boolean; rebuild: string; hint?: string }> {
  return req('/api/governance/trash/restore', {
    method: 'POST',
    body: JSON.stringify({ scope, ...args }),
  });
}

export function purgeTrash(scope: string, args: { group: string; dirName: string }): Promise<{ ok: true }> {
  return req('/api/governance/trash/purge', {
    method: 'POST',
    body: JSON.stringify({ scope, ...args }),
  });
}

export function getTrashSettings(scope: string): Promise<{ ok: true; settings: TrashSettingsView; options: number[] }> {
  return req(`/api/governance/trash/settings?${new URLSearchParams({ scope }).toString()}`);
}

export function putTrashSettings(scope: string, settings: TrashSettingsView): Promise<{ ok: true; settings: TrashSettingsView }> {
  return req('/api/governance/trash/settings', {
    method: 'PUT',
    body: JSON.stringify({ scope, ...settings }),
  });
}

// ─── 计数 / 诊断 ──────────────────────────────────────

export interface GovernanceCounts {
  ok: true;
  scope: string;
  docs: number;
  eventsOpen: number;
  eventsClosed: number;
  trash: number;
  pendingIndex: number;
}

export function getGovernanceCounts(scope: string): Promise<GovernanceCounts> {
  return req(`/api/governance/counts?${new URLSearchParams({ scope }).toString()}`);
}

export interface GovernanceDiagnostics {
  ok: true;
  scope: string;
  pending: { count: number; items: Array<{ group: string; relation: string; target: string; attempts: number }> };
  failures: { items: Array<{ group: string; relation: string; kind: string; code: string; message: string; attempts: number }> };
  trash: { total: number };
}

export function getGovernanceDiagnostics(scope: string): Promise<GovernanceDiagnostics> {
  return req(`/api/governance/diagnostics?${new URLSearchParams({ scope }).toString()}`);
}
