/**
 * query-vector-precompute 单元测试（O3）
 *
 * 契约：
 *   - ALS 传递：上下文内命中向量/失败标记；无上下文/空 map 时行为与改动前一致（直通）
 *   - 并发隔离：不同请求的 ALS 上下文互不串扰
 *   - mapWithConcurrency：并发不超过上限、保持输入顺序
 *
 * 运行：npx jiti test/query-vector-precompute.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPrecomputedQueryVector,
  mapWithConcurrency,
  runWithPrecomputedQueryVectors,
} from '../src/lib/query-vector-precompute.js';
import { extractSearchQueryArgs } from '../src/lib/mcp-http.js';
import { isQueryEmbedDegradable } from '../src/lib/vector-client.js';

describe('query-vector-precompute · ALS 传递', () => {
  it('无上下文时返回 undefined（CLI / stdio 行为与改动前一致）', () => {
    assert.equal(getPrecomputedQueryVector('q'), undefined);
  });

  it('上下文内命中向量与失败标记', () => {
    const entries = new Map([
      ['q1', { kind: 'vector', vector: [1, 2, 3] }],
      ['q2', { kind: 'failed', reason: 'embedding timeout' }],
    ]);
    runWithPrecomputedQueryVectors(entries, () => {
      assert.deepEqual(getPrecomputedQueryVector('q1'), { kind: 'vector', vector: [1, 2, 3] });
      assert.deepEqual(getPrecomputedQueryVector('q2'), { kind: 'failed', reason: 'embedding timeout' });
      assert.equal(getPrecomputedQueryVector('q3'), undefined);
    });
  });

  it('空 map 直通且不建立上下文', () => {
    runWithPrecomputedQueryVectors(new Map(), () => {
      assert.equal(getPrecomputedQueryVector('q'), undefined);
    });
  });

  it('并发上下文相互隔离（跨 await 保持绑定）', async () => {
    const [a, b] = await Promise.all([
      runWithPrecomputedQueryVectors(new Map([['q', { kind: 'vector', vector: [1] }]]), async () => {
        await new Promise((r) => setTimeout(r, 20));
        return getPrecomputedQueryVector('q');
      }),
      runWithPrecomputedQueryVectors(new Map([['q', { kind: 'vector', vector: [2] }]]), async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getPrecomputedQueryVector('q');
      }),
    ]);
    assert.deepEqual(a, { kind: 'vector', vector: [1] });
    assert.deepEqual(b, { kind: 'vector', vector: [2] });
  });
});

describe('mapWithConcurrency', () => {
  it('并发不超过上限且保持输入顺序', async () => {
    let active = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = await mapWithConcurrency(items, 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20 - n));
      active -= 1;
      return n * 2;
    });
    assert.deepEqual(out, items.map((n) => n * 2));
    assert.ok(peak <= 3, `并发峰值 ${peak} 应 ≤ 3`);
    assert.ok(peak >= 2, `并发峰值 ${peak} 应 ≥ 2（确实并行执行）`);
  });

  it('空数组返回空数组', async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  });

  it('上限大于条目数时按条目数执行', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([1, 2], 8, async (n) => {
      calls += 1;
      return n;
    });
    assert.deepEqual(out, [1, 2]);
    assert.equal(calls, 2);
  });
});

// ─── 耦合守卫：ki_search 工具参数契约 ───
// 预计算依赖「工具名 ki_search + 参数名 query/scope」，该契约定义在
// src/lib/mcp-tools/search.ts 的工具 schema。参数改名会让预计算静默失效（不报错、
// 只是失去优化），故在此断言，改名时测试会失败并指向本注释。
describe('extractSearchQueryArgs · 工具参数契约守卫', () => {
  const call = (name: string, args: unknown) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  it('提取 ki_search 的 query 与 scope（参数名契约）', () => {
    const out = extractSearchQueryArgs([call('ki_search', { query: '查询内容', scope: 'team-a,team-b' })]);
    assert.deepEqual(out, [{ query: '查询内容', rawScope: 'team-a,team-b' }]);
  });

  it('scope 缺省时返回空串（由调用方按 default 解析）', () => {
    assert.deepEqual(
      extractSearchQueryArgs([call('ki_search', { query: 'q' })]),
      [{ query: 'q', rawScope: '' }],
    );
  });

  it('非 ki_search 工具 / 空 query / 非字符串 query / 非 tools/call 一律跳过', () => {
    assert.deepEqual(
      extractSearchQueryArgs([
        call('ki_store', { query: 'x' }),
        call('ki_search', { query: '' }),
        call('ki_search', { query: 42 }),
        call('ki_search', {}),
        { jsonrpc: '2.0', id: 2, method: 'initialize' },
        null,
        'string',
      ]),
      [],
    );
  });

  it('batch 多消息按序提取', () => {
    const out = extractSearchQueryArgs([
      call('ki_search', { query: 'a', scope: 's1' }),
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      call('ki_search', { query: 'b' }),
    ]);
    assert.deepEqual(out.map((x) => x.query), ['a', 'b']);
  });
});

// ─── 降级判定契约（mcp-http 预计算与 vectorSearch 共用同一实现）───
describe('isQueryEmbedDegradable · 判定契约', () => {
  it('EmbeddingError 且 nonRetryable !== true → 可降级（超时/网络/429/5xx）', () => {
    const err = Object.assign(new Error('timeout after 2000ms'), {
      name: 'EmbeddingError',
      data: { nonRetryable: false },
    });
    assert.equal(isQueryEmbedDegradable(err), true);
  });

  it('EmbeddingError 且 nonRetryable === true → 不降级（4xx / 响应结构异常）', () => {
    const err = Object.assign(new Error('HTTP_401'), {
      name: 'EmbeddingError',
      data: { nonRetryable: true },
    });
    assert.equal(isQueryEmbedDegradable(err), false);
  });

  it('非 EmbeddingError（未知错误）→ 不降级（保守 fail-loud）', () => {
    assert.equal(isQueryEmbedDegradable(new Error('boom')), false);
    assert.equal(isQueryEmbedDegradable(undefined), false);
    assert.equal(isQueryEmbedDegradable('str'), false);
  });
});
