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
