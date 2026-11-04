/**
 * web-auth.test.ts —— Web Principal 解析（REQ-20261103-001 · S-02）
 *
 * 运行：npx jiti test/web-auth.test.ts
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import {
  authScopesForPrincipal,
  checkLoginRateLimit,
  clearLoginFailures,
  getSessionIdFromRequest,
  isLocalAdminRequest,
  isLoopbackHostHeader,
  parseCookies,
  recordLoginFailure,
  resetLoginRateLimit,
  resolveWebPrincipal,
  serializeSessionCookie,
  taskOperatorForPrincipal,
  toTokenAuth,
} from '../src/lib/web-auth.js';
import { clearSessions, createSession, getSession } from '../src/lib/web-session-store.js';
import { createUser, resetUserPassword, setUserDisabled } from '../src/lib/user-store.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-web-auth-'));
const usersPath = path.join(tempDir, 'users.json');

function fakeReq(
  headers: Record<string, string>,
  remoteAddress = '127.0.0.1',
): http.IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as http.IncomingMessage;
}

beforeEach(() => {
  clearSessions();
  resetLoginRateLimit();
});

after(() => {
  clearSessions();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('web-auth', () => {
  it('Host 回环判定', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:7423', 'localhost', 'localhost:7423', '[::1]:7423', '::1']) {
      assert.equal(isLoopbackHostHeader(host), true, host);
    }
    for (const host of ['evil.com', '127.0.0.1.evil.com', '127.evil.com', '192.168.1.2:7423', '', undefined]) {
      assert.equal(isLoopbackHostHeader(host), false, String(host));
    }
    assert.equal(isLoopbackHostHeader('127.0.0.2:7423'), true);
  });

  it('local-admin：源地址 + Host 双回环 + 无 XFF', () => {
    const req = fakeReq({ host: '127.0.0.1' });
    assert.equal(isLocalAdminRequest(req, '127.0.0.1', true), true);
    assert.equal(isLocalAdminRequest(fakeReq({ host: 'evil.com' }), '127.0.0.1', true), false);
    assert.equal(
      isLocalAdminRequest(fakeReq({ host: '127.0.0.1', 'x-forwarded-for': '1.2.3.4' }), '127.0.0.1', true),
      false,
    );
    // 回环绑定（authEnabled=false）：Host 缺失也兼容，但外部 Host 不判本机
    assert.equal(isLocalAdminRequest(fakeReq({}), '127.0.0.1', false), true);
    assert.equal(isLocalAdminRequest(fakeReq({ host: 'evil.com' }), '127.0.0.1', false), false);
    assert.equal(isLocalAdminRequest(fakeReq({}), '8.8.8.8', false), false);
    // --no-local-admin / mcp.http.localAdmin=false
    assert.equal(isLocalAdminRequest(fakeReq({ host: '127.0.0.1' }), '127.0.0.1', true, false), false);
    assert.equal(isLocalAdminRequest(fakeReq({ host: '127.0.0.1' }), '127.0.0.1', false, false), false);
  });

  it('resolveWebPrincipal：local-admin 优先级最高', () => {
    const r = resolveWebPrincipal(fakeReq({ host: 'localhost' }), {
      authEnabled: true,
      clientAddr: '127.0.0.1',
      usersPath,
    });
    assert.equal(r.principal?.kind, 'local-admin');
    assert.equal(authScopesForPrincipal(r.principal), null);
    assert.equal(toTokenAuth(r.principal), null);
  });

  it('localAdmin=false：本机也不判管理员', () => {
    const r = resolveWebPrincipal(fakeReq({ host: '127.0.0.1' }), {
      authEnabled: true,
      clientAddr: '127.0.0.1',
      localAdmin: false,
      usersPath,
    });
    assert.equal(r.principal, null);
  });

  it('Bearer：有效 / 无效 / 优先于 Cookie', () => {
    const valid = resolveWebPrincipal(fakeReq({ host: '8.8.8.8', authorization: 'Bearer secret' }), {
      authEnabled: true,
      token: 'secret',
      clientAddr: '8.8.8.8',
      usersPath,
    });
    assert.equal(valid.principal?.kind, 'token');

    const invalid = resolveWebPrincipal(fakeReq({ host: '8.8.8.8', authorization: 'Bearer bad' }), {
      authEnabled: true,
      token: 'secret',
      clientAddr: '8.8.8.8',
      usersPath,
    });
    assert.equal(invalid.principal, null);
    assert.equal(invalid.rejected, 'invalid-token');
  });

  it('会话：有效 / 禁用 / 改密后失效', () => {
    const user = createUser({ username: 'alice', password: 'Passw0rd!', role: 'editor' }, usersPath);
    const session = createSession(user.id, user.passwordUpdatedAt);
    const req = fakeReq({
      host: '8.8.8.8',
      cookie: `${serializeSessionCookie(session.id).split(';')[0]}`,
    });
    const ok = resolveWebPrincipal(req, {
      authEnabled: true,
      clientAddr: '8.8.8.8',
      usersPath,
    });
    assert.equal(ok.principal?.kind, 'session');
    if (ok.principal?.kind === 'session') {
      assert.equal(ok.principal.role, 'editor');
      assert.equal(ok.principal.readOnly, false);
    }
    assert.equal(toTokenAuth(ok.principal)?.readOnly, false);

    setUserDisabled('alice', true, usersPath);
    const disabled = resolveWebPrincipal(req, { authEnabled: true, clientAddr: '8.8.8.8', usersPath });
    assert.equal(disabled.principal, null);
    assert.equal(getSession(session.id), undefined);

    setUserDisabled('alice', false, usersPath);
    const userAfter = {
      ...user,
      passwordUpdatedAt: user.passwordUpdatedAt,
    };
    const s2 = createSession(userAfter.id, userAfter.passwordUpdatedAt);
    const req2 = fakeReq({
      host: '8.8.8.8',
      cookie: `${serializeSessionCookie(s2.id).split(';')[0]}`,
    });
    resetUserPassword('alice', 'NewPassw0rd!', usersPath);
    const changed = resolveWebPrincipal(req2, { authEnabled: true, clientAddr: '8.8.8.8', usersPath });
    assert.equal(changed.principal, null);
  });

  it('viewer 会话的 /mcp 授权为 readOnly', () => {
    const viewer = createUser({ username: 'guest', password: 'Passw0rd!', role: 'viewer' }, usersPath);
    const session = createSession(viewer.id, viewer.passwordUpdatedAt);
    const req = fakeReq({
      host: '8.8.8.8',
      cookie: `${serializeSessionCookie(session.id).split(';')[0]}`,
    });
    const r = resolveWebPrincipal(req, { authEnabled: true, clientAddr: '8.8.8.8', usersPath });
    assert.equal(r.principal?.kind, 'session');
    assert.equal(toTokenAuth(r.principal)?.readOnly, true);
  });

  it('Cookie 解析与序列化', () => {
    const cookie = serializeSessionCookie('abc+/=');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const req = fakeReq({ cookie: cookie.split(';')[0] });
    assert.equal(getSessionIdFromRequest(req), 'abc+/=');
    assert.deepEqual(parseCookies('a=1; b=hello%20world'), { a: '1', b: 'hello world' });
  });

  it('任务操作者快照：local / session / token', () => {
    assert.deepEqual(
      taskOperatorForPrincipal({ kind: 'local-admin', label: '本机', scopes: null, readOnly: false }),
      { type: 'local', label: '本机' },
    );
    const user = createUser({ username: 'opuser', password: 'Passw0rd!', role: 'editor' }, usersPath);
    assert.deepEqual(
      taskOperatorForPrincipal({
        kind: 'session', sessionId: 's', userId: user.id, username: user.username,
        role: 'editor', scopes: ['all'], readOnly: false,
      }),
      { type: 'user', label: 'opuser', userId: user.id },
    );
    assert.deepEqual(
      taskOperatorForPrincipal({ kind: 'token', tokenId: 'ab12cd34', scopes: ['all'], readOnly: false }),
      { type: 'token', label: 'Token ab12cd34', tokenId: 'ab12cd34' },
    );
  });

  it('登录限速：5 次失败后第 6 次拒绝，成功清除', () => {
    for (let i = 0; i < 5; i++) recordLoginFailure('8.8.8.8', 'alice');
    assert.equal(checkLoginRateLimit('8.8.8.8', 'alice').allowed, false);
    clearLoginFailures('8.8.8.8', 'alice');
    assert.equal(checkLoginRateLimit('8.8.8.8', 'alice').allowed, true);
  });
});
