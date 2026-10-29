/**
 * 总览「当前知识库」计数单测（2026-10-28）
 *
 * 锁住不变量：`/api/doc/list` 无 group 时按 500 截断，计数必须取响应里的完整口径
 * `total` / `groups`，**不得**用 `docs.length` 或由它去重得到的分组数。
 * 复现基线：ai-docs 实测 docs=500 / total=1882 / groups=634（列表去重只得 200 组）。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { scopeOverviewCounts } = await vite.ssrLoadModule('/src/lib/scopeCounts.ts');
after(async () => vite.close());

const doc = (group) => ({ group, name: `${group}-doc` });

describe('scopeOverviewCounts', () => {
  it('列表被截断时取 total / groups.length，而不是 docs.length 与列表去重', () => {
    const docs = Array.from({ length: 500 }, (_, i) => doc(`g${i % 200}`));
    const groups = Array.from({ length: 634 }, (_, i) => ({ name: `g${i}`, count: 1 }));
    assert.deepEqual(scopeOverviewCounts({ docs, total: 1882, groups }), {
      docTotal: 1882,
      groupCount: 634,
    });
  });

  it('列表完整时 total 与 docs.length 一致', () => {
    const docs = [doc('a'), doc('a'), doc('b')];
    const groups = [{ name: 'a', count: 2 }, { name: 'b', count: 1 }];
    assert.deepEqual(scopeOverviewCounts({ docs, total: 3, groups }), { docTotal: 3, groupCount: 2 });
  });

  it('旧 daemon 不返回 groups → 分组数回退到列表去重', () => {
    const docs = [doc('a'), doc('a'), doc('b')];
    assert.deepEqual(scopeOverviewCounts({ docs, total: 3 }), { docTotal: 3, groupCount: 2 });
  });

  it('total 缺失时回退到 docs.length（不产出 NaN）', () => {
    assert.deepEqual(scopeOverviewCounts({ docs: [doc('a'), doc('b')] }), { docTotal: 2, groupCount: 2 });
  });

  it('无数据 / 空 scope → 0 / 0', () => {
    assert.deepEqual(scopeOverviewCounts(undefined), { docTotal: 0, groupCount: 0 });
    assert.deepEqual(scopeOverviewCounts(null), { docTotal: 0, groupCount: 0 });
    assert.deepEqual(scopeOverviewCounts({ docs: [], total: 0, groups: [] }), { docTotal: 0, groupCount: 0 });
  });
});
