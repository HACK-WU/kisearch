import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EmbeddingSchedulerRuntime,
  normalizeEmbeddingScheduler,
  type EmbeddingBatch,
} from '../src/zvec-engine/embedding/batch-scheduler.ts';
import type { EmbeddingProvider } from '../src/zvec-engine/embedding/provider.ts';

function fakeProvider(delay: (batch: number) => number, active: { value: number; peak: number }): EmbeddingProvider {
  let calls = 0;
  return {
    dimension: 2,
    async embed(texts) {
      const call = calls++;
      active.value++;
      active.peak = Math.max(active.peak, active.value);
      await new Promise((resolve) => setTimeout(resolve, delay(call)));
      active.value--;
      return texts.map((text) => [text.length, call]);
    },
  };
}

test('scheduler bounds provider concurrency and serializes persistence callback', async () => {
  const active = { value: 0, peak: 0 };
  const runtime = new EmbeddingSchedulerRuntime({
    batchSize: 2,
    maxConcurrency: 2,
    maxGlobalConcurrency: 2,
    maxPrefetchBatches: 2,
    maxBufferedVectorBytes: 1024,
    globalBufferedVectorBytes: 2048,
  });
  const persisted: number[] = [];
  const result = await runtime.schedule(fakeProvider((batch) => batch === 0 ? 30 : 1, active), [
    'a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff',
  ], {
    getText: (item) => item,
    getDocId: (item) => item,
    onBatchComplete: async (batch: EmbeddingBatch<string>) => {
      persisted.push(batch.batchIndex);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { persisted: batch.items.length, failed: 0 };
    },
  });

  assert.equal(active.peak, 2);
  assert.equal(result.persisted, 6);
  assert.equal(result.failed, 0);
  assert.deepEqual([...persisted].sort((a, b) => a - b), [0, 1, 2]);
});

test('scheduler rejects duplicate mapping before calling provider', async () => {
  let calls = 0;
  const provider: EmbeddingProvider = {
    dimension: 2,
    async embed(texts) {
      calls++;
      return texts.map(() => [1, 2]);
    },
  };
  const runtime = new EmbeddingSchedulerRuntime({ batchSize: 2 });
  await assert.rejects(
    runtime.schedule(provider, ['a', 'b'], {
      getText: (item) => item,
      getDocId: () => 'same',
      onBatchComplete: () => undefined,
    }),
    (err: Error & { code?: string }) => err.code === 'EMBED_ITEM_MAPPING_INVALID',
  );
  assert.equal(calls, 0);
});

test('scheduler keeps same-batch text reuse without cross-batch cache', async () => {
  const requestSizes: number[] = [];
  const provider: EmbeddingProvider = {
    dimension: 2,
    async embed(texts) {
      requestSizes.push(texts.length);
      return texts.map(() => [1, 2]);
    },
  };
  const runtime = new EmbeddingSchedulerRuntime({ batchSize: 2, maxConcurrency: 1, maxGlobalConcurrency: 1, maxPrefetchBatches: 1 });
  const result = await runtime.schedule(provider, [
    { id: 'a', text: 'same' },
    { id: 'b', text: 'same' },
    { id: 'c', text: 'same' },
  ], {
    getText: (item) => item.text,
    getDocId: (item) => item.id,
    dedupeKey: (item) => item.text,
    onBatchComplete: (batch) => ({ persisted: batch.items.length, failed: 0 }),
  });
  assert.deepEqual(requestSizes, [1, 1]);
  assert.equal(result.persisted, 3);
});

test('scheduler stops launching new batches after cancellation and reports exact items', async () => {
  const active = { value: 0, peak: 0 };
  const controller = new AbortController();
  const runtime = new EmbeddingSchedulerRuntime({
    batchSize: 2,
    maxConcurrency: 1,
    maxGlobalConcurrency: 1,
    maxPrefetchBatches: 1,
    maxBufferedVectorBytes: 1024,
    globalBufferedVectorBytes: 1024,
  });
  let completed = 0;
  const resultPromise = runtime.schedule(fakeProvider(() => 10, active), ['a', 'b', 'c', 'd', 'e', 'f'], {
    getText: (item) => item,
    getDocId: (item) => item,
    abortSignal: controller.signal,
    onBatchComplete: (batch) => {
      completed += batch.items.length;
      controller.abort();
      return { persisted: batch.items.length, failed: 0 };
    },
  });
  const result = await resultPromise;
  assert.equal(completed, 2);
  assert.equal(result.persisted, 2);
  assert.equal(result.cancelled, 4);
  assert.deepEqual(result.cancelledItems.map((item) => item.docId), ['c', 'd', 'e', 'f']);
});

test('scheduler rejects a buffer smaller than one estimated batch before provider call', async () => {
  let calls = 0;
  const provider: EmbeddingProvider = {
    dimension: 2,
    async embed(texts) {
      calls++;
      return texts.map(() => [1, 2]);
    },
  };
  const runtime = new EmbeddingSchedulerRuntime({
    batchSize: 2,
    maxBufferedVectorBytes: 1,
    globalBufferedVectorBytes: 1,
  });
  await assert.rejects(
    runtime.schedule(provider, ['a'], {
      getText: (item) => item,
      getDocId: (item) => item,
      onBatchComplete: () => undefined,
    }),
    (err: Error & { code?: string }) => err.code === 'VECTOR_BUFFER_LIMIT_INVALID',
  );
  assert.equal(calls, 0);
});

test('maxPrefetchBatches 省略时自动跟随 maxConcurrency（只写一个字段即可生效）', () => {
  // 只改 maxConcurrency：预取窗口自动跟随，不再因默认值触发"不能小于"报错
  const derived = normalizeEmbeddingScheduler({ maxConcurrency: 30, maxGlobalConcurrency: 30 });
  assert.equal(derived.maxConcurrency, 30);
  assert.equal(derived.maxPrefetchBatches, 30);

  // 默认值必须自洽：预取窗口 ≥ 并发上限，否则实际并发会被 workerCount = min(...) 静默压低
  const defaults = normalizeEmbeddingScheduler();
  assert.equal(defaults.batchSize, 16);
  assert.equal(defaults.maxConcurrency, 25);
  assert.equal(defaults.maxGlobalConcurrency, 25);
  assert.equal(defaults.maxPrefetchBatches, 25);

  // 仅改其它字段 / 调小并发：预取窗口保持默认值，不因派生而意外膨胀
  assert.equal(normalizeEmbeddingScheduler({ batchSize: 32 }).maxPrefetchBatches, 25);
  assert.equal(normalizeEmbeddingScheduler({ maxConcurrency: 1 }).maxPrefetchBatches, 25);

  // 显式配置仍按用户意图生效（允许预取窗口大于 maxConcurrency）
  assert.equal(normalizeEmbeddingScheduler({ maxConcurrency: 1, maxPrefetchBatches: 5 }).maxPrefetchBatches, 5);

  // 只有显式写出矛盾值才 fail-loud，且报错带实际值与修复动作
  assert.throws(
    () => normalizeEmbeddingScheduler({ maxConcurrency: 3, maxPrefetchBatches: 2 }),
    /maxPrefetchBatches 不能小于 maxConcurrency（当前 maxPrefetchBatches=2，maxConcurrency=3；修复：删除配置中的 maxPrefetchBatches/,
  );
});

test('maxConcurrency 超过默认全局槽位时报错指出默认值来源与修复动作', () => {
  assert.throws(
    () => normalizeEmbeddingScheduler({ maxConcurrency: 26 }),
    /maxConcurrency 不能大于 maxGlobalConcurrency（当前 maxConcurrency=26，maxGlobalConcurrency=25，后者来自默认值；修复：/,
  );
  // 显式把全局槽位一并调大即合法，不再误报
  assert.equal(normalizeEmbeddingScheduler({ maxConcurrency: 30, maxGlobalConcurrency: 30 }).maxConcurrency, 30);
});

test('调度器把配置的 requestTimeoutMs 透传给 provider（默认 60s，超上限 fail-loud）', async () => {
  const seen: Array<number | undefined> = [];
  const provider: EmbeddingProvider = {
    dimension: 2,
    async embed(texts, opts) {
      seen.push(opts?.timeoutMs);
      return texts.map(() => [1, 2]);
    },
  };
  const runtime = new EmbeddingSchedulerRuntime({ batchSize: 2, requestTimeoutMs: 45_000 });
  await runtime.schedule(provider, ['a', 'b', 'c'], {
    getText: (item) => item,
    getDocId: (item) => item,
    onBatchComplete: (batch) => ({ persisted: batch.items.length, failed: 0 }),
  });
  // 每个批次都带上配置的超时（而非 provider 自身的 30s 默认）
  assert.deepEqual(seen, [45_000, 45_000]);

  assert.equal(normalizeEmbeddingScheduler().requestTimeoutMs, 60_000);
  assert.throws(
    () => normalizeEmbeddingScheduler({ requestTimeoutMs: 600_001 }),
    /requestTimeoutMs 不能大于 600000/,
  );
});
