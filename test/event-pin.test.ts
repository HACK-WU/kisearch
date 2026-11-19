/**
 * event-pin.test.ts —— 事件置顶（2026-11-19）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/event-pin.test.ts
 *
 * 钉住四条语义：
 *   1. 只写 `pinnedAt`，**不动** `updatedAt` / `revision`（置顶是列表偏好，不是内容变更）；
 *   2. 幂等：重复置顶 / 重复取消都不报错；取消是**删字段**；
 *   3. `includePinned=true` 才免疫「状态 / 类型」筛选，默认不免疫（MCP 与脚本不受影响）；
 *   4. 关键词 `q` 任何情况下都不免疫。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope } from '../src/lib/store.js';
import { getKbDir } from '../src/lib/scope.js';
import { createEventWithBinding, listEvents, setEventPinned, transitionEvent } from '../src/lib/events/event-service.js';
import { isEventPinned, readAllEvents, findEventIn } from '../src/lib/events/store.js';
import { handleGovernanceRoutes } from '../src/lib/governance-http.js';

const scope = `event-pin-${Date.now()}`;

async function mkEvent(title: string, typeId = 'et_1'): Promise<string> {
  const outcome = await createEventWithBinding(scope, { title, typeId });
  return outcome.event.id;
}

/** 置顶时间是毫秒，连点两次必须能排出先后 → 每次置顶前让出一个 tick 以上 */
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

before(() => {
  registerTestScope(scope);
  initScope(scope);
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('① 落盘语义：只写 pinnedAt', () => {
  it('置顶后 pinnedAt 有值，updatedAt / revision 原样', async () => {
    const id = await mkEvent('会被置顶的事件');
    const before = findEventIn(readAllEvents(scope), id)!;
    const pinned = await setEventPinned(scope, id, true);

    assert.equal(isEventPinned(pinned), true);
    assert.equal(typeof pinned.pinnedAt, 'number');
    assert.equal(pinned.updatedAt, before.updatedAt, '置顶不得改动 updatedAt（否则「最近更新」排序会莫名变化）');
    assert.equal(pinned.revision, before.revision, '置顶不得 bump revision（否则正在编辑描述的人会撞 409）');

    const stored = findEventIn(readAllEvents(scope), id)!;
    assert.equal(isEventPinned(stored), true, '必须真的落盘，不能只改内存对象');
  });

  it('重复置顶幂等：pinnedAt 不变、不抛错', async () => {
    const id = await mkEvent('幂等置顶');
    const first = await setEventPinned(scope, id, true);
    await tick();
    const again = await setEventPinned(scope, id, true);
    assert.equal(again.pinnedAt, first.pinnedAt, '已在目标态时不应重写时间戳');
  });

  it('取消置顶 = 删字段（不是写 0 / false）', async () => {
    const id = await mkEvent('取消置顶');
    await setEventPinned(scope, id, true);
    const off = await setEventPinned(scope, id, false);
    assert.equal('pinnedAt' in off, false, '取消后不得残留 pinnedAt 键');
    assert.equal(isEventPinned(off), false);
    // 再取消一次也不报错
    await setEventPinned(scope, id, false);
  });

  it('事件不存在 → EVENT_NOT_FOUND', async () => {
    await assert.rejects(
      () => setEventPinned(scope, 'evt_not_exist', true),
      (err: { code?: string }) => err.code === 'EVENT_NOT_FOUND',
    );
  });
});

describe('② 列表：置顶免疫状态 / 类型筛选，不免疫关键词', () => {
  /** 本组专用的干净 scope，避免与 ① 的事件互相干扰 */
  const listScope = `${scope}-list`;
  let openId = '';
  let closedId = '';
  let otherTypeId = '';

  before(async () => {
    registerTestScope(listScope);
    initScope(listScope);
    const open = await createEventWithBinding(listScope, { title: '排查中（会被置顶）', typeId: 'et_1' });
    const closed = await createEventWithBinding(listScope, { title: '已关闭的事件', typeId: 'et_1' });
    const other = await createEventWithBinding(listScope, { title: '另一个类型', typeId: 'et_2' });
    openId = open.event.id;
    closedId = closed.event.id;
    otherTypeId = other.event.id;

    // et_1 的末位 stage = st_4（已关闭）→ 收口
    await transitionEvent(listScope, { event: closedId, stage: 'st_4', by: 'user' });
    await setEventPinned(listScope, openId, true);
  });

  after(() => {
    const kbDir = getKbDir(listScope);
    if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  });

  const ids = (r: ReturnType<typeof listEvents>): string[] => r.items.map((i) => i.event.id);

  it('默认（includePinned 缺省）不免疫：查已收口看不到未收口的置顶项', () => {
    const r = listEvents(listScope, { status: 'closed' });
    assert.deepEqual(ids(r), [closedId]);
  });

  it('includePinned=true → 状态筛选免疫，且置顶项排第一', () => {
    const r = listEvents(listScope, { status: 'closed', includePinned: true });
    assert.deepEqual(ids(r), [openId, closedId], '置顶的未收口事件必须出现在「已收口」结果里且在最前');
  });

  it('includePinned=true → 类型筛选同样免疫', () => {
    const r = listEvents(listScope, { status: 'open', typeId: 'et_2', includePinned: true });
    assert.ok(ids(r).includes(openId), '置顶的是 et_1，也应出现在 et_2 的筛选结果里');
    assert.ok(ids(r).includes(otherTypeId));
    assert.equal(ids(r)[0], openId, '置顶项仍在最前');
  });

  it('关键词搜索不免疫：q 不匹配时置顶项也不出现', () => {
    const r = listEvents(listScope, { status: 'all', q: '另一个类型', includePinned: true });
    assert.deepEqual(ids(r), [otherTypeId], '搜索是主动找特定事件，置顶项不能硬塞进来');
  });

  it('置顶区内按「最近置顶在上」；普通区仍按 updatedAt 降序', async () => {
    await tick(10);
    await setEventPinned(listScope, otherTypeId, true);
    const r = listEvents(listScope, { status: 'all', includePinned: true });
    const list = ids(r);
    assert.deepEqual(list.slice(0, 2), [otherTypeId, openId], '后置顶的排在前面');
    assert.equal(list[2], closedId, '普通区只剩未置顶项');
  });
});

describe('③ HTTP 路由（handler 真跑一次）', () => {
  const httpScope = `${scope}-http`;

  async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      void handleGovernanceRoutes(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), { authScopes: null })
        .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  before(() => {
    registerTestScope(httpScope);
    initScope(httpScope);
  });

  after(() => {
    const kbDir = getKbDir(httpScope);
    if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  });

  it('POST /pin → 200 + hint；GET 列表带 includePinned=1 可见', { timeout: 10_000 }, async () => {
    const created = await createEventWithBinding(httpScope, { title: 'HTTP 置顶', typeId: 'et_1' });
    const { base, close } = await startServer();
    try {
      const res = await fetch(`${base}/api/governance/events/${created.event.id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: httpScope, pinned: true }),
      });
      assert.equal(res.status, 200);
      const payload = await res.json() as { ok: boolean; pinned: boolean; hint: string; event: { pinnedAt?: number } };
      assert.equal(payload.ok, true);
      assert.equal(payload.pinned, true);
      assert.equal(typeof payload.event.pinnedAt, 'number');
      assert.match(payload.hint, /置顶/);

      // 未收口的事实在「已收口」筛选下仍出现（Web 端就是这么取的）
      const listRes = await fetch(`${base}/api/governance/events?scope=${httpScope}&status=closed&includePinned=1`);
      const list = await listRes.json() as { events: Array<{ id: string }> };
      assert.deepEqual(list.events.map((e) => e.id), [created.event.id]);

      // 默认（不带 includePinned）仍严格过滤
      const strict = await fetch(`${base}/api/governance/events?scope=${httpScope}&status=closed`);
      const strictList = await strict.json() as { events: Array<{ id: string }> };
      assert.deepEqual(strictList.events, []);
    } finally {
      await close();
    }
  });

  it('POST /pin 传 pinned=false → 取消置顶', { timeout: 10_000 }, async () => {
    const created = await createEventWithBinding(httpScope, { title: 'HTTP 取消置顶', typeId: 'et_1' });
    const { base, close } = await startServer();
    try {
      await fetch(`${base}/api/governance/events/${created.event.id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: httpScope, pinned: true }),
      });
      const res = await fetch(`${base}/api/governance/events/${created.event.id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: httpScope, pinned: false }),
      });
      const payload = await res.json() as { pinned: boolean; event: { pinnedAt?: number } };
      assert.equal(payload.pinned, false);
      assert.equal(payload.event.pinnedAt, undefined);
    } finally {
      await close();
    }
  });
});
