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
 *   - 单例：启动先探活 /healthz，已有健康 KiSearch 实例则复用退出；写 lock 文件供排查
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { readKiVersion } from './version-guard.js';

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
  /** 每个 MCP 会话新建一个 McpServer 的工厂 */
  buildServer: () => McpServer;
  /** 进程退出前的额外清理（如停止 version guard） */
  onShutdown?: () => void;
}

/** 判断是否为回环地址（回环 → 免鉴权） */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '[::1]';
}

/** 探活/连接地址归一：0.0.0.0 / :: / localhost 统一到 127.0.0.1，确保同机不同写法命中同一实例（NEG-01） */
function probeHost(host: string): string {
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

/** 探活：命中健康的 KiSearch 实例返回 true（供幂等单例判定） */
export function probeHealthz(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return fetchHealthz(host, port, timeoutMs).then(
    (info) => info?.ok === true && info?.name === 'KiSearch',
  );
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
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
  /** 每个 MCP 会话新建一个 McpServer 的工厂 */
  buildServer: () => McpServer;
  /** 对外暴露的绑定地址（写入 /healthz，便于客户端确认连接目标一致，NEG-01） */
  advertiseAddr?: { host: string; port: number };
  /** 最大并发会话数（缺省 DEFAULT_MAX_SESSIONS） */
  maxSessions?: number;
  /** 会话空闲超时毫秒（缺省 DEFAULT_SESSION_IDLE_MS） */
  sessionIdleMs?: number;
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

  // 每会话一个 transport + 最近活跃时间（用于空闲回收）
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const lastActive = new Map<string, number>();
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
        name: 'KiSearch',
        pid: process.pid,
        version: readKiVersion(),
        ...(advertiseAddr ? { host: advertiseAddr.host, port: advertiseAddr.port } : {}),
      });
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { ok: false, error: 'Not Found' });
      return;
    }

    // 鉴权（仅非回环绑定启用）
    if (authEnabled) {
      const auth = req.headers['authorization'];
      const bearer = typeof auth === 'string' && auth.startsWith('Bearer ')
        ? auth.slice('Bearer '.length).trim()
        : '';
      if (!token || !bearer || !tokenMatches(bearer, token)) {
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
    }

    if (req.method === 'POST') {
      await handleMcpPost(req, res);
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
  ): Promise<void> {
    const body = await readJsonBody(req);
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
      const server = buildServer();
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
        `端口 ${host}:${port} 已被占用，但探活未发现健康的 KiSearch 实例。` +
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

/** 输出 HTTP 单例运行状态（ki mcp --status）：读取 lock + 探活，便于确认是否只有一个持锁进程（NEG-01/02） */
export async function printHttpStatus(host: string, port: number): Promise<void> {
  let lock: unknown = null;
  try {
    lock = JSON.parse(fs.readFileSync(getHttpLockPath(), 'utf-8'));
  } catch {
    /* 无 lock 文件视为未运行 */
  }
  const info = await fetchHealthz(host, port);
  const running = info?.ok === true && info?.name === 'KiSearch';
  console.log(
    JSON.stringify(
      {
        ok: true,
        running,
        target: { host: probeHost(host), port },
        healthz: running ? info : null,
        lock: lock ?? null,
        hint: running
          ? '已有健康的 KiSearch HTTP 实例在运行；请让所有 IDE 使用同一 URL 连接以共享单例，避免锁冲突。'
          : '未探测到运行中的 KiSearch HTTP 实例（可能未启动，或 --host/--port 与实例不一致）。',
      },
      null,
      2,
    ),
  );
}

/**
 * 启动 HTTP 版 ki mcp（幂等单例）。
 * 若目标 host:port 已有健康的 KiSearch 实例，则复用并 process.exit(0)。
 */
export async function startHttpMcpServer(opts: HttpServerOptions): Promise<void> {
  const { host, port, buildServer, allowedHosts, onShutdown } = opts;
  const authEnabled = !isLoopbackHost(host);
  const token = opts.token;

  // ─── 幂等单例：先探活，命中健康实例则复用退出 ───
  if (await probeHealthz(host, port)) {
    process.stderr.write(
      `已有健康的 KiSearch 实例在 ${probeHost(host)}:${port}，复用该实例，本次不再启动。\n`,
    );
    onShutdown?.();
    process.exit(0);
  }

  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled,
    token,
    allowedHosts,
    buildServer,
    advertiseAddr: { host, port },
  });

  // ─── 监听 + 单例 lock 文件 ───
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(describeListenError(err, host, port)));
    });
    httpServer.listen(port, host, () => resolve());
  });

  writeLockFile(host, port);

  process.stderr.write(
    `KiSearch MCP HTTP 服务已启动：http://${host}:${port}/mcp` +
      `（鉴权：${authEnabled ? '开启，需 Bearer Token' : '关闭，回环绑定'}）\n`,
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

function writeLockFile(host: string, port: number): void {
  try {
    const lockPath = getHttpLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify(
        { pid: process.pid, host, port, startedAt: new Date().toISOString() },
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
