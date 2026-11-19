/**
 * governance-refs-route.test.ts —— `/governance/events/:id/refs/search` 与 `/governance/docs/search` 的路由语义
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/governance-refs-route.test.ts
 *
 * 守的是**路由分发层**（`governance-http.ts`），不是检索实现：
 *   ① `refs/search` 已收窄为「只出 AI 候选」，带 `query` 必须显式 400 + 可操作提示，
 *      不允许静默忽略（旧前端会拿到空 hits 而不知道该怎么改）；
 *   ② `docs/search?eventId=` 的排除发生在服务端（R31），前端只负责禁用态；
 *   ③ 非 `/governance/*` 路径必须返回 false，不能吃掉上层路由。
 *
 * 不覆盖：真实语义检索（需要 embedding / 向量库），由 `refs-sr05-search.test.ts` 用注入 fake 守管线。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope, readJson, writeJson } from '../src/lib/store.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { loadGroupCache, writeGroupCache } from '../src/lib/group-cache.js';
import { createEvent } from '../src/lib/events/event-service.js';
import { addRefs } from '../src/lib/events/refs-service.js';
import { getRefsPath } from '../src/lib/events/refs-store.js';
import { handleGovernanceRoutes } from '../src/lib/governance-http.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `gov-refs-route-${Date.now()}`;
const GROUP = '错误库/Web前端界面';

/** 最小请求桩：`readJsonBody` 只监听 data / end / error */
function mkReq(method: string, payload?: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = method;
  const raw = payload === undefined ? '' : JSON.stringify(payload);
  setImmediate(() => {
    if (raw) req.emit('data', raw);
    req.emit('end');
  });
  return req;
}

/** 最小响应桩：只实现 writeHead / end，取最后一次 end 的 body */
function mkRes(): { res: ServerResponse; json: () => Record<string, unknown> } {
  const chunks: string[] = [];
  const res = {
    writeHead: () => res,
    end: (b?: string) => { if (b) chunks.push(b); },
  } as unknown as ServerResponse;
  return {
    res,
    json: () => JSON.parse(chunks[chunks.length - 1] ?? '{}') as Record<string, unknown>,
  };
}

async function call(method: string, url: string, payload?: unknown): Promise<Record<string, unknown> | false> {
  const { res, json } = mkRes();
  const handled = await handleGovernanceRoutes(
    mkReq(method, payload),
    res,
    new URL(url, 'http://localhost'),
    { authScopes: null },
  );
  return handled ? json() : false;
}

function seed(name: string): void {
  const rel: Relation = {
    id: `rel_${name.replace(/\W/g, '')}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
  };
  const doc = loadGroupCache(scope, GROUP) ?? { version: 1, scope, hot_relations: [], keywords: [], updatedAt: null };
  doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
  doc.hot_relations.push(rel);
  writeGroupCache(scope, GROUP, doc);

  const kbDir = getLocalKbDir(scope, GROUP);
  fs.mkdirSync(kbDir, { recursive: true });
  const kbPath = path.join(kbDir, 'index.json');
  const kb = readJson<Record<string, string>>(kbPath) ?? {};
  kb[name] = `# ${name}`;
  writeJson(kbPath, kb);
}

before(() => {
  registerTestScope(scope);
  initScope(scope);
  seed('路由搜索目标甲');
  seed('路由搜索目标乙');
  seed('路由搜索目标丙');
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('① refs/search 只出 AI 候选', () => {
  it('带 query → 400 REF_SEARCH_QUERY_UNSUPPORTED，并给出正确去处', async () => {
    const body = await call('POST', '/api/governance/events/evt_any/refs/search', {
      scope,
      query: '登录页白屏',
    });
    assert.ok(body, '必须被本模块处理，不能落到上层 404');
    assert.equal(body.ok, false);
    assert.equal(body.code, 'REF_SEARCH_QUERY_UNSUPPORTED');
    assert.match(String(body.error), /docs\/search/);
  });
});

describe('② docs/search 的排除在服务端', () => {
  it('带 eventId 时排除已关联与已加入', async () => {
    const event = await createEvent(scope, {
      title: '路由排除验证',
      typeId: 'et_1',
      docs: [{ group: GROUP, name: '路由搜索目标甲' }],
    });
    addRefs(scope, event.id, { docs: [{ group: GROUP, name: '路由搜索目标乙' }], addedBy: 'manual' });

    const body = await call(
      'GET',
      `/api/governance/docs/search?scope=${encodeURIComponent(scope)}&q=${encodeURIComponent('路由搜索')}&eventId=${encodeURIComponent(event.id)}`,
    );
    assert.ok(body);
    const hits = body.hits as Array<{ name: string }>;
    const names = hits.map((h) => h.name);
    assert.equal(names.includes('路由搜索目标甲'), false, '已关联必须排除');
    assert.equal(names.includes('路由搜索目标乙'), false, '已加入必须排除');
    assert.ok(names.includes('路由搜索目标丙'));
  });
});

describe('③ 挂载点不越界', () => {
  it('非 /governance/* 返回 false（交回上层）', async () => {
    const handled = await call('GET', '/api/doc/list');
    assert.equal(handled, false);
  });
});

/**
 * 事件 #44：find-summary 曾不校验事件存在。
 *
 * 两个后果一起守：① 读侧把「事件不存在」伪装成 `lastFind: null`；② 写侧给任意 id
 * 落一个孤儿 `.refs.json`（事件列表里看不到，排查时会被当成真实事件）。
 */
describe('④ find-summary 必须绑定真实事件', () => {
  it('不存在的事件：GET / POST 都是 EVENT_NOT_FOUND，且不落盘', async () => {
    const get = await call(
      'GET',
      `/api/governance/events/evt_missing/refs/find-summary?scope=${encodeURIComponent(scope)}`,
    );
    assert.ok(get);
    assert.equal(get.ok, false);
    assert.equal(get.code, 'EVENT_NOT_FOUND');

    const post = await call('POST', '/api/governance/events/evt_missing/refs/find-summary', {
      scope,
      summary: '不存在的事件不该落盘',
    });
    assert.ok(post);
    assert.equal(post.code, 'EVENT_NOT_FOUND');
    assert.equal(fs.existsSync(getRefsPath(scope, 'evt_missing')), false, '校验必须前置到写盘之前');
  });

  it('真实事件：summary + uncertainties 原样往返', async () => {
    const event = await createEvent(scope, { title: 'find-summary 往返验证', typeId: 'et_1' });
    const summary = '查了 3 个组没有命中，返回空数组。';
    const uncertainties = ['事件坐标系不明，无法判断 12px 偏移是否可复现'];

    const post = await call('POST', `/api/governance/events/${event.id}/refs/find-summary`, {
      scope,
      summary,
      uncertainties,
    });
    assert.ok(post);
    assert.equal(post.ok, true);

    const get = await call(
      'GET',
      `/api/governance/events/${event.id}/refs/find-summary?scope=${encodeURIComponent(scope)}`,
    );
    assert.ok(get);
    const last = get.lastFind as { summary: string; uncertainties?: string[] } | null;
    assert.equal(last?.summary, summary);
    assert.deepEqual(last?.uncertainties, uncertainties, '判断不了的点必须与面板看到的一致');
  });
});
