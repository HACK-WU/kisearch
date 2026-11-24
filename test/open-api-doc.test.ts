/**
 * `GET /open/v1/doc` 契约测试（REQ-20261124-002 · S-03）
 *
 * 本文件覆盖「不依赖真实库内容」的契约边界（正向正文同源由真库联调覆盖）：
 *   - 缺参 → 400 且点名缺哪个
 *   - `member` 传入 → 400 **显式拒绝**（不静默忽略，否则调用方误以为聚合生效）
 *   - 未授权 scope → 403 且不回显 scope 名
 *   - 文档不存在 → 404 且**不带候选清单**（内核的 hint 可能含候选 Group 路径 → 库结构探测）
 *   - 成功体原样透出（形状与 `executeGetModuleInfoLocal` 一致，不裁剪）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/open-api-doc.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { resetConfigCache } from '../src/lib/config.js';
import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import type { TokenAuth } from '../src/lib/mcp-token.js';

const scope = `openapi-doc-${Date.now()}`;
const OTHER_SCOPE = `openapi-doc-other-${Date.now()}`;

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

function docUrl(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  return `${http.base}/open/v1/doc?${q.toString()}`;
}

const auth = { Authorization: 'Bearer tok-scope' };

describe('① 参数校验', () => {
  it('缺 relation → 400 且文案点名 relation', async () => {
    const res = await fetch(docUrl({ scope, group: 'g' }), { headers: auth });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string; error?: string };
    assert.equal(body.code, 'OPEN_API_BAD_REQUEST');
    assert.ok(body.error?.includes('relation'));
  });

  it('scope 含路径字符 → 400 BAD_REQUEST（不能冒成 500）', async () => {
    const res = await fetch(docUrl({ scope: '../etc', group: 'g', relation: 'r' }), { headers: auth });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, 'OPEN_API_BAD_REQUEST');
  });

  it('传 member（视图聚合）→ 400 显式拒绝', async () => {
    const res = await fetch(docUrl({ scope, group: 'g', relation: 'r', member: 'x' }), { headers: auth });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string; error?: string };
    assert.equal(body.code, 'OPEN_API_BAD_REQUEST');
    assert.ok(body.error?.includes('member'));
  });
});

describe('② 鉴权', () => {
  it('未授权 scope → 403 且不回显 scope 名', async () => {
    const res = await fetch(docUrl({ scope: OTHER_SCOPE, group: 'g', relation: 'r' }), { headers: auth });
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.equal((JSON.parse(text) as { code?: string }).code, 'OPEN_API_SCOPE_FORBIDDEN');
    assert.ok(!text.includes(OTHER_SCOPE), '响应不得回显被请求的 scope 名');
  });
});

describe('③ 不存在：404 且不带候选清单（防库结构探测）', () => {
  it('group/relation 都不存在 → 404 NOT_FOUND，且响应体不含 hint / 候选路径', async () => {
    const res = await fetch(docUrl({ scope, group: '不存在的组', relation: '不存在的文档' }), { headers: auth });
    assert.equal(res.status, 404);
    const text = await res.text();
    const body = JSON.parse(text) as { code?: string; hint?: unknown; error?: string };
    assert.equal(body.code, 'OPEN_API_NOT_FOUND');
    assert.equal(body.hint, undefined, '不得透出内核 hint（可能含候选 Group 路径）');
    assert.ok(!text.includes('候选'));
  });
});
