export type TaskSource = 'cli' | 'daemon' | 'web';
export type TaskState = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown';

export interface TaskProgress {
  phase?: string;
  done: number;
  total: number;
  persisted?: number;
  failed?: number;
  cancelled?: number;
  notProcessed?: number;
  metadataPending?: number;
}

export interface TaskRecord {
  id: string;
  source: TaskSource;
  operation: string;
  scope: string;
  state: TaskState;
  phase?: string;
  progress?: TaskProgress;
  error?: string;
  recoveryHint?: string;
  partialCommitted?: number;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface TasksResponse {
  ok: boolean;
  tasks: TaskRecord[];
  total: number;
  retainedForMs: number;
  error?: string;
}

export interface VectorDimensionStatus {
  scope: string;
  state: 'compatible' | 'mismatch' | 'unknown';
  configured: number;
  persisted?: number;
  checkedAt?: number;
  error?: string;
  staleAfterMs: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { status: response.status, body });
  return body;
}

export function getTasks(limit = 100): Promise<TasksResponse> {
  return request<TasksResponse>(`/api/tasks?limit=${encodeURIComponent(String(limit))}`);
}

export function getTask(id: string): Promise<{ ok: boolean; task: TaskRecord }> {
  return request(`/api/tasks/${encodeURIComponent(id)}`);
}

export function getVectorDimensionStatus(scope: string): Promise<{ ok: boolean; status: VectorDimensionStatus }> {
  return request(`/api/vector/status?scope=${encodeURIComponent(scope)}`);
}

export function refreshVectorDimensionStatus(scope: string): Promise<{ ok: boolean; status: VectorDimensionStatus }> {
  return request('/api/vector/status/refresh', { method: 'POST', body: JSON.stringify({ scope }) });
}
