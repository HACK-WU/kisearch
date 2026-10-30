/**
 * httpApi.ts —— /api/* 接口封装（方案 A：扩展 mcp-http 路由）
 *
 * 与 ki mcp --http 同源，直接 fetch 同源路径（--web 提供页面）。
 * dev 模式下经 Vite proxy 转发到 daemon（目标见 `vite.config.ts` 的 `KI_API_TARGET`，默认 :7433）。
 */

// ─── 类型（对齐 mcp-http-api.ts 返回） ────────────────

export interface HealthItem {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail?: string;
  message?: string;
}

export interface HealthReport {
  /**
   * 通过项数（**数值**）。
   * ⚠️ 旧定义误写为 `boolean`，与后端不符 —— `src/lib/health-check.ts:36-41` 的
   * HealthReport 三项（pass/warn/fail）均为 count 数值；订正前前端无任何消费点，
   * 故直接更正（REQ-20261016-003 R2 起角标改用该计数）。
   */
  pass?: number;
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

export interface HttpReadinessResponse {
  ok: boolean;
  name?: string;
}

export interface SearchConfigResponse {
  ok: boolean;
  /** 语义检索 query embedding 默认超时（秒） */
  timeout: number;
  error?: string;
}

/**
 * `/healthz` 返回体中前端会用到的字段（完整结构见 `src/lib/mcp-http.ts` 的 `HealthzInfo`）。
 *
 * 只取**稳定**子集：`port` 是 daemon 实际监听端口（前端显示 MCP 端口的唯一权威来源，
 * 见 `lib/daemonPort.ts`），`version` 是 daemon 进程版本。
 */
export interface HealthzInfo {
  ok: boolean;
  name?: string;
  version?: string;
  /** 对外暴露的绑定地址；`--port 0` 或旧版本可能缺省 */
  host?: string;
  port?: number;
}

export interface DocItem {
  name: string;
  group: string;
  /** 导入源相对路径（relation.sourcePath）；MCP / CLI 写入的文档没有该字段 */
  path?: string;
  /**
   * 检索命中来源（**仅 `q` 检索时下发**）：`name` 名称命中 / `path` 路径命中。
   * 旧版 daemon 不返回 → 组件按"名称命中"降级，不丢结果。
   */
  matchedBy?: 'name' | 'path';
  /** 检索时下发：Group 与 sourcePath 合并后的完整路径（后端唯一拼装点，避免各端拼出不同路径） */
  logicalPath?: string;
  /** 文档级自定义标签（来自 relations-cache relation.tags） */
  tags?: string[];
  /**
   * 落点来源（REQ-20261021-001）：`scope-fallback` = 写入时 Group 留空，
   * 由「与 scope 同名组」兜底落进来。**缺省 = 用户显式指定了 Group**（老数据同此）。
   */
  groupSource?: 'scope-fallback';
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
  /** REQ-20261019-002：同步错误码（如 IMPORT_JOB_PARAMS_MISMATCH），供前端分流 */
  code?: string;
}

/**
 * 同名文档处理策略（REQ-20261010-001）。
 * `incremental`（默认）= 增量导入：同 sourcePath 重复导入时内容未变则跳过重算，
 * 内容变了照常覆盖；同名不同 sourcePath（或同批重复 rel）**一律直接覆盖**，不生成后缀副本。
 */
export type ImportConflictMode = 'incremental' | 'overwrite' | 'skip' | 'suffix';

export interface ImportJob {
  id: string;
  scope: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  phase?: string;
  progress?: { done: number; total: number };
  result?: Record<string, unknown>;
  error?: string;
  /** REQ-20261019-002：可判别错误码（ALL_FILES_DUPLICATES 等），前端据此渲染可纠正提示 */
  errorCode?: string;
  startedAt: number;
  finishedAt?: number;
  /**
   * S-02/S-03（REQ-20261009-003）：**两级完成口径**（后端纯新增字段）。
   *   - `usable`：元数据提交那一刻即 true ⇒「文档立即可用」，**不被索引整理推迟**；
   *   - `indexState`：`indexing` →（`optimized` | `available` | `skipped`）。
   *     `indexing` 期间前端**必须继续轮询**（`state` 已是 'done'），落到 `optimized` 才收尾；
   *   - `indexReadiness`：A11 交叉判据（索引实体 ∨ 引擎信号），`unknown` = 读取失败≠未建。
   */
  usable?: boolean;
  indexState?: 'indexing' | 'optimized' | 'available' | 'skipped';
  /** 整理结果未落定（unknown ≠ 失败）：前端不得渲染成 error，也不引导重跑 */
  indexMaintenanceUnknown?: boolean;
  indexMaintenance?: { scheduled: boolean; merged: boolean };
  indexMaintenanceDegraded?: { degraded?: string; reason?: string };
  indexReadiness?: {
    denseIndexed: boolean;
    completeness?: { dense?: number; fts?: number; scalar?: number };
    unknown?: boolean;
    reason?: string;
  };
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

/** 只确认 MCP HTTP 进程可响应；不执行 embedding 等外部健康诊断。 */
export async function getHttpReadiness(): Promise<HttpReadinessResponse> {
  return req<HttpReadinessResponse>('/healthz');
}

export async function getSearchConfig(): Promise<SearchConfigResponse> {
  return req<SearchConfigResponse>('/api/search-config');
}

/**
 * 探活端点 `/healthz`（免鉴权，MCP 单例探活同源）。
 *
 * 刻意**不走 `req()`**：`req` 会把耗时写进 `lastRttMs`，而总览页「MCP HTTP 服务」
 * 展示的是「最近一次 /api 请求响应 N ms」；让探活覆盖它会把运维指标污染成 1ms 级假象。
 */
export async function getHealthz(): Promise<HealthzInfo> {
  const res = await fetch('/healthz', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as HealthzInfo;
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

/** GET /api/doc/get 返回：单篇文档正文（浏览页阅读器） */
export interface DocContentResponse {
  ok?: boolean;
  scope?: string;
  content?: string;
  revision?: string;
  totalLines?: number;
  error?: string;
  hint?: string;
}

/**
 * 读取单篇文档正文（浏览页阅读器专用）。
 *
 * 为什么不再走 MCP `ki_get_module_info`：MCP 请求在后端按缺省 `write` 入队，
 * 导入/向量化长任务期间同 scope 的读被排到队尾（隔离实测 8745ms）；本接口走 `read`
 * 通道（只与元数据提交窗口短互斥），实测导入期间 3ms 级返回。
 * 代价：不做向量模糊兜底 —— group/relation 须精确（浏览页本就来自文档列表/深链接）。
 * 未命中时后端返回 404 + error/hint，这里拼成一条消息抛出（与 MCP 路径的提示口径一致）。
 */
export async function getDocContent(scope: string, group: string, relation: string): Promise<DocContentResponse> {
  const params = new URLSearchParams({ scope, group, relation });
  try {
    return await req<DocContentResponse>(`/api/doc/get?${params.toString()}`);
  } catch (err) {
    const body = (err as { body?: DocContentResponse }).body;
    if (body && (body.error || body.hint)) {
      throw new Error([body.error, body.hint].filter(Boolean).join('；'));
    }
    throw err;
  }
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

/** R6（REQ-20261010-001）：重复导入预检命中的一条（内容一致但来源路径不同） */
export interface ImportPreflightDuplicate {
  /** 本次待导入文件的相对路径 */
  rel: string;
  existingGroup: string;
  existingRelation: string;
  /** 库中该文档记录的来源路径（可能为空：手工写入的文档没有 sourcePath） */
  existingSourcePath: string;
}

export interface ImportPreflightResult {
  ok: boolean;
  scope?: string;
  error?: string;
  files?: { scanned: number; matched: number };
  duplicates?: ImportPreflightDuplicate[];
  /** 明细被截断（files.matched 仍是完整计数） */
  truncated?: boolean;
}

/**
 * 重复导入预检（只读，无任何写入）：导出前提示"本次 N 篇与库中已有文档内容一致、
 * 但来源路径不同，直接导入会新建副本"，由用户确认后再调 `runImport`。
 */
export async function preflightImport(args: {
  scope: string;
  uploadId: string;
  /**
   * 本次导入的 Group（与 `runImport` 同参数）。
   * ★ 必须传：落点 = group + 文件相对路径，服务端只比裸相对路径时，
   *   「上次选父目录、本次选 group 子目录」的幂等更新会被误报成重复。
   */
  group?: string;
  onlyRelPaths?: string[];
}): Promise<ImportPreflightResult> {
  return req<ImportPreflightResult>('/api/import/preflight', {
    method: 'POST',
    body: JSON.stringify(args),
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
  /** 同名文档处理策略，默认 incremental；skip = 库中已存在的一律不动（只导入新文件） */
  conflictMode?: ImportConflictMode;
  /** 自动后缀模板，必须包含 {n} */
  conflictSuffix?: string;
  /**
   * R2（REQ-20261009-001）：只重试这些文件（相对暂存目录的路径）。
   * 用同一 uploadId 重跑未完成子集——不必重新上传，已完成文件不重算 embedding。
   */
  onlyRelPaths?: string[];
  /**
   * REQ-20261019-002：跳过「内容与库中一致但 sourcePath 不同」的疑似重复文档。
   * 缺省不传 = 与改前行为一致；由服务端按同一判据重算（前端清单只用于展示）。
   */
  skipDuplicates?: boolean;
  /**
   * REQ-20261019-001：本次选择方式。只有 `'dir'` 才会计算清理候选；
   * `'files'` / `'mixed'`（目录与文件混合）一律不产候选。
   */
  pickMode?: 'dir' | 'files' | 'mixed';
  /** REQ-20261019-001：导入后是否计算「库中存在、本次目录已没有」的候选（默认关） */
  pruneStale?: boolean;
  /** 上传阶段失败的文件 rel（视为「本次有」，永不进候选）；仅在所有批次成功应答时提供 */
  preserveRels?: string[];
}): Promise<RunImportResponse> {
  return req<RunImportResponse>('/api/import/run', {
    method: 'POST',
    body: JSON.stringify(args),
  });
}

// ─── REQ-20261019-001：清理候选 ────────────────────────────

/** 与后端 `ImportPrunePlan` 逐字段一致的镜像（后端为准，改动需同步两端） */
export interface ImportPruneCandidate {
  group: string;
  relation: string;
  sourcePath: string;
  /** 所属 group 本次没有任何文件落入（前端默认不勾选） */
  untouched: boolean;
}

export interface ImportPrunePlan {
  scope: string;
  scopeGroups: number;
  libDocs: number;
  judicable: number;
  scanned: number;
  overlap: number;
  coordRatio: number;
  deleteRatio: number;
  /** 删除占比超 20%：不关闭功能，但必须强制二次确认 */
  warn: boolean;
  overLimit: boolean;
  total: number;
  items: ImportPruneCandidate[];
  truncated: boolean;
  unableCount: number;
  untouchedGroups: string[];
  token?: string;
  skipReason?: string;
  skipDetail?: string;
}

export interface PruneImportArgs {
  scope: string;
  /** 与导入时同口径；缺省 = 全 scope */
  group?: string;
  /** 首选：服务端重扫同一暂存目录（与 run 同源）。与 `scannedRels` 至少给一个 */
  uploadId?: string;
  /** 降级通道：仅 CLI/脚本使用 */
  scannedRels?: string[];
  /** 必须与 run 时一致（上传失败的文件视为「本次有」），否则 token 恒失配 */
  preserveRels?: string[];
  /** `dryRun` 时可省 */
  token?: string;
  /** true = 只重算并返回新清单与 token，不删除 */
  dryRun?: boolean;
  /** **必填**（fail-safe）：只删这些 `{group, relation}`；`[]` 不删任何东西 */
  selected: { group: string; relation: string }[];
}

export interface PruneImportResponse {
  ok: boolean;
  scope?: string;
  dryRun?: boolean;
  /** 候选已空（重复点击 / 上次已删完），不是错误 */
  allDone?: boolean;
  requested?: number;
  selected?: number;
  deleted?: number;
  skipped?: { group: string; relation: string; reason: string }[];
  failed?: { group: string; relation: string; reason: string }[];
  plan?: ImportPrunePlan;
  code?: string;
  error?: string;
  skipReason?: string;
  skipDetail?: string;
}

export async function pruneImport(args: PruneImportArgs): Promise<PruneImportResponse> {
  return req<PruneImportResponse>('/api/import/prune', {
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

/** R8 二期：超时降级的响应标记（与 `/vector/status/refresh` 的 `degraded` 同形） */
export interface TagsDegraded {
  reason: 'timeout';
  waitedMs: number;
}

export interface TagsResponse {
  ok: boolean;
  tags: TagInfo[];
  scope: string;
  error?: string;
  /**
   * R8 二期（REQ-20261009-003）：引擎未在超时上限内响应时为 `{reason:'timeout', waitedMs}`，
   * 此时 `ok=false`、`tags` 为空 —— 调用方应**保留现有标签、不视为故障**
   * （SearchPage / ImportPage / WritePage 现有 `if (res.ok)` 守卫已兼容）。
   * ⚠️ 与后端 `TagListResult.degraded`（boolean）**同名不同形**：后者不上线，
   *    本字段只表示 timeout 降级。
   */
  degraded?: TagsDegraded;
}

/** 获取 tag 列表（排除 ki-search/ki-relation/ki-path 内部保留 tag） */
export async function fetchTags(scope?: string): Promise<TagsResponse> {
  const sp = scope ? `?scope=${encodeURIComponent(scope)}` : '';
  return req<TagsResponse>(`/api/tags${sp}`);
}

// ─── 数据源（REQ-20261020-001 · 页面只读 + 唯一写动作「删除待删候选」） ───

export type DataSourceSyncState = 'ok' | 'partial' | 'failed' | 'cancelled';
export type DataSourceKind = 'directory' | 'git';

export interface SyncAvailabilityView {
  allowed: boolean;
  nextAvailableAt: number | null;
  retryAfterSec: number | null;
  reason: 'active' | 'cooldown' | null;
}

export interface DataSourcePendingItem {
  group: string;
  relation: string;
  sourcePath?: string;
  untouched?: boolean;
}

export interface DataSourcePendingDelete {
  token?: string;
  computedAt: number;
  total: number;
  overLimit: boolean;
  truncated: boolean;
  items: DataSourcePendingItem[];
  untouchedGroups: string[];
  unableCount: number;
  eligibleCount: number;
  stale: boolean;
  staleReason: 'source-missing' | 'source-unreadable' | 'not-recomputed' | null;
  blocked: string | null;
  skipDetail?: string;
}

export interface DataSourceResultView {
  files: {
    scanned: number;
    /** 旧 daemon 缺省 → 回退 scanned */
    fullScanned?: number;
    /** 旧 daemon 缺省 → 回退 scanned */
    changed?: number;
    completed: number;
    unchanged: number;
    skipped: number;
    incomplete: number;
    duplicatesSkipped: number;
  };
  vectorized: number;
  fullTextIndexed: number;
  groups: string[];
  conflicts: { path: string; relation: string; action: string; unchanged?: boolean }[];
  failures: { path: string; reason: string }[];
  /** 本次新建的文档（旧快照不返回 → 卡片显示"无记录"而非"0 篇"） */
  created?: { group: string; relation: string }[];
  createdTotal?: number;
  createdTruncated?: boolean;
}

export interface DataSourceGitSyncView {
  commit: string | null;
  runCommit: string | null;
  shortCommit: string | null;
  subject: string | null;
  authorTime: number | null;
  changedCount: number;
  fullScanned: number;
  untrackedMarkdown: number;
  update: 'updated' | 'up-to-date' | 'skipped' | 'failed';
  updateDetail?: string;
  fetch: 'ok' | 'failed' | 'skipped';
  fetchDetail?: string;
}

export interface DataSourceWarningView {
  code: string;
  message: string;
}

export interface DataSourceLastSyncView {
  at: number;
  durationMs: number;
  state: DataSourceSyncState;
  taskId?: string;
  params: {
    group: string | null;
    conflictMode: string;
    vector: boolean;
    chunkSize: number | null;
    chunkOverlap: number | null;
    /** 旧快照缺省 → 视作全量 */
    mode?: 'incremental' | 'full';
  };
  result: DataSourceResultView;
  /** 服务端内部扫描基线，detail 接口不下发（页面不消费） */
  seenRels?: string[];
  pendingDelete: DataSourcePendingDelete;
  git?: DataSourceGitSyncView;
  warnings?: DataSourceWarningView[];
}

/** 当前同步运行态（来自任务台账）：null = 空闲 */
export type DataSourceActiveState = 'queued' | 'running';

export type DataSourceScheduleMode = 'interval' | 'at';
export type DataSourceScheduleUnit = 'minute' | 'hour' | 'day';
export type DataSourceScheduleRepeat = 'once' | 'daily';

export interface DataSourceScheduleView {
  enabled: boolean;
  mode: DataSourceScheduleMode;
  intervalValue: number | null;
  intervalUnit: DataSourceScheduleUnit | null;
  at: string | null;
  repeat: DataSourceScheduleRepeat | null;
  revision: number;
  /** 启用锚点（服务端写，客户端只读）：周期模式的起算基准之一，旧 daemon 不返回 */
  enabledAt?: number | null;
  consecutiveFailures: number;
  lastAutoAt: number | null;
  lastAutoFor: number | null;
  lastAutoState: DataSourceSyncState | null;
  lastSkipReason: string | null;
  lastSkipAt: number | null;
  nextRunAt: number | null;
}

export interface DataSourceScheduleInput {
  enabled: boolean;
  mode: DataSourceScheduleMode;
  intervalValue: number | null;
  intervalUnit: DataSourceScheduleUnit | null;
  at: string | null;
  repeat: DataSourceScheduleRepeat | null;
  baseRevision?: number;
}

export interface DataSourceScheduleResponse {
  ok: boolean;
  scope: string;
  schedule: DataSourceScheduleView;
  nextRunAt: number | null;
  warnings: { code: string; message: string }[];
  schedulerDisabled: boolean;
}

export interface DataSourceRecordView {
  version: number;
  scope: string;
  type?: DataSourceKind;
  dir: string;
  git?: {
    repoRoot: string;
    relativeRoot: string;
    branch: string | null;
    remoteUrl: string | null;
    managed: boolean;
    remoteBranch: string | null;
  };
  group: string | null;
  conflictMode: string;
  conflictSuffix: string;
  vector: boolean;
  chunkSize: number | null;
  chunkOverlap: number | null;
  createdAt: number;
  updatedAt: number;
  /** 配置修订号（仅登记/编辑同步参数 +1；旧 daemon 不返回，按 0 处理） */
  revision?: number;
  /** 旧 daemon 不下发 → 页面隐藏定时入口 */
  schedule?: DataSourceScheduleView;
  lastSync: DataSourceLastSyncView | null;
}

export interface DataSourceListRow {
  scope: string;
  type?: DataSourceKind;
  git?: {
    repoRoot: string;
    relativeRoot: string;
    branch: string | null;
    managed: boolean;
    shortCommit: string | null;
    commitTime: number | null;
    untrackedMarkdown: number;
  } | null;
  syncAvailability?: SyncAvailabilityView;
  dir: string;
  group: string | null;
  conflictMode: string;
  vector: boolean;
  registeredAt: number;
  updatedAt: number;
  lastSync: {
    at: number;
    durationMs: number;
    state: DataSourceSyncState;
    files: DataSourceResultView['files'];
    pendingDelete: { total: number; overLimit: boolean; stale: boolean; blocked: string | null };
  } | null;
  running: boolean;
  /** 当前运行态（精确口径）；`running === (activeState !== null)`。旧 daemon 不返回，按 running 兜底 */
  activeState?: DataSourceActiveState | null;
  /** 本次同步开始时间（仅 running） */
  activeStartedAt?: number | null;
  stale: boolean;
  /** 定时计划视图（旧 daemon 不下发） */
  schedule?: DataSourceScheduleView;
}

export interface DataSourceListResponse {
  ok: boolean;
  total: number;
  /** 能力声明：旧 daemon 不返回 ⇒ 隐藏「编辑」与只读开关 */
  capabilities?: {
    datasourceUpdate?: boolean;
    scopeReadonly?: boolean;
  };
  schedulerDisabled?: boolean;
  sources: DataSourceListRow[];
  missing: { scope: string; reason: string; schedule?: DataSourceScheduleView }[];
  corrupt?: { scope: string; reason: string }[];
}

export interface DataSourceDetailResponse {
  ok: boolean;
  running: boolean;
  /** 旧 daemon 缺省；页面用 running 兜底 */
  activeState?: DataSourceActiveState | null;
  activeStartedAt?: number | null;
  /** 旧 daemon 缺省 → 页面隐藏同步入口并提示升级 */
  syncAvailability?: SyncAvailabilityView;
  schedulerDisabled?: boolean;
  source: DataSourceRecordView;
}

export interface DataSourceSyncTriggerResponse {
  ok: boolean;
  scope: string;
  taskId: string;
  mode: 'incremental' | 'full';
  state: 'queued';
}

export interface DataSourcePruneResponse {
  ok: boolean;
  scope: string;
  deleted: number;
  failed: number;
  results: { group: string; relation: string; deleted: boolean; wikiRemoved: boolean; wikiSkipReason?: string; reason?: string }[];
  skipped: { group: string; relation: string; reason: string }[];
  pendingDelete: DataSourcePendingDelete;
}

export async function getDataSourceList(scope?: string): Promise<DataSourceListResponse> {
  const sp = scope ? `?scope=${encodeURIComponent(scope)}` : '';
  return req<DataSourceListResponse>(`/api/datasource/list${sp}`);
}

export async function getDataSourceDetail(scope: string): Promise<DataSourceDetailResponse> {
  return req<DataSourceDetailResponse>(`/api/datasource/detail?scope=${encodeURIComponent(scope)}`);
}

/** 页面同步（服务端负责限频/并发闸门；返回 taskId） */
export async function syncDataSource(input: {
  scope: string;
  full?: boolean;
}): Promise<DataSourceSyncTriggerResponse> {
  return req<DataSourceSyncTriggerResponse>('/api/datasource/sync', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 保存定时设置（唯一配置入口；baseRevision 用于多标签页乐观锁） */
export async function saveDataSourceSchedule(input: {
  scope: string;
  schedule: DataSourceScheduleInput;
}): Promise<DataSourceScheduleResponse> {
  return req<DataSourceScheduleResponse>('/api/datasource/schedule', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** S-05：页面添加 Git URL 数据源（服务端 clone + 登记 + 自动入队首次同步） */
export interface AddRemoteDataSourceResponse {
  ok: boolean;
  scope: string;
  taskId: string;
  state: 'queued';
}

export async function addRemoteDataSource(input: {
  scope: string;
  url: string;
  branch?: string;
  subdir?: string;
  group?: string | null;
  vector?: boolean;
  /** 新建 scope 时同时设为只读（写 config.scopeReadonly；失败由任务警告回报） */
  readonly?: boolean;
}): Promise<AddRemoteDataSourceResponse> {
  return req<AddRemoteDataSourceResponse>('/api/datasource/add-remote', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 编辑同步参数（2026-10-30）：只改传入字段；身份字段不在其中 */
export interface UpdateDataSourceConfigInput {
  scope: string;
  /** 乐观锁：打开编辑弹窗时的 record.revision */
  baseRevision?: number;
  patch: {
    conflictMode?: string;
    conflictSuffix?: string;
    vector?: boolean;
    chunkSize?: number | null;
    chunkOverlap?: number | null;
  };
}

export interface UpdateDataSourceConfigResponse {
  ok: boolean;
  scope: string;
  record: DataSourceRecordView;
  changed: string[];
  schedulerDisabled?: boolean;
}

export async function updateDataSourceConfig(
  input: UpdateDataSourceConfigInput,
): Promise<UpdateDataSourceConfigResponse> {
  return req<UpdateDataSourceConfigResponse>('/api/datasource/update', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function pruneDataSource(input: {
  scope: string;
  token: string;
  selected: { group: string; relation: string }[];
}): Promise<DataSourcePruneResponse> {
  return req<DataSourcePruneResponse>('/api/datasource/prune', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 取消数据源登记的结果（不删库内文档） */
export interface RemoveDataSourceResponse {
  ok: boolean;
  scope: string;
  /** false = 读到之后、删除之前登记已被并发移除（按成功处理，不是失败） */
  removed: boolean;
  /** 托管 clone 根目录（仅要求 purge 且为托管源时返回） */
  managedCloneDir?: string;
  cloneRemoved?: boolean;
  /** 其他 scope 仍在复用该 clone，已跳过删除 */
  cloneRemoveSkipped?: boolean;
  cloneRemoveReason?: string;
  cloneRemoveError?: string;
}

/**
 * 移除数据源登记（等价 CLI `ki datasource remove`），**不删库内文档**。
 * - `purge`：一并删除服务端托管的 clone 目录（受引用计数保护）
 * - `force`：仅用于不可解析的登记（CORRUPT / INVALID）——坏文件解析不了，这是唯一出口
 */
export async function removeDataSource(input: {
  scope: string;
  purge?: boolean;
  force?: boolean;
}): Promise<RemoveDataSourceResponse> {
  return req<RemoveDataSourceResponse>('/api/datasource/remove', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
