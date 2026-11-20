/**
 * governance-view.test.ts —— 治理读路径的视图聚合（REQ-20261120-001 · S-01 / S-02）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/governance-view.test.ts
 *
 * 覆盖三件容易静默坏掉的事：
 *   ① 单库响应必须保持原样（只新增字段）——否则浏览/分类页会因契约变化集体回归；
 *   ② 视图下 total / lifecycleCounts 必须是**各成员库之和**，且每条带 scope；
 *   ③ 鉴权必须「视图名 ∧ 全部成员」全有或全无（只比名字 = 越权）。
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
import { executeSyncRelation } from '../src/sync-relation.js';
import { handleGovernanceRoutes } from '../src/lib/governance-http.js';

const stamp = Date.now();
const A = `gv-a-${stamp}`;
const B = `gv-b-${stamp}`;
const VIEW = `gv-view-${stamp}`;

after(() => {
  try { deleteView(loadConfig(), VIEW); } catch { /* 视图可能没建成功 */ }
  for (const s of [A, B]) {
    const dir = getKbDir(s);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  cleanupTestConfig();
});

async function startServer(authScopes: string[] | null): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handleGovernanceRoutes(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), { authScopes })
      .then((handled) => {
        if (!handled) { res.writeHead(404); res.end(); }
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function getJson(base: string, p: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function sendJson(
  base: string,
  p: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('治理页视图聚合', { timeout: 120_000 }, () => {
  let base = '';
  let close = (): Promise<void> => Promise.resolve();

  it('准备：两个库各一篇文档 + 一个含两成员的视图', async () => {
    for (const s of [A, B]) {
      registerTestScope(s);
      initScope(s);
    }
    const a = await executeSyncRelation({ scope: A, group: '运维', relation: 'A 文档', moduleInfo: '# A', vector: false });
    const b = await executeSyncRelation({ scope: B, group: '运维', relation: 'B 文档', moduleInfo: '# B', vector: false });
    assert.equal(a.ok, true, `写 A 失败：${a.ok ? '' : a.error}`);
    assert.equal(b.ok, true, `写 B 失败：${b.ok ? '' : b.error}`);
    createView(loadConfig(), VIEW, [A, B]);

    const started = await startServer(null);
    base = started.base;
    close = started.close;
  });

  it('单库 /docs：响应语义不变，条目带 scope，带 lifecycleCounts', async () => {
    const { status, body } = await getJson(base, `/api/governance/docs?scope=${A}`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.scope, A);
    assert.equal(body.view, undefined, '单库响应不得出现 view');
    assert.equal(body.total, 1);
    const items = body.items as Array<Record<string, unknown>>;
    assert.equal(items[0].scope, A);
    assert.equal(items[0].group, '运维');
    assert.equal(items[0].name, 'A 文档');
    const counts = body.lifecycleCounts as Record<string, number>;
    assert.equal(counts.all, 1);
    assert.equal(counts.wiki, 1, '缺省分类应是 wiki');
  });

  it('视图 /docs：total = 各库之和，members / buckets / 条目 scope 齐全', async () => {
    const { status, body } = await getJson(base, `/api/governance/docs?scope=${VIEW}`);
    assert.equal(status, 200);
    assert.equal(body.view, VIEW);
    assert.deepEqual(body.members, [A, B]);
    assert.equal(body.total, 2);
    const items = body.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.scope), [A, B], '条目顺序按成员库顺序，不跨库重排');
    const buckets = body.buckets as Array<{ scope: string; total: number }>;
    assert.deepEqual(buckets.map((b) => [b.scope, b.total]), [[A, 1], [B, 1]]);
    const counts = body.lifecycleCounts as Record<string, number>;
    assert.equal(counts.all, 2);
  });

  it('视图 /docs：limit 很小时两个成员库仍各有条目（不被第一库挤空）', async () => {
    const { body } = await getJson(base, `/api/governance/docs?scope=${VIEW}&limit=1`);
    const items = body.items as Array<Record<string, unknown>>;
    // 真机回归点：按总条数切片会让第一库吃满 limit，后置库一条都看不到
    assert.deepEqual(items.map((i) => i.scope), [A, B], '每库各取 limit 条，两个库都必须可见');
    assert.equal(body.total, 2);
  });

  it('视图 /docs：关键字过滤与 total / lifecycleCounts 同集合', async () => {
    const { body } = await getJson(base, `/api/governance/docs?scope=${VIEW}&q=A`);
    assert.equal(body.total, 1, '搜索后 total 必须是过滤后的数');
    const counts = body.lifecycleCounts as Record<string, number>;
    assert.equal(counts.all, 1, 'tab 计数必须随搜索变化（与改造前前端行为一致）');
  });

  it('视图 /counts：五项均为各库之和', async () => {
    const { status, body } = await getJson(base, `/api/governance/counts?scope=${VIEW}`);
    assert.equal(status, 200);
    assert.equal(body.view, VIEW);
    assert.equal(body.docs, 2);
    assert.equal(body.trash, 0);
    assert.equal(Array.isArray(body.buckets), true);
  });

  it('单库 /counts：与改造前字段一致（无 view）', async () => {
    const { body } = await getJson(base, `/api/governance/counts?scope=${A}`);
    assert.equal(body.view, undefined);
    assert.equal(body.scope, A);
    assert.equal(body.docs, 1);
    assert.equal(typeof body.pendingIndex, 'number');
  });

  it('视图 /trash：合并条目 + settingsByScope，且不返回单一 settings', async () => {
    const { status, body } = await getJson(base, `/api/governance/trash?scope=${VIEW}`);
    assert.equal(status, 200);
    assert.equal(body.view, VIEW);
    assert.equal(body.total, 0);
    assert.equal(body.settings, undefined, '视图下不得给单一 settings（各库可能不同）');
    const byScope = body.settingsByScope as Array<{ scope: string }>;
    assert.deepEqual(byScope.map((s) => s.scope), [A, B]);
  });

  it('视图 /docs/search：逐库命中合并，每条带 scope', async () => {
    const { status, body } = await getJson(base, `/api/governance/docs/search?scope=${VIEW}&q=文档`);
    assert.equal(status, 200);
    assert.equal(body.view, VIEW);
    const hits = body.hits as Array<Record<string, unknown>>;
    assert.equal(hits.length, 2, '两个成员库各命中一篇');
    assert.deepEqual(hits.map((h) => h.scope).sort(), [A, B].sort());
    const buckets = body.buckets as Array<{ scope: string; total: number }>;
    assert.deepEqual(buckets.map((b) => b.total), [1, 1]);
  });

  it('视图 /diagnostics：合并 pending / failures / trash 并给分桶', async () => {
    const { status, body } = await getJson(base, `/api/governance/diagnostics?scope=${VIEW}`);
    assert.equal(status, 200);
    assert.equal(body.view, VIEW);
    assert.equal(typeof (body.pending as { count: number }).count, 'number');
    assert.equal((body.trash as { total: number }).total, 0);
    assert.equal((body.failures as { items: unknown[] }).items.length, 0);
    assert.equal((body.buckets as unknown[]).length, 2);
  });

  it('多段 scope → 400 SCOPE_MULTI_UNSUPPORTED', async () => {
    const { status, body } = await getJson(base, `/api/governance/docs?scope=${A},${B}`);
    assert.equal(status, 400);
    assert.equal(body.code, 'SCOPE_MULTI_UNSUPPORTED');
  });

  it('不存在的名字按普通库处理（空列表，不报错）', async () => {
    const { status, body } = await getJson(base, `/api/governance/docs?scope=no-such-scope-${stamp}`);
    assert.equal(status, 200);
    assert.equal(body.total, 0);
  });

  it('鉴权：只授权视图名、未授权成员 → 403 且列出缺失成员', async () => {
    const auth = await startServer([VIEW]);
    try {
      const { status, body } = await getJson(auth.base, `/api/governance/docs?scope=${VIEW}`);
      assert.equal(status, 403);
      assert.equal(body.code, 'FORBIDDEN_SCOPE');
      const details = body.details as { missingViewMembers?: string[] };
      assert.deepEqual(details.missingViewMembers, [A, B]);
    } finally {
      await auth.close();
    }
  });

  /**
   * S-03：视图下的写请求必须 409 `VIEW_NOT_WRITABLE`，且**不得建出视图名目录**。
   * 两个裸写端点（presets / trash-settings）此前不经写锁，会直接落到 walWrite → mkdir。
   */
  it('视图写门禁：presets / trash-settings / restore / purge / apply 全 409', async () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['POST', '/api/governance/lifecycle/presets', { scope: VIEW, name: 'x', kind: 'temp', ttlDays: 7 }],
      // DELETE 的 scope 走 query（该 handler 只读 query，不放 body）
      ['DELETE', `/api/governance/lifecycle/presets/preset_x?scope=${VIEW}`, {}],
      ['PUT', '/api/governance/trash/settings', { scope: VIEW, keepDays: 7, expireAction: 'purge' }],
      ['POST', '/api/governance/trash/restore', { scope: VIEW, group: '运维', dirName: 'x' }],
      ['POST', '/api/governance/trash/purge', { scope: VIEW, group: '运维', dirName: 'x' }],
      ['POST', '/api/governance/lifecycle/apply', { scope: VIEW, group: '运维', name: 'A 文档', lifecycle: 'wiki' }],
    ];
    for (const [method, p, payload] of cases) {
      const { status, body } = await sendJson(base, p, method, payload);
      assert.equal(status, 409, `${method} ${p} 应 409，实际 ${status}`);
      assert.equal(body.code, 'VIEW_NOT_WRITABLE', `${method} ${p} 错误码不符：${String(body.code)}`);
    }
    // 幽灵目录：视图名不得出现在 dataDir 下
    assert.equal(fs.existsSync(getKbDir(VIEW)), false, `视图名下不该建出目录：${getKbDir(VIEW)}`);
  });

  it('关闭共享 server', async () => {
    await close();
  });
});
