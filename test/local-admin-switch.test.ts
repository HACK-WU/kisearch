/**
 * local-admin-switch.test.ts —— --no-local-admin / mcp.http.localAdmin=false（S-06）
 *
 * 运行：npx jiti test/local-admin-switch.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpHttpServer } from '../src/lib/mcp-http.js';

async function start(localAdmin: boolean) {
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: true,
    localAdmin,
    // 模拟本机来源 + 回环 Host
    resolveClientAddr: () => '127.0.0.1',
    buildServer: () => new McpServer({ name: 'kisearch', version: '0.0.0-test' }),
    webDir: null,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function me(base: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/auth/me`);
  return await res.json() as Record<string, unknown>;
}

describe('local-admin switch', () => {
  it('默认：本机回环自动管理员', async () => {
    const s = await start(true);
    try {
      const body = await me(s.base);
      assert.equal(body.authenticated, true);
      assert.equal(body.source, 'local');
    } finally {
      await s.close();
    }
  });

  it('localAdmin=false：本机不再自动管理员，/mcp 也拒绝空 principal', async () => {
    const s = await start(false);
    try {
      const body = await me(s.base);
      assert.equal(body.authenticated, false);
      assert.equal(body.localAdminEnabled, false);

      const res = await fetch(`${s.base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });
      assert.equal(res.status, 401);
      try { await res.body?.cancel(); } catch { /* ignore */ }
    } finally {
      await s.close();
    }
  });
});
