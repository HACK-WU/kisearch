/**
 * `GET /open/v1/asset` 契约测试（REQ-20261124-002 · S-02）
 *
 * 钉的是「这条通道的契约」而不是实现细节：
 *   - **字节一致**：200 的 body 必须与库内文件逐字节相同（客户端据此算 sha256）
 *   - **子路径与 `./` 前缀**：`shots/a.png` 与 `./assets/a.svg` 两种 ref 都能取到
 *     （后者验证 `normalizeImageRef` 剥 `./` 后与「双层 assets」目录自洽 —— 推演 P7）
 *   - **越界 403**：group 含 `..`、ref 带 `../`、绝对路径一律拒（双锚点）
 *   - **同语义 404**：不存在 / 后缀不在白名单 / 外链 ref（不暴露目录结构）
 *   - **SVG 必带 CSP sandbox**
 *   - **鉴权**：未授权 scope → 403 且不回显 scope 名
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/open-api-asset.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { resetConfigCache } from '../src/lib/config.js';
import { getAssetsDir } from '../src/lib/scope.js';
import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import type { TokenAuth } from '../src/lib/mcp-token.js';

const scope = `openapi-asset-${Date.now()}`;
const OTHER_SCOPE = `openapi-asset-other-${Date.now()}`;
const group = 'demo/子组';

/** 一张"PNG"：asset 端点不校验魔数（只按后缀白名单），字节任意即可 */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-payload-for-contract-test'),
]);
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';

const TOKENS: Record<string, TokenAuth> = {
  'tok-scope': { id: 'tok-scope', scopes: [scope], readOnly: true },
};

function buildTestServer(): McpServer {
  const server = new McpServer({ name: 'kisearch', version: '0.0.0-test' });
  server.tool('ping', 'test ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

let http: { base: string; close: () => Promise<void> };

before(async () => {
  registerTestScope(scope);
  resetConfigCache();

  // 铺三种形态：普通子目录、双层 assets（文档写 `./assets/x.svg` 的落点）
  const assetsDir = getAssetsDir(scope, group);
  fs.mkdirSync(path.join(assetsDir, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(assetsDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'shots', 'pic.png'), PNG_BYTES);
  fs.writeFileSync(path.join(assetsDir, 'assets', 'legacy.svg'), SVG_TEXT, 'utf-8');

  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: false,
    resolveClientAddr: () => '127.0.0.1',
    resolveTokenAuth: (t: string) => TOKENS[t],
    uploadApi: true,
    downloadApi: true,
    uploadMaxBytes: 8 * 1024 * 1024,
    buildServer: buildTestServer,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const { port } = httpServer.address() as AddressInfo;
  http = {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
});

after(async () => {
  await http?.close();
  cleanupTestConfig();
  resetConfigCache();
});

function assetUrl(params: { scope?: string; group?: string; path?: string }): string {
  const q = new URLSearchParams();
  if (params.scope !== undefined) q.set('scope', params.scope);
  if (params.group !== undefined) q.set('group', params.group);
  if (params.path !== undefined) q.set('path', params.path);
  return `${http.base}/open/v1/asset?${q.toString()}`;
}

const auth = { Authorization: 'Bearer tok-scope' };

describe('① 成功路径：字节一致', () => {
  it('子目录 ref（shots/pic.png）→ 200 + 字节逐字节相同 + 正确 Content-Type', async () => {
    const res = await fetch(assetUrl({ scope, group, path: 'shots/pic.png' }), { headers: auth });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(PNG_BYTES), 'body 必须与库内文件逐字节相同');
    assert.equal(Number(res.headers.get('content-length')), PNG_BYTES.length);
  });

  it('`./assets/x.svg` 形态（双层目录）→ 200 且带 CSP sandbox', async () => {
    const res = await fetch(assetUrl({ scope, group, path: './assets/legacy.svg' }), { headers: auth });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.equal(res.headers.get('content-security-policy'), 'sandbox');
    assert.equal(await res.text(), SVG_TEXT);
  });
});

describe('② 越界一律 403（双锚点）', () => {
  it('group 含 .. → 403 PATH_FORBIDDEN', async () => {
    const res = await fetch(assetUrl({ scope, group: 'demo/../../etc', path: 'passwd' }), { headers: auth });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code?: string }).code, 'OPEN_API_PATH_FORBIDDEN');
  });

  it('ref 带 ../ → 403', async () => {
    const res = await fetch(assetUrl({ scope, group, path: '../../../etc/passwd' }), { headers: auth });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code?: string }).code, 'OPEN_API_PATH_FORBIDDEN');
  });

  it('绝对路径 → 403', async () => {
    const res = await fetch(assetUrl({ scope, group, path: '/etc/passwd' }), { headers: auth });
    assert.equal(res.status, 403);
  });
});

describe('③ 同语义 404（不暴露目录结构）', () => {
  it('文件不存在 → 404 NOT_FOUND', async () => {
    const res = await fetch(assetUrl({ scope, group, path: 'shots/none.png' }), { headers: auth });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, 'OPEN_API_NOT_FOUND');
  });

  it('后缀不在白名单 → 404（与不存在同码，不区分）', async () => {
    const res = await fetch(assetUrl({ scope, group, path: 'shots/pic.exe' }), { headers: auth });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, 'OPEN_API_NOT_FOUND');
  });

  it('外链 ref → 404 + hint 指向 images[].ref', async () => {
    const res = await fetch(assetUrl({ scope, group, path: 'https://example.com/a.png' }), { headers: auth });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { code?: string; hint?: string };
    assert.equal(body.code, 'OPEN_API_NOT_FOUND');
    assert.ok(body.hint?.includes('images[].ref'));
  });
});

describe('④ 参数与鉴权', () => {
  it('缺 path → 400 BAD_REQUEST 且文案点名缺哪个', async () => {
    const res = await fetch(assetUrl({ scope, group }), { headers: auth });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string; error?: string };
    assert.equal(body.code, 'OPEN_API_BAD_REQUEST');
    assert.ok(body.error?.includes('path'));
  });

  it('scope 含路径字符 → 400 BAD_REQUEST（不能冒成 500，也不回显原值）', async () => {
    const res = await fetch(assetUrl({ scope: '../etc', group, path: 'shots/pic.png' }), { headers: auth });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.equal((JSON.parse(text) as { code?: string }).code, 'OPEN_API_BAD_REQUEST');
    assert.ok(!text.includes('../etc'), '不得回显非法 scope 原值');
  });

  it('未授权 scope → 403 SCOPE_FORBIDDEN 且不回显 scope 名', async () => {
    const res = await fetch(assetUrl({ scope: OTHER_SCOPE, group, path: 'shots/pic.png' }), { headers: auth });
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.equal((JSON.parse(text) as { code?: string }).code, 'OPEN_API_SCOPE_FORBIDDEN');
    assert.ok(!text.includes(OTHER_SCOPE), '响应不得回显被请求的 scope 名');
  });
});
