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
function buildTestServer(_authScopes: string[] | null = null): McpServer {
  const server = new McpServer({ name: 'kisearch', version: '0.0.0-test' });
  server.tool('ping', 'test ping', {}, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  // 模拟枚举类无参工具（schema 为 {}），用于验证 HTTP 闸门对白名单工具的豁免
  server.tool('ki_scope_list', 'test scope list', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ scopes: [] }) }],
  }));
  return server;
}

interface TestHandle {
  base: string;
  port: number;
  close: () => Promise<void>;
}

async function startTestServer(
  opts: {
    authEnabled: boolean;
    token?: string;
    maxSessions?: number;
    advertiseAddr?: { host: string; port: number };
    clientAddr?: string;
    resolveTokenScopes?: (token: string) => string[] | undefined;
    buildServer?: (authScopes: string[] | null) => McpServer;
  } = { authEnabled: false },
): Promise<TestHandle> {
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: opts.authEnabled,
    token: opts.token,
    maxSessions: opts.maxSessions,
    advertiseAddr: opts.advertiseAddr,
    // 测试注入客户端地址：缺省为本地回环（127.0.0.1）；传入 clientAddr 模拟远程来源以验证远程鉴权
    resolveClientAddr: () => opts.clientAddr ?? '127.0.0.1',
    resolveTokenScopes: opts.resolveTokenScopes,
    buildServer: opts.buildServer ?? buildTestServer,
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

/** 发一个 tools/call 请求（带 sessionId），返回状态码 */
async function callTool(
  base: string,
  sid: string,
  token: string | undefined,
  scope: string,
): Promise<{ status: number }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-session-id': sid,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ping', arguments: { scope } },
    }),
  });
  try {
    await res.body?.cancel();
  } catch {
    /* 忽略 */
  }
  return { status: res.status };
}

/** 发一个 tools/call 请求并读取响应体文本（用于验证 403 脱敏：响应体不含 scope 名） */
async function callToolReadBody(
  base: string,
  sid: string,
  token: string | undefined,
  scope: string,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-session-id': sid,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ping', arguments: { scope } },
    }),
  });
  const body = await res.text();
  return { status: res.status, body };
}

/** 发一个 JSON-RPC batch 请求（含两个 tools/call），返回状态码（用于验证 batch 越权绕过被拦截） */
async function callToolBatch(
  base: string,
  sid: string,
  token: string | undefined,
  scopes: [string, string],
): Promise<{ status: number }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-session-id': sid,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify([
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'ping', arguments: { scope: scopes[0] } } },
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'ping', arguments: { scope: scopes[1] } } },
    ]),
  });
  try {
    await res.body?.cancel();
  } catch {
    /* 忽略 */
  }
  return { status: res.status };
}

/** 发一个任意 tools/call 请求（自定义工具名与 arguments），返回状态码与响应体 */
async function callToolRaw(
  base: string,
  sid: string,
  token: string | undefined,
  name: string,
  args?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-session-id': sid,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const params: Record<string, unknown> = { name };
  if (args !== undefined) params.arguments = args;
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params,
    }),
  });
  const body = await res.text();
  return { status: res.status, body };
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

  it('即使开启鉴权，/healthz 仍免鉴权返回 kisearch 标识', async () => {
    const res = await fetch(`${srv.base}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; name: string; pid: number };
    assert.equal(body.ok, true);
    assert.equal(body.name, 'kisearch');
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

// ─── D. 非回环绑定：本地来源豁免，远程来源鉴权 ───

describe('非回环绑定 + 本地来源（authEnabled=true, remote=127.0.0.1）', () => {
  let srv: TestHandle;
  before(async () => {
    // 缺省 clientAddr=127.0.0.1：本地回环来源，即使对外绑定也应免鉴权
    srv = await startTestServer({ authEnabled: true, token: 'secret-token' });
  });
  after(async () => {
    await srv.close();
  });

  it('无 Token → 200（本地来源豁免鉴权）', async () => {
    const { status } = await initialize(srv.base);
    assert.equal(status, 200);
  });
});

describe('非回环绑定 + 远程来源（authEnabled=true, remote=192.168.1.10）', () => {
  let srv: TestHandle;
  before(async () => {
    // 注入远程客户端地址：远程来源必须鉴权
    srv = await startTestServer({ authEnabled: true, token: 'secret-token', clientAddr: '192.168.1.10' });
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
    assert.equal(info!.name, 'kisearch');
    assert.equal(info!.host, '0.0.0.0');
    assert.equal(info!.port, 7423);
  });

  it("localhost 归一到 127.0.0.1，探活同一实例（NEG-01）", async () => {
    const info = await fetchHealthz('localhost', srv.port);
    assert.ok(info, "localhost 应归一为 127.0.0.1 并命中同一实例");
    assert.equal(info!.name, 'kisearch');
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

// ─── K. scope 越权校验（RBAC：token → 授权 scope 集合） ───

describe('scope 越权校验（RBAC）', () => {
  let srv: TestHandle;
  before(async () => {
    // 注入 token→scope 查询：'team-a-token' 仅授权 ['team-a']，其余 token 未授权
    srv = await startTestServer({
      authEnabled: true,
      clientAddr: '192.168.1.10', // 远程来源，强制鉴权
      resolveTokenScopes: (t) => (t === 'team-a-token' ? ['team-a'] : undefined),
    });
  });
  after(async () => {
    await srv.close();
  });

  it('授权 scope 的 tools/call → 放行（200）', async () => {
    const { status, sid } = await initialize(srv.base, 'team-a-token');
    assert.equal(status, 200);
    assert.ok(sid);
    const res = await callTool(srv.base, sid!, 'team-a-token', 'team-a');
    assert.equal(res.status, 200);
  });

  it('未授权 scope 的 tools/call → 拒绝（403）', async () => {
    const { sid } = await initialize(srv.base, 'team-a-token');
    assert.ok(sid);
    const res = await callTool(srv.base, sid!, 'team-a-token', 'team-b');
    assert.equal(res.status, 403);
  });

  it('403 响应体脱敏：不泄露具体 scope 名（防枚举探测）', async () => {
    const { sid } = await initialize(srv.base, 'team-a-token');
    assert.ok(sid);
    const res = await callToolReadBody(srv.base, sid!, 'team-a-token', 'team-b');
    assert.equal(res.status, 403);
    assert.ok(!res.body.includes('team-b'), '响应体不应包含被拒的 scope 名');
  });

  it('batch 中任一 tools/call 越权 → 整体拒绝（403，防绕过）', async () => {
    const { sid } = await initialize(srv.base, 'team-a-token');
    assert.ok(sid);
    // 首项合法 team-a，次项越权 team-b：必须整体拒绝，不能只校验首项
    const res = await callToolBatch(srv.base, sid!, 'team-a-token', ['team-a', 'team-b']);
    assert.equal(res.status, 403);
  });

  it('无 scope 参数工具（白名单）无参调用 → 放行（200，输出由工具层按授权过滤）', async () => {
    const { sid } = await initialize(srv.base, 'team-a-token');
    assert.ok(sid);
    const res = await callToolRaw(srv.base, sid!, 'team-a-token', 'ki_scope_list', {});
    assert.equal(res.status, 200);
  });

  it('batch 混合：白名单工具豁免 + 越权 scope 工具仍整体拒绝（豁免不扩大化）', async () => {
    const { sid } = await initialize(srv.base, 'team-a-token');
    assert.ok(sid);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer team-a-token',
      'mcp-session-id': sid!,
    };
    const res = await fetch(`${srv.base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify([
        // 白名单工具：无 scope 参数，HTTP 层不做缺省校验
        { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'ki_scope_list', arguments: {} } },
        // 普通 scope 工具越权：必须整体拦截
        { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'ping', arguments: { scope: 'team-b' } } },
      ]),
    });
    try {
      await res.body?.cancel();
    } catch {
      /* 忽略 */
    }
    assert.equal(res.status, 403);
  });

  it('scope 工具完全省略 arguments 字段 → 视为缺省 default 参与校验（防缺参绕过）', async () => {
    const { sid } = await initialize(srv.base, 'team-a-token');
    assert.ok(sid);
    // 省略 arguments 时工具层 zod 会缺省 scope='default'，而 'default' 不在授权集合内，必须拦截
    const res = await callToolRaw(srv.base, sid!, 'team-a-token', 'ping');
    assert.equal(res.status, 403);
  });

  it("'all' 权限 token 可访问任意 scope", async () => {
    const srv2 = await startTestServer({
      authEnabled: true,
      clientAddr: '192.168.1.10',
      resolveTokenScopes: (t) => (t === 'admin-token' ? ['all'] : undefined),
    });
    try {
      const { sid } = await initialize(srv2.base, 'admin-token');
      assert.ok(sid);
      const res = await callTool(srv2.base, sid!, 'admin-token', 'any-scope');
      assert.equal(res.status, 200);
    } finally {
      await srv2.close();
    }
  });

  it('授权 scope 集合正确传递到 buildServer 工厂（枚举工具过滤依据）', async () => {
    let received: string[] | null = null;
    const srv2 = await startTestServer({
      authEnabled: true,
      clientAddr: '192.168.1.10',
      resolveTokenScopes: (t) => (t === 'team-a-token' ? ['team-a'] : undefined),
      buildServer: (authScopes) => {
        received = authScopes;
        return buildTestServer(authScopes);
      },
    });
    try {
      const { sid } = await initialize(srv2.base, 'team-a-token');
      assert.ok(sid);
      assert.deepEqual(received, ['team-a']);
    } finally {
      await srv2.close();
    }
  });

  it('免鉴权（回环）时 buildServer 收到 null（不过滤）', async () => {
    let received: string[] | null = 'unset' as unknown as string[] | null;
    const srv2 = await startTestServer({
      authEnabled: false,
      buildServer: (authScopes) => {
        received = authScopes;
        return buildTestServer(authScopes);
      },
    });
    try {
      const { sid } = await initialize(srv2.base);
      assert.ok(sid);
      assert.equal(received, null);
    } finally {
      await srv2.close();
    }
  });
});
