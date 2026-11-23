/**
 * governance-analysis-edit-route.test.ts —— `PATCH /governance/events/:id/analysis` 的路由语义
 * （REQ-20261123-001 · S01 批 2/4）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/governance-analysis-edit-route.test.ts
 *
 * 守的是**路由分发层**（`governance-http.ts`），不是校验实现（那份由 `analysis-edit.test.ts`
 * 与 `analysis-save-edits.test.ts` 覆盖）：
 *   ① 缺省字段 = 不改：只传 `conclusion` 时其余块原样保留；
 *   ② `conclusion: null` / `chain: []` 是"人工清空"，不能被当成"没传"；
 *   ③ 校验失败 / 冲突 / 事件不存在分别落 400 / 409 / 404，且错误码可判别；
 *   ④ scope 不在 token 范围内 → 403（越权不泄露资源是否存在）。
 *
 * 不覆盖：手工新增位置的验真（要配真实代码目录，由 `analysis-save-edits.test.ts` 注入配置覆盖）。
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
import { readAnalysisDocRaw, writeDraftStart } from '../src/lib/events/analysis-store.js';
import { handleGovernanceRoutes } from '../src/lib/governance-http.js';

const scope = `gov-ana-edit-${Date.now()}`;

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

async function call(
  method: string,
  url: string,
  payload?: unknown,
  authScopes: string[] | null = null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { res, status, json } = mkRes();
  const handled = await handleGovernanceRoutes(
    mkReq(method, payload),
    res,
    new URL(url, 'http://localhost'),
    { authScopes },
  );
  assert.notEqual(handled, false, `路由未命中：${method} ${url}`);
  return { status: status(), body: json() };
}

async function seedDraft(): Promise<string> {
  const ev = await createEvent(scope, { title: `人工校正-${Math.random().toString(36).slice(2, 7)}`, typeId: 'et_1' });
  await writeDraftStart(scope, ev.id, {
    runId: 'run_route',
    status: 'ready',
    targetDir: '/tmp',
    commit: null,
    conclusion: '原结论',
    chain: [{ kind: 'symptom', text: '原现象' }],
    candidates: [],
    unconfirmed: ['原疑问'],
    steps: [],
    stats: { turns: 1, filesRead: 0, tokens: 0, ms: 0 },
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
  return ev.id;
}

before(() => {
  registerTestScope(scope);
  initScope(scope);
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('PATCH /analysis：基本语义', () => {
  it('① 只传 conclusion → 200，其余块保持原值，editedAt 出现', async () => {
    const id = await seedDraft();
    const { status, body } = await call('PATCH', `/governance/events/${id}/analysis`, {
      scope,
      expectedRunId: 'run_route',
      conclusion: '改后的结论',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const draft = body.draft as Record<string, unknown>;
    assert.equal(draft.conclusion, '改后的结论');
    assert.deepEqual(draft.chain, [{ kind: 'symptom', text: '原现象' }]);
    assert.deepEqual(draft.unconfirmed, ['原疑问']);
    assert.equal(typeof draft.editedAt, 'number');
    assert.equal(body.editedAt, draft.editedAt);
  });

  it('② conclusion=null + chain=[] 是"人工清空"：draft 不置 null', async () => {
    const id = await seedDraft();
    const { status, body } = await call('PATCH', `/governance/events/${id}/analysis`, {
      scope,
      conclusion: null,
      chain: [],
      unconfirmed: [],
    });
    assert.equal(status, 200);
    assert.notEqual(body.draft, null);
    const draft = body.draft as Record<string, unknown>;
    assert.equal(draft.conclusion, null);
    assert.deepEqual(draft.chain, []);
  });

  it('③ 空 patch（只带 scope）→ 200 且不产生 editedAt（不写盘）', async () => {
    const id = await seedDraft();
    const { status, body } = await call('PATCH', `/governance/events/${id}/analysis`, { scope });
    assert.equal(status, 200);
    const draft = body.draft as Record<string, unknown>;
    assert.equal(draft.editedAt, undefined);
    assert.equal(readAnalysisDocRaw(scope, id).draft?.editedAt, undefined);
  });

  it('④ GET /analysis 能读到 editedAt（读出口自动跟随）', async () => {
    const id = await seedDraft();
    await call('PATCH', `/governance/events/${id}/analysis`, { scope, conclusion: '读出口检查' });
    const { status, body } = await call('GET', `/governance/events/${id}/analysis?scope=${scope}`);
    assert.equal(status, 200);
    const draft = body.draft as Record<string, unknown>;
    assert.equal(draft.conclusion, '读出口检查');
    assert.equal(typeof draft.editedAt, 'number');
  });
});

describe('PATCH /analysis：错误语义', () => {
  it('⑤ 校验失败 → 400 ANALYSIS_EDIT_INVALID + details.errors', async () => {
    const id = await seedDraft();
    const { status, body } = await call('PATCH', `/governance/events/${id}/analysis`, {
      scope,
      chain: Array.from({ length: 6 }, (_, i) => ({ kind: 'symptom', text: `n${i}` })),
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'ANALYSIS_EDIT_INVALID');
    const details = body.details as { errors: Array<{ field: string }> };
    assert.equal(details.errors[0]!.field, 'chain');
  });

  it('⑥ expectedRunId 不匹配 → 409 REVISION_CONFLICT', async () => {
    const id = await seedDraft();
    const { status, body } = await call('PATCH', `/governance/events/${id}/analysis`, {
      scope,
      expectedRunId: 'run_other',
      conclusion: 'x',
    });
    assert.equal(status, 409);
    assert.equal(body.code, 'REVISION_CONFLICT');
    assert.equal(readAnalysisDocRaw(scope, id).draft?.conclusion, '原结论');
  });

  it('⑦ 事件不存在 → 404 EVENT_NOT_FOUND', async () => {
    const { status, body } = await call('PATCH', '/governance/events/evt_nope/analysis', {
      scope,
      conclusion: 'x',
    });
    assert.equal(status, 404);
    assert.equal(body.code, 'EVENT_NOT_FOUND');
  });

  it('⑧ scope 越权 → 403 FORBIDDEN_SCOPE（不泄露事件是否存在）', async () => {
    const id = await seedDraft();
    const { status, body } = await call(
      'PATCH',
      `/governance/events/${id}/analysis`,
      { scope, conclusion: 'x' },
      ['some-other-scope'],
    );
    assert.equal(status, 403);
    assert.equal(body.code, 'FORBIDDEN_SCOPE');
  });
});
