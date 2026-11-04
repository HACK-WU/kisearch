/**
 * web-auth-api.test.ts —— /api/auth/* 端到端（REQ-20261103-001 · S-02）
 *
 * 运行：npx jiti test/web-auth-api.test.ts
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
import { clearSessions } from '../src/lib/web-session-store.js';
import { resetLoginRateLimit } from '../src/lib/web-auth.js';
import { createTaskReporter } from '../src/lib/task-registry.js';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-web-auth-api-'));
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

let currentClientAddr = '203.0.113.10';
let handle: { base: string; close: () => Promise<void> } | null = null;

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

before(async () => {
  createUser({ username: 'admin1', password: 'AdminPass1!', role: 'admin' });
  createUser({ username: 'editor1', password: 'EditorPass1!', role: 'editor' });
  createUser({ username: 'editor2', password: 'EditorPass2!', role: 'editor' });
  createUser({ username: 'viewer1', password: 'ViewerPass1!', role: 'viewer' });

  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: true,
    token: 'test-token',
    buildServer: buildTestServer,
    webDir: null,
    resolveClientAddr: () => currentClientAddr,
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
  currentClientAddr = '203.0.113.10';
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

describe('/api/auth', () => {
  it('匿名 me → authenticated:false；匿名业务接口 → 401', async () => {
    const me = await jsonFetch(`${handle!.base}/api/auth/me`);
    assert.equal(me.status, 200);
    assert.equal(me.body.authenticated, false);

    const docList = await jsonFetch(`${handle!.base}/api/doc/list?scope=default`);
    assert.equal(docList.status, 401);
    assert.equal(docList.body.code, 'AUTH_REQUIRED');
  });

  it('本地回环 + Host 回环 → local-admin', async () => {
    currentClientAddr = '127.0.0.1';
    const me = await jsonFetch(`${handle!.base}/api/auth/me`);
    assert.equal(me.status, 200);
    assert.equal(me.body.authenticated, true);
    assert.equal(me.body.source, 'local');
    assert.equal((me.body.user as { role: string }).role, 'admin');
  });

  it('登录 → 会话 → me → 登出', async () => {
    const loginRes = await login('viewer1', 'ViewerPass1!');
    assert.equal(loginRes.status, 200);
    assert.match(loginRes.cookie, /^ki_web_session=/);
    assert.deepEqual(
      (loginRes.body.user as { role: string }).role,
      'viewer',
    );

    const me = await jsonFetch(`${handle!.base}/api/auth/me`, {
      headers: { cookie: loginRes.cookie },
    });
    assert.equal(me.status, 200);
    assert.equal(me.body.authenticated, true);
    assert.equal(me.body.source, 'session');
    assert.equal((me.body.user as { username: string }).username, 'viewer1');
    assert.ok((me.body.permissions as string[]).includes('knowledge.read'));
    assert.equal((me.body.permissions as string[]).includes('knowledge.write'), false);

    const logout = await jsonFetch(`${handle!.base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: loginRes.cookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.cookie, /^ki_web_session=$/);

    const afterLogout = await jsonFetch(`${handle!.base}/api/auth/me`, {
      headers: { cookie: loginRes.cookie },
    });
    assert.equal(afterLogout.body.authenticated, false);
  });

  it('改密：旧会话失效，新密码可登录', async () => {
    const loginRes = await login('editor1', 'EditorPass1!');
    const changed = await jsonFetch(`${handle!.base}/api/auth/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: loginRes.cookie },
      body: JSON.stringify({ oldPassword: 'EditorPass1!', newPassword: 'EditorPass2!' }),
    });
    assert.equal(changed.status, 200);
    assert.match(changed.cookie, /^ki_web_session=/);

    const oldCookieMe = await jsonFetch(`${handle!.base}/api/auth/me`, {
      headers: { cookie: loginRes.cookie },
    });
    assert.equal(oldCookieMe.body.authenticated, false);

    assert.equal((await login('editor1', 'EditorPass1!')).status, 401);
    assert.equal((await login('editor1', 'EditorPass2!')).status, 200);
  });

  it('登录失败限速：第 6 次 429', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await login('viewer1', 'wrong-password');
      assert.equal(r.status, 401);
      assert.equal(r.body.code, 'AUTH_INVALID');
    }
    const blocked = await login('viewer1', 'wrong-password');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'AUTH_RATE_LIMITED');
  });

  it('viewer：写接口 403 USER_READONLY；数据源读 403；任务读 200', async () => {
    const loginRes = await login('viewer1', 'ViewerPass1!');
    const cookie = loginRes.cookie;

    const edit = await jsonFetch(`${handle!.base}/api/doc/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(edit.status, 403);
    assert.equal(edit.body.code, 'USER_READONLY');

    const sync = await jsonFetch(`${handle!.base}/api/datasource/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(sync.status, 403);
    assert.equal(sync.body.code, 'USER_READONLY');

    const restore = await jsonFetch(`${handle!.base}/api/restore/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(restore.status, 403);
    assert.equal(restore.body.code, 'USER_READONLY');

    const dsList = await jsonFetch(`${handle!.base}/api/datasource/list`, {
      headers: { cookie },
    });
    assert.equal(dsList.status, 403);
    assert.equal(dsList.body.code, 'DATA_SOURCE_FORBIDDEN');

    const tasks = await jsonFetch(`${handle!.base}/api/tasks`, { headers: { cookie } });
    assert.equal(tasks.status, 200);
  });

  it('editor：数据源写/删 403；运维/账号/取消 403；知识写允许', async () => {
    const loginRes = await login('editor2', 'EditorPass2!');
    const cookie = loginRes.cookie;

    const sync = await jsonFetch(`${handle!.base}/api/datasource/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(sync.status, 403);
    assert.equal(sync.body.code, 'DATA_SOURCE_FORBIDDEN');

    const remove = await jsonFetch(`${handle!.base}/api/datasource/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(remove.status, 403);
    assert.equal(remove.body.code, 'DATA_SOURCE_FORBIDDEN');

    const restore = await jsonFetch(`${handle!.base}/api/restore/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(restore.status, 403);
    assert.equal(restore.body.code, 'OPS_FORBIDDEN');

    const cancel = await jsonFetch(`${handle!.base}/api/import/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(cancel.status, 403);
    assert.equal(cancel.body.code, 'OPS_FORBIDDEN');

    const users = await jsonFetch(`${handle!.base}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.equal(users.status, 403);
    assert.equal(users.body.code, 'OPS_FORBIDDEN');

    const dsList = await jsonFetch(`${handle!.base}/api/datasource/list`, {
      headers: { cookie },
    });
    assert.notEqual(dsList.status, 403);

    const edit = await jsonFetch(`${handle!.base}/api/doc/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    assert.notEqual(edit.status, 403);
  });

  it('Token：不获得 users.manage；既有知识读/数据源删仍可用', async () => {
    const users = await jsonFetch(`${handle!.base}/api/users`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(users.status, 403);
    assert.equal(users.body.code, 'FORBIDDEN');

    const docList = await jsonFetch(`${handle!.base}/api/doc/list?scope=default`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.notEqual(docList.status, 401);
    assert.notEqual(docList.status, 403);

    const remove = await jsonFetch(`${handle!.base}/api/datasource/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({}),
    });
    assert.notEqual(remove.status, 403);
  });

  it('管理员用户管理：列表 / 创建 / 改角色 / 禁用 / 删除；最后 admin 保护', async () => {
    const loginRes = await login('admin1', 'AdminPass1!');
    const cookie = loginRes.cookie;

    const list = await jsonFetch(`${handle!.base}/api/users`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const initialUsers = list.body.users as Array<{ id: string; username: string }>;
    assert.ok(initialUsers.some((u) => u.username === 'admin1'));

    const created = await jsonFetch(`${handle!.base}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ username: 'editor3', password: 'EditorPass3!', role: 'editor' }),
    });
    assert.equal(created.status, 201);
    const editorId = (created.body.user as { id: string }).id;

    const roleChanged = await jsonFetch(`${handle!.base}/api/users/${editorId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ role: 'viewer' }),
    });
    assert.equal(roleChanged.status, 200);
    assert.equal((roleChanged.body.user as { role: string }).role, 'viewer');

    const disabled = await jsonFetch(`${handle!.base}/api/users/${editorId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disabled.status, 200);
    assert.equal((disabled.body.user as { disabled: boolean }).disabled, true);

    const removed = await jsonFetch(`${handle!.base}/api/users/${editorId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(removed.status, 200);

    const adminId = initialUsers.find((u) => u.username === 'admin1')!.id;
    const lastAdmin = await jsonFetch(`${handle!.base}/api/users/${adminId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(lastAdmin.status, 409);
    assert.equal(lastAdmin.body.code, 'USER_SELF_PROTECTED');
  });

  it('任务列表/详情返回 operator（viewer 可读）', async () => {
    const reporter = createTaskReporter(
      { dataDir: path.join(tmpHome, '.ki', 'kb') },
      {
        id: 'task-op-api',
        source: 'web',
        operator: { type: 'user', label: 'alice', userId: 'u-1' },
        operation: 'import',
        scope: 'default',
      },
    );
    try {
      reporter.finish('succeeded');
    } finally {
      reporter.stop();
    }

    const loginRes = await login('viewer1', 'ViewerPass1!');
    const list = await jsonFetch(`${handle!.base}/api/tasks`, { headers: { cookie: loginRes.cookie } });
    assert.equal(list.status, 200);
    const row = (list.body.tasks as Array<{ id: string; operator?: { label: string } }>)
      .find((task) => task.id === 'task-op-api');
    assert.equal(row?.operator?.label, 'alice');

    const detail = await jsonFetch(`${handle!.base}/api/tasks/task-op-api`, {
      headers: { cookie: loginRes.cookie },
    });
    assert.equal(detail.status, 200);
    assert.equal((detail.body.task as { operator?: { label: string } }).operator?.label, 'alice');
  });

  it('CSRF：跨站 Origin / text/plain 被拒绝；同源 JSON 放行', async () => {
    const origin = handle!.base;
    const cross = await fetch(`${handle!.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.com' },
      body: JSON.stringify({ username: 'viewer1', password: 'ViewerPass1!' }),
    });
    assert.equal(cross.status, 403);
    assert.equal(((await cross.json()) as { code: string }).code, 'CSRF_ORIGIN_REJECTED');

    const textPlain = await fetch(`${handle!.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: origin },
      body: JSON.stringify({ username: 'viewer1', password: 'ViewerPass1!' }),
    });
    assert.equal(textPlain.status, 415);
    assert.equal(((await textPlain.json()) as { code: string }).code, 'UNSUPPORTED_CONTENT_TYPE');

    const sameOrigin = await fetch(`${handle!.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ username: 'viewer1', password: 'ViewerPass1!' }),
    });
    assert.equal(sameOrigin.status, 200);

    const mcpCross = await fetch(`${handle!.base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(mcpCross.status, 403);
    const mcpBody = await mcpCross.json() as { error?: { data?: { code?: string } } };
    assert.equal(mcpBody.error?.data?.code, 'CSRF_ORIGIN_REJECTED');
  });

  it('未知 /api 路径 → 404；local-admin 不受能力门禁阻断', async () => {
    const viewer = await login('viewer1', 'ViewerPass1!');
    const missing = await jsonFetch(`${handle!.base}/api/nope`, {
      headers: { cookie: viewer.cookie },
    });
    assert.equal(missing.status, 404);

    currentClientAddr = '127.0.0.1';
    const localAdmin = await jsonFetch(`${handle!.base}/api/datasource/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.notEqual(localAdmin.status, 403);
  });
});
