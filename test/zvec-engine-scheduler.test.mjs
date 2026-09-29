import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZvecEngine } from '../dist/zvec-engine/index.js';
import { EmbeddingSchedulerRuntime } from '../dist/zvec-engine/embedding/batch-scheduler.js';

const DIM = 4096;
const vector = (text, call) => {
  const value = (text.length + call) / 100;
  return Array.from({ length: DIM }, () => value);
};

function makeConfig(dbPath, embedding) {
  return {
    dbPath,
    collection: {
      name: 'scheduler_test',
      denseField: 'dense',
      dimension: DIM,
      metric: 'COSINE',
      scalarFields: [
        { name: 'tag', dataType: 'STRING', indexed: true },
        { name: 'content', dataType: 'STRING' },
      ],
      fts: { field: 'content', tokenizer: 'jieba' },
    },
    embedding,
  };
}

test('ZvecEngine：Embedding 并行、单 writer 写入与逐批进度闭环', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zvec-scheduler-'));
  let calls = 0;
  let active = 0;
  let peak = 0;
  const embedding = {
    dimension: DIM,
    async embed(texts) {
      const call = calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, call === 0 ? 30 : 1));
      active--;
      return texts.map((text) => vector(text, call));
    },
  };
  const engine = await ZvecEngine.create(makeConfig(join(root, 'db'), embedding));
  t.after(async () => {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  });
  const runtime = new EmbeddingSchedulerRuntime({
    batchSize: 2,
    maxConcurrency: 2,
    maxGlobalConcurrency: 2,
    maxPrefetchBatches: 2,
    maxBufferedVectorBytes: 4 * 1024 * 1024,
    globalBufferedVectorBytes: 8 * 1024 * 1024,
  });
  const progress = [];
  const result = await engine.upsert(
    ['a', 'bb', 'ccc', 'dddd', 'eeeee'].map((text, index) => ({ id: `doc-${index}`, text })),
    {
      scheduler: runtime,
      onProgress: (event) => progress.push(event),
    },
  );

  assert.equal(peak, 2);
  assert.equal(calls, 3);
  assert.deepEqual({ ok: result.ok, failed: result.failed, status: result.status }, { ok: 5, failed: 0, status: 'succeeded' });
  assert.ok(progress.some((event) => event.phase === 'persist' && event.done === 5));
  const fetched = await engine.fetch(['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4']);
  assert.deepEqual(fetched.map((doc) => doc.id).sort(), ['doc-0', 'doc-1', 'doc-2', 'doc-3', 'doc-4']);
});

test('ZvecEngine：兼容串行入口遇到系统性 provider 故障后停止后续批次', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zvec-serial-stop-'));
  let calls = 0;
  const embedding = {
    dimension: DIM,
    async embed(texts) {
      calls++;
      throw Object.assign(new Error('embedding service unavailable'), { code: 'HTTP_503' });
    },
  };
  const engine = await ZvecEngine.create(makeConfig(join(root, 'db'), embedding));
  t.after(async () => {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  const result = await engine.upsert(
    Array.from({ length: 129 }, (_, index) => ({ id: `serial-${index}`, text: `doc ${index}` })),
  );

  assert.equal(calls, 1);
  assert.equal(result.ok, 0);
  assert.equal(result.failed, 64);
  assert.equal(result.notProcessed, 65);
  assert.equal(result.status, 'failed');
  assert.equal(result.stopReason?.kind, 'provider-unavailable');
  assert.deepEqual(result.notProcessedItems, Array.from({ length: 65 }, (_, index) => `serial-${index + 64}`));
});
