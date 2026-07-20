/**
 * zvec-engine-errors.test.mjs —— 异常类型化体系（TC-ERR-01）
 *
 * 纯函数测试，无需 worker / zvec。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZvecEngineError,
  DimensionMismatchError,
  InvalidSchemaError,
  InvalidDocInputError,
  InvalidSearchError,
  InvalidFilterError,
  SchemaMismatchError,
  InconsistentUpdateError,
  CollectionNotFoundError,
  CollectionLockedException,
  CollectionCorruptedException,
  CollectionAlreadyExistsError,
} from '../dist/zvec-engine/index.js';

const EXPORTED_ERRORS = [
  DimensionMismatchError,
  InvalidSchemaError,
  InvalidDocInputError,
  InvalidSearchError,
  InvalidFilterError,
  SchemaMismatchError,
  InconsistentUpdateError,
  CollectionNotFoundError,
  CollectionLockedException,
  CollectionCorruptedException,
  CollectionAlreadyExistsError,
];

test('TC-ERR-01: 所有导出异常 instanceof ZvecEngineError', () => {
  for (const E of EXPORTED_ERRORS) {
    const e = new E('msg');
    assert.ok(e instanceof ZvecEngineError, `${E.name} should be instanceof ZvecEngineError`);
    assert.equal(e.name, E.name);
    assert.ok(e instanceof Error);
  }
});

test('ZvecEngineError 携带 code/data/cause 字段', () => {
  const cause = new Error('root');
  const e = new DimensionMismatchError('m', { code: 'DIM', data: { x: 1 }, cause });
  assert.equal(e.code, 'DIM');
  assert.deepEqual(e.data, { x: 1 });
  assert.equal(e.cause, cause);
  assert.equal(e.message, 'm');
});

test('ZvecEngineError 默认 code/data 为 undefined', () => {
  const e = new InvalidSchemaError('m');
  assert.equal(e.code, undefined);
  assert.equal(e.data, undefined);
});

test('ERROR_CONSTRUCTORS 反序列化覆盖（name → 构造器）', async () => {
  const { ERROR_CONSTRUCTORS } = await import('../dist/zvec-engine/errors.js');
  for (const E of EXPORTED_ERRORS) {
    assert.equal(ERROR_CONSTRUCTORS[E.name], E, `${E.name} 应在 ERROR_CONSTRUCTORS 中`);
  }
  assert.equal(ERROR_CONSTRUCTORS.ZvecEngineError, ZvecEngineError);
});
