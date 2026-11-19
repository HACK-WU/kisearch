/**
 * open-api-events.test.ts —— `GET /open/v1/events`（事件状态查询，2026-11-19）
 *
 * 这个端点存在的唯一理由：`lifecycle=event` 上传前要能确认「这个事件存不存在、收没收口、
 * 当前阶段是什么」。没有它，客户端只能等 POST 返回 400 —— 而 httpflex 在 4xx 时会丢掉
 * 响应体，脚本连 `available` 都看不到，只能明确说一句"有几种可能"。
 *
 * 覆盖：
 *   A. 单个事件：`#N` 与 `evt_…` 两种写法都能查；回显标题/类型/阶段可见性/终态动作/收口状态
 *   B. 不存在 → 404 OPEN_API_EVENT_NOT_FOUND + available（只列未收口）
 *   C. 已收口事件照常返回（`closed: true`）—— 查询不替上传做判断，否则调用方分不清
 *      「不存在」与「收口了」
 *   D. 列表：status 过滤 / q 模糊 / limit 校验 / 默认只给未收口
 *   E. scope 越权 → 403 且响应脱敏
 *
 * 运行：npx jiti test/open-api-events.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

import { registerTestScope, cleanupTestConfig, testConfigPath } from './test-config.js';
import { handleOpenApiEvents } from '../src/lib/open-api/routes/events.js';
import { resetConfigCache } from '../src/lib/config.js';
import { ensureScopeDir } from '../src/lib/store.js';
import { allocateShortId, newEventId, writeEvent, writeTypesDoc } from '../src/lib/events/store.js';
import type { EventRecord, EventTypeRecord } from '../src/lib/events/types.js';

const scope = `openapi-events-${Date.now()}`;
registerTestScope(scope);
const rawConfig = JSON.parse(fs.readFileSync(testConfigPath, 'utf-8'));
rawConfig.scopes[scope] = {};
fs.writeFileSync(testConfigPath, JSON.stringify(rawConfig), 'utf-8');
resetConfigCache();
ensureScopeDir(scope);

function fakeRes(): { res: http.ServerResponse; state: { status: number; body: string } } {
  const state = { status: 0, body: '' };
  let ended = false;
  const res = {
    get writableEnded(): boolean { return ended; },
    writeHead(code: number): unknown { state.status = code; return res; },
    end(chunk?: string): void { if (chunk) state.body += chunk; ended = true; },
  };
  return { res: res as unknown as http.ServerResponse, state };
}

async function query(
  params: Record<string, string>,
  principal: { scopes: string[]; readOnly: boolean } = { scopes: [scope], readOnly: true },
): Promise<{ status: number; body: any }> {
  const { res, state } = fakeRes();
  const search = new URLSearchParams(params).toString();
  await handleOpenApiEvents({
    res,
    url: new URL(`http://127.0.0.1/open/v1/events${search ? `?${search}` : ''}`),
    principal,
  });
  return { status: state.status, body: JSON.parse(state.body || '{}') };
}

const typeId = 'et_events_test';
const trashTypeId = 'et_events_trash';
const typeRecord: EventTypeRecord = {
  id: typeId,
  scope,
  name: '查询测试类型',
  builtin: false,
  stages: [
    { key: 'st_1', name: '排查中', visibility: 'hidden' },
    { key: 'st_2', name: '已定位', visibility: 'fts-only' },
    { key: 'st_3', name: '已关闭', visibility: 'full' },
  ],
  terminalAction: 'keep',
  fallbackDays: 90,
  revision: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
// 两个类型一次写好：`trash` 是对外必须回显的一条信息（产物文档会被收口动作清掉）
writeTypesDoc(scope, {
  version: 1,
  revision: 1,
  types: [typeRecord, { ...typeRecord, id: trashTypeId, name: '性能优化', terminalAction: 'trash' }],
});

const base = { scope, typeId, revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
const openEvent: EventRecord = {
  ...base,
  id: newEventId(),
  shortId: allocateShortId(scope),
  title: '登录页白屏',
  stageKey: 'st_2',
  stageIndex: 1,
  closedAt: null,
};
const closedEvent: EventRecord = {
  ...base,
  id: newEventId(),
  shortId: allocateShortId(scope),
  title: '支付回调丢失',
  stageKey: 'st_3',
  stageIndex: 2,
  closedAt: Date.now(),
};
const trashEvent: EventRecord = {
  ...base,
  id: newEventId(),
  shortId: allocateShortId(scope),
  title: '列表首屏慢',
  typeId: trashTypeId,
  stageKey: 'st_1',
  stageIndex: 0,
  closedAt: null,
};
writeEvent(scope, openEvent);
writeEvent(scope, closedEvent);
writeEvent(scope, trashEvent);

after(() => {
  cleanupTestConfig();
});

describe('A. 单个事件：上传前预检要看到的字段', () => {
  it('`#N` 写法：回显标题 / 类型 / 阶段可见性 / 终态动作 / 未收口', async () => {
    const r = await query({ scope, event: `#${openEvent.shortId}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.event.id, openEvent.id);
    assert.equal(r.body.event.shortId, openEvent.shortId);
    assert.equal(r.body.event.title, '登录页白屏');
    assert.equal(r.body.event.typeName, '查询测试类型');
    assert.equal(r.body.event.terminalAction, 'keep');
    assert.deepEqual(r.body.event.stage, { key: 'st_2', name: '已定位', visibility: 'fts-only' });
    assert.equal(r.body.event.closed, false);
  });

  it('`evt_…` 写法与 `#N` 等价', async () => {
    const r = await query({ scope, event: openEvent.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.event.shortId, openEvent.shortId);
  });

  it('trash 类型回显 terminalAction=trash（产物文档会被收口动作清掉）', async () => {
    const r = await query({ scope, event: `#${trashEvent.shortId}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.event.terminalAction, 'trash');
    assert.equal(r.body.event.stage.visibility, 'hidden');
  });
});

describe('B. 不存在：404 + 可用事件清单', () => {
  it('`#999999` → OPEN_API_EVENT_NOT_FOUND 且 available 只列未收口', async () => {
    const r = await query({ scope, event: '#999999' });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'OPEN_API_EVENT_NOT_FOUND');
    assert.ok(Array.isArray(r.body.available));
    const ids = (r.body.available as Array<{ id: string }>).map((e) => e.id);
    assert.ok(ids.includes(openEvent.id), '未收口事件应在 available 里');
    assert.ok(!ids.includes(closedEvent.id), '已收口事件不该出现在 available 里');
  });

  it('available 至多 5 条（与上传链路同口径）', async () => {
    const r = await query({ scope, event: '#999999' });
    assert.ok((r.body.available as unknown[]).length <= 5);
  });
});

describe('C. 已收口事件照常返回（查询不替上传做判断）', () => {
  it('closed: true，且阶段可见性是终态的 full', async () => {
    const r = await query({ scope, event: `#${closedEvent.shortId}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.event.closed, true);
    assert.equal(r.body.event.stage.visibility, 'full');
  });
});

describe('D. 列表', () => {
  it('默认只给未收口（status 缺省 = open）', async () => {
    const r = await query({ scope });
    assert.equal(r.status, 200);
    const ids = (r.body.events as Array<{ id: string }>).map((e) => e.id);
    assert.ok(ids.includes(openEvent.id));
    assert.ok(!ids.includes(closedEvent.id));
  });

  it('status=all 含已收口', async () => {
    const r = await query({ scope, status: 'all' });
    const ids = (r.body.events as Array<{ id: string }>).map((e) => e.id);
    assert.ok(ids.includes(openEvent.id));
    assert.ok(ids.includes(closedEvent.id));
  });

  it('q 按标题模糊匹配', async () => {
    const r = await query({ scope, status: 'all', q: '支付回调' });
    const titles = (r.body.events as Array<{ title: string }>).map((e) => e.title);
    assert.deepEqual(titles, ['支付回调丢失']);
  });

  it('status 非法 → 400', async () => {
    const r = await query({ scope, status: 'done' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'OPEN_API_BAD_REQUEST');
  });

  it('limit 越界 / 非整数 → 400', async () => {
    for (const bad of ['0', '51', 'abc', '1.5']) {
      const r = await query({ scope, limit: bad });
      assert.equal(r.status, 400, `limit=${bad} 应被拒`);
      assert.equal(r.body.code, 'OPEN_API_BAD_REQUEST');
    }
  });
});

describe('E. scope 越权', () => {
  it('未授权的 scope → 403 且响应不回显库名', async () => {
    const r = await query({ scope: 'secret-kb', event: `#${openEvent.shortId}` }, { scopes: [scope], readOnly: false });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'OPEN_API_SCOPE_FORBIDDEN');
    assert.doesNotMatch(JSON.stringify(r.body), /secret-kb/);
  });
});
