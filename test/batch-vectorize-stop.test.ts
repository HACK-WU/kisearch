/**
 * batch-vectorize-stop.test.ts —— P0 输出治理：系统性停止后的「未处理清单」不得逐条展开
 *
 * 背景（2026-10-12 排查）：整库导入遇 provider 系统性故障（如 /embeddings 超时）时，
 * 原实现把**剩余每一个 chunk** 逐条 push 进 errors —— 1.5 万单元的库里就是 1.5 万条
 * 同因条目（`{path, error}`），CLI/HTTP 全量回吐后被读成"一直在超时 / 没有停止"。
 *
 * 契约（本套件固化）：
 *   1. errors 中「未处理」只留 **1 条汇总**（数量写在文案里），数量另由 `notProcessed` 承载；
 *   2. **真实尝试过并失败**的条目仍逐条保留（诊断价值，且 incomplete 清单靠 path 反查原因）；
 *   3. 停止后不再调用 bulkStore（break），后续批次不产生任何请求。
 *
 * 运行：npx jiti test/batch-vectorize-stop.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bulkVectorize } from '../src/lib/batch-vectorize.js';

const STOP_REASON = {
  kind: 'provider-unavailable',
  code: 'TIMEOUT',
  phase: 'embedding',
  reason: 'dashscope /embeddings timeout after 60000ms',
} as const;

function mkEntries(count: number): { path: string; text: string }[] {
  return Array.from({ length: count }, (_, i) => ({ path: `docs/doc-${String(i).padStart(4, '0')}.md#1`, text: `正文 ${i}` }));
}

/** 首批：2 条真实失败 + 198 条未尝试；返回 stopReason（模拟 engine 的 notProcessedIds 映射）。 */
function firstBatchWithStop(batchSize: number) {
  return {
    total: batchSize,
    succeeded: 0,
    failed: batchSize,
    notProcessed: batchSize - 2,
    stopReason: STOP_REASON,
    results: Array.from({ length: batchSize }, (_, i) => (i < 2
      ? { index: i, success: false, error: 'dashscope /embeddings HTTP 400: bad text' }
      : { index: i, success: false, notProcessed: true, error: STOP_REASON.reason })),
  };
}

describe('P0：系统性停止后的 errors 汇总（不再逐条展开）', () => {
  it('首批即系统性停止 → 只输出 1 条未处理汇总 + 2 条真实失败；后续批次零调用', async () => {
    let calls = 0;
    const result = await bulkVectorize(mkEntries(500) as never, 'scope-x', {}, {
      bulkStore: (async (params: { entries: unknown[] }) => {
        calls++;
        return firstBatchWithStop(params.entries.length) as never;
      }) as never,
    });

    assert.equal(calls, 1, '系统性停止后不得再提交后续批次');
    assert.equal(result.stopReason?.code, 'TIMEOUT');
    // 未处理 = 本批 198 + 其后 300 = 498
    assert.equal(result.notProcessed, 498);
    assert.equal(result.errors.length, 3, `errors 应只有 2 条真实失败 + 1 条汇总，实际 ${result.errors.length}`);

    const notProcessedErrors = result.errors.filter((e) => e.path === '<not-processed>');
    assert.equal(notProcessedErrors.length, 1, '未处理清单必须是 1 条汇总，不得逐条展开');
    assert.match(notProcessedErrors[0].error, /未处理 498 条/);
    assert.match(notProcessedErrors[0].error, /本批 198 \+ 其后 300/);
    assert.match(notProcessedErrors[0].error, /timeout after 60000ms/);

    const attemptedFailures = result.errors.filter((e) => e.path !== '<not-processed>');
    assert.equal(attemptedFailures.length, 2, '真实尝试失败的条目仍逐条保留（供诊断/incomplete 反查）');
    assert.ok(attemptedFailures.every((e) => e.path.startsWith('docs/doc-000')));
  });

  it('对照：无 stopReason 的普通失败不汇总（逐条保留），且跑完全部批次', async () => {
    let calls = 0;
    const result = await bulkVectorize(mkEntries(201) as never, 'scope-y', {}, {
      bulkStore: (async (params: { entries: unknown[] }) => {
        calls++;
        return {
          total: params.entries.length,
          succeeded: params.entries.length - 1,
          failed: 1,
          results: params.entries.map((_, i) => (i === 0
            ? { index: i, success: false, error: '单条坏文本' }
            : { index: i, success: true, memoryId: `m${calls}-${i}` })),
        } as never;
      }) as never,
    });

    assert.equal(calls, 2, '无系统性停止时跑满全部批次');
    assert.equal(result.errors.length, 2, '每批 1 条真实失败，逐条保留');
    assert.equal(result.stopReason, undefined);
    assert.equal(result.notProcessed, 0);
  });

  it('高频间歇失败（无 stopReason）下逐条明细也设上限：50 条 + 1 条汇总', async () => {
    let calls = 0;
    const result = await bulkVectorize(mkEntries(600) as never, 'scope-z', {}, {
      bulkStore: (async (params: { entries: unknown[] }) => {
        calls++;
        // provider 半挂：每批整批失败但不触发熔断（未达阈值）→ 600 条全部「尝试后失败」
        return {
          total: params.entries.length,
          succeeded: 0,
          failed: params.entries.length,
          results: params.entries.map((_, i) => ({ index: i, success: false, error: '批量 400：坏文本' })),
        } as never;
      }) as never,
    });

    assert.equal(calls, 3);
    assert.equal(result.errors.length, 51, '50 条逐条明细 + 1 条截断汇总');
    const truncated = result.errors.filter((e) => e.path === '<truncated>');
    assert.equal(truncated.length, 1);
    assert.match(truncated[0].error, /另有 550 条失败明细未逐条列出/);
  });
});
