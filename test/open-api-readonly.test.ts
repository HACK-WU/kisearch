/**
 * `/open/v1` 只读取件两端点的契约骨架（REQ-20261124-002 · 前置层）
 *
 * 本文件在**骨架期**只守三件事：
 *   1. 两条读路由已注册且**不绕过鉴权**（无 token 401、Cookie 不顶用）；
 *   2. 方法不符给 405 并带 `Allow`；
 *   3. 桩当前返回 501 `OPEN_API_NOT_IMPLEMENTED`——**这是防遗忘的守门断言**：
 *      S-02 / S-03 填充实现时，这两条会红，请把断言改为 200 并接上真正的字节/正文校验。
 *
 * 真正的契约断言（200 字节一致、403 越界、400 视图名、`downloadApi=false` 404）
 * 以 `it.skip` 形式预置，实现对应子需求时去掉 skip 即可。
 *
 * 运行：npx jiti test/open-api-readonly.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import type { TokenAuth } from '../src/lib/mcp-token.js';

function buildTestServer(): McpServer {
  const server = new McpServer({ name: 'kisearch', version: '0.0.0-test' });
  server.tool('ping', 'test ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

const TOKENS: Record<string, TokenAuth> = {
  'tok-rw': { id: 'tok-rw', scopes: ['default'], readOnly: false },
  'tok-ro': { id: 'tok-ro', scopes: ['default'], readOnly: true },
};

interface Handle { base: string; close: () => Promise<void> }

let api: Handle;
/** `downloadApi=false` 的实例：验证读出口开关只关读端点、不碰 ping */
let apiNoDownload: Handle;

async function start(opts: { downloadApi?: boolean } = {}): Promise<Handle> {
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    // 与真实默认部署一致：回环 + 本机免登录。此配置下 /api/* 免登录，
    // 而 /open/v1/* 必须仍然要 Bearer —— 读端点同样适用。
    authEnabled: false,
    resolveClientAddr: () => '127.0.0.1',
    resolveTokenAuth: (t: string) => TOKENS[t],
    uploadApi: true,
    downloadApi: opts.downloadApi,
    uploadMaxBytes: 8 * 1024 * 1024,
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

const PATHS = ['/open/v1/asset?scope=default&group=g&path=a.png', '/open/v1/doc?scope=default&group=g&relation=r'];

before(async () => {
  api = await start();
  apiNoDownload = await start({ downloadApi: false });
});
after(async () => {
  await api?.close();
  await apiNoDownload?.close();
});

describe('/open/v1 只读端点：命名空间与鉴权边界', () => {
  for (const p of PATHS) {
    it(`${p.split('?')[0]} 无 token → 401 TOKEN_REQUIRED`, async () => {
      const res = await fetch(`${api.base}${p}`);
      assert.equal(res.status, 401);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, 'OPEN_API_TOKEN_REQUIRED');
    });

    it(`${p.split('?')[0]} 读写 token 用 POST → 405 且带 Allow`, async () => {
      const res = await fetch(`${api.base}${p}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok-rw', 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 405);
      assert.ok(res.headers.get('allow')?.includes('GET'));
    });

    it(`${p.split('?')[0]} 只读 token 用 POST → 403 TOKEN_READONLY（先于 405 的已有语义）`, async () => {
      const res = await fetch(`${api.base}${p}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok-ro', 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, 'OPEN_API_TOKEN_READONLY');
    });
  }
});

describe('骨架码已消失（S-02 / S-03 均已实现）', () => {
  for (const p of PATHS) {
    it(`${p.split('?')[0]} 带 token 不再返回 501 NOT_IMPLEMENTED`, async () => {
      const res = await fetch(`${api.base}${p}`, { headers: { Authorization: 'Bearer tok-rw' } });
      assert.notEqual(res.status, 501);
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      assert.notEqual(body.code, 'OPEN_API_NOT_IMPLEMENTED');
    });
  }
});

// asset 的契约断言已落地在 `test/open-api-asset.test.ts`（10 例）

describe('/open/v1/doc 契约（S-03 填充后启用）', () => {
  it.skip('返回 content 与 images[]，且 ref 可直接作为 asset 的 path', async () => {});
  it.skip('传 member → 400 OPEN_API_BAD_REQUEST（显式拒绝而非忽略）', async () => {});
  it.skip('文档不存在 → 404 且不回候选清单', async () => {});
});

describe('读出口开关（S-01）', () => {
  for (const p of PATHS) {
    it(`${p.split('?')[0]} 在 downloadApi=false 时 → 404（不泄露存在性）`, async () => {
      const res = await fetch(`${apiNoDownload.base}${p}`, { headers: { Authorization: 'Bearer tok-rw' } });
      assert.equal(res.status, 404);
      const body = (await res.json()) as { code?: string };
      assert.equal(body.code, 'OPEN_API_NOT_FOUND');
    });
  }

  it('downloadApi=false 不影响 ping（诊断入口必须可用）', async () => {
    const res = await fetch(`${apiNoDownload.base}/open/v1/ping`, { headers: { Authorization: 'Bearer tok-rw' } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; uploadApi?: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.uploadApi, true);
  });

  it('开关关闭时也不做鉴权（与上传开关同口径：连 401 都不给）', async () => {
    const res = await fetch(`${apiNoDownload.base}${PATHS[0]}`);
    assert.equal(res.status, 404);
  });
});

describe('ping 能力位（S-01）', () => {
  it('返回 contractVersion=1 与 capabilities.download 全开', async () => {
    const res = await fetch(`${api.base}/open/v1/ping`, { headers: { Authorization: 'Bearer tok-rw' } });
    const body = (await res.json()) as {
      contractVersion?: number;
      capabilities?: { download?: { asset?: boolean; doc?: boolean }; maxAssetSize?: number | null };
      limits?: { maxAssetSize?: number };
    };
    assert.equal(body.contractVersion, 1);
    assert.equal(body.capabilities?.download?.asset, true);
    assert.equal(body.capabilities?.download?.doc, true);
    // 与 limits.maxAssetSize 同源同值（客户端两处读到的必须一致）
    assert.equal(body.capabilities?.maxAssetSize, body.limits?.maxAssetSize);
  });

  it('downloadApi=false 时 capabilities.download 两项均为 false（但端点仍注册）', async () => {
    const res = await fetch(`${apiNoDownload.base}/open/v1/ping`, { headers: { Authorization: 'Bearer tok-rw' } });
    const body = (await res.json()) as { capabilities?: { download?: { asset?: boolean; doc?: boolean } } };
    assert.equal(body.capabilities?.download?.asset, false);
    assert.equal(body.capabilities?.download?.doc, false);
  });
});
