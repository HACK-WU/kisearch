/**
 * governance-view-events.test.ts —— 事件页视图只读合并（REQ-20261120-001 · S-05 二期）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/governance-view-events.test.ts
 *
 * 三个必须钉死的点：
 *   ① 列表跨库合并后每条带 `scope`（详情/写操作都靠它定位）；
 *   ② 详情用 `evt_…` 在成员库中定位，响应 `scope` 回填**事件所属库**；
 *   ③ `#N` 在视图下必须 400 —— 各库独立计数，猜库 = 静默串数据。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope } from '../src/lib/store.js';
import { getKbDir } from '../src/lib/scope.js';
import { loadConfig } from '../src/lib/config.js';
import { createView, deleteView } from '../src/lib/scope-view.js';
import { createEventWithBinding } from '../src/lib/events/event-service.js';
import { handleGovernanceRoutes } from '../src/lib/governance-http.js';

const stamp = Date.now();
const A = `ev-a-${stamp}`;
const B = `ev-b-${stamp}`;
const VIEW = `ev-view-${stamp}`;

/** 两库各自分配 shortId，都会拿到 1 —— 这正是「#N 跨库有歧义」的真实来源 */
let eventAId = '';
let eventBId = '';

after(() => {
  try { deleteView(loadConfig(), VIEW); } catch { /* 可能没建成功 */ }
  for (const s of [A, B]) {
    const dir = getKbDir(s);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  cleanupTestConfig();
});

async function startServer(authScopes: string[] | null): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handleGovernanceRoutes(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), { authScopes })
      .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function getJson(base: string, p: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('事件页视图只读合并', { timeout: 120_000 }, () => {
  let base = '';
  let close = (): Promise<void> => Promise.resolve();

  it('准备：两库各一条事件（shortId 都是 1，验证跨库歧义真实存在）+ 视图', async () => {
    for (const s of [A, B]) {
      registerTestScope(s);
      initScope(s);
    }
    const a = await createEventWithBinding(A, { title: 'A 库事件', typeId: 'et_1', by: 'user' });
    const b = await createEventWithBinding(B, { title: 'B 库事件', typeId: 'et_1', by: 'user' });
    eventAId = a.event.id;
    eventBId = b.event.id;
    assert.equal(a.event.shortId, 1, 'A 库首个事件 shortId=1');
    assert.equal(b.event.shortId, 1, 'B 库首个事件 shortId 也是 1 —— 跨库必然撞号');
    createView(loadConfig(), VIEW, [A, B]);
    const started = await startServer(null);
    base = started.base;
    close = started.close;
  });

  it('单库列表：语义不变（无 view 字段），条目新增 scope', async () => {
    const { status, body } = await getJson(base, `/api/governance/events?scope=${A}&status=all`);
    assert.equal(status, 200);
    assert.equal(body.view, undefined);
    assert.equal(body.total, 1);
    const events = body.events as Array<Record<string, unknown>>;
    assert.equal(events[0].scope, A);
    assert.equal(events[0].id, eventAId);
  });

  it('视图列表：两库合并、total 为和、每条带 scope', async () => {
    const { status, body } = await getJson(base, `/api/governance/events?scope=${VIEW}&status=all`);
    assert.equal(status, 200);
    assert.equal(body.view, VIEW);
    assert.equal(body.total, 2);
    const events = body.events as Array<Record<string, unknown>>;
    assert.deepEqual(events.map((e) => e.scope).sort(), [A, B].sort());
    // updatedAt 降序：B 更新，应排在前面
    assert.equal(events[0].scope, B);
  });


  it('视图列表：type 筛选带库前缀，只出该库的事件', async () => {
    const { body } = await getJson(base, `/api/governance/events?scope=${VIEW}&status=all&type=${A}:et_1`);
    assert.equal(body.total, 1);
    const events = body.events as Array<Record<string, unknown>>;
    assert.equal(events[0].scope, A);
  });

  it('视图详情：evt_ id 跨库定位，响应 scope 回填事件所属库', async () => {
    const { status, body } = await getJson(base, `/api/governance/events/${eventBId}?scope=${VIEW}`);
    assert.equal(status, 200);
    assert.equal(body.scope, B, 'scope 必须是事件所属库，不能是视图名');
    assert.equal(body.view, VIEW);
    const event = body.event as Record<string, unknown>;
    assert.equal(event.id, eventBId);
  });

  it('视图详情：#N 必须 400（各库独立编号，跨库歧义）', async () => {
    const { status, body } = await getJson(base, `/api/governance/events/%231?scope=${VIEW}`);
    assert.equal(status, 400);
    assert.equal(body.code, 'EVENT_SCOPE_REQUIRED');
  });

  it('视图类型：逐库合并，每条带 scope 与 typeKey', async () => {
    const { status, body } = await getJson(base, `/api/governance/event-types?scope=${VIEW}`);
    assert.equal(status, 200);
    assert.equal(body.view, VIEW);
    const types = body.types as Array<Record<string, unknown>>;
    assert.equal(types.length, 6, '两库各 3 个内置类型');
    for (const t of types) {
      assert.match(String(t.typeKey), new RegExp(`^(${A}|${B}):et_\\d+$`));
      assert.ok(t.scope === A || t.scope === B);
    }
  });

  it('单库类型：语义不变（无 view 字段，无 typeKey）', async () => {
    const { body } = await getJson(base, `/api/governance/event-types?scope=${A}`);
    assert.equal(body.view, undefined);
    const types = body.types as Array<Record<string, unknown>>;
    assert.equal(types.length, 3);
    assert.equal(types[0].typeKey, undefined);
  });

  it('视图下创建事件 → 409 VIEW_NOT_WRITABLE', async () => {
    const res = await fetch(`${base}/api/governance/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: VIEW, title: '不该建出来', typeId: 'et_1' }),
    });
    assert.equal(res.status, 409);
    const body = await res.json() as { code?: string };
    assert.equal(body.code, 'VIEW_NOT_WRITABLE');
  });

  it('视图列表：某库条数超过 limit 时 hasMore 必须为 true', async () => {
    /*
     * 放在最后：要给 A 库补两条事件，会改变前面用例的 total 断言。
     * 只查 A 库 + limit=1 → 修复前按 merged.length 判断会误报 hasMore=false。
     */
    await createEventWithBinding(A, { title: 'A 库事件 2', typeId: 'et_1', by: 'user' });
    await createEventWithBinding(A, { title: 'A 库事件 3', typeId: 'et_1', by: 'user' });
    const one = await getJson(base, `/api/governance/events?scope=${VIEW}&status=all&limit=1&type=${A}:et_1`);
    assert.equal(one.body.total, 3);
    assert.equal((one.body.events as unknown[]).length, 1);
    assert.equal(one.body.hasMore, true, '还有 2 条未取回，不能报「没有更多」');
  });

  it('关闭共享 server', async () => {
    await close();
  });
});
