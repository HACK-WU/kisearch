/**
 * governance-ask-cancel-route.test.ts —— `POST /governance/events/:id/analysis/ask/cancel` 的路由语义
 * （2026-11-24 · 追问停止）
 *
 * 守的是**路由分发层**（`governance-http.ts`）：
 *   ① 没在跑 → 200 + `canceled:false`（幂等，按钮点两次不该报错）；
 *   ② 事件不存在 → 404 `EVENT_NOT_FOUND`（不能静默 200 假装停成功）。
 *
 * ⚠ 为什么这里**不**测「运行中 → canceled:true」：
 * 本仓用 jiti 跑 TS 测试时，测试文件（ESM 入口）与 `governance-http`（内部相对 import）
 * 拿到的 `analysis-ask-runner` 是**两个模块实例**，各自持有一份 `activeAsks` ——
 * 测试里起的那一轮，路由那边看不见（实测 canceled 恒为 false，但 activeIds 里确实有）。
 * 该串联（set → cancel → abort → 收口）由 `test/events/analysis-ask-cancel.test.ts`
 * 在同一实例内覆盖，两边合起来等价，不重复造 mock LLM 只为绕过测试运行器的限制。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope } from '../src/lib/store.js';
import { getKbDir } from '../src/lib/scope.js';
import { createEvent } from '../src/lib/events/event-service.js';
import { writeDraftStart } from '../src/lib/events/analysis-store.js';
import { handleGovernanceRoutes } from '../src/lib/governance-http.js';

const scope = `gov-ask-cancel-${Date.now()}`;

before(() => {
  registerTestScope(scope);
  initScope(scope);
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

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

function mkRes(): { res: ServerResponse; status: () => number; json: () => Record<string, unknown> } {
  const chunks: string[] = [];
  let status = 0;
  const res = {
    writeHead: (code: number) => { status = code; return res; },
    end: (b?: string) => { if (b) chunks.push(b); },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    json: () => JSON.parse(chunks[chunks.length - 1] ?? '{}') as Record<string, unknown>,
  };
}

async function call(method: string, url: string, payload?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { res, status, json } = mkRes();
  const handled = await handleGovernanceRoutes(mkReq(method, payload), res, new URL(url, 'http://localhost'), {
    authScopes: null,
  });
  assert.notEqual(handled, false, `路由未命中：${method} ${url}`);
  return { status: status(), body: json() };
}

async function seedDraft(eventId: string): Promise<void> {
  await writeDraftStart(scope, eventId, {
    runId: 'run_route',
    status: 'ready',
    targetDir: '/tmp',
    commit: null,
    conclusion: '结论',
    candidates: [],
    unconfirmed: [],
    steps: [],
    stats: { turns: 0, filesRead: 0, tokens: 0, ms: 0 },
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

describe('停止追问路由', () => {
  it('① 没在跑 → 200 + canceled:false（幂等）', async () => {
    const ev = await createEvent(scope, { title: '空停路由', typeId: 'et_1' });
    await seedDraft(ev.id);
    const r = await call('POST', `/governance/events/${ev.id}/analysis/ask/cancel`, { scope });
    assert.equal(r.status, 200);
    assert.equal(r.body.canceled, false);
  });

  it('② 事件不存在 → 404（不能假装停成功）', async () => {
    const r = await call('POST', '/governance/events/evt_missing/analysis/ask/cancel', { scope });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'EVENT_NOT_FOUND');
  });


});
