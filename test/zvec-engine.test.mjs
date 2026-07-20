/**
 * zvec-engine.test.mjs —— ZvecEngine 冒烟测试（编译产物）
 *
 * 覆盖：
 *   - S-01 create 校验（集合名/维度/metric/fts 字段）
 *   - S-02 Filter 编译（白名单 + 转义）
 *   - S-06 create → upsert → 4 类检索 → close → reopen → probe 全链路
 *   - probe 三种状态（NOT_FOUND / 健康 / locked）
 *
 * 运行：node --test test/zvec-engine.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ZvecEngine,
  DimensionMismatchError,
  InvalidSchemaError,
  InvalidFilterError,
  CollectionNotFoundError,
} from '../dist/zvec-engine/index.js';

// ─── 固定 mock EmbeddingProvider（4096 维 hash 向量） ───

const DIM = 4096;

function hashVector(text, dim = DIM) {
  // 简单 hash 向量：让相同文本的向量完全一致（可用于验证 vector 检索自检索 top1）
  const v = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[(text.charCodeAt(i) * 31 + i) % dim] += 1;
  }
  // L2 归一化（COSINE 距离要求）
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const mockEmbedding = {
  dimension: DIM,
  embed: async (texts) => texts.map((t) => hashVector(t)),
};

function makeConfig(dbPath) {
  return {
    dbPath,
    collection: {
      name: 'smoke_test',
      denseField: 'dense',
      dimension: DIM,
      metric: 'COSINE',
      scalarFields: [
        { name: 'tag', dataType: 'STRING', indexed: true },
        { name: 'content', dataType: 'STRING' },
        { name: 'score', dataType: 'FLOAT' },
      ],
      fts: { field: 'content', tokenizer: 'jieba' },
    },
    embedding: mockEmbedding,
  };
}

// ─── S-01 Schema 校验 ───

test('S-01: create 维度不符 → DimensionMismatchError', async () => {
  const dbPath = mkdtempSync(join(tmpdir(), 'zvec-s01-')) + '/db';
  const config = makeConfig(dbPath);
  config.embedding = { dimension: 2048, embed: mockEmbedding.embed };
  await assert.rejects(() => ZvecEngine.create(config), DimensionMismatchError);
});

test('S-01: create 集合名过短 → InvalidSchemaError', async () => {
  const dbPath = mkdtempSync(join(tmpdir(), 'zvec-s01-')) + '/db';
  const config = makeConfig(dbPath);
  config.collection.name = 'ab';
  await assert.rejects(() => ZvecEngine.create(config), InvalidSchemaError);
});

test('S-01: create 集合名前导下划线 → InvalidSchemaError', async () => {
  const dbPath = mkdtempSync(join(tmpdir(), 'zvec-s01-')) + '/db';
  const config = makeConfig(dbPath);
  config.collection.name = '__probe__';
  await assert.rejects(() => ZvecEngine.create(config), InvalidSchemaError);
});

test('S-01: create fts.field 未声明 → InvalidSchemaError', async () => {
  const dbPath = mkdtempSync(join(tmpdir(), 'zvec-s01-')) + '/db';
  const config = makeConfig(dbPath);
  config.collection.fts = { field: 'nonexistent', tokenizer: 'jieba' };
  await assert.rejects(() => ZvecEngine.create(config), InvalidSchemaError);
});

// ─── S-02 Filter 编译（间接经 engine.listIds） ───

test('S-02: filter 字段白名单拒绝未声明字段', async (t) => {
  const dbPath = mkdtempSync(join(tmpdir(), 'zvec-s02-')) + '/db';
  const engine = await ZvecEngine.create(makeConfig(dbPath));
  t.after(() => engine.close());

  await assert.rejects(
    () => engine.listIds({ field: 'unknown_field', op: '==', value: 'x' }),
    InvalidFilterError,
  );
});

// ─── S-06 全链路 ───

test('S-06: create → upsert → 4 类检索 → close → reopen → probe', async (t) => {
  const tmpdirRoot = mkdtempSync(join(tmpdir(), 'zvec-s06-'));
  const dbPath = join(tmpdirRoot, 'db');
  t.after(() => rmSync(tmpdirRoot, { recursive: true, force: true }));

  // create
  const engine = await ZvecEngine.create(makeConfig(dbPath));
  assert.equal(engine.isOpen(), true);
  assert.equal(engine.isHealthy(), true);

  // upsert
  const result = await engine.upsert([
    { id: 'doc1', text: 'hello world', fields: { tag: 'A', score: 0.9 } },
    { id: 'doc2', text: '你好世界', fields: { tag: 'B', score: 0.5 } },
    { id: 'doc3', text: 'zvec engine test', fields: { tag: 'A', score: 0.7 } },
  ]);
  assert.equal(result.ok, 3);
  assert.equal(result.failed, 0);

  // vectorSearch（自检索 top1 应≈1）
  const vecHits = await engine.vectorSearch({
    vector: hashVector('hello world'),
    topk: 3,
  });
  assert.equal(vecHits.length, 3);
  assert.equal(vecHits[0].id, 'doc1');
  assert.ok(vecHits[0].score > 0.99, `vector top1 score should ≈1, got ${vecHits[0].score}`);
  assert.equal(vecHits[0].queryType, 'vector');

  // semanticSearch（embed 路径）
  const semHits = await engine.semanticSearch({ queryText: 'hello world', topk: 3 });
  assert.equal(semHits[0].id, 'doc1');

  // ftsSearch（jieba 中文）
  const ftsHits = await engine.ftsSearch({ match: '世界', topk: 3 });
  assert.ok(ftsHits.length > 0);
  assert.equal(ftsHits[0].queryType, 'fts');
  assert.ok(ftsHits[0].score > 0);

  // hybridSearch（两路 RRF）
  const hybHits = await engine.hybridSearch({
    queryText: 'hello world',
    fts: '世界',
    topk: 3,
  });
  assert.ok(hybHits.length > 0);
  assert.equal(hybHits[0].queryType, 'hybrid');

  // hybridSearch queryText + vector 同传 → InvalidSearchError
  await assert.rejects(
    () => engine.hybridSearch({ queryText: 'x', vector: hashVector('x') }),
    /mutually exclusive/,
  );

  // listIds 带 filter
  const idsA = await engine.listIds({ field: 'tag', op: '==', value: 'A' });
  assert.deepEqual(idsA.sort(), ['doc1', 'doc3']);

  // fetch
  const docs = await engine.fetch(['doc1', 'doc2']);
  assert.equal(docs.length, 2);
  assert.equal(docs.find((d) => d.id === 'doc1').text, 'hello world');

  // delete
  const delResult = await engine.delete(['doc3']);
  assert.equal(delResult.ok, 1);

  // info
  const info = await engine.info();
  assert.equal(info.name, 'smoke_test');
  assert.equal(info.dimension, DIM);
  assert.equal(info.metric, 'COSINE');
  assert.equal(info.docCount, 2);
  assert.equal(info.fts?.tokenizer, 'jieba');

  // close
  await engine.close();
  assert.equal(engine.isOpen(), false);

  // reopen
  const engine2 = await ZvecEngine.open({
    dbPath,
    collectionName: 'smoke_test',
    embedding: mockEmbedding,
  });
  const info2 = await engine2.info();
  assert.equal(info2.docCount, 2);
  await engine2.close();
});

test('S-06: probe 不存在 → NOT_FOUND', async () => {
  const dbPath = join(tmpdir(), 'zvec-probe-nonexistent-' + Date.now());
  const result = await ZvecEngine.probe(dbPath);
  assert.deepEqual(result, { exists: false, locked: false, healthy: false, error: 'NOT_FOUND' });
});

test('S-06: probe 健康 db', async (t) => {
  const tmpdirRoot = mkdtempSync(join(tmpdir(), 'zvec-probe-'));
  const dbPath = join(tmpdirRoot, 'db');
  t.after(() => rmSync(tmpdirRoot, { recursive: true, force: true }));

  const engine = await ZvecEngine.create(makeConfig(dbPath));
  await engine.close();

  const result = await ZvecEngine.probe(dbPath);
  assert.deepEqual(result, { exists: true, locked: false, healthy: true });
});

test('S-06: probe 被持锁的 db → locked=true', async (t) => {
  const tmpdirRoot = mkdtempSync(join(tmpdir(), 'zvec-probe-locked-'));
  const dbPath = join(tmpdirRoot, 'db');
  t.after(async () => {
    await engineRef.engine?.close();
    rmSync(tmpdirRoot, { recursive: true, force: true });
  });

  const engineRef = { engine: await ZvecEngine.create(makeConfig(dbPath)) };
  // 主 engine 持锁时 probe
  const result = await ZvecEngine.probe(dbPath);
  assert.equal(result.exists, true);
  assert.equal(result.locked, true);
  assert.equal(result.healthy, true);
});

test('S-06: open 不存在 → CollectionNotFoundError', async () => {
  const dbPath = join(tmpdir(), 'zvec-open-nonexistent-' + Date.now());
  await assert.rejects(
    () => ZvecEngine.open({ dbPath, collectionName: 'x', embedding: mockEmbedding }),
    CollectionNotFoundError,
  );
});

test('S-06: tryOpen 失败返回 null', async () => {
  const dbPath = join(tmpdir(), 'zvec-tryopen-nonexistent-' + Date.now());
  const result = await ZvecEngine.tryOpen({
    dbPath,
    collectionName: 'x',
    embedding: mockEmbedding,
  });
  assert.equal(result, null);
});

test('S-06: update 仅 vector 且配 FTS → InconsistentUpdateError', async (t) => {
  const tmpdirRoot = mkdtempSync(join(tmpdir(), 'zvec-s06-update-'));
  const dbPath = join(tmpdirRoot, 'db');
  t.after(() => rmSync(tmpdirRoot, { recursive: true, force: true }));

  const engine = await ZvecEngine.create(makeConfig(dbPath));
  t.after(() => engine.close());

  await assert.rejects(
    () => engine.update([{ id: 'doc1', vector: hashVector('x') }]),
    /InconsistentUpdateError|desync FTS/,
  );
});

test('S-06: upsert 部分 embedding 失败 → EMBEDDING_FAILED', async (t) => {
  const tmpdirRoot = mkdtempSync(join(tmpdir(), 'zvec-s06-embed-fail-'));
  const dbPath = join(tmpdirRoot, 'db');
  t.after(() => rmSync(tmpdirRoot, { recursive: true, force: true }));

  // mock embedding 首次调用即失败（整批失败）
  const flakyEmbedding = {
    dimension: DIM,
    embed: async () => {
      throw new Error('simulated embedding failure');
    },
  };

  const config = makeConfig(dbPath);
  config.embedding = flakyEmbedding;
  const engine = await ZvecEngine.create(config);
  t.after(() => engine.close());

  const result = await engine.upsert([
    { id: 'doc1', text: 'first' },
    { id: 'doc2', text: 'second' },
  ]);
  // 当前实现：embed 失败整批标 EMBEDDING_FAILED（小批粒度）
  // 两次调用都会触发（按 batchSize=64 一批内）→ 全部失败
  assert.equal(result.failed, 2);
  assert.equal(result.ok, 0);
  assert.equal(result.errors[0].code, 'EMBEDDING_FAILED');
});

test('S-06: 预计算 vector 不受 embed 失败影响（S-03 失败粒度）', async (t) => {
  const tmpdirRoot = mkdtempSync(join(tmpdir(), 'zvec-s06-prevector-'));
  const dbPath = join(tmpdirRoot, 'db');
  t.after(() => rmSync(tmpdirRoot, { recursive: true, force: true }));

  const failEmbedding = {
    dimension: DIM,
    embed: async () => { throw new Error('always fails'); },
  };

  const config = makeConfig(dbPath);
  config.embedding = failEmbedding;
  const engine = await ZvecEngine.create(config);
  t.after(() => engine.close());

  const result = await engine.upsert([
    { id: 'doc1', text: 'will fail embed' },
    { id: 'doc2', vector: hashVector('precomputed') },  // 预计算 vector 不参与 embed
  ]);

  // doc1 embed 失败，doc2 预计算 vector 应成功写入
  assert.equal(result.ok, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].id, 'doc1');
  assert.equal(result.errors[0].code, 'EMBEDDING_FAILED');

  // 验证 doc2 已写入
  const docs = await engine.fetch(['doc2']);
  assert.equal(docs.length, 1);
});
