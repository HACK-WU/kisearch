/**
 * zvec-engine-search.test.mjs —— 检索路由与 score 归一化纯函数（TG-05 纯函数部分）
 *
 * 覆盖：TC-REQ-04-13/14/15（normalize/toHit）+ TC-REQ-04-05~12,18（router 退化矩阵/互斥/topk）
 * 无需 worker / zvec。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVectorScore, toHit } from '../dist/zvec-engine/search/normalize.js';
import { routeSearch } from '../dist/zvec-engine/search/router.js';
import { InvalidSearchError, SchemaMismatchError } from '../dist/zvec-engine/index.js';

const DIM = 4096;
const vec = (n = DIM) => new Array(n).fill(0);
const ctx = { denseField: 'dense', ftsField: 'content', dimension: DIM };
const ctxNoFts = { denseField: 'dense', dimension: DIM };

// ─── normalizeVectorScore（TC-REQ-04-13/14） ───

test('TC-REQ-04-13: distance clamp [0,2] → 1/(1+d)', () => {
  assert.equal(normalizeVectorScore(0, 'COSINE'), 1);
  assert.equal(normalizeVectorScore(-1, 'COSINE'), 1);     // clamp 0 → 1
  assert.equal(normalizeVectorScore(2, 'COSINE'), 1 / 3);
  assert.equal(normalizeVectorScore(3, 'COSINE'), 1 / 3);  // clamp 2 → 1/3
  assert.ok(Math.abs(normalizeVectorScore(1, 'COSINE') - 0.5) < 1e-9);
});

test('TC-REQ-04-14: 非 COSINE → SchemaMismatchError', () => {
  assert.throws(() => normalizeVectorScore(0, 'IP'), SchemaMismatchError);
});

// ─── toHit（TC-REQ-04-15/16） ───

test('TC-REQ-04-15: vector 路 distance NaN/undefined → null', () => {
  assert.equal(toHit({ id: 'x', distance: NaN, fields: {} }, { queryType: 'vector', metric: 'COSINE' }), null);
  assert.equal(toHit({ id: 'x', distance: undefined, fields: {} }, { queryType: 'vector', metric: 'COSINE' }), null);
});

test('TC-REQ-04-15: fts 路 score NaN/undefined → null', () => {
  assert.equal(toHit({ id: 'x', score: NaN, fields: {} }, { queryType: 'fts', metric: 'COSINE' }), null);
  assert.equal(toHit({ id: 'x', score: undefined, fields: {} }, { queryType: 'fts', metric: 'COSINE' }), null);
});

test('toHit vector 路归一化 + includeVector 填充', () => {
  const hit = toHit(
    { id: 'd1', distance: 0, fields: { tag: 'A' }, text: 'hello', vector: new Float32Array([1, 2, 3]) },
    { queryType: 'vector', metric: 'COSINE', includeVector: true },
  );
  assert.equal(hit.id, 'd1');
  assert.equal(hit.score, 1);
  assert.equal(hit.queryType, 'vector');
  assert.equal(hit.text, 'hello');
  assert.deepEqual(hit.vector, [1, 2, 3]);
});

test('toHit includeVector=false 不返回 vector', () => {
  const hit = toHit(
    { id: 'd1', distance: 0, fields: {}, vector: new Float32Array([1]) },
    { queryType: 'vector', metric: 'COSINE', includeVector: false },
  );
  assert.equal(hit.vector, undefined);
});

// ─── routeSearch 退化矩阵 / 互斥 / topk ───

test('TC-REQ-04-05: hybridSearch queryText + vector 同传 → InvalidSearchError', () => {
  assert.throws(
    () => routeSearch({ queryText: 'x', vector: vec(), topk: 3 }, ctx),
    /mutually exclusive/,
  );
});

test('TC-REQ-04-06: 三者皆缺 → InvalidSearchError', () => {
  assert.throws(
    () => routeSearch({ topk: 3 }, ctx),
    InvalidSearchError,
  );
});

test('TC-REQ-04-07: queryText 无 fts → 退化为单路 vector', () => {
  const r = routeSearch({ queryText: 'hello', topk: 3 }, ctx);
  assert.equal(r.kind, 'query');
  assert.equal(r.queryType, 'vector');
  assert.equal(r.needsEmbed, true);
  assert.deepEqual(r.embedTexts, ['hello']);
});

test('TC-REQ-04-08: 仅 fts → 退化为单路 fts', () => {
  const r = routeSearch({ fts: '世界', topk: 3 }, ctx);
  assert.equal(r.kind, 'query');
  assert.equal(r.queryType, 'fts');
  assert.equal(r.needsEmbed, false);
});

test('TC-REQ-04-04: fts + queryText → multiQuery hybrid', () => {
  const r = routeSearch({ queryText: 'hello', fts: '世界', topk: 3 }, ctx);
  assert.equal(r.kind, 'multiQuery');
  assert.equal(r.queryType, 'hybrid');
  assert.equal(r.needsEmbed, true);
});

test('TC-REQ-04-09: ftsSearch 集合无 FTS 配置 → InvalidSearchError', () => {
  assert.throws(
    () => routeSearch({ match: 'x', topk: 3 }, ctxNoFts),
    /no fts config/,
  );
});

test('TC-REQ-04-09b: hybrid 给 fts 但集合无 FTS → InvalidSearchError', () => {
  assert.throws(
    () => routeSearch({ fts: 'x', topk: 3 }, ctxNoFts),
    /no fts config/,
  );
});

test('TC-REQ-04-10: vector 维度不符 → InvalidSearchError', () => {
  assert.throws(
    () => routeSearch({ vector: vec(2048), topk: 3 }, ctx),
    /dimension mismatch/,
  );
});

test('TC-REQ-04-11: topk 非正整数 / 超上限 → InvalidSearchError', () => {
  assert.throws(() => routeSearch({ vector: vec(), topk: 0 }, ctx), InvalidSearchError);
  assert.throws(() => routeSearch({ vector: vec(), topk: -1 }, ctx), InvalidSearchError);
  assert.throws(() => routeSearch({ vector: vec(), topk: 1001 }, ctx), InvalidSearchError);
});

test('TC-REQ-04-11b: topk 默认 10', () => {
  const r = routeSearch({ vector: vec() }, ctx);
  assert.equal(r.payload.topk, 10);
});

test('TC-REQ-04-12: queryText 空串 / 超长 → InvalidSearchError', () => {
  assert.throws(() => routeSearch({ queryText: '', topk: 3 }, ctx), InvalidSearchError);
  assert.throws(() => routeSearch({ queryText: 'x'.repeat(10001), topk: 3 }, ctx), InvalidSearchError);
});

test('TC-REQ-04-18: weighted 缺 weights → InvalidSearchError', () => {
  assert.throws(
    () => routeSearch({ queryText: 'x', fts: 'y', rerank: { type: 'weighted' }, topk: 3 }, ctx),
    /weighted requires weights/,
  );
});

test('TC-REQ-04-19: weighted 带 weights 正常路由', () => {
  const r = routeSearch(
    { queryText: 'x', fts: 'y', rerank: { type: 'weighted', weights: { dense: 0.7, content: 0.3 } }, topk: 3 },
    ctx,
  );
  assert.equal(r.kind, 'multiQuery');
  assert.equal(r.queryType, 'hybrid');
  assert.ok(r.payload.rerankWeighted, '应有 rerankWeighted');
  assert.deepEqual(r.payload.rerankWeighted.weights, [0.7, 0.3]);
});

test('TC-REQ-04-20: rrf 自定义 rankConstant', () => {
  const r = routeSearch({ queryText: 'x', fts: 'y', rerank: { type: 'rrf', rankConstant: 30 }, topk: 3 }, ctx);
  assert.ok(r.payload.rerankRrf);
  assert.equal(r.payload.rerankRrf.rankConstant, 30);
});

test('vector 直接检索（VectorSearchReq）', () => {
  const r = routeSearch({ vector: vec(), topk: 5 }, ctx);
  assert.equal(r.kind, 'query');
  assert.equal(r.queryType, 'vector');
  assert.equal(r.needsEmbed, false);
  assert.equal(r.payload.topk, 5);
});
