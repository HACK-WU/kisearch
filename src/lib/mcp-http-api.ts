/**
 * mcp-http-api.ts —— 方案 A：扩展 mcp-http 的 /api/* 路由
 *
 * 为可视化前端补齐 MCP 缺失能力（REQ-20260806-003，S-02/S-03）：
 *   GET  /api/health                ki doctor 健康报告（runHealthCheck）
 *   GET  /api/doc/list              Group 路径 + 文档列表（支持 q 文件名模糊搜索）
 *   POST /api/import/upload         上传文件落盘受控目录（~/.ki/import-uploads/<uploadId>/）
 *   POST /api/import/run            触发导入（full/incremental，异步 job）
 *   GET  /api/import/status         轮询导入进度/结果
 *
 * 设计要点：
 *   - 延迟加载（mcp-http.ts 动态 import），避免初始化拉重依赖
 *   - 上传仅接受文件内容，不接受服务器路径（受控目录防路径注入）
 *   - 导入直接调 handleDirectImport/handleIncrementalDirect（纯函数，复用内部锁）
 *   - job 状态内存 Map，服务重启即清空（低频操作可接受）
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveScope } from './config.js';
import { runHealthCheck } from './health-check.js';
import { getRelationsCachePath } from './scope.js';
import { handleDirectImport, type ImportResult } from './import.js';
import {
  handleIncrementalDirect,
  type IncrementalResult,
} from './incremental.js';
import { executeTagList } from '../tag.js';

// ─── 常量 ─────────────────────────────────────────────

/** 上传文件扩展名白名单（对齐 config import.extensions 默认） */
const ALLOWED_EXT = new Set(['.md', '.markdown', '.mdx']);
/** 单文件大小上限（对齐 maxFileSizeBytes 默认 1MB） */
const MAX_FILE_SIZE = 1024 * 1024;
/** 请求体上限（对齐 mcp-http readJsonBody 的 16MB） */
const MAX_BODY = 16 * 1024 * 1024;
/** /api/doc/list 默认分页上限 */
const DOC_LIST_LIMIT = 500;
/** /api/health 超时（runHealthCheck 含 zvec 探活） */
const HEALTH_TIMEOUT_MS = 10_000;

/** 上传根目录：~/.ki/import-uploads/ */
function getUploadsRoot(): string {
  return path.join(os.homedir(), '.ki', 'import-uploads');
}

// ─── job 管理（内存 Map） ─────────────────────────────

interface ImportJob {
  id: string;
  scope: string;
  mode: 'full' | 'incremental';
  state: 'running' | 'done' | 'failed';
  phase?: 'scan' | 'vectorize' | 'persist';
  progress?: { done: number; total: number };
  result?: ImportResult | IncrementalResult;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, ImportJob>();
const MAX_JOBS = 50;
const JOB_TTL_MS = 60 * 60 * 1000; // 1h

function createJob(scope: string, mode: 'full' | 'incremental'): ImportJob {
  // 清理过期 job，防止 Map 无界增长
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.finishedAt && now - j.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
  if (jobs.size >= MAX_JOBS) {
    // 优先淘汰最早完成的
    const oldest = [...jobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!)[0];
    if (oldest) jobs.delete(oldest.id);
  }
  const job: ImportJob = {
    id: crypto.randomUUID(),
    scope,
    mode,
    state: 'running',
    startedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

// ─── 工具 ─────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** 读取 JSON 请求体（复用 mcp-http readJsonBody 逻辑） */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8').trim();
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

/** 常量时间比较 Bearer Token（与 mcp-http 一致） */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sanitizeFileName(name: string): string {
  // 仅允许相对路径文件名（支持子目录），拒绝绝对路径与穿越
  const normalized = path.normalize(name);
  if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new Error(`非法的文件名（拒绝路径穿越）：${name}`);
  }
  return normalized;
}

// ─── /api/doc/list 缓存 ───────────────────────────────

interface DocListCache {
  scope: string;
  docs: { name: string; group: string; path?: string }[];
  mtimeMs: number;
  size: number;
  builtAt: number;
}

const docListCache = new Map<string, DocListCache>();

/** 读取 relations-cache 并聚合文件级文档（Group 路径 + 文档名） */
function buildDocList(scope: string): DocListCache['docs'] {
  const cachePath = getRelationsCachePath(scope);
  if (!fs.existsSync(cachePath)) return [];
  const stat = fs.statSync(cachePath);
  const cached = docListCache.get(scope);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.docs;
  }

  const raw = fs.readFileSync(cachePath, 'utf-8');
  const data = JSON.parse(raw) as {
    groups?: Record<string, { hot_relations?: { text?: string; sourcePath?: string }[] }>;
  };
  const docs: DocListCache['docs'] = [];
  const seen = new Set<string>();
  for (const [group, groupData] of Object.entries(data.groups ?? {})) {
    for (const rel of groupData.hot_relations ?? []) {
      if (!rel.text) continue;
      const key = `${group}\u0000${rel.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push({
        name: rel.text,
        group,
        ...(rel.sourcePath ? { path: rel.sourcePath } : {}),
      });
    }
  }

  docListCache.set(scope, { scope, docs, mtimeMs: stat.mtimeMs, size: stat.size, builtAt: Date.now() });
  return docs;
}

// ─── 路由分发 ─────────────────────────────────────────

export interface ApiRequestCtx {
  authEnabled: boolean;
  token?: string;
}

/**
 * 处理 /api/* 请求（由 mcp-http.ts handleRequest 动态 import 调用）。
 * 注意：调用方已确保 pathname.startsWith('/api/')。
 */
export async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: ApiRequestCtx,
): Promise<void> {
  // 鉴权（与 /mcp 一致，仅非回环绑定启用）
  if (ctx.authEnabled) {
    const auth = req.headers['authorization'];
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length).trim()
      : '';
    if (!ctx.token || !bearer || !tokenMatches(bearer, ctx.token)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized: invalid or missing Bearer token' });
      return;
    }
  }

  const p = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  try {
    if (p === '/health' && req.method === 'GET') return void (await handleHealth(res));
    if (p === '/tags' && req.method === 'GET') return void (await handleTags(res, url));
    if (p === '/doc/list' && req.method === 'GET') return void (await handleDocList(res, url));
    if (p === '/import/upload' && req.method === 'POST') return void (await handleImportUpload(req, res));
    if (p === '/import/run' && req.method === 'POST') return void (await handleImportRun(req, res));
    if (p === '/import/status' && req.method === 'GET') return void (await handleImportStatus(res, url));
    sendJson(res, 404, { ok: false, error: `Not Found: /api${p}` });
  } catch (err) {
    const e = err as Error & { code?: string };
    sendJson(res, 400, { ok: false, error: e.message, code: e.code ?? 'API_ERROR' });
  }
}

// ─── GET /api/health ──────────────────────────────────

async function handleHealth(res: http.ServerResponse): Promise<void> {
  const config = loadConfig();
  const report = await Promise.race([
    runHealthCheck(config),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('health check timeout')),
        HEALTH_TIMEOUT_MS,
      ),
    ),
  ]);
  sendJson(res, 200, { ok: true, report });
}

// ─── GET /api/tags ──────────────────────────────────────

async function handleTags(res: http.ServerResponse, url: URL): Promise<void> {
  const scopeRaw = url.searchParams.get('scope') ?? '';
  const scope = resolveScope(loadConfig(), scopeRaw);
  const result = await executeTagList({ scope });
  if (!result.ok) {
    sendJson(res, 200, { ok: false, error: result.error, tags: [], scope });
    return;
  }
  // 过滤内部保留 tag（ki-search/ki-relation/ki-path）
  const reserved = new Set(['ki-search', 'ki-relation', 'ki-path']);
  const tags = result.tags.filter(t => !reserved.has(t.tag));
  sendJson(res, 200, { ok: true, tags, scope });
}

// ─── GET /api/doc/list ────────────────────────────────

async function handleDocList(res: http.ServerResponse, url: URL): Promise<void> {
  const scopeRaw = url.searchParams.get('scope') ?? '';
  const scope = resolveScope(loadConfig(), scopeRaw);
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const groupRaw = url.searchParams.get('group');
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 0, 1), DOC_LIST_LIMIT) : DOC_LIST_LIMIT;

  const all = buildDocList(scope);
  // Group 树需要完整 group 集合 + 每组文档数量，不受 docs 分页 limit 影响
  // （否则后写入的独立 group 如 tag 若排在前 500 条 docs 之外，前端 Group 树会缺失该节点）
  const groupCounts = new Map<string, number>();
  for (const d of all) {
    groupCounts.set(d.group, (groupCounts.get(d.group) ?? 0) + 1);
  }
  const groups = Array.from(groupCounts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));

  // 指定 group 时返回该 group 全部文档（不受 500 条分页截断影响），确保选中任一节点都能取到完整文档
  if (groupRaw) {
    const groupDocs = all
      .filter((d) => d.group === groupRaw && (!q || d.name.toLowerCase().includes(q)))
      .slice(0, limit);
    sendJson(res, 200, {
      ok: true,
      scope,
      docs: groupDocs,
      total: groupDocs.length,
      truncated: false,
      groups,
    });
    return;
  }

  // 不带 group 参数时 docs 被截断到 500 条无意义（前端 BrowsePage 已改用 useGroupDocs 按组拉取），
  // 仅返回空数组 + 完整 groups 供 Group 树构建；搜索场景请用 q + group 组合。
  const filtered = q ? all.filter((d) => d.name.toLowerCase().includes(q)) : [];
  sendJson(res, 200, {
    ok: true,
    scope,
    docs: filtered.slice(0, limit),
    total: filtered.length,
    truncated: filtered.length > limit,
    groups,
  });
}

// ─── POST /api/import/upload ──────────────────────────

async function handleImportUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as {
    scope?: string;
    files?: { name?: string; content?: string; size?: number }[];
  } | undefined;
  if (!body || !Array.isArray(body.files) || body.files.length === 0) {
    sendJson(res, 400, { ok: false, error: '缺少 files 数组（{ scope, files: [{ name, content }] }）' });
    return;
  }
  const scope = resolveScope(loadConfig(), body.scope);

  const uploadId = crypto.randomUUID();
  const dir = path.join(getUploadsRoot(), uploadId);
  fs.mkdirSync(dir, { recursive: true });

  const saved: { name: string; path: string; size: number }[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const f of body.files) {
    const name = f.name ?? '';
    const content = f.content ?? '';
    try {
      if (!name) throw new Error('缺少文件名');
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        throw new Error(`不支持的扩展名（${ext || '(无)'}），仅允许 .md/.markdown/.mdx`);
      }
      const buf = Buffer.from(content, 'base64');
      if (buf.length > MAX_FILE_SIZE) {
        throw new Error(`文件超过大小上限（${Math.round(MAX_FILE_SIZE / 1024)}KB）`);
      }
      const safeName = sanitizeFileName(name);
      const abs = path.join(dir, safeName);
      if (!abs.startsWith(dir + path.sep)) {
        throw new Error('非法路径');
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      saved.push({ name: safeName, path: abs, size: buf.length });
    } catch (err) {
      errors.push({ name: name || '(未命名)', error: (err as Error).message });
    }
  }

  // 全部失败则清理目录
  if (saved.length === 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    sendJson(res, 400, {
      ok: false,
      error: '所有文件均校验失败',
      errors,
      scope,
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    uploadId,
    scope,
    files: saved,
    total: saved.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

// ─── POST /api/import/run ─────────────────────────────

async function handleImportRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as {
    scope?: string;
    uploadId?: string;
    mode?: string;
    rootName?: string;
    /** 自定义 Group 前缀路径（如 "wiki/我的文档"），覆盖 rootName */
    group?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    vector?: boolean;
  } | undefined;
  if (!body || !body.scope || !body.uploadId) {
    sendJson(res, 400, { ok: false, error: '缺少 scope/uploadId' });
    return;
  }
  const scope = resolveScope(loadConfig(), body.scope);
  const mode = body.mode === 'incremental' ? 'incremental' : 'full';
  const sourceDir = path.join(getUploadsRoot(), body.uploadId);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    sendJson(res, 400, { ok: false, error: `uploadId 不存在（${body.uploadId}）` });
    return;
  }
  // 安全：确认 sourceDir 在受控目录内
  const root = path.normalize(getUploadsRoot());
  if (!path.normalize(sourceDir).startsWith(root + path.sep)) {
    sendJson(res, 400, { ok: false, error: '非法 uploadId' });
    return;
  }

  const job = createJob(scope, mode);
  void runImportJob(job, {
    scope,
    sourceDir,
    mode,
    rootName: (body.group || body.rootName)?.trim() || scope,
    chunkSize: body.chunkSize,
    chunkOverlap: body.chunkOverlap,
    vector: body.vector,
  });

  sendJson(res, 202, { ok: true, jobId: job.id, scope, mode });
}

interface RunImportArgs {
  scope: string;
  sourceDir: string;
  mode: 'full' | 'incremental';
  rootName?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  vector?: boolean;
}

async function runImportJob(job: ImportJob, args: RunImportArgs): Promise<void> {
  try {
    const result =
      args.mode === 'incremental'
        ? await handleIncrementalDirect({
            scope: args.scope,
            sourceDir: args.sourceDir,
            chunkSize: args.chunkSize,
            chunkOverlap: args.chunkOverlap,
            vector: args.vector,
          })
        : await handleDirectImport({
            scope: args.scope,
            sourceDir: args.sourceDir,
            rootName: args.rootName ?? args.scope,
            chunkSize: args.chunkSize,
            chunkOverlap: args.chunkOverlap,
            vector: args.vector,
          });
    job.state = 'done';
    job.result = result;
    job.phase = 'persist';
  } catch (err) {
    job.state = 'failed';
    job.error = (err as Error).message;
  } finally {
    job.finishedAt = Date.now();
  }
}

// ─── GET /api/import/status ───────────────────────────

async function handleImportStatus(res: http.ServerResponse, url: URL): Promise<void> {
  const jobId = url.searchParams.get('jobId') ?? '';
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) {
    sendJson(res, 404, { ok: false, error: 'job not found（服务可能已重启，请重新导入）' });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    job: {
      id: job.id,
      scope: job.scope,
      mode: job.mode,
      state: job.state,
      phase: job.phase,
      progress: job.progress,
      result: job.result,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    },
  });
}
