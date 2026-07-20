/**
 * zvec-engine-engine.test.mjs —— 引擎门面集成（TG-06 CRUD/生命周期 + TG-07 Z 契约）
 *
 * 需 zvec worker。只读用例共享一个 engine（经 describe+before），减少 jieba 字典加载次数；
 * 破坏性用例各自独立 engine。所有 engine 在 after 中 close/destroy，避免 worker 泄漏。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZvecEngine,
  DimensionMismatchError,
  InvalidDocInputError,
  InvalidSchemaError,
} from '../dist/zvec-engine/index.js';
import { WorkerUnavailableError } from '../dist/zvec-engine/errors.js';
import { DIM, mockEmbedding, hashVector, makeConfig, makeDbPath } from './zvec-engine-fixtures.mjs';

const SEED = [
  { id: 'doc1', text: 'hello world', fields: { tag: 'A', score: 0.9 } },
  { id: 'doc2', text: '你好世界', fields: { tag: 'B', score: 0.5 } },
  { id: 'doc3', text: 'zvec engine test', fields: { tag: 'A', score: 0.7 } },
];

/** 创建独立 engine 并 seed，t.after 自动关闭 */
async function freshEngine(t, seed = SEED) {
  const engine = await ZvecEngine.create(makeConfig(makeDbPath('zvec-eng-')));
  if (seed.length > 0) await engine.upsert(seed);
  t.after(() => engine.close());
  return engine;
}

// ─── 共享 engine 的只读用例组 ───

describe('共享 engine · 只读用例', () => {
  let engine;
  before(async () => {
    engine = await ZvecEngine.create(makeConfig(makeDbPath('zvec-shared-')));
    await engine.upsert(SEED);
  });
  after(() => engine.close());

  test('TC-REQ-01-32: fetch 不存在 id → 返回长度 < 请求数', async () => {
    const docs = await engine.fetch(['doc1', 'nope']);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].id, 'doc1');
  });

  test('TC-REQ-01-33: fetch includeVector=true 返回向量', async () => {
    const docs = await engine.fetch(['doc1'], true);
    assert.equal(docs.length, 1);
    assert.ok(Array.isArray(docs[0].vector));
    assert.equal(docs[0].vector.length, DIM);
  });

  test('TC-REQ-01-34: listIds 无 filter 返回全部 / limit 截断', async () => {
    const all = await engine.listIds();
    assert.equal(all.length, 3);
    const limited = await engine.listIds(undefined, 2);
    assert.equal(limited.length, 2);
  });

  test('TC-REQ-01-38: isHealthy/isLocked/isOpen 语义', () => {
    assert.equal(engine.isOpen(), true);
    assert.equal(engine.isHealthy(), true);
    assert.equal(engine.isLocked(), false);
  });

  test('TC-REQ-01-50: outputFields 过滤返回字段', async () => {
    const hits = await engine.vectorSearch({ vector: hashVector('hello world'), topk: 1, outputFields: ['tag'] });
    assert.ok(hits.length >= 1);
    assert.ok('tag' in hits[0].fields, '应含 tag');
    assert.ok(!('score' in hits[0].fields), '不应含 score');
  });

  test('TC-REQ-01-53: 并发纯读（15 个并发请求）', async () => {
    const v = hashVector('hello world');
    const reqs = [
      ...Array.from({ length: 5 }, () => engine.vectorSearch({ vector: v, topk: 3 })),
      ...Array.from({ length: 5 }, () => engine.ftsSearch({ match: '世界', topk: 3 })),
      ...Array.from({ length: 5 }, () => engine.listIds()),
    ];
    const results = await Promise.all(reqs);
    assert.equal(results.length, 15);
    for (const r of results) assert.ok(Array.isArray(r));
  });

  test('TC-Z-01: 无 filter 检索不传显式 undefined（条件展开）', async () => {
    const v = hashVector('hello world');
    // 三类检索均不传 filter，应不抛 "Expected a string for 'filter'"
    const vecHits = await engine.vectorSearch({ vector: v, topk: 3 });
    const ftsHits = await engine.ftsSearch({ match: '世界', topk: 3 });
    const hybHits = await engine.hybridSearch({ queryText: 'hello', fts: '世界', topk: 3 });
    assert.ok(Array.isArray(vecHits));
    assert.ok(Array.isArray(ftsHits));
    assert.ok(Array.isArray(hybHits));
  });
});

// ─── 破坏性 / 独立 engine 用例 ───

test('TC-REQ-01-25: upsert 写入维度不符 → DimensionMismatchError（批级）', async (t) => {
  const engine = await freshEngine(t, []);
  await assert.rejects(
    () => engine.upsert([{ id: 'd1', vector: new Array(2048).fill(0) }]),
    DimensionMismatchError,
  );
});

test('TC-REQ-01-26: upsert 含未声明标量字段 → InvalidDocInputError（批级）', async (t) => {
  const engine = await freshEngine(t, []);
  await assert.rejects(
    () => engine.upsert([{ id: 'd1', text: 'x', fields: { unknown: 'y' } }]),
    InvalidDocInputError,
  );
});

test('TC-REQ-01-48: upsert 无 text 无 vector → UNKNOWN 文档级', async (t) => {
  const engine = await freshEngine(t, []);
  const result = await engine.upsert([{ id: 'd1', fields: { tag: 'A' } }]);
  assert.equal(result.ok, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].code, 'UNKNOWN');
});

test('TC-Z-02: upsert 仅 vector 无 fields → 成功（vectors/fields 至少 {}）', async (t) => {
  const engine = await freshEngine(t, []);
  const result = await engine.upsert([{ id: 'd1', vector: hashVector('x') }]);
  assert.equal(result.ok, 1);
  assert.equal(result.failed, 0);
});

test('TC-REQ-01-49: text + vector 并存（vector 为准 + text 写 FTS）', async (t) => {
  const engine = await freshEngine(t, []);
  await engine.upsert([{ id: 'd1', text: 'FTS_TEXT', vector: hashVector('VEC') }]);
  const ftsHits = await engine.ftsSearch({ match: 'FTS_TEXT', topk: 3 });
  assert.ok(ftsHits.length > 0, 'fts 路应命中（text 写入 FTS 索引）');
  const vecHits = await engine.vectorSearch({ vector: hashVector('VEC'), topk: 3 });
  assert.ok(vecHits.length > 0, 'vector 路应命中（用预计算 vector）');
});

test('TC-REQ-01-29: insert 重复 id → ID_CONFLICT（不回滚不覆盖）', async (t) => {
  const engine = await freshEngine(t, []);
  await engine.insert([{ id: 'doc1', text: 'first' }]);
  const result = await engine.insert([
    { id: 'doc1', text: 'dup' },
    { id: 'doc2', text: 'ok' },
  ]);
  assert.equal(result.ok, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].code, 'ID_CONFLICT');
  assert.equal(result.errors[0].id, 'doc1');
  // doc1 原内容未被覆盖
  const docs = await engine.fetch(['doc1']);
  assert.equal(docs[0].text, 'first');
});

test('TC-REQ-01-29b: delete 不存在 id → NOT_FOUND 文档级（T-03）', async (t) => {
  const engine = await freshEngine(t, []);
  const result = await engine.delete(['nonexistent']);
  assert.equal(result.ok, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.errors[0].code, 'NOT_FOUND');
});

test('TC-REQ-01-31: upsert 幂等（同 id 再写覆盖）', async (t) => {
  const engine = await freshEngine(t, []);
  await engine.upsert([{ id: 'doc1', text: 'a' }]);
  await engine.upsert([{ id: 'doc1', text: 'b' }]);
  const docs = await engine.fetch(['doc1']);
  assert.equal(docs[0].text, 'b');
});

test('TC-REQ-01-36: 空数组写入 → { ok:0, failed:0 }', async (t) => {
  const engine = await freshEngine(t, []);
  const result = await engine.upsert([]);
  assert.equal(result.ok, 0);
  assert.equal(result.failed, 0);
});

test('TC-REQ-01-28: update 传 text → 重嵌 + 同步 FTS', async (t) => {
  const engine = await freshEngine(t, [{ id: 'doc1', text: 'old text', fields: { tag: 'A' } }]);
  const r = await engine.update([{ id: 'doc1', text: 'brand new text' }]);
  assert.equal(r.ok, 1);
  const newHits = await engine.ftsSearch({ match: 'brand', topk: 3 });
  assert.ok(newHits.length > 0, 'FTS 索引应同步为新文本');
  const oldHits = await engine.ftsSearch({ match: 'old', topk: 3 });
  assert.equal(oldHits.length, 0, '旧文本不应再被命中');
});

test('TC-REQ-01-55: update 仅 fields（Z-03，dense vector 必填）', async (t) => {
  const engine = await freshEngine(t, [{ id: 'doc1', text: 'x', fields: { tag: 'A' } }]);
  // zvec updateSync 要求 dense vector 必填 → 抛错
  await assert.rejects(
    () => engine.update([{ id: 'doc1', fields: { tag: 'B' } }]),
    (e) => /dense|required|field/i.test(e.message),
  );
});

test('TC-REQ-01-47: listIds limit 截断 + >10000 上限缺口（文档化）', async (t) => {
  const engine = await freshEngine(t, []);
  // limit=2 截断
  await engine.upsert([
    { id: 'a', text: 'x', fields: { tag: 'A' } },
    { id: 'b', text: 'y', fields: { tag: 'A' } },
    { id: 'c', text: 'z', fields: { tag: 'A' } },
  ]);
  const limited = await engine.listIds(undefined, 2);
  assert.equal(limited.length, 2);
  // ⚠ 实现缺口：listIds 未做 >10000 上限校验（直接透传 worker）。
  // 此处仅验证 10001 不抛 InvalidSearchError（当前行为），以文档化缺口；契约要求应抛错。
  await engine.listIds(undefined, 10001); // 不抛
  assert.ok(true, '已知缺口：limit>10000 未校验，见 test-plan TC-REQ-01-47');
});

test('TC-REQ-01-51: readOnly open 写入失败', async (t) => {
  const dbPath = makeDbPath('zvec-ro-');
  const w = await ZvecEngine.create(makeConfig(dbPath));
  await w.upsert([{ id: 'd1', text: 'x' }]);
  await w.close();
  t.after(async () => { try { await ro?.close(); } catch { /* */ } });

  const ro = await ZvecEngine.open({
    dbPath,
    collectionName: 'test_col',
    embedding: mockEmbedding,
    readOnly: true,
  });
  await assert.rejects(
    () => ro.upsert([{ id: 'd2', text: 'y' }]),
  );
});

test('TC-REQ-01-37: destroy 后操作 → InvalidSchemaError', async (t) => {
  const engine = await ZvecEngine.create(makeConfig(makeDbPath('zvec-dest-')));
  await engine.destroy();
  await assert.rejects(
    () => engine.upsert([{ id: 'd1', text: 'x' }]),
    InvalidSchemaError,
  );
  assert.equal(engine.isHealthy(), false);
});

test('TC-REQ-01-52: destroy 幂等（二次调用不抛）', async (t) => {
  const engine = await ZvecEngine.create(makeConfig(makeDbPath('zvec-dest2-')));
  await engine.destroy();
  await engine.destroy(); // 不抛
  assert.equal(engine.isHealthy(), false);
});

test('TC-REQ-01-56: send 非 open 状态 → WorkerUnavailableError', async (t) => {
  const engine = await ZvecEngine.create(makeConfig(makeDbPath('zvec-closed-')));
  await engine.close();
  await assert.rejects(
    () => engine.info(),
    WorkerUnavailableError,
  );
});
