/**
 * `/open/v1/*` 命名空间与强鉴权单元测试（REQ-20261105-001 / W3 + W4）
 *
 * 覆盖的是「这通道的边界」而不是业务能力：
 *   - Bearer-only：无 token / 非 Bearer / 无效 token 三种 401；**Cookie 不顶用**
 *   - **回环也照拦**：整个服务以 authEnabled=false（本机免登录）启动，`/api/*` 在这个
 *     配置下是免登录的，而 `/open/v1/*` 必须仍然 401 —— 这正是需求里最容易做错的一条
 *   - 只读 token 的写方法拦截（403 READONLY）
 *   - scope 越权 403 且响应脱敏（不回显 scope 名）
 *   - 开关：`uploadApi=false` 时 `/open/v1/import/*` 一律 404（不泄露接口存在性），
 *     而 `/open/v1/ping`、`/healthz` 不受影响
 *   - 405 带 Allow；未知路径 404
 *
 * 运行：npx jiti test/open-api-ping.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import { resetConfigCache } from '../src/lib/config.js';
import type { TokenAuth } from '../src/lib/mcp-token.js';

// ─── 测试用最小 McpServer 工厂（不触碰向量引擎） ───
function buildTestServer(): McpServer {
  const server = new McpServer({ name: 'kisearch', version: '0.0.0-test' });
  server.tool('ping', 'test ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

const TOKENS: Record<string, TokenAuth> = {
  'tok-rw': { id: 'tok-rw', scopes: ['default', 'other'], readOnly: false },
  'tok-ro': { id: 'tok-ro', scopes: ['default'], readOnly: true },
  'tok-scoped': { id: 'tok-scoped', scopes: ['default'], readOnly: false },
};

const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const CONFIG_MAX_FILE_SIZE = 20 * 1024 * 1024;

interface Handle { base: string; close: () => Promise<void> }

let tmpDir: string;
let originalConfigPath: string | undefined;
let openApi: Handle;   // uploadApi = true
let closedApi: Handle; // uploadApi = false

async function start(opts: { uploadApi: boolean }): Promise<Handle> {
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    // ★ 故意用 false：模拟「回环绑定 + 本机免登录」的默认部署，
    //   在这套配置下 /api/* 不需要登录，而 /open/v1/* 必须仍然要 Bearer。
    authEnabled: false,
    resolveClientAddr: () => '127.0.0.1',
    resolveTokenAuth: (t: string) => TOKENS[t],
    uploadApi: opts.uploadApi,
    uploadMaxBytes: UPLOAD_MAX_BYTES,
    buildServer: buildTestServer,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const { port } = httpServer.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function call(
  base: string,
  pathname: string,
  init: { method?: string; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers['Authorization'] = `Bearer ${init.token}`;
  const res = await fetch(`${base}${pathname}`, { method: init.method ?? 'GET', headers });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

before(async () => {
  // 配置隔离：ping 的 limits 来自 ctx.config，绝不能读真实 ~/.ki/config.yaml
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-openapi-'));
  const cfgPath = path.join(tmpDir, 'config.yaml');
  fs.writeFileSync(cfgPath, [
    `dataDir: ${path.join(tmpDir, 'kb')}`,
    `vectorDir: ${path.join(tmpDir, 'vec')}`,
    'scopes:',
    '  default:',
    '    import:',
    `      maxFileSize: ${CONFIG_MAX_FILE_SIZE}`,
    '',
  ].join('\n'), 'utf-8');
  originalConfigPath = process.env.KI_CONFIG_PATH;
  process.env.KI_CONFIG_PATH = cfgPath;
  resetConfigCache();

  openApi = await start({ uploadApi: true });
  closedApi = await start({ uploadApi: false });
});

after(async () => {
  await openApi?.close();
  await closedApi?.close();
  if (originalConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = originalConfigPath;
  resetConfigCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Bearer-only：回环绑定也必须带 token', () => {
  it('无 Authorization → 401 OPEN_API_TOKEN_REQUIRED', async () => {
    const r = await call(openApi.base, '/open/v1/ping');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'OPEN_API_TOKEN_REQUIRED');
  });

  it('只有 Cookie（本机在 /api 下是免登录的）→ 仍 401', async () => {
    const r = await call(openApi.base, '/open/v1/ping', {
      headers: { Cookie: 'ki_web_session=whatever' },
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'OPEN_API_TOKEN_REQUIRED');
  });

  it('非 Bearer 方案（Basic）→ 401 REQUIRED（不猜其它认证方式）', async () => {
    const r = await call(openApi.base, '/open/v1/ping', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'OPEN_API_TOKEN_REQUIRED');
  });

  it('无效 token → 401 OPEN_API_TOKEN_INVALID（不区分不存在/被禁用）', async () => {
    const r = await call(openApi.base, '/open/v1/ping', { token: 'nope' });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'OPEN_API_TOKEN_INVALID');
  });
});

describe('GET /open/v1/ping 正常路径', () => {
  it('回显身份、开关与真实生效上限', async () => {
    const r = await call(openApi.base, '/open/v1/ping', { token: 'tok-rw' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.api, 'open/v1');
    assert.equal(r.body.tokenId, 'tok-rw');
    assert.deepEqual(r.body.scopes, ['default', 'other']);
    assert.equal(r.body.readOnly, false);
    assert.equal(r.body.uploadApi, true);
    assert.equal(r.body.limits.scope, 'default');
    // 请求体上限来自 mcp.http.uploadMaxBytes（注入值），单文件上限来自 scopes.default.import
    assert.equal(r.body.limits.maxRequestBody, UPLOAD_MAX_BYTES);
    assert.equal(r.body.limits.maxFileSize, CONFIG_MAX_FILE_SIZE);
    assert.ok(r.body.limits.maxAssetSize > 0);
  });

  it('?scope= 未授权的 scope → 403 且响应脱敏（不回显 scope 名）', async () => {
    const r = await call(openApi.base, '/open/v1/ping?scope=secret-kb', { token: 'tok-scoped' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'OPEN_API_SCOPE_FORBIDDEN');
    assert.doesNotMatch(JSON.stringify(r.body), /secret-kb/);
  });

  it('只读 token 读 ping 正常（只读只拦写方法）', async () => {
    const r = await call(openApi.base, '/open/v1/ping', { token: 'tok-ro' });
    assert.equal(r.status, 200);
    assert.equal(r.body.readOnly, true);
  });
});

describe('写方法与路由语义', () => {
  it('只读 token 调写接口 → 403 OPEN_API_TOKEN_READONLY', async () => {
    const r = await call(openApi.base, '/open/v1/import/upload', { method: 'POST', token: 'tok-ro' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'OPEN_API_TOKEN_READONLY');
  });

  it('未知子路径 → 404 OPEN_API_NOT_FOUND（鉴权通过才走到这一步）', async () => {
    const r = await call(openApi.base, '/open/v1/pin', { token: 'tok-rw' });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'OPEN_API_NOT_FOUND');
  });

  it('方法不符 → 405 且带 Allow 头', async () => {
    const r = await call(openApi.base, '/open/v1/ping', { method: 'POST', token: 'tok-rw' });
    assert.equal(r.status, 405);
    assert.equal(r.body.code, 'OPEN_API_METHOD_NOT_ALLOWED');
    assert.equal(r.headers.get('allow'), 'GET');
  });

  it('上传路由已注册：缺 Content-Type → 415（列出两种可用形态，不是 500）', async () => {
    const r = await call(openApi.base, '/open/v1/import/upload', { method: 'POST', token: 'tok-rw' });
    assert.equal(r.status, 415);
    assert.equal(r.body.code, 'OPEN_API_UNSUPPORTED_CONTENT_TYPE');
    assert.match(r.body.error, /multipart\/form-data/);
  });
});

describe('上传开关：只拦 /open/v1/import/*，且不泄露存在性', () => {
  it('关闭后：无 token 的写请求也是 404（不是 401/403，连"需要鉴权"都不透露）', async () => {
    const r = await call(closedApi.base, '/open/v1/import/upload', { method: 'POST' });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'OPEN_API_NOT_FOUND');
  });

  it('关闭后：带合法 token 的写请求同样 404', async () => {
    const r = await call(closedApi.base, '/open/v1/import/upload', { method: 'POST', token: 'tok-rw' });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'OPEN_API_NOT_FOUND');
  });

  it('关闭后：/open/v1/ping 仍可用（诊断入口不受开关影响）', async () => {
    const r = await call(closedApi.base, '/open/v1/ping', { token: 'tok-rw' });
    assert.equal(r.status, 200);
    assert.equal(r.body.uploadApi, false);
  });

  it('关闭后：/healthz 免鉴权照常（硬边界：关上传不影响其它入口）', async () => {
    const r = await call(closedApi.base, '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});
