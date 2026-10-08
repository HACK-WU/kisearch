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
  code?: string;
}

export interface SearchConfigResponse {
  ok: boolean;
  /** 语义检索 query embedding 默认超时（秒） */
  timeout: number;
  error?: string;
}

export interface DocItem {
  name: string;
  group: string;
  path?: string;
  /** 文档级自定义标签（来自 relations-cache relation.tags） */
  tags?: string[];
  /**
   * 是否已向量化（KB 层登记的 memoryId/memoryIds 非空）→ 决定是否渲染 RAG 状态标签。
   * undefined = 后端未提供该字段（旧版 daemon），同样不渲染标签。
   */
  vectorized?: boolean;
  /** 是否有完整的 FTS-only 索引（旧 relation 缺少完整状态时以非空 ftsIds 兼容判定）。 */
  fullTextIndexed?: boolean;
}

/**
 * 单个 Group 的完整路径与本组文档数（不含子 Group）。
 * count 由后端按精确 group 名统计，不受 docs 分页 limit 截断影响。
 */
export interface DocGroup {
  name: string;
  count: number;
}

export interface DocListResponse {
  ok: boolean;
  scope: string;
  docs: DocItem[];
  total: number;
  truncated?: boolean;
  /** 服务端分页：本页起始偏移（S0-2；旧 daemon 不返回该字段） */
  offset?: number;
  /** 完整 group 列表 + 文档数量（不受 docs 分页 limit 影响），用于构建 Group 树 */
  groups?: DocGroup[];
  /** 全部文档的自定义 tag 去重列表（供前端 tag 过滤下拉使用） */
  tags?: string[];
  error?: string;
}

export interface EditableDocument {
  ok: true;
  scope: string;
  group: string;
  relation: string;
  content: string;
  revision: string;
  sourceConfigured: boolean;
  sourceRevision?: string;
  sourceError?: string;
  warning?: string;
  indexMode: 'fts' | 'dense';
}

export interface SaveDocumentResponse {
  ok: true;
  revision: string;
  sourceConfigured: boolean;
  sourceWritten: boolean;
  fullTextUpdated: boolean;
  vectorStored: boolean;
  indexedAs: 'fts' | 'dense' | 'unchanged';
  warning?: string;
}

export interface UploadFile {
  name: string;
  path?: string;
  size: number;
}

export interface UploadResponse {
  ok: boolean;
  uploadId?: string;
  jobId?: string;
  scope?: string;
  files?: UploadFile[];
  total?: number;
  errors?: { name: string; error: string }[];
  error?: string;
}

export interface UploadStatusResponse {
  ok: boolean;
  uploadId: string;
  scope: string;
  state: 'uploading' | 'importing' | 'done' | 'failed';
  jobId?: string;
  active: boolean;
  errors: { name: string; error: string }[];
}

export interface ImportConfigResponse {
  ok: boolean;
  scope: string;
  extensions: string[];
  maxFileSize: number;
  assets: boolean;
  assetExtensions: string[];
  maxAssetSize: number;
  maxRequestBody: number;
  vectorDimension?: { configured: number; persisted?: number; compatible: boolean | null; error?: string };
  error?: string;
}

export interface RunImportResponse {
  ok: boolean;
  jobId?: string;
  scope?: string;
  error?: string;
}

export type ImportConflictMode = 'overwrite' | 'skip' | 'suffix';

export interface ImportJob {
  id: string;
  scope: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
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

/**
 * 最近一次成功请求的往返耗时（ms）。
 * 总览「MCP HTTP 服务」健康项用它展示「最近一次响应 N ms」（demo 同款口径）。
 */
let lastRttMs: number | null = null;

/** 读取最近一次请求耗时；null = 尚无成功请求 */
export function getLastRttMs(): number | null {
  return lastRttMs;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const startedAt = performance.now();
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
    throw Object.assign(new Error(err), { status: res.status, body });
  }
  lastRttMs = Math.max(1, Math.round(performance.now() - startedAt));
  return body as T;
}

// ─── 业务封装 ─────────────────────────────────────────

export async function getHealth(): Promise<HealthResponse> {
  return req<HealthResponse>('/api/health');
}

export async function getSearchConfig(): Promise<SearchConfigResponse> {
  return req<SearchConfigResponse>('/api/search-config');
}

export async function getDocList(
  scope: string,
  opts: { q?: string; group?: string; tag?: string; offset?: number } = {},
): Promise<DocListResponse> {
  const params = new URLSearchParams({ scope });
  if (opts.q) params.set('q', opts.q);
  // 指定 group 时按 [offset, offset+limit) 分页返回该 group 文档（S0-2 服务端分页）
  if (opts.group) params.set('group', opts.group);
  // 按自定义 tag 过滤（relation.tags 精确匹配）
  if (opts.tag) params.set('tag', opts.tag);
  // 服务端分页偏移（与 limit 组合翻页；缺省 0 = 第一页）
  if (opts.offset !== undefined && opts.offset > 0) params.set('offset', String(opts.offset));
  return req<DocListResponse>(`/api/doc/list?${params.toString()}`);
}

/**
 * 取全指定 Group 的文档（S0-2）：按 offset 翻页聚合到 truncated:false 或取完 total。
 * 安全护栏 GROUP_DOCS_MAX_PAGES 防御 total 异常膨胀导致的无限循环（500 × 1000 = 50 万篇封顶）。
 */
const GROUP_DOCS_MAX_PAGES = 1000;

export async function fetchGroupDocsAll(
  scope: string,
  group: string,
  tag?: string,
): Promise<DocListResponse> {
  const first = await getDocList(scope, { group, tag });
  if (!first.truncated || first.docs.length === 0) return first;
  const total = Math.max(first.total, first.docs.length);
  const docs = [...first.docs];
  let offset = docs.length;
  for (let page = 1; page < GROUP_DOCS_MAX_PAGES && docs.length < total; page++) {
    const next = await getDocList(scope, { group, tag, offset });
    if (next.docs.length === 0) break;
    docs.push(...next.docs);
    offset += next.docs.length;
  }
  return { ...first, docs, truncated: docs.length < total };
}

export async function getEditableDocument(scope: string, group: string, relation: string): Promise<EditableDocument> {
  return req<EditableDocument>(`/api/doc/edit?${new URLSearchParams({ scope, group, relation }).toString()}`);
}

export async function saveEditableDocument(args: {
  scope: string;
  group: string;
  relation: string;
  content: string;
  expectedRevision: string;
  expectedSourceRevision?: string;
  vectorize?: boolean;
  editId?: string;
}): Promise<SaveDocumentResponse> {
  return req<SaveDocumentResponse>('/api/doc/edit', { method: 'POST', body: JSON.stringify(args) });
}

export async function getImportConfig(scope: string): Promise<ImportConfigResponse> {
  return req<ImportConfigResponse>(`/api/import/config?${new URLSearchParams({ scope }).toString()}`);
}

/** 请求取消导入任务：服务端在当前 embedding/zvec 批次完成后停止后续写入（POST /api/import/cancel） */
export async function cancelImport(jobId: string): Promise<{ ok: boolean; jobId: string; state: string; message?: string }> {
  const res = await fetch('/api/import/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; jobId?: string; state?: string; message?: string; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `取消请求失败（HTTP ${res.status}）`);
  }
  return { ok: true, jobId: data.jobId ?? jobId, state: data.state ?? 'cancelling', message: data.message };
}

export async function uploadFiles(
  scope: string,
  files: { name: string; content: string }[],
  uploadId: string,
  batchIndex: number,
  batchCount: number,
  finalize?: Omit<Parameters<typeof runImport>[0], 'scope' | 'uploadId'>,
): Promise<UploadResponse> {
  return req<UploadResponse>('/api/import/upload', {
    method: 'POST',
    headers: { 'X-Ki-Upload-Id': uploadId },
    body: JSON.stringify({
      scope,
      uploadId,
      batchIndex,
      batchCount,
      ...(finalize ? { finalize } : {}),
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
  /** 自定义 Group 路径前缀（如 "wiki/我的文档"） */
  group?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  vector?: boolean;
  /** 文档级自定义标签（逗号分隔），对本次导入全部文件生效 */
  tags?: string;
  /** 同名文档处理策略，默认 suffix */
  conflictMode?: ImportConflictMode;
  /** 自动后缀模板，必须包含 {n} */
  conflictSuffix?: string;
}): Promise<RunImportResponse> {
  return req<RunImportResponse>('/api/import/run', {
    method: 'POST',
    body: JSON.stringify(args),
  });
}

export async function getImportStatus(jobId: string): Promise<StatusResponse> {
  return req<StatusResponse>(`/api/import/status?jobId=${encodeURIComponent(jobId)}`);
}

export async function getImportUploadStatus(scope: string, uploadId: string): Promise<UploadStatusResponse> {
  return req<UploadStatusResponse>(`/api/import/upload-status?${new URLSearchParams({ scope, uploadId }).toString()}`);
}

// ─── Tag 相关 ───────────────────────────────────────────

export interface TagInfo {
  tag: string;
  count: number;
}

export interface TagsResponse {
  ok: boolean;
  tags: TagInfo[];
  scope: string;
  error?: string;
}

/** 获取 tag 列表（排除 ki-search/ki-relation/ki-path 内部保留 tag） */
export async function fetchTags(scope?: string): Promise<TagsResponse> {
  const sp = scope ? `?scope=${encodeURIComponent(scope)}` : '';
  return req<TagsResponse>(`/api/tags${sp}`);
}
