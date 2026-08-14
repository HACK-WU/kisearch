/**
 * mcp-http-api 单元测试 —— 方案 A /api/* 路由（REQ-20260806-003）
 *
 * 覆盖：
 *   - GET  /api/health                健康报告（200）
 *   - GET  /api/doc/list              空 scope → 空列表；q 过滤；Group 路径 + 文档结构
 *   - POST /api/import/upload         文件校验（扩展名白名单/大小/路径穿越）；落盘受控目录
 *   - POST /api/import/run            参数校验（scope/uploadId 缺失 → 400；uploadId 不存在 → 400）
 *   - GET  /api/import/status         jobId 不存在 → 404
 *   - /api/* 与 /mcp 隔离（非 /api 404）
 *
 * 运行：npx jiti test/mcp-http-api.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import { getRelationsCachePath } from '../src/lib/scope.js';

// ─── 测试隔离：临时 HOME，避免污染真实 ~/.ki ───
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-api-test-'));
process.env.HOME = tmpHome;
process.env.KI_CONFIG_PATH = path.join(tmpHome, 'ki-config.json');
fs.writeFileSync(
  process.env.KI_CONFIG_PATH,
  JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock' } }),
);

function buildTestServer(_authScopes: string[] | null = null): McpServer {
  const server = new McpServer({ name: 'kisearch', version: '0.0.0-test' });
  server.tool('ping', 'test ping', {}, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return server;
}

let handle: { base: string; port: number; close: () => Promise<void> } | null = null;

before(async () => {
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: false,
    buildServer: buildTestServer,
    webDir: null,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  handle = {
    base: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
});

after(async () => {
  await handle?.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** 构造一个 scope 的 relations-cache，供 /api/doc/list 测试 */
function seedRelationsCache(scope: string, groups: Record<string, string[]>): void {
  const cachePath = getRelationsCachePath(scope);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const data: Record<string, unknown> = {
    version: 1,
    scope,
    partition_config: {},
    groups: {},
    updatedAt: null,
  };
  for (const [group, rels] of Object.entries(groups)) {
    (data.groups as Record<string, unknown>)[group] = {
      hot_relations: rels.map((r) => ({ id: `r-${r}`, text: r, score: 1, sourcePath: `docs/${r}.md` })),
      keywords: [],
      max_hot_count: 0,
    };
  }
  fs.writeFileSync(cachePath, JSON.stringify(data));
}

describe('/api/health', () => {
  it('返回健康报告（200）', async () => {
    const res = await fetch(`${handle!.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.report);
  });
});

describe('/api/doc/list', () => {
  it('scope 为空（default）返回空列表', async () => {
    const res = await fetch(`${handle!.base}/api/doc/list?scope=empty-scope`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.docs, []);
    assert.equal(body.total, 0);
  });

  it('返回 Group 路径 + 文档，q 过滤生效', async () => {
    seedRelationsCache('doc-test', {
      告警收敛: ['告警收敛策略', '告警通知'],
      架构: ['系统架构'],
    });
    const res = await fetch(`${handle!.base}/api/doc/list?scope=doc-test`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.total, 3);
    assert.ok(body.docs.some((d: { name: string; group: string }) => d.name === '告警收敛策略' && d.group === '告警收敛'));

    const filtered = await (await fetch(`${handle!.base}/api/doc/list?scope=doc-test&q=告警`)).json();
    assert.equal(filtered.total, 2);
    assert.ok(filtered.docs.every((d: { name: string }) => d.name.includes('告警')));
  });
});

describe('/api/import/upload', () => {
  it('校验扩展名白名单（非 md 拒绝）', async () => {
    const res = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'up-test', files: [{ name: 'evil.txt', content: Buffer.from('x').toString('base64') }] }),
    });
    assert.equal(res.status, 400);
  });

  it('拒绝路径穿越（../）', async () => {
    const res = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'up-test', files: [{ name: '../evil.md', content: Buffer.from('x').toString('base64') }] }),
    });
    assert.equal(res.status, 400);
  });

  it('合法文件落盘受控目录并返回 uploadId', async () => {
    const res = await fetch(`${handle!.base}/api/import/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'up-test',
        files: [
          { name: 'docs/alarm.md', content: Buffer.from('# 告警').toString('base64') },
          { name: 'b.md', content: Buffer.from('# B').toString('base64') },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.uploadId);
    assert.equal(body.total, 2);
    // 文件确实落盘到受控目录
    const abs = path.join(process.env.HOME!, '.ki', 'import-uploads', body.uploadId, 'docs', 'alarm.md');
    assert.ok(fs.existsSync(abs));
    assert.equal(fs.readFileSync(abs, 'utf-8'), '# 告警');
  });
});

describe('/api/import/run + status', () => {
  it('run 缺参数 → 400', async () => {
    const res = await fetch(`${handle!.base}/api/import/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'x' }),
    });
    assert.equal(res.status, 400);
  });

  it('run uploadId 不存在 → 400', async () => {
    const res = await fetch(`${handle!.base}/api/import/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'x', uploadId: 'no-such-id' }),
    });
    assert.equal(res.status, 400);
  });

  it('status jobId 不存在 → 404', async () => {
    const res = await fetch(`${handle!.base}/api/import/status?jobId=no-such-job`);
    assert.equal(res.status, 404);
  });
});

describe('--web 静态服务', () => {
  it('根路径返回 index.html；未知 /api/* 不 fallback；SPA fallback 生效', async () => {
    // 独立的 webDir 服务（复用同一 server，但 webDir 需要在 createMcpHttpServer 时传入——
    // 这里直接用文件系统验证 serveStatic 行为：起一个带 webDir 的独立服务）
    const webDir = path.join(tmpHome, 'webdist');
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, 'index.html'), '<html>ki-web</html>');
    fs.writeFileSync(path.join(webDir, 'app.js'), 'console.log(1)');

    const { httpServer, closeAllSessions } = createMcpHttpServer({
      authEnabled: false,
      buildServer: buildTestServer,
      webDir,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      // 根路径 → index.html
      const root = await fetch(`${base}/`);
      assert.equal(root.status, 200);
      assert.ok((await root.text()).includes('ki-web'));

      // 静态资源 → app.js
      const js = await fetch(`${base}/app.js`);
      assert.equal(js.status, 200);
      assert.ok((await js.text()).includes('console.log'));

      // SPA fallback：非 /api 非 /mcp 的 GET 404 → index.html
      const spa = await fetch(`${base}/some/route`);
      assert.equal(spa.status, 200);
      assert.ok((await spa.text()).includes('ki-web'));

      // /api/* 未匹配 → JSON 404（不 fallback HTML）
      const api = await fetch(`${base}/api/nope`);
      assert.equal(api.status, 404);
      const apiBody = await api.json();
      assert.equal(apiBody.ok, false);
    } finally {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

describe('/api/* 与 /mcp 隔离', () => {
  it('未知 /api/xxx → JSON 404（非 fallback）', async () => {
    const res = await fetch(`${handle!.base}/api/unknown`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  it('/mcp 仍正常（POST initialize 可达）', async () => {
    const res = await fetch(`${handle!.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    assert.equal(res.status, 200);
  });
});

describe('/api/* 鉴权（对外绑定 + 本地豁免）', () => {
  /** 起一个 authEnabled=true 的 server，注入 clientAddr 模拟来源 */
  async function startAuthServer(clientAddr: string): Promise<{ base: string; port: number; close: () => Promise<void> }> {
    const { httpServer, closeAllSessions } = createMcpHttpServer({
      authEnabled: true,
      token: 'secret-token',
      buildServer: buildTestServer,
      webDir: null,
      resolveClientAddr: () => clientAddr,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${addr.port}`,
      port: addr.port,
      close: async () => {
        await closeAllSessions();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      },
    };
  }

  it('本地来源（127.0.0.1）+ 无 token → /api/health 200（本地豁免）', async () => {
    const srv = await startAuthServer('127.0.0.1');
    try {
      const res = await fetch(`${srv.base}/api/health`);
      assert.equal(res.status, 200);
    } finally {
      await srv.close();
    }
  });

  it('远程来源（192.168.1.10）+ 无 token → /api/health 401', async () => {
    const srv = await startAuthServer('192.168.1.10');
    try {
      const res = await fetch(`${srv.base}/api/health`);
      assert.equal(res.status, 401);
    } finally {
      await srv.close();
    }
  });

  it('远程来源 + 错误 token → /api/health 401', async () => {
    const srv = await startAuthServer('192.168.1.10');
    try {
      const res = await fetch(`${srv.base}/api/health`, { headers: { Authorization: 'Bearer wrong-token' } });
      assert.equal(res.status, 401);
    } finally {
      await srv.close();
    }
  });

  it('远程来源 + 正确 token → /api/health 200', async () => {
    const srv = await startAuthServer('192.168.1.10');
    try {
      const res = await fetch(`${srv.base}/api/health`, { headers: { Authorization: 'Bearer secret-token' } });
      assert.equal(res.status, 200);
    } finally {
      await srv.close();
    }
  });
});
