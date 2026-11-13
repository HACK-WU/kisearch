/**
 * `POST /open/v1/import/upload` 与 `GET /open/v1/import/status`（design S-02）。
 *
 * 一条纪律贯穿全文件：**导入内核只有一处真相**。
 * 这里只做「参数校验 → 收流落盘 → 创建 job → 交给 runImportJob」，不重写切分/附件/
 * group 推导/批量向量化中的任何一步；job 状态也只用 `getJobById` 读现有 Map
 * （`/api/import/status`、任务台账、`ki log` 必须与第三方看到同一个 job）。
 */

import type http from 'node:http';

import type { KiConfig } from '../../config.js';
import type { WikiImportWritebackResult } from '../../wiki-sync.js';
import { isScopeAuthorized } from '../../mcp-token.js';
import { assertHttpChannelWritable, isScopeReadonlyError } from '../../scope-policy.js';
import { readViews } from '../../scope-view.js';
import { groupDisplayName, isUserAssignableGroup } from '../../import-path.js';
import { DEFAULT_IMPORT_CONFLICT_MODE, type ImportConflictMode } from '../../import-conflict.js';
import { readTaskLog } from '../../task-log.js';
import { getTaskRecord, type TaskRecord } from '../../task-registry.js';
import { createJob, getJobById, runImportJob, type Job } from '../../mcp-http-api.js';
import type { TaskOperator } from '../../task-registry.js';
import { sendJson, sendOpenApiError } from '../respond.js';
import { ArchiveError, cleanupUpload, receiveMultipart, receiveTar, writeSession, type ReceivedUpload } from '../upload-stream.js';
import { MultipartError } from '../multipart.js';
import type { OpenApiPrincipal } from '../auth.js';
import type { OpenApiContext } from '../index.js';

type RouteInput = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  ctx: OpenApiContext;
  principal: OpenApiPrincipal;
};

/** chunk 参数范围：与 `/api/import/run` 的校验同源（切分器 100–4000 / 重叠 0–500） */
const CHUNK_MIN = 100;
const CHUNK_MAX = 4000;
const OVERLAP_MAX = 500;
const CONFLICT_MODES: ImportConflictMode[] = ['incremental', 'overwrite', 'skip', 'suffix'];

export async function handleOpenApiImportUpload(input: RouteInput): Promise<void> {
  const { req, res, url, ctx, principal } = input;
  const q = url.searchParams;
  const scope = (q.get('scope') ?? '').trim() || 'default';

  // ── 1) scope 授权（脱敏：scope 名只进服务端日志）──
  if (!isScopeAuthorized(principal.scopes, scope)) {
    process.stderr.write(`[open-api] 上传越权：token ${principal.tokenId ?? '(临时)'} 请求 scope "${scope}"\n`);
    sendOpenApiError(res, 403, 'OPEN_API_SCOPE_FORBIDDEN', '该 Token 未被授权写入所请求的 scope（用 ki mcp token list 核对授权范围）');
    return;
  }

  // ── 2) 视图名不是可写落点：视图是「检索范围」，写入会落到不存在的目标上 ──
  try {
    const views = readViews(ctx.config);
    if (Object.prototype.hasOwnProperty.call(views, scope)) {
      sendOpenApiError(
        res,
        400,
        'OPEN_API_VIEW_NOT_WRITABLE',
        `"${scope}" 是知识视图（多个库的检索视图），不能作为上传目标；请改为具体的库名`,
      );
      return;
    }
  } catch { /* 视图表损坏不影响上传（与 CLI 侧一致：不阻塞授权） */ }

  // ── 3) 只读 scope：上传阶段就拒，避免收完几 GB 才失败 ──
  try {
    assertHttpChannelWritable(scope, 'import');
  } catch (err) {
    if (isScopeReadonlyError(err)) {
      sendOpenApiError(res, 403, 'OPEN_API_SCOPE_READONLY', `${scope} 是只读库，不能上传；请先取消其只读标记`);
      return;
    }
    throw err;
  }

  // ── 4) 参数校验（一律 fail-loud + 给出路）──
  const group = (q.get('group') ?? '').trim();
  if (group && !isUserAssignableGroup(group)) {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', `非法 group「${group}」：不能是绝对路径、含 .. 或反斜杠，也不能是保留名 "__root__"（要写入根目录请不传 group）`);
    return;
  }
  const chunkSize = parseOptionalInt(q.get('chunkSize'));
  const chunkOverlap = parseOptionalInt(q.get('chunkOverlap'));
  // NaN 必须先拦：`NaN < 100` 为 false，不显式判断会被当成合法值一路传进切分器
  if (Number.isNaN(chunkSize) || Number.isNaN(chunkOverlap)) {
    sendOpenApiError(res, 400, 'OPEN_API_INVALID_CHUNK', 'chunkSize / chunkOverlap 必须是整数');
    return;
  }
  if (chunkSize !== undefined && (chunkSize < CHUNK_MIN || chunkSize > CHUNK_MAX)) {
    sendOpenApiError(res, 400, 'OPEN_API_INVALID_CHUNK', `chunkSize 必须在 ${CHUNK_MIN}–${CHUNK_MAX} 之间（实际 ${chunkSize}）`);
    return;
  }
  if (chunkOverlap !== undefined && (chunkOverlap < 0 || chunkOverlap > OVERLAP_MAX)) {
    sendOpenApiError(res, 400, 'OPEN_API_INVALID_CHUNK', `chunkOverlap 必须在 0–${OVERLAP_MAX} 之间（实际 ${chunkOverlap}）`);
    return;
  }
  if (chunkSize !== undefined && chunkOverlap !== undefined && chunkOverlap >= chunkSize) {
    sendOpenApiError(res, 400, 'OPEN_API_INVALID_CHUNK', `chunkOverlap（${chunkOverlap}）必须小于 chunkSize（${chunkSize}）`);
    return;
  }
  const conflictRaw = (q.get('conflictMode') ?? '').trim();
  if (conflictRaw && !CONFLICT_MODES.includes(conflictRaw as ImportConflictMode)) {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', `conflictMode 只能是 ${CONFLICT_MODES.join(' / ')}（实际「${conflictRaw}」）`);
    return;
  }
  const conflictMode = (conflictRaw || DEFAULT_IMPORT_CONFLICT_MODE) as ImportConflictMode;
  const vectorRaw = (q.get('vector') ?? '').trim();
  if (vectorRaw && vectorRaw !== '0' && vectorRaw !== '1') {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', `vector 只能是 1（默认，写入向量）或 0（等价 --no-vector，只做全文索引）`);
    return;
  }
  const vector = vectorRaw === '0' ? false : true;
  const tags = (q.get('tags') ?? '').trim() || undefined;
  const conflictSuffix = (q.get('conflictSuffix') ?? '').trim() || undefined;

  // ── 5) 按 Content-Type 分流收流 ──
  const contentType = String(req.headers['content-type'] ?? '');
  const receiveOpts = { config: ctx.config, scope, uploadMaxBytes: ctx.uploadMaxBytes };
  let received: ReceivedUpload;
  try {
    if (/^multipart\/form-data/i.test(contentType)) {
      const boundary = multipartBoundary(contentType);
      if (!boundary) {
        sendOpenApiError(res, 400, 'OPEN_API_BAD_MULTIPART', 'multipart 请求缺少 boundary（请用 curl -F，不要手拼请求体）');
        return;
      }
      received = await receiveMultipart(req, boundary, receiveOpts);
    } else if (/^(application\/(x-)?(gzip|tar)|application\/octet-stream)$/i.test(contentType) || q.get('archive') === 'tar.gz') {
      received = await receiveTar(req, receiveOpts);
    } else {
      sendOpenApiError(
        res,
        415,
        'OPEN_API_UNSUPPORTED_CONTENT_TYPE',
        '不支持的 Content-Type。两种可用形态：multipart/form-data（curl -F "files=@a.md"）或 application/gzip（tar czf - -C ./docs . | curl --data-binary @-）',
      );
      return;
    }
  } catch (err) {
    respondReceiveError(res, err);
    return;
  }

  // ── 6) 一个合法文件都没有 → 不创建半成品任务 ──
  if (received.saved === 0) {
    cleanupUpload(received.dir);
    sendOpenApiError(res, 400, 'OPEN_API_NO_VALID_FILE', '没有可导入的文件（全部被跳过），请检查 skippedSample 里的原因', {
      files: { saved: 0, skipped: received.skipped, skippedSample: received.skippedSample },
      totalBytes: received.totalBytes,
    });
    return;
  }

  // ── 7) 一步式：建 job → 落会话（含 jobId）→ 异步导入 ──
  const operator: TaskOperator = {
    type: 'token',
    label: principal.tokenId ? `Token ${principal.tokenId}` : 'Token 临时',
    ...(principal.tokenId ? { tokenId: principal.tokenId } : {}),
  };
  // 建 job 与写会话**必须作为一个整体成功**：会话里缺 jobId 时，24h 惰性清理会把
  // 已是导入源的 content/ 移走删除。因此这里任一失败都要回收目录并明确报错，
  // 不能带着「可能被清理」的状态继续启动导入。
  let job: Job | undefined;
  try {
    // 来源标 open-api：任务列表显示「open api upload」，来源列显示「OpenAPI」
    job = createJob(scope, 'import', ctx.config, { operator, source: 'open-api' });
    writeSession(received.dir, scope, 'importing', job.id);
  } catch (err) {
    // job 已登记但会话目录写不进去：把它标成失败，否则它会以 'running' 永远挂在
    // 任务列表里（`/api/tasks` 与 status 都能看到），看起来像卡住。
    if (job) {
      job.state = 'failed';
      job.error = '暂存目录不可写，导入未启动';
      job.finishedAt = Date.now();
    }
    cleanupUpload(received.dir);
    process.stderr.write(`[open-api] 创建导入任务失败（已清理暂存目录）：${(err as Error).message}\n`);
    sendOpenApiError(res, 503, 'OPEN_API_STORAGE_FAILED', '创建导入任务失败（任务记录或暂存目录不可写），请稍后重试');
    return;
  }

  void runImportJob(
    job,
    {
      scope,
      sourceDir: received.contentDir,
      ...(group ? { group } : {}),
      ...(tags ? { tags } : {}),
      ...(chunkSize !== undefined ? { chunkSize } : {}),
      ...(chunkOverlap !== undefined ? { chunkOverlap } : {}),
      ...(conflictSuffix ? { conflictSuffix } : {}),
      vector,
      conflictMode,
      // 上传即回写：scope 配了 wikiSync.sourceDir 时，本次导入完成的文档会同步成
      // wiki 文件（已存在文件跳过）。未配置就是零副作用。
      wikiWriteback: true,
    },
    ctx.config,
  ).then(() => {
    // kernel 的会话收尾是按 sourceDir 找 `.upload-session.json`，而本通道 sourceDir 是
    // content/ 子目录（元数据在上层）——所以终态由这里补写，保持与 /api 一致的可查性。
    writeSession(received.dir, scope, job.state === 'done' ? 'done' : 'failed', job.id);
  }).catch((err: unknown) => {
    process.stderr.write(`[open-api] 导入任务 ${job.id} 收尾失败：${(err as Error).message}\n`);
    writeSession(received.dir, scope, 'failed', job.id);
  });

  sendJson(res, 200, {
    ok: true,
    uploadId: received.uploadId,
    taskId: job.id,
    scope,
    ...(group ? { group } : {}),
    files: {
      saved: received.saved,
      skipped: received.skipped,
      skippedSample: received.skippedSample,
    },
    totalBytes: received.totalBytes,
    statusUrl: `/open/v1/import/status?taskId=${job.id}`,
  });
}

export async function handleOpenApiImportStatus(input: RouteInput): Promise<void> {
  const { res, url, ctx, principal } = input;
  const taskId = (url.searchParams.get('taskId') ?? '').trim();
  if (!taskId) {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', '缺少 taskId（上传响应的 taskId 字段即为它）');
    return;
  }

  // ① 进程内 job（最可信）
  const job = getJobById(taskId);
  if (job) {
    if (!isScopeAuthorized(principal.scopes, job.scope)) {
      rejectForeignTask(res, principal, job.scope, taskId);
      return;
    }
    sendJson(res, 200, memoryStatus(job));
    return;
  }

  // ② 任务台账（daemon 重启后，保留期内仍可查）
  const record = safeTaskRecord(ctx.config, taskId);
  if (record) {
    if (!isScopeAuthorized(principal.scopes, record.scope)) {
      rejectForeignTask(res, principal, record.scope, taskId);
      return;
    }
    sendJson(res, 200, ledgerStatus(record));
    return;
  }

  // ③ 任务日志（台账过期但日志还在）：只回「曾经开始过」，不猜终态
  const log = safeTaskLog(ctx.config, taskId);
  if (log?.head) {
    if (!isScopeAuthorized(principal.scopes, log.head.scope)) {
      rejectForeignTask(res, principal, log.head.scope, taskId);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      taskId,
      state: 'unknown',
      phase: null,
      progress: 0,
      waitingForScopeLock: false,
      cancelRequested: false,
      source: 'log',
      result: null,
      hint: `该任务已不在内存与台账中（daemon 重启 + 台账过期），可执行 ki log ${taskId} 查看运行日志`,
    });
    return;
  }

  sendOpenApiError(
    res,
    404,
    'OPEN_API_TASK_NOT_FOUND',
    '任务不存在（taskId 拼错，或已超过保留期）。注意：服务重启后内存态任务改由台账/日志兜底，仍查不到才说明从未开始',
  );
}

/** 内存态 job → 对外形状（`queued` 与 `running` 必须可区分，见 design S-02 §3.8） */
function memoryStatus(job: Job): Record<string, unknown> {
  const waiting = job.waitingForScopeLock === true;
  const done = job.progress?.total ? job.progress.done / job.progress.total : 0;
  return {
    ok: true,
    taskId: job.id,
    scope: job.scope,
    state: waiting ? 'queued' : job.state,
    phase: waiting ? 'waiting' : job.phase ?? null,
    progress: Math.round(Math.min(1, Math.max(0, done)) * 1000) / 1000,
    waitingForScopeLock: waiting,
    cancelRequested: job.cancelRequested,
    source: 'memory',
    result: job.state === 'done' ? summarizeImportResult(job.result) : null,
    ...(job.error ? { error: job.error } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
  };
}

/** 台账记录 → 对外形状（`stale: true` 明确告知「这不是实时进度」） */
function ledgerStatus(record: TaskRecord): Record<string, unknown> {
  const done = record.progress?.total ? record.progress.done / record.progress.total : 0;
  return {
    ok: true,
    taskId: record.id,
    scope: record.scope,
    state: mapLedgerState(record.state),
    phase: record.phase ?? null,
    progress: Math.round(Math.min(1, Math.max(0, done)) * 1000) / 1000,
    waitingForScopeLock: record.state === 'queued',
    cancelRequested: false,
    source: 'ledger',
    stale: true,
    result: record.result ? summarizeSnapshotResult(record.result) : null,
    ...(record.error ? { error: record.error } : {}),
  };
}

function mapLedgerState(state: TaskRecord['state']): string {
  switch (state) {
    case 'succeeded':
    case 'partial':
      return 'done';
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/**
 * 只回传对 agent 有用的摘要（前 20 条 group + 总数），避免大目录把响应撑到几百 KB
 * （design S-02 Q-03）。字段不齐时给 0/null，不做无根据的推断。
 */
function summarizeImportResult(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    stats?: { total?: number; vectorized?: number; skipped?: number; errors?: number; vector?: boolean };
    groups?: string[];
    wikiWriteback?: WikiWritebackLike;
  };
  const groups = Array.isArray(r.groups) ? r.groups : [];
  return {
    total: r.stats?.total ?? 0,
    vectorized: r.stats?.vectorized ?? 0,
    skipped: r.stats?.skipped ?? 0,
    errors: r.stats?.errors ?? 0,
    // `__root__` 是存储层保留键，项目约定任何面向人的出口都映射成「根」
    // （`import-path.ts::groupDisplayName`）——这里也不破例，否则调用方会把它当真实目录名。
    groups: groups.slice(0, 20).map(groupDisplayName),
    groupsTotal: groups.length,
    ...(r.stats?.vector === undefined ? {} : { vectorStored: r.stats.vector }),
    ...(r.wikiWriteback ? { wikiWriteback: summarizeWikiWriteback(r.wikiWriteback) } : {}),
  };
}

/**
 * 导入内核的 wiki 写回结果。
 *
 * 直接复用 `wiki-sync.ts` 的类型而不是本地重声明：字段改名时 TypeScript 会报错，
 * 本地重声明则会静默变成 undefined（对外只会看到 `0/0/0`，看着像"一篇都没写"）。
 */
type WikiWritebackLike = Pick<WikiImportWritebackResult, 'written' | 'skipped' | 'failed' | 'failedCount'>;

/**
 * wiki 写回 → 对外摘要。
 *
 * 只给计数，不给 `targetDir`（服务端绝对路径）与失败 `reason`（文件系统错误串，
 * 可能带内部路径）——调用方据此能判断「到底写没写、被跳过了多少」，定位细节看服务端日志。
 */
function summarizeWikiWriteback(wiki: WikiWritebackLike): Record<string, number> {
  return {
    written: typeof wiki.written === 'number' ? wiki.written : 0,
    skipped: typeof wiki.skipped === 'number' ? wiki.skipped : 0,
    failed: typeof wiki.failedCount === 'number'
      ? wiki.failedCount
      : (Array.isArray(wiki.failed) ? wiki.failed.length : 0),
  };
}

/**
 * 台账摘要（`TaskResultSnapshot`）→ 与内存态同一组字段。
 *
 * 两种结构不同：内存里是完整的 `ImportResult`（`stats.total` 等），台账里是裁剪过的
 * 快照（`files.scanned/completed/incomplete` 且**没有** `total`）。照抄内存那套映射的
 * 后果是重启后所有任务都报 `total: 0` —— 数字看着像真的，实际是没映射上。
 */
function summarizeSnapshotResult(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    files?: { scanned?: number; completed?: number; incomplete?: number; skipped?: number };
    vectorized?: number;
    groups?: string[];
  };
  const files = r.files ?? {};
  const completed = files.completed ?? 0;
  const incomplete = files.incomplete ?? 0;
  const groups = Array.isArray(r.groups) ? r.groups : [];
  return {
    total: files.scanned ?? completed + incomplete,
    vectorized: r.vectorized ?? 0,
    skipped: files.skipped ?? 0,
    errors: incomplete,
    groups: groups.slice(0, 20).map(groupDisplayName),
    groupsTotal: groups.length,
  };
}

function rejectForeignTask(
  res: http.ServerResponse,
  principal: OpenApiPrincipal,
  scope: string,
  taskId: string,
): void {
  // 403 而不是 404：任务确实存在，只是无权查看。404 会让「枚举他人 taskId」看起来像拼错。
  process.stderr.write(`[open-api] status 越权：token ${principal.tokenId ?? '(临时)'} 请求 ${taskId}（scope "${scope}"）\n`);
  sendOpenApiError(res, 403, 'OPEN_API_SCOPE_FORBIDDEN', '该任务属于你未被授权的 scope，无法查看');
}

function safeTaskRecord(config: KiConfig, taskId: string): TaskRecord | null {
  try { return getTaskRecord(config, taskId); } catch { return null; }
}

function safeTaskLog(config: KiConfig, taskId: string): ReturnType<typeof readTaskLog> {
  try { return readTaskLog(config, taskId, 1); } catch { return null; }
}

/** 收流阶段的异常 → HTTP 语义（每类都带「怎么改」，不只说失败） */
function respondReceiveError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof MultipartError) {
    const status = err.code === 'OPEN_API_PAYLOAD_TOO_LARGE' ? 413 : 400;
    sendOpenApiError(res, status, err.code, err.message, err.detail);
    return;
  }
  if (err instanceof ArchiveError) {
    sendOpenApiError(res, 400, err.code, err.message, err.detail);
    return;
  }
  // 客户端中途断开：连接已经没了，写响应无意义，只留服务端痕迹
  const e = err as Error & { code?: string };
  if (e?.code === 'ECONNRESET' || e?.name === 'AbortError' || /aborted/i.test(e?.message ?? '')) {
    process.stderr.write('[open-api] 上传被客户端中断，已清理暂存目录\n');
    return;
  }
  process.stderr.write(`[open-api] 接收上传失败：${e?.message ?? String(err)}\n`);
  sendOpenApiError(res, 500, 'OPEN_API_STORAGE_FAILED', '接收上传时发生服务端错误（磁盘或权限），请查看服务端日志');
}

/** 从 Content-Type 里取 multipart boundary（支持带引号形式） */
function multipartBoundary(contentType: string): string | undefined {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = (m?.[1] ?? m?.[2] ?? '').trim();
  return value || undefined;
}

function parseOptionalInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  // 不做 Math.trunc：`chunkSize=100.9` 悄悄变成 100 会让调用方以为参数被接受，
  // 实际切分口径与他填的不同。非整数一律按非法参数报错。
  return Number.isInteger(n) ? n : Number.NaN;
}
