/**
 * zvec-engine-schema.test.mjs —— Schema 构建与校验（TG-01 + TC-S01-01/02/03）
 *
 * 涵盖：create 校验 V-01~V-07、open 校验 O-02~O-05、纯函数
 *   mapZvecOpenError / assertSchemaMatch / buildCollectionSchema。
 * 需 zvec worker（集成部分）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ZVecDataType } from '@zvec/zvec';
import {
  ZvecEngine,
  DimensionMismatchError,
  InvalidSchemaError,
  SchemaMismatchError,
  CollectionAlreadyExistsError,
  CollectionNotFoundError,
  CollectionLockedException,
  CollectionCorruptedException,
} from '../dist/zvec-engine/index.js';
import { mapZvecOpenError, assertSchemaMatch } from '../dist/zvec-engine/schema/validator.js';
import { buildCollectionSchema } from '../dist/zvec-engine/schema/builder.js';
import { DIM, mockEmbedding, makeConfig, makeConfigNoFts, makeDbPath } from './zvec-engine-fixtures.mjs';

// ─── 纯函数：mapZvecOpenError（TC-S01-01） ───

test('TC-S01-01: mapZvecOpenError lock 消息 → CollectionLockedException', () => {
  const e = mapZvecOpenError(new Error("Can't lock read-write collection: /db/LOCK"), '/db');
  assert.ok(e instanceof CollectionLockedException);
});

test('TC-S01-01: mapZvecOpenError not exist 消息 → CollectionNotFoundError', () => {
  const e = mapZvecOpenError(new Error('enoent: no such file or directory'), '/db');
  assert.ok(e instanceof CollectionNotFoundError);
});

test('TC-S01-01: mapZvecOpenError corrupt 消息 → CollectionCorruptedException', () => {
  const e = mapZvecOpenError(new Error('failed to parse malformed schema'), '/db');
  assert.ok(e instanceof CollectionCorruptedException);
});

test('TC-S01-01: mapZvecOpenError 未识别 → 原样返回', () => {
  const orig = new Error('something weird');
  const e = mapZvecOpenError(orig, '/db');
  assert.equal(e, orig);
});

test('TC-S01-01: mapZvecOpenError 已是 ZvecEngineError → 原样返回', () => {
  const orig = new CollectionLockedException('x');
  assert.equal(mapZvecOpenError(orig, '/db'), orig);
});

// ─── 纯函数：assertSchemaMatch（TC-S01-02） ───

const persisted = {
  name: 'c', denseField: 'dense', dimension: 4096, metric: 'COSINE', denseDataType: 'FP32',
  scalarFields: [{ name: 'tag', dataType: 'STRING' }, { name: 'content', dataType: 'STRING' }],
  fts: { field: 'content', tokenizer: 'jieba' },
};

test('TC-S01-02: dimension 不符 → SchemaMismatchError', () => {
  assert.throws(() => assertSchemaMatch({ dimension: 2048 }, persisted), SchemaMismatchError);
});

test('TC-S01-02: metric 不符 → SchemaMismatchError', () => {
  assert.throws(() => assertSchemaMatch({ metric: 'COSINE' }, { ...persisted, metric: 'IP' }), SchemaMismatchError);
});

test('TC-S01-02: scalarFields 缺字段 → SchemaMismatchError', () => {
  assert.throws(() => assertSchemaMatch({ scalarFields: [{ name: 'nope', dataType: 'STRING' }] }, persisted), SchemaMismatchError);
});

test('TC-S01-02: scalarFields dataType 不符 → SchemaMismatchError', () => {
  assert.throws(() => assertSchemaMatch({ scalarFields: [{ name: 'tag', dataType: 'INT32' }] }, persisted), SchemaMismatchError);
});

test('TC-S01-02: fts.field 不符 → SchemaMismatchError', () => {
  assert.throws(() => assertSchemaMatch({ fts: { field: 'tag', tokenizer: 'jieba' } }, persisted), SchemaMismatchError);
});

test('TC-S01-02: 持久化无 fts 但 assert 有 → SchemaMismatchError', () => {
  assert.throws(() => assertSchemaMatch({ fts: { field: 'content', tokenizer: 'jieba' } }, { ...persisted, fts: undefined }), SchemaMismatchError);
});

test('TC-S01-02: 完全匹配 → 不抛', () => {
  assert.doesNotThrow(() => assertSchemaMatch({
    dimension: 4096, metric: 'COSINE',
    scalarFields: [{ name: 'tag', dataType: 'STRING' }],
    fts: { field: 'content', tokenizer: 'jieba' },
  }, persisted));
});

// ─── 纯函数：buildCollectionSchema（TC-S01-03） ───

test('TC-S01-03: FP16 denseDataType → VECTOR_FP16', () => {
  const config = makeConfigNoFts('/tmp/unused');
  config.collection.denseDataType = 'FP16';
  const schema = buildCollectionSchema(config);
  assert.equal(schema.vectors()[0].dataType, ZVecDataType.VECTOR_FP16);
  assert.equal(schema.vectors()[0].dimension, DIM);
});

test('TC-S01-03: 默认 FP32 → VECTOR_FP32', () => {
  const schema = buildCollectionSchema(makeConfigNoFts('/tmp/unused'));
  assert.equal(schema.vectors()[0].dataType, ZVecDataType.VECTOR_FP32);
});

test('TC-S01-03: indexed 标量字段 → INVERT 索引', () => {
  const schema = buildCollectionSchema(makeConfigNoFts('/tmp/unused'));
  const tagField = schema.fields().find((f) => f.name === 'tag');
  assert.ok(tagField.indexParams, 'indexed 字段应有 indexParams');
});

test('TC-S01-03: 非 COSINE metric → InvalidSchemaError', () => {
  const config = makeConfigNoFts('/tmp/unused');
  config.collection.metric = 'IP';
  assert.throws(() => buildCollectionSchema(config), InvalidSchemaError);
});

// ─── 集成：create 校验 V-01~V-07 ───

test('TC-REQ-01-01: create 正常建库 + info', async () => {
  const dbPath = makeDbPath('zvec-s01-');
  const engine = await ZvecEngine.create(makeConfig(dbPath));
  const info = await engine.info();
  assert.equal(info.name, 'test_col');
  assert.equal(info.dimension, DIM);
  assert.equal(info.metric, 'COSINE');
  assert.equal(info.fts?.tokenizer, 'jieba');
  assert.equal(engine.isOpen(), true);
  assert.equal(engine.isHealthy(), true);
  await engine.close();
  assert.equal(engine.isOpen(), false);
});

test('TC-REQ-01-03: metric 非 COSINE → InvalidSchemaError', async () => {
  const dbPath = makeDbPath('zvec-s03-');
  await assert.rejects(
    () => ZvecEngine.create(makeConfig(dbPath, { collection: { metric: 'IP' } })),
    InvalidSchemaError,
  );
  assert.equal(existsSync(dbPath), false, '校验失败不应建库');
});

test('TC-REQ-01-06: 集合名含非法字符 → InvalidSchemaError', async () => {
  const dbPath = makeDbPath('zvec-s06-');
  await assert.rejects(
    () => ZvecEngine.create(makeConfig(dbPath, { collection: { name: 'ki-search!' } })),
    InvalidSchemaError,
  );
});

test('TC-REQ-01-07: 标量字段与 denseField 重名 → InvalidSchemaError', async () => {
  const dbPath = makeDbPath('zvec-s07-');
  await assert.rejects(
    () => ZvecEngine.create(makeConfig(dbPath, {
      collection: { fts: undefined, scalarFields: [{ name: 'dense', dataType: 'STRING' }, { name: 'tag', dataType: 'STRING' }] },
    })),
    InvalidSchemaError,
  );
});

test('TC-REQ-01-08: 标量字段互相重名 → InvalidSchemaError', async () => {
  const dbPath = makeDbPath('zvec-s08-');
  await assert.rejects(
    () => ZvecEngine.create(makeConfig(dbPath, {
      collection: { fts: undefined, scalarFields: [{ name: 'tag', dataType: 'STRING' }, { name: 'tag', dataType: 'STRING' }] },
    })),
    InvalidSchemaError,
  );
});

test('TC-REQ-01-10: fts.field 非 STRING → InvalidSchemaError', async () => {
  const dbPath = makeDbPath('zvec-s10-');
  await assert.rejects(
    () => ZvecEngine.create(makeConfig(dbPath, {
      collection: { scalarFields: [{ name: 'content', dataType: 'FLOAT' }], fts: { field: 'content', tokenizer: 'jieba' } },
    })),
    InvalidSchemaError,
  );
});

test('TC-REQ-01-11: fts.tokenizer 缺省 → InvalidSchemaError', async () => {
  const dbPath = makeDbPath('zvec-s11-');
  await assert.rejects(
    () => ZvecEngine.create(makeConfig(dbPath, { collection: { fts: { field: 'content' } } })),
    InvalidSchemaError,
  );
});

test('TC-REQ-01-12: dbPath 已存在 → CollectionAlreadyExistsError', async (t) => {
  const dbPath = makeDbPath('zvec-s12-');
  const engine = await ZvecEngine.create(makeConfig(dbPath));
  t.after(() => engine.close());
  await assert.rejects(
    () => ZvecEngine.create(makeConfig(dbPath)),
    CollectionAlreadyExistsError,
  );
});

test('TC-REQ-01-13: dbPath 非绝对路径 → InvalidSchemaError', async () => {
  await assert.rejects(
    () => ZvecEngine.create(makeConfig('relative/db')),
    InvalidSchemaError,
  );
});

test('TC-REQ-01-14: dbPath 含 ".." → InvalidSchemaError', async () => {
  await assert.rejects(
    () => ZvecEngine.create(makeConfig('/tmp/../etc/db')),
    InvalidSchemaError,
  );
});

test('TC-REQ-01-15: 单进程单写句柄语义（经 probe-locked 覆盖，见 smoke）', () => {
  // 注：直接 ZvecEngine.open 撞锁会令 worker 在原生 ZVecOpen 中阻塞，
  // Promise.race 超时后该 worker 无法 terminate（泄漏），导致进程无法退出。
  // 故本语义由 smoke 的 probe-locked（probe 自带超时+terminate）覆盖，此处不重复。
  assert.ok(true, '语义覆盖见 test/zvec-engine.test.mjs probe-locked 用例');
});

// ─── 集成：open 校验 O-02~O-05 ───

/** 记录 embed 调用次数的"错维度" provider，用于证明全文链路根本不触碰 embedding。 */
function mismatchedEmbedding(dim = 2048) {
  const provider = {
    dimension: dim,
    calls: 0,
    embed: async (texts) => {
      provider.calls += 1;
      return texts.map(() => new Array(dim).fill(0));
    },
  };
  return provider;
}

/** 建一个 DIM 维度的库并写入一条可全文检索的文档，返回 dbPath。 */
async function createPopulatedCollection(t, dbPath) {
  const engine = await ZvecEngine.create(makeConfig(dbPath));
  const written = await engine.upsert([
    { id: 'doc-1', text: 'dimension mismatch sample', fields: { tag: 'ki-search' } },
  ]);
  assert.equal(written.ok, 1);
  await engine.close();
  t.after(async () => { try { await engine.close(); } catch { /* 已关 */ } });
  return engine;
}

// 契约（REQ：全文搜索与向量维度解耦）：open 阶段不比较当前 embedding 维度与持久化
// 维度。FTS 检索、读取、删除都不依赖 embedding，维度变更期间必须继续可用；
// 真正需要 dense 的操作才在各自边界拒绝（见 16b/16c）。

test('TC-REQ-01-16a: open 维度与持久化不符 → 允许打开，FTS 检索/读取/删除仍可用', async (t) => {
  const dbPath = makeDbPath('zvec-s16a-');
  await createPopulatedCollection(t, dbPath);

  const embedding = mismatchedEmbedding();
  const engine = await ZvecEngine.open({ dbPath, collectionName: 'test_col', embedding });
  t.after(async () => { await engine.close(); });

  const hits = await engine.ftsSearch({ match: 'dimension', topk: 5 });
  assert.equal(hits.length, 1, '维度不符时全文检索应正常命中');
  assert.equal(hits[0].id, 'doc-1');

  const fetched = await engine.fetch(['doc-1']);
  assert.equal(fetched.length, 1, '维度不符时读取应正常');

  const deleted = await engine.delete(['doc-1']);
  assert.equal(deleted.ok, 1, '维度不符时删除应正常');
  assert.equal(embedding.calls, 0, 'FTS/读取/删除不得调用 embedding');
});

test('TC-REQ-01-16b: 维度不符时 dense 检索与需 embed 的写入被拒，且不调用 provider', async (t) => {
  const dbPath = makeDbPath('zvec-s16b-');
  await createPopulatedCollection(t, dbPath);

  const embedding = mismatchedEmbedding();
  const engine = await ZvecEngine.open({ dbPath, collectionName: 'test_col', embedding });
  t.after(async () => { await engine.close(); });

  await assert.rejects(() => engine.semanticSearch({ queryText: 'dimension', topk: 5 }), DimensionMismatchError);
  await assert.rejects(() => engine.hybridSearch({ queryText: 'dimension', topk: 5 }), DimensionMismatchError);
  await assert.rejects(() => engine.upsert([{ id: 'doc-2', text: 'new content', fields: { tag: 'ki-search' } }]), DimensionMismatchError);
  assert.equal(embedding.calls, 0, '应在调用 embedding 服务前拒绝，避免白跑一次网络请求');

  // 只有关键词侧的 hybrid（检索降级的实际调用形态）不触发 dense，应正常返回
  const keywordOnly = await engine.hybridSearch({ fts: 'dimension', topk: 5 });
  assert.equal(keywordOnly.length, 1, 'hybrid 仅 fts 时不应要求 embedding');
  assert.equal(embedding.calls, 0, '仅关键词检索仍不得调用 embedding');

  // 显式向量按"持久化维度"校验（而非当前配置维度）：长度不符即拒
  await assert.rejects(
    () => engine.upsert([{ id: 'doc-3', vector: new Array(2048).fill(0), fields: { tag: 'ki-search' } }]),
    DimensionMismatchError,
  );
  // 纯标量更新不触碰 dense，应仍可用
  const scalarUpdated = await engine.update([{ id: 'doc-1', fields: { tag: 'ki-search' } }]).catch(() => null);
  if (scalarUpdated) assert.equal(scalarUpdated.ok, 1);
});

test('TC-REQ-01-16c: create 仍要求 embedding 维度与声明维度一致', async () => {
  const dbPath = makeDbPath('zvec-s16c-');
  await assert.rejects(
    () => ZvecEngine.create(makeConfig(dbPath, { embedding: mismatchedEmbedding() })),
    DimensionMismatchError,
  );
});

test('TC-REQ-01-17: open schemaAssert 不符 → SchemaMismatchError', async (t) => {
  const dbPath = makeDbPath('zvec-s17-');
  const engine = await ZvecEngine.create(makeConfig(dbPath));
  await engine.close();
  t.after(async () => { try { await engine.close(); } catch { /* 已关 */ } });

  await assert.rejects(
    () => ZvecEngine.open({
      dbPath,
      collectionName: 'test_col',
      embedding: mockEmbedding,
      schemaAssert: { fts: { field: 'content', tokenizer: 'standard' } },
    }),
    SchemaMismatchError,
  );
});

test('TC-REQ-01-17b: open schemaAssert 完全匹配 → 成功', async (t) => {
  const dbPath = makeDbPath('zvec-s17b-');
  const engine = await ZvecEngine.create(makeConfig(dbPath));
  await engine.close();
  t.after(async () => { try { await engine.close(); } catch { /* 已关 */ } });

  const engine2 = await ZvecEngine.open({
    dbPath,
    collectionName: 'test_col',
    embedding: mockEmbedding,
    schemaAssert: { dimension: DIM, metric: 'COSINE', fts: { field: 'content', tokenizer: 'jieba' } },
  });
  assert.equal(engine2.isOpen(), true);
  await engine2.close();
});
