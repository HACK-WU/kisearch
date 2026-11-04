/**
 * user-token-api.test.ts —— 账号有效期 / 管理员保护 / 自助与代管 Token（REQ-20261104-001）
 *
 * 运行：npx jiti test/user-token-api.test.ts
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import { createUser } from '../src/lib/user-store.js';
import { findTokenAuth, listTokensByOwner } from '../src/lib/mcp-token.js';
import { clearSessions } from '../src/lib/web-session-store.js';
import { resetLoginRateLimit } from '../src/lib/web-auth.js';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-user-token-api-'));
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

let handle: { base: string; close: () => Promise<void> } | null = null;
const ids: Record<string, string> = {};

function buildTestServer(): McpServer {
  return new McpServer({ name: 'kisearch', version: '0.0.0-test' });
}

async function jsonFetch(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown>; cookie: string }> {
  const res = await fetch(url, init);
  let body: Record<string, unknown> = {};
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
    /* 非 JSON */
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { status: res.status, body, cookie: setCookie.split(';')[0] ?? '' };
}

async function login(username: string, password: string) {
  return jsonFetch(`${handle!.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

async function createViaApi(cookie: string, username: string, role = 'viewer', expiresAt?: string | null) {
  return jsonFetch(`${handle!.base}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ username, password: 'Passw0rd!', role, ...(expiresAt !== undefined ? { expiresAt } : {}) }),
  });
}

before(async () => {
  const admin = createUser({ username: 'admin1', password: 'AdminPass1!', role: 'admin' });
  const editor = createUser({ username: 'editor-token', password: 'EditorPass1!', role: 'editor' });
  const viewer = createUser({ username: 'viewer-token', password: 'ViewerPass1!', role: 'viewer' });
  const cap = createUser({ username: 'viewer-cap', password: 'ViewerPass1!', role: 'viewer' });
  ids.admin = admin.id;
  ids.editor = editor.id;
  ids.viewer = viewer.id;
  ids.cap = cap.id;

  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: true,
    token: 'test-token',
    buildServer: buildTestServer,
    webDir: null,
    resolveClientAddr: () => '203.0.113.10',
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

beforeEach(() => {
  resetLoginRateLimit();
  clearSessions();
});

after(async () => {
  await handle?.close();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalConfig === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = originalConfig;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('账号有效期与管理员保护', () => {
  it('Web 不能创建 admin；管理员不可降级/禁用；当前管理员不能删除自己', async () => {
    const admin = await login('admin1', 'AdminPass1!');
    const cookie = admin.cookie;

    const createAdmin = await createViaApi(cookie, 'admin2', 'admin');
    assert.equal(createAdmin.status, 400);
    assert.equal(createAdmin.body.code, 'USER_ADMIN_CLI_ONLY');

    const demote = await jsonFetch(`${handle!.base}/api/users/${ids.admin}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ role: 'editor' }),
    });
    assert.equal(demote.status, 409);
    assert.equal(demote.body.code, 'USER_ADMIN_PROTECTED');

    const disable = await jsonFetch(`${handle!.base}/api/users/${ids.admin}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disable.status, 409);
    assert.equal(disable.body.code, 'USER_SELF_PROTECTED');

    const setExpiry = await jsonFetch(`${handle!.base}/api/users/${ids.admin}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ expiresAt: '2099-12-31T23:59:00.000Z' }),
    });
    assert.equal(setExpiry.status, 409);
    assert.equal(setExpiry.body.code, 'USER_ADMIN_PROTECTED');

    const removeSelf = await jsonFetch(`${handle!.base}/api/users/${ids.admin}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(removeSelf.status, 409);
    assert.equal(removeSelf.body.code, 'USER_SELF_PROTECTED');
  });

  it('创建账号可带有效期；过期后登录 401；清除后恢复', async () => {
    const admin = await login('admin1', 'AdminPass1!');
    const cookie = admin.cookie;
    const created = await createViaApi(cookie, 'expired-on-create', 'editor', '2020-01-01T00:00:00.000Z');
    assert.equal(created.status, 201);
    assert.equal((created.body.user as { expiresAt: string }).expiresAt, '2020-01-01T00:00:00.000Z');
    assert.equal((await login('expired-on-create', 'Passw0rd!')).status, 401);

    const future = await createViaApi(cookie, 'future-user', 'viewer', '2099-12-31T23:59:00.000Z');
    assert.equal(future.status, 201);
    const futureId = (future.body.user as { id: string }).id;
    assert.equal((await login('future-user', 'Passw0rd!')).status, 200);

    const cleared = await jsonFetch(`${handle!.base}/api/users/${futureId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ expiresAt: null }),
    });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.body.user as { expiresAt: string | null }).expiresAt, null);
  });

  it('已登录会话在账号过期后立即失效', async () => {
    const future = await login('future-user', 'Passw0rd!');
    assert.equal(future.status, 200);
    const admin = await login('admin1', 'AdminPass1!');
    const futureId = (await jsonFetch(`${handle!.base}/api/users`, { headers: { cookie: admin.cookie } }))
      .body.users as Array<{ id: string; username: string }>;
    const id = futureId.find((user) => user.username === 'future-user')!.id;
    const expired = await jsonFetch(`${handle!.base}/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ expiresAt: '2020-01-01T00:00:00.000Z' }),
    });
    assert.equal(expired.status, 200);
    const me = await jsonFetch(`${handle!.base}/api/auth/me`, { headers: { cookie: future.cookie } });
    assert.equal(me.body.authenticated, false);
    assert.equal((await login('future-user', 'Passw0rd!')).status, 401);
  });

  it('用户列表返回 expiresAt 与 tokenCount', async () => {
    const admin = await login('admin1', 'AdminPass1!');
    const list = await jsonFetch(`${handle!.base}/api/users`, {
      headers: { cookie: admin.cookie },
    });
    assert.equal(list.status, 200);
    const users = list.body.users as Array<{ username: string; expiresAt: string | null; tokenCount: number }>;
    assert.ok(users.every((u) => 'expiresAt' in u && typeof u.tokenCount === 'number'));
  });
});

describe('自助 Token', () => {
  it('editor 创建读写 Token；列表不回传明文；重名 409；撤销后计数归零', async () => {
    const editor = await login('editor-token', 'EditorPass1!');
    const cookie = editor.cookie;
    const created = await jsonFetch(`${handle!.base}/api/me/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'Cursor', readOnly: false, scopes: ['all'] }),
    });
    assert.equal(created.status, 201);
    const tokenValue = created.body.token as string;
    const item = created.body.item as { id: string; readOnly: boolean; createdBy: string };
    assert.match(tokenValue, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(item.readOnly, false);
    assert.equal(item.createdBy, 'self');

    const list = await jsonFetch(`${handle!.base}/api/me/tokens`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const tokens = list.body.tokens as Array<Record<string, unknown>>;
    assert.equal(tokens.length, 1);
    assert.equal('token' in tokens[0], false);
    assert.equal(tokens[0].label, 'Cursor');

    const duplicate = await jsonFetch(`${handle!.base}/api/me/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'cursor', readOnly: false, scopes: ['all'] }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'TOKEN_LABEL_EXISTS');

    const removed = await jsonFetch(`${handle!.base}/api/me/tokens/${item.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(removed.status, 200);
    const after = await jsonFetch(`${handle!.base}/api/me/tokens`, { headers: { cookie } });
    assert.equal((after.body.tokens as unknown[]).length, 0);
  });

  it('viewer 创建 Token 强制只读；Token principal 不能走 /me/tokens', async () => {
    const viewer = await login('viewer-token', 'ViewerPass1!');
    const cookie = viewer.cookie;
    const created = await jsonFetch(`${handle!.base}/api/me/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'Read Token', readOnly: false, scopes: ['all'] }),
    });
    assert.equal(created.status, 201);
    assert.equal((created.body.item as { readOnly: boolean }).readOnly, true);
    const tokenValue = created.body.token as string;
    assert.equal(findTokenAuth(tokenValue)?.readOnly, true);

    const viaToken = await jsonFetch(`${handle!.base}/api/me/tokens`, {
      headers: { authorization: `Bearer ${tokenValue}` },
    });
    assert.equal(viaToken.status, 403);
  });

  it('普通账号第 11 个 Token 被拒；撤销一个后可再建', async () => {
    const viewer = await login('viewer-cap', 'ViewerPass1!');
    const cookie = viewer.cookie;
    const createdIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const r = await jsonFetch(`${handle!.base}/api/me/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ label: `cap-${i}`, readOnly: true, scopes: ['all'] }),
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      createdIds.push((r.body.item as { id: string }).id);
    }
    const overflow = await jsonFetch(`${handle!.base}/api/me/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'cap-overflow', readOnly: true, scopes: ['all'] }),
    });
    assert.equal(overflow.status, 409);
    assert.equal(overflow.body.code, 'TOKEN_LIMIT_REACHED');

    await jsonFetch(`${handle!.base}/api/me/tokens/${createdIds[0]}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    const again = await jsonFetch(`${handle!.base}/api/me/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'cap-replacement', readOnly: true, scopes: ['all'] }),
    });
    assert.equal(again.status, 201);
  });

  it('管理员可为成员创建 Token；成员自助列表可见；普通用户不能走管理员端点', async () => {
    const admin = await login('admin1', 'AdminPass1!');
    const created = await jsonFetch(`${handle!.base}/api/users/${ids.viewer}/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ label: '管理员代建', readOnly: true, scopes: ['all'] }),
    });
    assert.equal(created.status, 201);
    assert.equal((created.body.item as { createdBy: string }).createdBy, 'admin');

    const viewer = await login('viewer-token', 'ViewerPass1!');
    const list = await jsonFetch(`${handle!.base}/api/me/tokens`, { headers: { cookie: viewer.cookie } });
    assert.ok((list.body.tokens as Array<{ label: string }>).some((t) => t.label === '管理员代建'));

    const forbidden = await jsonFetch(`${handle!.base}/api/users/${ids.editor}/tokens`, {
      headers: { cookie: viewer.cookie },
    });
    assert.equal(forbidden.status, 403);
  });
});

describe('Token 随 owner 状态失效', () => {
  it('owner 降为 viewer → 读写 Token 生效为只读；禁用 → 失效；删除账号 → Token 清除', async () => {
    const editor = await login('editor-token', 'EditorPass1!');
    const created = await jsonFetch(`${handle!.base}/api/me/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: editor.cookie },
      body: JSON.stringify({ label: 'lifecycle', readOnly: false, scopes: ['all'] }),
    });
    const tokenValue = created.body.token as string;
    assert.equal(findTokenAuth(tokenValue)?.readOnly, false);

    const admin = await login('admin1', 'AdminPass1!');
    const demote = await jsonFetch(`${handle!.base}/api/users/${ids.editor}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ role: 'viewer' }),
    });
    assert.equal(demote.status, 200);
    assert.equal(findTokenAuth(tokenValue)?.readOnly, true);

    const expire = await jsonFetch(`${handle!.base}/api/users/${ids.editor}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ expiresAt: '2020-01-01T00:00:00.000Z' }),
    });
    assert.equal(expire.status, 200);
    assert.equal(findTokenAuth(tokenValue), undefined);
    const expireClear = await jsonFetch(`${handle!.base}/api/users/${ids.editor}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ expiresAt: null }),
    });
    assert.equal(expireClear.status, 200);

    const disable = await jsonFetch(`${handle!.base}/api/users/${ids.editor}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disable.status, 200);
    assert.equal(findTokenAuth(tokenValue), undefined);

    const enable = await jsonFetch(`${handle!.base}/api/users/${ids.editor}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ disabled: false }),
    });
    assert.equal(enable.status, 200);
    assert.equal(findTokenAuth(tokenValue)?.readOnly, true);

    const removed = await jsonFetch(`${handle!.base}/api/users/${ids.editor}`, {
      method: 'DELETE',
      headers: { cookie: admin.cookie },
    });
    assert.equal(removed.status, 200);
    assert.equal(listTokensByOwner(ids.editor).length, 0);
    assert.equal(findTokenAuth(tokenValue), undefined);
  });
});
