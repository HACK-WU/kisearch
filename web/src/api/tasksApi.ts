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

/**
 * S-03/R6（REQ-20261009-003）：索引就绪判据（A11 交叉口径）。
 *   - `denseIndexed`：主判据（dense 索引实体 ≥1）；
 *   - `completeness`：引擎自报信号（**仅参考**——该信号曾恒为 0，单看会误判"从未建"）；
 *   - `unknown`：读取失败/超时 ⇒ **≠ 未建**（文案必须区分，N9 同源语义）。
 */
export interface TaskIndexReadiness {
  denseIndexed: boolean;
  completeness?: { dense?: number; fts?: number; scalar?: number };
  unknown?: boolean;
  reason?: string;
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
  /** S-03/R6：索引就绪判据（导入类任务在整理落定后写入；缺失 = 本次未产生整理） */
  indexReadiness?: TaskIndexReadiness;
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

/**
 * 本 scope 是否有运行中的导入类任务（S0-6：Browse 排队等待提示信号）。
 * 只看非终态任务；operation 为 import 的任务会与同 scope 的 /api/doc/list
 * 共用 OperationCoordinator 串行队列——列表加载慢大概率是排队。
 * 注：unknown（心跳过期）也计入——daemon 高负载导入时心跳可能饿死，
 * 任务被读侧改判 unknown 但实际仍在跑，此时正是最需要排队提示的场景。
 */
export function scopeImportRunning(tasks: TaskRecord[] | undefined, scope: string): TaskRecord | null {
  if (!tasks) return null;
  const active: Set<TaskState> = new Set(['running', 'queued', 'unknown']);
  return tasks.find((t) => t.scope === scope && t.operation === 'import' && active.has(t.state)) ?? null;
}

export function getTask(id: string): Promise<{ ok: boolean; task: TaskRecord }> {
  return request(`/api/tasks/${encodeURIComponent(id)}`);
}

/**
 * R8（REQ-20261009-003）：辅助读超时降级标记 —— 引擎未在超时上限内响应时，后端返回
 * **上次快照**（`status.state` 已置为 `'unknown'`，防止被误读为"刚刷新成功"）+ 本标记。
 * ★ 语义是"本次未确认"，不是"快照缺失/故障"（N9）—— UI 文案必须区分。
 */
export interface VectorDimensionDegraded {
  /** 当前后端只发 'timeout'（收窄类型：新增 reason 需同步改文案分支，见 vectorDimensionCopy.ts） */
  reason: 'timeout';
  waitedMs: number;
}

export interface VectorDimensionStatusResponse {
  ok: boolean;
  status: VectorDimensionStatus;
  degraded?: VectorDimensionDegraded;
}

export function getVectorDimensionStatus(scope: string): Promise<VectorDimensionStatusResponse> {
  return request(`/api/vector/status?scope=${encodeURIComponent(scope)}`);
}

export function refreshVectorDimensionStatus(scope: string): Promise<VectorDimensionStatusResponse> {
  return request('/api/vector/status/refresh', { method: 'POST', body: JSON.stringify({ scope }) });
}

/**
 * 未完成清单摘要（2026-10-13）——任务详情「重试未完成 N 篇」入口的只读判据。
 *
 * 后端只读清单文件 + 源目录存在性（走 `read` 通道，导入期间不被排队）；
 * ★ 响应**不含绝对路径**（只有 `sourceKind` / `sourceExists` / 计数）。
 */
export interface ImportIncompleteStatus {
  ok: boolean;
  scope: string;
  /** 主清单存在且可解析 */
  hasRecord: boolean;
  /** 清单文件存在但损坏（≠ 没有待办） */
  corrupted: boolean;
  /** 旧清单（写入时还没有 taskId）⇒ 归属未知，放行但需提示 */
  legacy: boolean;
  taskId?: string;
  itemCount: number;
  createdAt?: string;
  cancelled?: boolean;
  sourceKind?: 'upload' | 'external';
  sourceExists?: boolean;
  /** 是否可以按本清单重试——UI 只认这一个判据 */
  canRetry: boolean;
  /** canRetry=false 时的原因（可直接展示） */
  reason?: string;
  previous?: { itemCount: number; sourceKind: 'upload' | 'external'; sourceExists: boolean } | null;
}

export function getImportIncomplete(scope: string): Promise<ImportIncompleteStatus> {
  return request<ImportIncompleteStatus>(`/api/import/incomplete?scope=${encodeURIComponent(scope)}`);
}

/** 重试未完成的响应；失败分支（400/409）经 `request` 抛出，`error.body` 带 `code` 与原因 */
export interface RetryIncompleteResponse {
  ok: boolean;
  jobId?: string;
  scope?: string;
  itemCount?: number;
  sourceKind?: 'upload' | 'external';
  /** 清单无 taskId 时后端回带（归属未知，已按最新清单重试） */
  legacy?: boolean;
  /** 失败分支 */
  code?: string;
  error?: string;
  currentTaskId?: string;
}

/**
 * 按 scope 清单重试未完成文件（服务端解析源目录，**不需要浏览器凭据**）。
 * @param taskId 触发重试的任务 ID：与清单归属不一致时后端 409（清单已被后续导入覆盖）
 */
export function retryImportIncomplete(scope: string, taskId?: string): Promise<RetryIncompleteResponse> {
  return request<RetryIncompleteResponse>('/api/import/retry-incomplete', {
    method: 'POST',
    body: JSON.stringify({ scope, ...(taskId ? { taskId } : {}) }),
  });
}
