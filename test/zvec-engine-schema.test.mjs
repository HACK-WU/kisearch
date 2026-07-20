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

test('TC-REQ-01-16: open 维度与持久化不符 → DimensionMismatchError', async (t) => {
  const dbPath = makeDbPath('zvec-s16-');
  const engine = await ZvecEngine.create(makeConfig(dbPath));
  await engine.close();
  t.after(async () => { try { await engine.close(); } catch { /* 已关 */ } });

  await assert.rejects(
    () => ZvecEngine.open({
      dbPath,
      collectionName: 'test_col',
      embedding: { dimension: 2048, embed: mockEmbedding.embed },
    }),
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
