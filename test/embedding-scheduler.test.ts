import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EmbeddingSchedulerRuntime,
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
