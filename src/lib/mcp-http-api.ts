/**
 * mcp-http-api.ts —— 方案 A：扩展 mcp-http 的 /api/* 路由
 *
 * 为可视化前端补齐 MCP 缺失能力（REQ-20260806-003，S-02/S-03）：
 *   GET  /api/health                ki doctor 健康报告（runHealthCheck）
 *   GET  /api/doc/list              Group 路径 + 文档列表（支持 q 文件名模糊搜索）
 *   POST /api/import/upload         上传文件落盘受控目录（~/.ki/import-uploads/<uploadId>/）
 *   POST /api/import/run            触发导入（幂等追加，异步 job）
 *   GET  /api/import/status         轮询导入进度/结果
 *
 * 设计要点：
 *   - 延迟加载（mcp-http.ts 动态 import），避免初始化拉重依赖
 *   - 上传仅接受文件内容，不接受服务器路径（受控目录防路径注入）
 *   - 导入直接调 handleDirectImport（纯函数，复用内部锁）
 *   - job 状态内存 Map，服务重启即清空（低频操作可接受）
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveScope } from './config.js';
import { isLoopbackAddr } from './net-addr.js';
import { findTokenScopes, ALL_SCOPES } from './mcp-token.js';
import { runHealthCheck } from './health-check.js';
import { getRelationsCachePath, getAssetsDir, getKbDir } from './scope.js';
import { handleDirectImport, type ImportResult } from './import.js';
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
  state: 'running' | 'done' | 'failed';
  phase?: 'scan' | 'vectorize' | 'persist';
  progress?: { done: number; total: number };
  result?: ImportResult;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, ImportJob>();
const MAX_JOBS = 50;
const JOB_TTL_MS = 60 * 60 * 1000; // 1h

function createJob(scope: string): ImportJob {
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

/** 判断 scope 是否在授权集合内（'all' 通配全部） */
function scopeAllowed(scopes: string[], scope: string): boolean {
  return scopes.includes(ALL_SCOPES) || scopes.includes(scope);
}

/**
 * scope 越权拒绝：服务端记日志（含具体 scope 便于排查），响应体脱敏（不下发 scope 名，防枚举探测）。
 */
function rejectScopeViolation(res: http.ServerResponse, scope: string, via: string): void {
  process.stderr.write(
    `[kisearch] scope 越权拦截（/api${via}）：请求 scope "${scope}" 不在该 Token 授权范围内。\n`,
  );
  sendJson(res, 403, { ok: false, error: 'Forbidden: 无权访问该 scope' });
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
  docs: { name: string; group: string; path?: string; tags?: string[] }[];
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
    groups?: Record<string, { hot_relations?: { text?: string; sourcePath?: string; tags?: string[] }[] }>;
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
        ...(rel.tags && rel.tags.length > 0 ? { tags: rel.tags } : {}),
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
  /** 客户端来源地址（由 mcp-http.ts 按 resolveClientAddr 解析传入；缺省用 req.socket.remoteAddress） */
  clientAddr?: string;
  /** 按 Token 明文查询授权 scope（缺省走多 Token 存储；测试可注入覆盖） */
  resolveTokenScopes?: (token: string) => string[] | undefined;
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
  // 鉴权（与 /mcp 一致）：对外绑定（authEnabled）时，本地回环来源免鉴权，远程来源需 Bearer Token。
  // 同时解析该 Token 的授权 scope 集合（全权临时 Token → ['all']；否则查多 Token 存储），
  // 供后续 handler 做 scope 越权校验。authScopes 为 null 表示免鉴权（不限）。
  // clientAddr 由 mcp-http.ts 的 resolveClientAddr 解析传入（支持测试注入模拟远程来源）
  let authScopes: string[] | null = null;
  if (ctx.authEnabled && !isLoopbackAddr(ctx.clientAddr ?? req.socket.remoteAddress)) {
    const auth = req.headers['authorization'];
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length).trim()
      : '';
    let scopes: string[] | undefined;
    if (bearer && ctx.token && tokenMatches(bearer, ctx.token)) {
      scopes = [ALL_SCOPES];
    } else if (bearer) {
      scopes = ctx.resolveTokenScopes
        ? ctx.resolveTokenScopes(bearer)
        : findTokenScopes(bearer);
    }
    if (!scopes) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized: invalid or missing Bearer token' });
      return;
    }
    authScopes = scopes;
  }

  const p = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';

  // query scope 越权校验：仅对带 scope 的只读接口（tags / doc/list）生效；
  // effective scope = query scope 或 'default'（与工具缺省值一致，防止缺省时绕过授权）
  if (authScopes !== null && (p === '/tags' || p === '/doc/list' || p === '/asset')) {
    const queryScope = url.searchParams.get('scope');
    const effectiveScope = queryScope && queryScope.trim() ? queryScope.trim() : 'default';
    if (!scopeAllowed(authScopes, effectiveScope)) {
      rejectScopeViolation(res, effectiveScope, p);
      return;
    }
  }

  try {
    if (p === '/health' && req.method === 'GET') return void (await handleHealth(res));
    if (p === '/tags' && req.method === 'GET') return void (await handleTags(res, url));
    if (p === '/doc/list' && req.method === 'GET') return void (await handleDocList(res, url));
    if (p === '/asset' && req.method === 'GET') return void (await handleAsset(res, url));
    if (p === '/import/upload' && req.method === 'POST') return void (await handleImportUpload(req, res, authScopes));
    if (p === '/import/run' && req.method === 'POST') return void (await handleImportRun(req, res, authScopes));
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

// ─── GET /api/asset ──────────────────────────────────

/** 附件 MIME 映射（REQ-20260904-001；后缀集合与 import.ts ASSET_EXTENSIONS 对应） */
const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/**
 * GET /api/asset?scope=&group=&path= —— 读取 group 级 assets 目录下的附件（REQ-20260904-001）
 *
 * 纯文件读取（不经过向量引擎），导入后无需重启即可生效（与 /api/doc/list 同模式）。
 * 安全：path 经 decodeURIComponent + normalize 后必须仍落在该 group 的 assets 目录内（防路径穿越）；
 * scope 越权由 handleApiRequest 统一校验（authScopes）。
 * 404 返回 JSON：/api/* 不走 SPA fallback，避免把缺失附件伪装成 200 + index.html（REQ 层 2 缺陷）。
 */
async function handleAsset(res: http.ServerResponse, url: URL): Promise<void> {
  const scopeRaw = url.searchParams.get('scope') ?? '';
  const scope = resolveScope(loadConfig(), scopeRaw);
  const group = (url.searchParams.get('group') ?? '').trim();
  const rawPath = url.searchParams.get('path') ?? '';
  if (!group || !rawPath.trim()) {
    sendJson(res, 400, { ok: false, error: 'Bad Request: group and path are required' });
    return;
  }
  // group 穿越校验：group 原样进 path.join 会搬移下方前缀校验的锚点 → 跨 scope 越权 / KB 外宿主机文件读取。
  // 拒绝绝对路径与含 .. / . / 空段的 group（合法 group 为干净相对路径段序列）。
  if (path.isAbsolute(group) || group.split(/[\\/]/).some((s) => s === '..' || s === '.' || s === '')) {
    sendJson(res, 400, { ok: false, error: 'Bad Request: invalid group' });
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // 与导入侧“解码失败按原样”对称：文件名含裸 % （如 50%.png）时不至永远 404
    decoded = rawPath;
  }
  // 双锚点校验：assetsDir 必须落在该 scope 的 KB 根内（不可搬移），resolved 必须落在 assetsDir 内（防穿越）
  const kbRoot = path.resolve(getKbDir(scope));
  const assetsDir = path.resolve(getAssetsDir(scope, group));
  if (assetsDir !== kbRoot && !assetsDir.startsWith(kbRoot + path.sep)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }
  const resolved = path.normalize(path.join(assetsDir, decoded));
  if (resolved !== assetsDir && !resolved.startsWith(assetsDir + path.sep)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }
  // 后缀白名单（与导入侧 ASSET_EXTENSIONS 对齐）：assets 目录内非图片文件不予服务
  const ext = path.extname(resolved).toLowerCase();
  if (!ASSET_MIME[ext]) {
    sendJson(res, 404, { ok: false, error: `Not Found: 不支持的附件类型 ${ext || '(无后缀)'}` });
    return;
  }
  let content: Buffer;
  try {
    content = fs.readFileSync(resolved);
  } catch (err) {
    // 仅 ENOENT 映射为 404；EISDIR/EACCES/EMFILE 等真实故障向上抛（fail-loud，不伪装成“未导入”）
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    sendJson(res, 404, {
      ok: false,
      error: `Not Found: 附件 ${rawPath} 未随文档导入（导入时未开启附件收集、源文件缺失，或该引用为不支持的形态）`,
    });
    return;
  }
  res.writeHead(200, {
    'Content-Type': ASSET_MIME[ext],
    // 幂等重导会覆盖同名附件 → 不做强缓存，每次向服务器协商
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    // SVG 可内嵌脚本：sandbox 使其成为独立 origin，防外部 wiki 的 SVG 在本应用同源执行
    ...(ext === '.svg' ? { 'Content-Security-Policy': 'sandbox' } : {}),
  });
  res.end(content);
}

// ─── GET /api/doc/list ────────────────────────────────

async function handleDocList(res: http.ServerResponse, url: URL): Promise<void> {
  const scopeRaw = url.searchParams.get('scope') ?? '';
  const scope = resolveScope(loadConfig(), scopeRaw);
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const groupRaw = url.searchParams.get('group');
  // 按自定义 tag 过滤（relation.tags 精确匹配；缺省不过滤）
  const tagRaw = (url.searchParams.get('tag') ?? '').toLowerCase();
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 0, 1), DOC_LIST_LIMIT) : DOC_LIST_LIMIT;

  const all = buildDocList(scope);
  // Group 树需要完整 group 集合 + 每组文档数量，不受 docs 分页 limit 影响
  // （否则后写入的独立 group 如 tag 若排在前 500 条 docs 之外，前端 Group 树会缺失该节点）
  const groupCounts = new Map<string, number>();
  const tagSet = new Set<string>();
  for (const d of all) {
    groupCounts.set(d.group, (groupCounts.get(d.group) ?? 0) + 1);
    for (const t of d.tags ?? []) tagSet.add(t);
  }
  const groups = Array.from(groupCounts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
  // 全部文档的自定义 tag 去重列表（供前端 tag 过滤下拉使用）
  const tags = Array.from(tagSet).sort();

  // tag 过滤辅助：tagRaw 为空则不过滤；否则匹配 relation.tags 中的某个 tag
  const matchTag = (d: { tags?: string[] }): boolean =>
    !tagRaw || (d.tags ?? []).some((t) => t.toLowerCase() === tagRaw);

  // 指定 group 时返回该 group 全部文档（不受 500 条分页截断影响），确保选中任一节点都能取到完整文档
  if (groupRaw) {
    const groupDocs = all
      .filter((d) => d.group === groupRaw && (!q || d.name.toLowerCase().includes(q)) && matchTag(d))
      .slice(0, limit);
    sendJson(res, 200, {
      ok: true,
      scope,
      docs: groupDocs,
      total: groupDocs.length,
      truncated: false,
      groups,
      tags,
    });
    return;
  }

  // 不带 group 参数时：
  //   - 有搜索词(q)：返回跨组模糊匹配的文档（全局搜索场景，limit 放宽到 2000）
  //   - 无搜索词(q)：返回前 limit 条全部 docs（兼容既有 API 契约；BrowsePage 前端已改用 useGroupDocs 按组精确拉取）
  const SEARCH_LIMIT = 2000;
  const filtered = (q ? all.filter((d) => d.name.toLowerCase().includes(q)) : all).filter(matchTag);
  const searchLimit = q ? Math.min(SEARCH_LIMIT, filtered.length) : Math.min(limit, filtered.length);
  sendJson(res, 200, {
    ok: true,
    scope,
    docs: filtered.slice(0, searchLimit),
    total: filtered.length,
    truncated: filtered.length > searchLimit,
    groups,
    tags,
  });
}

// ─── POST /api/import/upload ──────────────────────────

async function handleImportUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    scope?: string;
    files?: { name?: string; content?: string; size?: number }[];
  } | undefined;
  // scope 越权校验：鉴权模式下校验 body.scope（缺省 'default'，与工具缺省值一致）
  if (authScopes !== null) {
    const rawScope = body?.scope;
    const effectiveScope = rawScope && rawScope.trim() ? rawScope.trim() : 'default';
    if (!scopeAllowed(authScopes, effectiveScope)) {
      rejectScopeViolation(res, effectiveScope, '/import/upload');
      return;
    }
  }
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

async function handleImportRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authScopes: string[] | null,
): Promise<void> {
  const body = (await readJsonBody(req)) as {
    scope?: string;
    uploadId?: string;
    /** 目标 Group 落点（如 "wiki/我的文档"）；缺省用 scope */
    group?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    vector?: boolean;
    /** 文档级自定义标签（逗号分隔多个），对本次导入全部文件生效 */
    tags?: string;
  } | undefined;
  if (!body || !body.scope || !body.uploadId) {
    sendJson(res, 400, { ok: false, error: '缺少 scope/uploadId' });
    return;
  }
  // scope 越权校验（body.scope 必填）
  if (authScopes !== null && !scopeAllowed(authScopes, body.scope)) {
    rejectScopeViolation(res, body.scope, '/import/run');
    return;
  }
  const scope = resolveScope(loadConfig(), body.scope);
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

  const job = createJob(scope);
  void runImportJob(job, {
    scope,
    sourceDir,
    // group 缺省 → undefined → handleDirectImport 按推断落点（与 CLI 语义一致，REQ-01）；
    // 不再用 scope 兜底（子目录会落 <scope>/<sub>，与 CLI 缺省落 <sub> 不一致）
    group: body.group?.trim() || undefined,
    chunkSize: body.chunkSize,
    chunkOverlap: body.chunkOverlap,
    vector: body.vector,
    tags: body.tags,
  });

  sendJson(res, 202, { ok: true, jobId: job.id, scope });
}

interface RunImportArgs {
  scope: string;
  sourceDir: string;
  group?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  vector?: boolean;
  tags?: string;
}

async function runImportJob(job: ImportJob, args: RunImportArgs): Promise<void> {
  try {
    const result = await handleDirectImport({
      scope: args.scope,
      sourceDir: args.sourceDir,
      // group 缺省（undefined）→ handleDirectImport 推断落点，与 CLI 缺省语义一致
      group: args.group,
      chunkSize: args.chunkSize,
      chunkOverlap: args.chunkOverlap,
      vector: args.vector,
      tags: args.tags,
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
