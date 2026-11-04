/**
 * mcp-http-web-session.test.ts —— /mcp 接受 Web 会话（REQ-20261103-001 · S-02）
 *
 * 运行：npx jiti test/mcp-http-web-session.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import { createUser } from '../src/lib/user-store.js';
import { clearSessions, createSession } from '../src/lib/web-session-store.js';
import { serializeSessionCookie } from '../src/lib/web-auth.js';
import type { TokenAuth } from '../src/lib/mcp-token.js';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-mcp-web-session-'));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalConfig = process.env.KI_CONFIG_PATH;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.KI_CONFIG_PATH = path.join(tmpHome, 'ki-config.json');
fs.writeFileSync(
  process.env.KI_CONFIG_PATH,
  JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock' } }),
);

let lastAuth: TokenAuth | null = null;
let handle: { base: string; close: () => Promise<void> } | null = null;

async function initialize(cookie?: string): Promise<number> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${handle!.base}/mcp`, {
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
  try {
    await res.body?.cancel();
  } catch {
    /* 忽略 */
  }
  return res.status;
}

before(async () => {
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: true,
    // 模拟远程来源；Host 仍是 127.0.0.1（测试服务监听地址），因此不会误判 local-admin
    resolveClientAddr: () => '203.0.113.10',
    buildServer: (auth) => {
      lastAuth = auth;
      return new McpServer({ name: 'kisearch', version: '0.0.0-test' });
    },
    webDir: null,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  handle = {
    base: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
});

after(async () => {
  await handle?.close();
  clearSessions();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalConfig === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = originalConfig;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('/mcp Web 会话', () => {
  it('无凭据 → 401', async () => {
    assert.equal(await initialize(), 401);
  });

  it('editor 会话 → 200，非只读工具集', async () => {
    const user = createUser({ username: 'editor1', password: 'EditorPass1!', role: 'editor' });
    const session = createSession(user.id, user.passwordUpdatedAt);
    const cookie = serializeSessionCookie(session.id).split(';')[0];
    assert.equal(await initialize(cookie), 200);
    assert.equal(lastAuth?.readOnly, false);
  });

  it('viewer 会话 → 200，只读工具集', async () => {
    const user = createUser({ username: 'viewer1', password: 'ViewerPass1!', role: 'viewer' });
    const session = createSession(user.id, user.passwordUpdatedAt);
    const cookie = serializeSessionCookie(session.id).split(';')[0];
    assert.equal(await initialize(cookie), 200);
    assert.equal(lastAuth?.readOnly, true);
  });

  it('无效 Cookie → 401', async () => {
    assert.equal(await initialize('ki_web_session=not-a-real-session'), 401);
  });
});
