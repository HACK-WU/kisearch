/**
 * zvec-engine-filter.test.mjs —— Filter 编译器（TG-02 / TC-REQ-01-18~22,60）
 *
 * 纯函数测试 compileFilter / buildAllowedFields，无需 worker。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter, buildAllowedFields } from '../dist/zvec-engine/filter/compiler.js';
import { InvalidFilterError } from '../dist/zvec-engine/index.js';

const allowed = buildAllowedFields(
  [
    { name: 'tag', dataType: 'STRING' },
    { name: 'score', dataType: 'FLOAT' },
    { name: 'flag', dataType: 'BOOL' },
  ],
  'content',
);

test('TC-REQ-01-18: 白名单拒绝未声明字段', () => {
  assert.throws(
    () => compileFilter({ field: 'unknown', op: '==', value: 'x' }, allowed),
    InvalidFilterError,
  );
});

test('TC-REQ-01-19: 字符串值单引号转义（防注入）', () => {
  const sql = compileFilter({ field: 'tag', op: '==', value: "A'; DROP TABLE--" }, allowed);
  // == → =，单引号被转义为 \'，整个值仍是单个引号包裹的 token
  assert.equal(sql, "tag = 'A\\'; DROP TABLE--'");
  assert.ok(sql.includes("\\'"), `单引号应转义为 \'，got: ${sql}`);
});

test('TC-REQ-01-20: 反斜杠转义', () => {
  const sql = compileFilter({ field: 'tag', op: '==', value: 'a\\b' }, allowed);
  // a\b → a\\b（反斜杠翻倍）
  assert.equal(sql, String.raw`tag = 'a\\b'`);
});

test('TC-REQ-01-21: and/or 嵌套编译', () => {
  const sql = compileFilter(
    { and: [{ field: 'tag', op: '==', value: 'A' }, { field: 'score', op: '>=', value: 0.7 }] },
    allowed,
  );
  assert.equal(sql, "(tag = 'A') AND (score >= 0.7)");

  const orSql = compileFilter(
    { or: [{ field: 'tag', op: '==', value: 'A' }, { field: 'tag', op: '==', value: 'B' }] },
    allowed,
  );
  assert.equal(orSql, "(tag = 'A') OR (tag = 'B')");
});

test('TC-REQ-01-22: 嵌套过深 → InvalidFilterError', () => {
  let deep = { not: { field: 'tag', op: '==', value: 'A' } };
  for (let i = 0; i < 33; i++) deep = { not: deep };
  assert.throws(() => compileFilter(deep, allowed), InvalidFilterError);
});

test('TC-REQ-01-22: 空 and/or 数组 → InvalidFilterError', () => {
  assert.throws(() => compileFilter({ and: [] }, allowed), InvalidFilterError);
  assert.throws(() => compileFilter({ or: [] }, allowed), InvalidFilterError);
});

test('TC-REQ-01-22: null/undefined/NaN 值 → InvalidFilterError', () => {
  assert.throws(() => compileFilter({ field: 'tag', op: '==', value: null }, allowed), InvalidFilterError);
  assert.throws(() => compileFilter({ field: 'tag', op: '==', value: undefined }, allowed), InvalidFilterError);
  assert.throws(() => compileFilter({ field: 'score', op: '==', value: NaN }, allowed), InvalidFilterError);
  assert.throws(() => compileFilter({ field: 'score', op: '==', value: Infinity }, allowed), InvalidFilterError);
});

test('TC-REQ-01-60: op 变体（==→=, !=, >, <, >=, <=）', () => {
  assert.equal(compileFilter({ field: 'score', op: '>', value: 0.5 }, allowed), 'score > 0.5');
  assert.equal(compileFilter({ field: 'score', op: '<', value: 1 }, allowed), 'score < 1');
  assert.equal(compileFilter({ field: 'score', op: '>=', value: 1 }, allowed), 'score >= 1');
  assert.equal(compileFilter({ field: 'score', op: '<=', value: 1 }, allowed), 'score <= 1');
  assert.equal(compileFilter({ field: 'tag', op: '!=', value: 'A' }, allowed), "tag != 'A'");
  assert.equal(compileFilter({ field: 'tag', op: '==', value: 'A' }, allowed), "tag = 'A'");
});

test('TC-REQ-01-60: boolean 值渲染为 true/false', () => {
  assert.equal(compileFilter({ field: 'flag', op: '==', value: true }, allowed), 'flag = true');
  assert.equal(compileFilter({ field: 'flag', op: '!=', value: false }, allowed), 'flag != false');
});

test('TC-REQ-01-60: not 子句正常路径', () => {
  const sql = compileFilter({ not: { field: 'tag', op: '==', value: 'A' } }, allowed);
  assert.equal(sql, "NOT (tag = 'A')");
});

test('TC-REQ-01-60: 数字值原样输出（整数/浮点/负数）', () => {
  assert.equal(compileFilter({ field: 'score', op: '==', value: 0 }, allowed), 'score = 0');
  assert.equal(compileFilter({ field: 'score', op: '==', value: -1.5 }, allowed), 'score = -1.5');
});

test('buildAllowedFields 含 fts.field', () => {
  assert.ok(allowed.has('content'), 'fts.field content 应在白名单');
  assert.ok(allowed.has('tag'));
  assert.ok(!allowed.has('nope'));
});
