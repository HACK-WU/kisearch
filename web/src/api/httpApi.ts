/**
 * httpApi.ts —— /api/* 接口封装（方案 A：扩展 mcp-http 路由）
 *
 * 与 ki mcp --http 同源，直接 fetch 同源路径（--web 提供页面）。
 * dev 模式下经 Vite proxy 转发到 7423。
 */

// ─── 类型（对齐 mcp-http-api.ts 返回） ────────────────

export interface HealthItem {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail?: string;
  message?: string;
}

export interface HealthReport {
  pass?: boolean;
  fail?: number;
  warn?: number;
  items: HealthItem[];
  [k: string]: unknown;
}

export interface HealthResponse {
  ok: boolean;
  report?: HealthReport;
  error?: string;
}

export interface DocItem {
  name: string;
  group: string;
  path?: string;
}

export interface DocListResponse {
  ok: boolean;
  scope: string;
  docs: DocItem[];
  total: number;
  truncated?: boolean;
  error?: string;
}

export interface UploadFile {
  name: string;
  path?: string;
  size: number;
}

export interface UploadResponse {
  ok: boolean;
  uploadId?: string;
  scope?: string;
  files?: UploadFile[];
  total?: number;
  errors?: { name: string; error: string }[];
  error?: string;
}

export interface RunImportResponse {
  ok: boolean;
  jobId?: string;
  scope?: string;
  mode?: string;
  error?: string;
}

export interface ImportJob {
  id: string;
  scope: string;
  mode: 'full' | 'incremental';
  state: 'running' | 'done' | 'failed';
  phase?: string;
  progress?: { done: number; total: number };
  result?: Record<string, unknown>;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface StatusResponse {
  ok: boolean;
  job?: ImportJob;
  error?: string;
}

// ─── 基础 fetch 封装 ──────────────────────────────────

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: T | undefined;
  try {
    body = (await res.json()) as T;
  } catch {
    /* 非 JSON（如 404 HTML） */
  }
  if (!res.ok || !body) {
    const err = (body as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
    throw new Error(err);
  }
  return body as T;
}

// ─── 业务封装 ─────────────────────────────────────────

export async function getHealth(): Promise<HealthResponse> {
  return req<HealthResponse>('/api/health');
}

export async function getDocList(scope: string, q?: string): Promise<DocListResponse> {
  const params = new URLSearchParams({ scope });
  if (q) params.set('q', q);
  return req<DocListResponse>(`/api/doc/list?${params.toString()}`);
}

export async function uploadFiles(
  scope: string,
  files: { name: string; content: string }[],
): Promise<UploadResponse> {
  return req<UploadResponse>('/api/import/upload', {
    method: 'POST',
    body: JSON.stringify({
      scope,
      files: files.map((f) => ({
        name: f.name,
        content: f.content,
        size: Math.round((f.content.length * 3) / 4), // base64 → 原始字节估算
      })),
    }),
  });
}

export async function runImport(args: {
  scope: string;
  uploadId: string;
  mode: 'full' | 'incremental';
  rootName?: string;
  /** 自定义 Group 路径前缀（如 "wiki/我的文档"） */
  group?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  vector?: boolean;
}): Promise<RunImportResponse> {
  return req<RunImportResponse>('/api/import/run', {
    method: 'POST',
    body: JSON.stringify(args),
  });
}

export async function getImportStatus(jobId: string): Promise<StatusResponse> {
  return req<StatusResponse>(`/api/import/status?jobId=${encodeURIComponent(jobId)}`);
}
