/**
 * mcp-http.ts —— ki mcp 的 Streamable HTTP 传输 + 幂等单例守护
 *
 * 背景（多 IDE 锁冲突根治）：
 *   嵌入式向量库同一时刻只能被一个进程持锁打开。多个 IDE 各自用
 *   `command: ki mcp` 拉起独立 stdio 进程时，只有一个能拿到锁，其余降级。
 *   本模块让 ki mcp 以「单进程 HTTP 服务」形态运行，作为向量库唯一持锁者，
 *   所有 IDE（本地/远程）经 URL 共享同一进程 → 从根本上消除锁冲突。
 *
 * 关键设计：
 *   - 传输：@modelcontextprotocol/sdk 的 StreamableHTTPServerTransport（node:http 内建，不引入 express）
 *   - 会话：每个 initialize 建一个 transport + 一个 McpServer（经工厂），共享模块级单例 engine
 *   - 鉴权：按绑定地址条件生效——回环免鉴权，非回环强制 Bearer Token
 *   - 单例：启动先探活 /healthz，已有健康 kisearch 实例则复用退出；写 lock 文件供排查
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { readKiVersion } from './version-guard.js';
import { findTokenScopes, tokenCount, ALL_SCOPES } from './mcp-token.js';
import { listLiveStdioLocks } from './mcp-stdio-lock.js';
import { SERVICE_NAME } from './constants.js';

// 延迟加载的 /api/* 处理器（避免 mcp-http 模块初始化时触发重依赖链）
let apiHandlerPromise: Promise<typeof import('./mcp-http-api.js')> | null = null;
function getApiHandler(): Promise<typeof import('./mcp-http-api.js')> {
  apiHandlerPromise ??= import('./mcp-http-api.js');
  return apiHandlerPromise;
}

/** 默认监听端口 */
export const DEFAULT_MCP_HTTP_PORT = 7423;

/**
 * 默认监听地址：回环地址，secure by default。
 * `ki mcp --http` 开箱即用（免鉴权、零网络暴露），覆盖本机多 IDE 共享；
 * 远程/跨机共享需显式 `--host 0.0.0.0 --token <t>` 主动开启。
 */
export const DEFAULT_MCP_HTTP_HOST = '127.0.0.1';

/** 单进程最大并发会话数（防止会话无界增长耗尽内存） */
export const DEFAULT_MAX_SESSIONS = 256;

/** 会话空闲超时（毫秒）：超过则回收，默认 30 分钟 */
export const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

/** 空闲会话清扫间隔（毫秒） */
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

/** 优雅退出兜底超时（毫秒）：超过则强制 exit，避免残留进程仍持锁 */
const SHUTDOWN_TIMEOUT_MS = 5000;

/** lock 文件路径：~/.ki/mcp-http.lock（持锁者身份可查） */
export function getHttpLockPath(): string {
  return path.join(os.homedir(), '.ki', 'mcp-http.lock');
}

export interface HttpServerOptions {
  host: string;
  port: number;
  /** 非回环绑定时必须提供；回环绑定时忽略 */
  token?: string;
  /** DNS rebinding 保护允许的 Host 头（可选） */
  allowedHosts?: string[];
  /**
   * 每个 MCP 会话新建一个 McpServer 的工厂。
   * 接收该会话的授权 scope 集合（authScopes）：null = 免鉴权（不限）；否则为授权集合（['all'] 或具体列表）。
   * 供枚举类工具（ki_scope_list / ki_manage_index_list）按授权过滤，避免泄露未授权 scope。
   */
  buildServer: (authScopes: string[] | null) => McpServer;
  /** 进程退出前的额外清理（如停止 version guard） */
  onShutdown?: () => void;
  /** --web：同时提供前端静态页面（默认 webDir，浏览器访问 http://<host>:<port>/） */
  web?: boolean;
}

import { isLoopbackAddr, isLoopbackHost } from './net-addr.js';
// re-export isLoopbackHost 保持向后兼容（外部/测试从 mcp-http 引用）
export { isLoopbackHost };

/** 探活/连接地址归一：0.0.0.0 / :: / localhost 统一到 127.0.0.1，确保同机不同写法命中同一实例（NEG-01） */
export function probeHost(host: string): string {
  const h = host.trim().toLowerCase();
  if (h === '0.0.0.0' || h === '::' || h === '' || h === 'localhost') return '127.0.0.1';
  return host;
}

/** 判断请求体是否为 initialize（新会话触发） */
function isInitializeBody(body: unknown): boolean {
  const isInit = (m: unknown): boolean =>
    !!m && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize';
  return Array.isArray(body) ? body.some(isInit) : isInit(body);
}

/**
 * 无 scope 参数的工具白名单（schema 为 `{}`，输出由工具层按 authScopes 过滤）。
 *
 * 这类「枚举/元数据」工具的授权语义是「按 Token 权限集合过滤输出」，而非「校验单点
 * scope」，不适用「缺省 default」的单点越权规则——否则受限 Token（授权不含 default）
 * 按契约无参调用会天然被 403（其安全边界由工具层 authScopes 过滤兜住，不受影响）。
 *
 * ⚠️ 新增 schema 不含 scope 参数的工具时必须同步加入此清单。
 */
const SCOPE_LESS_TOOLS = new Set(['ki_scope_list', 'ki_manage_index_list']);

/**
 * 校验请求体中所有 tools/call 的 scope 是否均在授权集合内。
 * 逐个 tools/call 校验（含 batch 数组），任一越权即拒绝，防止「batch 首项合法、后续越权」绕过。
 * 白名单工具（SCOPE_LESS_TOOLS）跳过此校验，由工具层 authScopes 过滤兜底。
 * @returns 违规的 scope（需拒绝）；null 表示无需拒绝（非 tools/call 或全部 scope 被授权）
 */
function findScopeViolation(body: unknown, scopes: string[]): string | null {
  const items = Array.isArray(body) ? body : [body];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const m = item as {
      method?: unknown;
      params?: { name?: unknown; arguments?: { scope?: unknown } };
    };
    if (m.method !== 'tools/call') continue;
    // 无 scope 参数的枚举工具：放行给工具层按授权集合过滤（见 SCOPE_LESS_TOOLS 注释）
    if (typeof m.params?.name === 'string' && SCOPE_LESS_TOOLS.has(m.params.name)) continue;
    // 缺失/非法 arguments 等价于工具层 zod 缺省 scope='default'，必须参与校验，
    // 否则恶意客户端省略 arguments 即可绕过闸门读未授权的 default scope
    const rawArgs = m.params?.arguments;
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
    const scope = (args as { scope?: unknown }).scope;
    const effective = typeof scope === 'string' && scope.trim() ? scope.trim() : 'default';
    if (scopes.includes(ALL_SCOPES) || scopes.includes(effective)) continue;
    return effective;
  }
  return null;
}

/** 提取 JSON-RPC 请求 id（供错误响应回填，兼容 batch 取首项） */
function extractJsonRpcId(body: unknown): unknown {
  const item = Array.isArray(body) ? body[0] : body;
  if (item && typeof item === 'object') return (item as { id?: unknown }).id ?? null;
  return null;
}

/** 读取并解析 JSON 请求体（POST）；空体返回 undefined */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 16 * 1024 * 1024; // 16MB 上限，防止滥用
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX) {
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

/** 常量时间比较 Bearer Token */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** /healthz 返回体结构 */
export interface HealthzInfo {
  ok: boolean;
  name: string;
  pid: number;
  version?: string;
  host?: string;
  port?: number;
  /** 启动以来的鉴权失败次数（仅非回环鉴权模式下出现） */
  authFailures?: number;
}

/** GET /healthz 并解析返回体；失败返回 null */
export function fetchHealthz(
  host: string,
  port: number,
  timeoutMs = 1500,
): Promise<HealthzInfo | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: probeHost(host), port, path: '/healthz', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as HealthzInfo;
            resolve(res.statusCode === 200 ? body : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** 探活：命中健康的 kisearch 实例返回 true（供幂等单例判定） */
export function probeHealthz(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return fetchHealthz(host, port, timeoutMs).then(
    (info) => info?.ok === true && info?.name === SERVICE_NAME,
  );
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** 静态文件 MIME 映射 */
const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/** 提供 --web 静态页面：GET 请求，支持 SPA fallback（非 /api /mcp 的 404 返回 index.html） */
function serveStatic(res: http.ServerResponse, webDir: string, pathname: string): void {
  try {
    // 防路径穿越：decodeURIComponent 后 normalize，确保解析路径仍在 webDir 内
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendJson(res, 400, { ok: false, error: 'Bad Request: invalid URL encoding' });
      return;
    }
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const resolved = path.normalize(path.join(webDir, relative));
    if (!resolved.startsWith(path.normalize(webDir))) {
      sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return;
    }

    // 读文件；不存在时 SPA fallback（仅对非静态资源扩展名）
    let content: Buffer;
    try {
      content = fs.readFileSync(resolved);
    } catch {
      // SPA fallback：非 /api /mcp 的 GET 404 都回 index.html（前端路由接管）
      const index = path.join(webDir, 'index.html');
      if (fs.existsSync(index)) {
        content = fs.readFileSync(index);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
        return;
      }
      sendJson(res, 404, { ok: false, error: 'Not Found' });
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': STATIC_MIME[ext] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    sendJson(res, 500, { ok: false, error: 'Internal error serving static file' });
  }
}

/**
 * MCP HTTP 服务构建参数（不含生命周期字段）。
 */
export interface HttpAppOptions {
  /** 是否启用 Bearer Token 鉴权（由调用方按绑定地址判定） */
  authEnabled: boolean;
  /** authEnabled 为 true 时用于校验的 Token */
  token?: string;
  /** DNS rebinding 保护允许的 Host 头（可选） */
  allowedHosts?: string[];
  /** 每个 MCP 会话新建一个 McpServer 的工厂（接收该会话的授权 scope 集合，见 HttpServerOptions） */
  buildServer: (authScopes: string[] | null) => McpServer;
  /** 对外暴露的绑定地址（写入 /healthz，便于客户端确认连接目标一致，NEG-01） */
  advertiseAddr?: { host: string; port: number };
  /** 最大并发会话数（缺省 DEFAULT_MAX_SESSIONS） */
  maxSessions?: number;
  /** 会话空闲超时毫秒（缺省 DEFAULT_SESSION_IDLE_MS） */
  sessionIdleMs?: number;
  /** --web：静态文件根目录（缺省不提供静态页面）；为 null/undefined 时禁用 */
  webDir?: string | null;
  /**
   * 解析请求客户端地址（用于鉴权时判定本地回环来源豁免）。
   * 默认 `(req) => req.socket.remoteAddress`；测试可注入返回非本地地址以验证远程来源需鉴权。
   */
  resolveClientAddr?: (req: http.IncomingMessage) => string | undefined;
  /**
   * 按 Token 明文查询授权 scope 集合（RBAC 鉴权）。
   * 默认走多 Token 存储 `findTokenScopes`（读 ~/.ki/mcp-tokens.json）；测试可注入返回固定 scopes，
   * 以验证 scope 越权校验（无需触碰真实 HOME 存储）。
   */
  resolveTokenScopes?: (token: string) => string[] | undefined;
}

export interface McpHttpApp {
  /** 已构建但尚未 listen 的 http 服务（便于测试用临时端口驱动） */
  httpServer: http.Server;
  /** 关闭全部在途会话 transport */
  closeAllSessions: () => Promise<void>;
}

/**
 * 构建 MCP HTTP 服务（仅建 server，不 listen、不注册信号、不 process.exit）。
 * 便于单元测试用临时端口驱动并干净关闭；生产生命周期由 startHttpMcpServer 包装。
 */
export function createMcpHttpServer(opts: HttpAppOptions): McpHttpApp {
  const { authEnabled, token, allowedHosts, buildServer, advertiseAddr } = opts;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const webDir = opts.webDir ?? null;
  // 解析请求客户端地址：默认取 socket.remoteAddress，测试可注入覆盖（验证远程来源需鉴权）
  const resolveClientAddr = opts.resolveClientAddr ?? ((req: http.IncomingMessage) => req.socket.remoteAddress);
  // 按 Token 查授权 scope：默认走多 Token 存储，测试可注入覆盖
  const resolveTokenScopes = opts.resolveTokenScopes ?? ((t: string) => findTokenScopes(t));

  // 每会话一个 transport + 最近活跃时间（用于空闲回收）
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const lastActive = new Map<string, number>();

  // 鉴权失败可观测：客户端（IDE）往往吞掉 401 只显示“工具(0)”，
  // 服务端必须留下痕迹（stderr 日志 + /healthz 计数）才有排查入口。
  let authFailures = 0;
  let lastAuthLogAt = 0;
  const AUTH_LOG_INTERVAL_MS = 5000; // 限流：客户端重试风暴不刷屏
  const logAuthFailure = (req: http.IncomingMessage, reason: string): void => {
    authFailures++;
    const now = Date.now();
    if (now - lastAuthLogAt < AUTH_LOG_INTERVAL_MS) return;
    lastAuthLogAt = now;
    process.stderr.write(
      `[kisearch] 鉴权失败（第 ${authFailures} 次）：来自 ${req.socket.remoteAddress ?? '未知'}，${reason}。` +
        `请核对客户端 Authorization: Bearer 与 ki mcp token list 的输出完全一致（整段复制，勿手抄）。\n`,
    );
  };
  const touch = (id?: string): void => {
    if (id) lastActive.set(id, Date.now());
  };
  const dropSession = (id: string): void => {
    transports.delete(id);
    lastActive.delete(id);
  };

  // 空闲会话定期回收：客户端异常断开（未发 DELETE）残留的会话不会无限堆积。
  // unref 确保该定时器不阻止进程退出。
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, t] of transports) {
      if (now - (lastActive.get(id) ?? now) > sessionIdleMs) {
        void Promise.resolve(t.close()).catch(() => {});
        dropSession(id);
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
          id: null,
        });
      } else {
        try {
          res.end();
        } catch {
          /* 忽略 */
        }
      }
    });
  });

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // /healthz：免鉴权，供单例探活与运维排查
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        name: SERVICE_NAME,
        pid: process.pid,
        version: readKiVersion(),
        ...(advertiseAddr ? { host: advertiseAddr.host, port: advertiseAddr.port } : {}),
        ...(authEnabled ? { authFailures } : {}),
      });
      return;
    }

    // /api/*：方案 A 扩展接口（导入/健康/文档列表），与 MCP 会话隔离
    // 注意：/api/* 未匹配的请求返回 JSON 404（不 fallback 到静态页面，防止前端 JSON.parse 崩溃）
    if (url.pathname.startsWith('/api/')) {
      const api = await getApiHandler();
      await api.handleApiRequest(req, res, url, {
        authEnabled,
        token,
        clientAddr: resolveClientAddr(req),
        resolveTokenScopes,
      });
      return;
    }

    if (url.pathname !== '/mcp') {
      // --web：提供前端静态页面（GET 请求走静态服务，含 SPA fallback）
      if (webDir && req.method === 'GET') {
        serveStatic(res, webDir, url.pathname);
        return;
      }
      sendJson(res, 404, { ok: false, error: 'Not Found' });
      return;
    }

    // 鉴权：对外绑定（authEnabled）时，本地回环来源（127.0.0.1/::1）免鉴权，远程来源需 Bearer Token。
    // 同时解析该 Token 的授权 scope 集合（全权临时 Token → ['all']；否则查多 Token 存储），
    // 供 handleMcpPost 做 tools/call 的 scope 越权校验。authScopes 为 null 表示免鉴权（不限）。
    let authScopes: string[] | null = null;
    if (authEnabled && !isLoopbackAddr(resolveClientAddr(req))) {
      const auth = req.headers['authorization'];
      const bearer = typeof auth === 'string' && auth.startsWith('Bearer ')
        ? auth.slice('Bearer '.length).trim()
        : '';
      let scopes: string[] | undefined;
      if (bearer && token && tokenMatches(bearer, token)) {
        // 全权临时 Token（--token/KI_MCP_TOKEN）：授权全部 scope
        scopes = [ALL_SCOPES];
      } else if (bearer) {
        // 多 Token 存储：按明文查找授权 scope 集合（常量时间比较）
        scopes = resolveTokenScopes(bearer);
      }
      if (!scopes) {
        const reason = !bearer
          ? '请求未携带 Authorization: Bearer 头'
          : 'Token 无效（未在托管 Token 存储中匹配到）';
        logAuthFailure(req, reason);
        res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized: invalid or missing Bearer token' },
            id: null,
          }),
        );
        return;
      }
      authScopes = scopes;
    }

    if (req.method === 'POST') {
      await handleMcpPost(req, res, authScopes);
      return;
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      await handleSessionRequest(req, res);
      return;
    }
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, POST, DELETE' });
    res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
  }

  async function handleMcpPost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    authScopes: string[] | null,
  ): Promise<void> {
    const body = await readJsonBody(req);

    // scope 越权校验：鉴权模式下（authScopes !== null），拦截 tools/call 的 scope 参数。
    // 所有工具 scope 参数统一位于 arguments.scope 顶层（缺省 'default'），
    // 在此统一校验，避免下沉到各工具导致鉴权入口分散（安全关键路径）。
    if (authScopes !== null) {
      const violation = findScopeViolation(body, authScopes);
      if (violation !== null) {
        // 越权日志：服务端留痕（含具体 scope 便于排查），但响应体不下发 scope 名，避免被用于枚举探测
        process.stderr.write(
          `[kisearch] scope 越权拦截：来自 ${req.socket.remoteAddress ?? '未知'}，` +
            `请求 scope "${violation}" 不在该 Token 授权范围内（授权：${authScopes.join(', ')}）。\n`,
        );
        sendJson(res, 403, {
          jsonrpc: '2.0',
          error: { code: -32002, message: 'Forbidden: 无权访问该 scope' },
          id: extractJsonRpcId(body),
        });
        return;
      }
    }

    const sid = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;

    let transport: StreamableHTTPServerTransport | undefined;
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
      touch(sessionId);
    } else if (!sessionId && isInitializeBody(body)) {
      // 新会话：先做会话数上限保护，避免本机进程反复 initialize 致 Map 无界增长
      if (transports.size >= maxSessions) {
        sendJson(res, 503, {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: `Too many active sessions (>= ${maxSessions})；请稍后重试或关闭闲置连接。`,
          },
          id: null,
        });
        return;
      }
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        ...(allowedHosts && allowedHosts.length > 0
          ? { enableDnsRebindingProtection: true, allowedHosts }
          : {}),
        onsessioninitialized: (id: string) => {
          transports.set(id, newTransport);
          touch(id);
        },
        onsessionclosed: (id: string) => {
          dropSession(id);
        },
      });
      newTransport.onclose = () => {
        if (newTransport.sessionId) dropSession(newTransport.sessionId);
      };
      const server = buildServer(authScopes);
      await server.connect(newTransport);
      transport = newTransport;
    } else {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session ID' },
        id: null,
      });
      return;
    }

    await transport!.handleRequest(req, res, body);
  }

  async function handleSessionRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const sid = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    if (!sessionId || !transports.has(sessionId)) {
      sendJson(res, 400, { ok: false, error: 'Invalid or missing session ID' });
      return;
    }
    touch(sessionId);
    await transports.get(sessionId)!.handleRequest(req, res);
  }

  async function closeAllSessions(): Promise<void> {
    clearInterval(sweepTimer);
    for (const t of transports.values()) {
      try {
        await t.close();
      } catch {
        /* 忽略 */
      }
    }
    transports.clear();
    lastActive.clear();
  }

  return { httpServer, closeAllSessions };
}

/** 将 listen 错误翻译为面向用户的可诊断信息（NEG-04） */
export function describeListenError(
  err: NodeJS.ErrnoException,
  host: string,
  port: number,
): string {
  switch (err.code) {
    case 'EADDRINUSE':
      return (
        `端口 ${host}:${port} 已被占用，但探活未发现健康的 kisearch 实例。` +
        `可能是非 ki 进程占用或存在残留实例。请更换端口（--port）或排查该端口的占用进程后重试。`
      );
    case 'EACCES':
      return `无权限绑定 ${host}:${port}：端口 <1024 通常需要提升权限，请改用 1024 以上的高位端口（--port）。`;
    case 'EADDRNOTAVAIL':
      return `无法绑定地址 ${host}：本机不存在该地址。本机访问用 127.0.0.1，对外监听用 0.0.0.0。`;
    case 'ENOTFOUND':
      return `无法解析主机 ${host}：请检查 --host 是否为合法 IP 或可解析的主机名。`;
    default:
      return `启动 HTTP 服务失败（${err.code ?? 'UNKNOWN'}）：${err.message}`;
  }
}

/** 输出 ki mcp 运行状态（ki mcp --status）：读取 HTTP lock + stdio lock + 探活，便于确认实例全貌（NEG-01/02） */
export async function printHttpStatus(host: string, port: number): Promise<void> {
  let lock: unknown = null;
  try {
    lock = JSON.parse(fs.readFileSync(getHttpLockPath(), 'utf-8'));
  } catch {
    /* 无 lock 文件视为未运行 */
  }
  const info = await fetchHealthz(host, port);
  const running = info?.ok === true && info?.name === SERVICE_NAME;
  const tokenTotal = tokenCount();
  // stdio 多实例：遍历 lock 目录，报告所有存活实例（排除当前进程）
  const stdioInstances = listLiveStdioLocks().map((l) => ({ pid: l.pid, startedAt: l.startedAt }));
  console.log(
    JSON.stringify(
      {
        ok: true,
        running,
        target: { host: probeHost(host), port },
        healthz: running ? info : null,
        lock: lock ?? null,
        // stdio 多实例：存活实例列表（HTTP 单例与 stdio 互斥，正常二者不会同时存在）
        stdioInstances,
        // 多 Token 存储：仅报告数量，绝不回显明文
        managedTokens: { count: tokenTotal },
        hint: running
          ? (info?.authFailures ?? 0) > 0
            ? `实例健康，但启动以来已有 ${info!.authFailures} 次鉴权失败：很可能有客户端 Token 配置错误，` +
              `请核对各 IDE 的 Authorization: Bearer 与 ki mcp token list 输出完全一致（服务端 stderr 日志有失败原因）。`
            : '已有健康的 kisearch HTTP 实例在运行；请让所有 IDE 使用同一 URL 连接以共享单例，避免锁冲突。'
          : stdioInstances.length > 0
            ? `未探测到 HTTP 实例，但有 ${stdioInstances.length} 个 stdio 实例在运行（pid ${stdioInstances.map((s) => s.pid).join(', ')}）；用 ki mcp stop 可全部关闭。`
            : '未探测到运行中的 kisearch 实例（可能未启动，或 --host/--port 与实例不一致）。',
      },
      null,
      2,
    ),
  );
}

/**
 * 启动 HTTP 版 ki mcp（幂等单例）。
 * 若目标 host:port 已有健康的 kisearch 实例，则复用并 process.exit(0)。
 */
export async function startHttpMcpServer(opts: HttpServerOptions): Promise<void> {
  const { host, port, buildServer, allowedHosts, onShutdown } = opts;
  const authEnabled = !isLoopbackHost(host);
  const token = opts.token;

  // ─── 幂等单例：先探活，命中健康实例则复用退出 ───
  if (await probeHealthz(host, port)) {
    process.stderr.write(
      `已有健康的 kisearch 实例在 ${probeHost(host)}:${port}，复用该实例，本次不再启动。\n`,
    );
    onShutdown?.();
    process.exit(0);
  }

  // --web：静态目录默认 web/dist（相对于包根目录）；目录不存在时提示但不阻塞 MCP 启动
  let webDir: string | null = null;
  if (opts.web) {
    webDir = path.join(getPackageRoot(), 'web', 'dist');
    if (!fs.existsSync(path.join(webDir, 'index.html'))) {
      process.stderr.write(
        `警告：--web 已指定，但未找到前端构建产物（${path.join(webDir, 'index.html')}）。` +
          `请先在 web/ 目录执行 npm install && npm run build。静态页面将不可访问，MCP 服务正常启动。\n`,
      );
    }
  }

  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled,
    token,
    allowedHosts,
    buildServer,
    advertiseAddr: { host, port },
    webDir,
  });

  // ─── 监听 + 单例 lock 文件 ───
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(describeListenError(err, host, port)));
    });
    httpServer.listen(port, host, () => resolve());
  });

  writeLockFile(host, port, opts.web === true);

  process.stderr.write(
    `kisearch MCP HTTP 服务已启动：http://${host}:${port}/mcp` +
      `（鉴权：${authEnabled ? '开启，需 Bearer Token' : '关闭，回环绑定'}）` +
      (webDir ? `；前端页面：http://${host}:${port}/` : '') +
      '\n',
  );
  if (allowedHosts && allowedHosts.length > 0) {
    process.stderr.write(
      `DNS rebinding 保护已开启，仅允许 Host 头：${allowedHosts.join(', ')}` +
        `（若客户端连接报 403，请核对该白名单）\n`,
    );
  }

  // ─── 优雅退出 ───
  let shuttingDown = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 兜底：即使有清理/连接挂起，也在超时后强制退出，避免残留进程仍持锁
    const forceExit = setTimeout(() => process.exit(code), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    try {
      onShutdown?.();
    } catch {
      /* 忽略 */
    }
    // 关闭所有会话（含空闲清扫定时器）
    await closeAllSessions();
    // 强制断开残留的 keep-alive / SSE 长连接，确保 http server 能及时关闭（Node >= 18.2）
    httpServer.closeAllConnections?.();
    // 释放向量库锁
    try {
      const { closeEngine } = await import('./vector-client.js');
      await closeEngine();
    } catch {
      /* 忽略 */
    }
    // 关闭 http 服务
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    removeLockFile();
    clearTimeout(forceExit);
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
}

function writeLockFile(host: string, port: number, web: boolean): void {
  try {
    const lockPath = getHttpLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify(
        { pid: process.pid, host, port, startedAt: new Date().toISOString(), web },
        null,
        2,
      ),
    );
  } catch {
    /* lock 文件仅供排查，写失败不阻塞启动 */
  }
}

function removeLockFile(): void {
  try {
    fs.rmSync(getHttpLockPath(), { force: true });
  } catch {
    /* 忽略 */
  }
}

/**
 * 包根目录：从 __dirname 向上探测含 web/ 的目录（jiti 运行时 __dirname 指向 src/lib，
 * 编译后指向 dist/lib，探测法兼容两种场景）。支持 KI_WEB_DIR 环境变量显式覆盖。
 */
function getPackageRoot(): string {
  const explicit = process.env.KI_WEB_DIR;
  if (explicit) return path.resolve(explicit);
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'web'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：cwd（通常是项目根，如 jiti src/mcp-server.ts）
  return process.cwd();
}
