/**
 * web-session-store.test.ts —— Web 会话生命周期（REQ-20261103-001 · S-02）
 *
 * 运行：npx jiti test/web-session-store.test.ts
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSessions,
  createSession,
  deleteSession,
  deleteUserSessions,
  getSession,
  sessionCount,
} from '../src/lib/web-session-store.js';

beforeEach(() => clearSessions());
after(() => clearSessions());

describe('web-session-store', () => {
  it('创建 / 读取 / 删除', () => {
    const s = createSession('u1', '2026-11-03T00:00:00.000Z');
    assert.ok(getSession(s.id));
    assert.equal(getSession(s.id)?.userId, 'u1');
    deleteSession(s.id);
    assert.equal(getSession(s.id), undefined);
    assert.equal(sessionCount(), 0);
  });

  it('过期即失效', async () => {
    const s = createSession('u2', '2026-11-03T00:00:00.000Z', 1);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(getSession(s.id), undefined);
  });

  it('单用户最多 10 个会话，淘汰最旧', () => {
    const first = createSession('u3', '2026-11-03T00:00:00.000Z');
    for (let i = 0; i < 9; i++) createSession('u3', '2026-11-03T00:00:00.000Z');
    assert.equal(sessionCount(), 10);
    const extra = createSession('u3', '2026-11-03T00:00:00.000Z');
    assert.equal(sessionCount(), 10);
    assert.equal(getSession(first.id), undefined);
    assert.ok(getSession(extra.id));
  });

  it('删除某用户全部会话，可保留当前会话', () => {
    const a = createSession('u4', '2026-11-03T00:00:00.000Z');
    const b = createSession('u4', '2026-11-03T00:00:00.000Z');
    createSession('u5', '2026-11-03T00:00:00.000Z');
    const removed = deleteUserSessions('u4', a.id);
    assert.equal(removed, 1);
    assert.ok(getSession(a.id));
    assert.equal(getSession(b.id), undefined);
    assert.equal(sessionCount(), 2);
  });
});
