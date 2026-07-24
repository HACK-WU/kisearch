/**
 * mcp-http 单元测试 —— HTTP 共享单例模式
 *
 * 覆盖：
 *   - isLoopbackHost 判定（回环免鉴权的依据）
 *   - /healthz 免鉴权探活（单例复用的基础）
 *   - 回环绑定（authEnabled=false）：无 Token 也能 initialize
 *   - 非回环绑定（authEnabled=true）：无/错 Token → 401，正确 Token → 200 + sessionId
 *   - 会话隔离：两次 initialize 得到不同 sessionId，共享同一进程
 *   - probeHealthz：实例在线返回 true，端口关闭返回 false（幂等单例判定）
 *
 * 运行：npx jiti test/mcp-http.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  createMcpHttpServer,
  isLoopbackHost,
  probeHealthz,
  fetchHealthz,
  describeListenError,
  DEFAULT_MCP_HTTP_PORT,
} from '../src/lib/mcp-http.js';

// ─── 测试用最小 McpServer 工厂（不触碰向量引擎） ───
function buildTestServer(): McpServer {
  const server = new McpServer({ name: 'KiSearch', version: '0.0.0-test' });
  server.tool('ping', 'test ping', {}, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return server;
}

interface TestHandle {
  base: string;
  port: number;
  close: () => Promise<void>;
}

async function startTestServer(
  opts: { authEnabled: boolean; token?: string; maxSessions?: number; advertiseAddr?: { host: string; port: number } } = { authEnabled: false },
): Promise<TestHandle> {
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: opts.authEnabled,
    token: opts.token,
    maxSessions: opts.maxSessions,
    advertiseAddr: opts.advertiseAddr,
    buildServer: buildTestServer,
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', () => resolve()),
  );
  const addr = httpServer.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    base,
    port: addr.port,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** 发一个 initialize 请求，返回状态码与 mcp-session-id（不解析 SSE 正文） */
async function initialize(
  base: string,
  token?: string,
): Promise<{ status: number; sid: string | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }),
  });
  const sid = res.headers.get('mcp-session-id');
  try {
    await res.body?.cancel();
  } catch {
    /* 忽略 */
  }
  return { status: res.status, sid };
}

// ─── A. isLoopbackHost ───

describe('isLoopbackHost', () => {
  it('回环地址判定为 true', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('LOCALHOST'), true);
  });
  it('非回环地址判定为 false', () => {
    assert.equal(isLoopbackHost('0.0.0.0'), false);
    assert.equal(isLoopbackHost('192.168.1.10'), false);
    assert.equal(isLoopbackHost('::'), false);
  });
});

describe('默认端口常量', () => {
  it('DEFAULT_MCP_HTTP_PORT 为 7423', () => {
    assert.equal(DEFAULT_MCP_HTTP_PORT, 7423);
  });
});

// ─── B. /healthz 免鉴权 ───

describe('/healthz 探活', () => {
  let srv: TestHandle;
  before(async () => {
    srv = await startTestServer({ authEnabled: true, token: 'secret' });
  });
  after(async () => {
    await srv.close();
  });

  it('即使开启鉴权，/healthz 仍免鉴权返回 KiSearch 标识', async () => {
    const res = await fetch(`${srv.base}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; name: string; pid: number };
    assert.equal(body.ok, true);
    assert.equal(body.name, 'KiSearch');
    assert.equal(typeof body.pid, 'number');
  });
});

// ─── C. 回环绑定：免鉴权 ───

describe('回环绑定（authEnabled=false）', () => {
  let srv: TestHandle;
  before(async () => {
    srv = await startTestServer({ authEnabled: false });
  });
  after(async () => {
    await srv.close();
  });

  it('未设 Token 也能直接 initialize', async () => {
    const { status, sid } = await initialize(srv.base);
    assert.equal(status, 200);
    assert.ok(sid && sid.length > 0, '应返回 mcp-session-id');
  });
});

// ─── D. 非回环绑定：条件鉴权 ───

describe('非回环绑定（authEnabled=true）', () => {
  let srv: TestHandle;
  before(async () => {
    srv = await startTestServer({ authEnabled: true, token: 'secret-token' });
  });
  after(async () => {
    await srv.close();
  });

  it('无 Token → 401', async () => {
    const { status } = await initialize(srv.base);
    assert.equal(status, 401);
  });

  it('错误 Token → 401', async () => {
    const { status } = await initialize(srv.base, 'wrong-token');
    assert.equal(status, 401);
  });

  it('正确 Token → 200 且返回 sessionId', async () => {
    const { status, sid } = await initialize(srv.base, 'secret-token');
    assert.equal(status, 200);
    assert.ok(sid && sid.length > 0);
  });
});

// ─── E. 会话隔离 ───

describe('会话隔离', () => {
  let srv: TestHandle;
  before(async () => {
    srv = await startTestServer({ authEnabled: false });
  });
  after(async () => {
    await srv.close();
  });

  it('两次 initialize 得到不同 sessionId（共享同一进程）', async () => {
    const a = await initialize(srv.base);
    const b = await initialize(srv.base);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.ok(a.sid && b.sid);
    assert.notEqual(a.sid, b.sid);
  });
});

// ─── G. 会话数上限保护 ───

describe('会话数上限保护', () => {
  let srv: TestHandle;
  before(async () => {
    srv = await startTestServer({ authEnabled: false, maxSessions: 1 });
  });
  after(async () => {
    await srv.close();
  });

  it('超过 maxSessions 后新的 initialize 返回 503', async () => {
    const a = await initialize(srv.base);
    assert.equal(a.status, 200, '首个会话应成功');
    const b = await initialize(srv.base);
    assert.equal(b.status, 503, '超上限的新会话应被拒绝');
  });
});

// ─── H. probeHealthz（幂等单例判定） ───

describe('probeHealthz', () => {
  it('实例在线返回 true，关闭后返回 false', async () => {
    const srv = await startTestServer({ authEnabled: false });
    const up = await probeHealthz('127.0.0.1', srv.port);
    assert.equal(up, true, '在线实例应探活命中');
    await srv.close();
    const down = await probeHealthz('127.0.0.1', srv.port, 800);
    assert.equal(down, false, '端口关闭后应探活失败');
  });
});

// ─── I. fetchHealthz 与 advertiseAddr / localhost 归一（NEG-01） ───

describe('fetchHealthz + advertiseAddr', () => {
  let srv: TestHandle;
  before(async () => {
    srv = await startTestServer({
      authEnabled: false,
      advertiseAddr: { host: '0.0.0.0', port: 7423 },
    });
  });
  after(async () => {
    await srv.close();
  });

  it('/healthz 回体携带 advertiseAddr 的 host/port', async () => {
    const info = await fetchHealthz('127.0.0.1', srv.port);
    assert.ok(info, '应返回 healthz 信息');
    assert.equal(info!.name, 'KiSearch');
    assert.equal(info!.host, '0.0.0.0');
    assert.equal(info!.port, 7423);
  });

  it("localhost 归一到 127.0.0.1，探活同一实例（NEG-01）", async () => {
    const info = await fetchHealthz('localhost', srv.port);
    assert.ok(info, "localhost 应归一为 127.0.0.1 并命中同一实例");
    assert.equal(info!.name, 'KiSearch');
  });
});

// ─── J. describeListenError 分类（NEG-04） ───

describe('describeListenError', () => {
  const mk = (code: string): NodeJS.ErrnoException => {
    const e = new Error(code) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  };
  it('EADDRINUSE 提示端口占用与换端口', () => {
    const msg = describeListenError(mk('EADDRINUSE'), '0.0.0.0', 7423);
    assert.match(msg, /已被占用/);
    assert.match(msg, /--port/);
  });
  it('EACCES 提示提权/高位端口', () => {
    const msg = describeListenError(mk('EACCES'), '0.0.0.0', 80);
    assert.match(msg, /权限|高位端口/);
  });
  it('EADDRNOTAVAIL 提示地址不存在', () => {
    const msg = describeListenError(mk('EADDRNOTAVAIL'), '10.1.2.3', 7423);
    assert.match(msg, /本机不存在该地址|无法绑定/);
  });
  it('未知错误回退到通用文案且包含 code', () => {
    const msg = describeListenError(mk('EPERM'), '0.0.0.0', 7423);
    assert.match(msg, /EPERM/);
  });
});
