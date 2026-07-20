/**
 * schema/validator.ts —— 配置铁律校验
 *
 * 与设计文档对齐：S-01 §3.3 / §3.4 / §3.5
 *
 *   - create 时：V-01 ~ V-07
 *   - open 时：O-01 ~ O-05
 *   - schemaAssert 逐项比对
 *   - zvec 原始错误 → 类型化异常识别规则（S-01 §3.5）
 */

import {
  CollectionAlreadyExistsError,
  CollectionCorruptedException,
  CollectionLockedException,
  CollectionNotFoundError,
  DimensionMismatchError,
  InvalidSchemaError,
  SchemaMismatchError,
  ZvecEngineError,
} from '../errors.js';
import type {
  PersistedSchema,
  ScalarFieldDef,
  SchemaAssert,
  ZvecEngineConfig,
  ZvecEngineOpenConfig,
} from '../types.js';

const COLLECTION_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{2,}$/;

// ─── create 校验（V-01 ~ V-07） ───

export function validateCreateConfig(
  config: ZvecEngineConfig,
  dbPathExists: boolean,
): void {
  const { name, dimension, metric, scalarFields, fts, denseField } = config.collection;

  // V-01 集合名合法性
  if (!COLLECTION_NAME_PATTERN.test(name)) {
    throw new InvalidSchemaError(
      `collection name "${name}" invalid: must match ${COLLECTION_NAME_PATTERN} (≥3 chars, start with letter, alphanumeric+underscore)`,
      { data: { name } },
    );
  }

  // V-02 维度铁律
  if (dimension !== config.embedding.dimension) {
    throw new DimensionMismatchError(
      `collection.dimension (${dimension}) !== embedding.dimension (${config.embedding.dimension})`,
      { data: { collectionDim: dimension, embeddingDim: config.embedding.dimension } },
    );
  }

  // V-03 metric 限定
  if (metric !== 'COSINE') {
    throw new InvalidSchemaError(
      `collection.metric must be 'COSINE', got: ${metric}`,
      { data: { metric } },
    );
  }

  // V-06 字段重名
  const seen = new Set<string>([denseField]);
  for (const sf of scalarFields) {
    if (seen.has(sf.name)) {
      throw new InvalidSchemaError(
        `duplicate field name: "${sf.name}" (conflicts with denseField or another scalarField)`,
        { data: { field: sf.name } },
      );
    }
    seen.add(sf.name);
  }

  // V-04 + V-05 FTS 校验
  if (fts !== undefined) {
    if (!fts.tokenizer) {
      throw new InvalidSchemaError(
        `fts.tokenizer is required (default 'jieba' recommended; 'standard' breaks CJK FTS)`,
      );
    }
    const ftsField = scalarFields.find((sf) => sf.name === fts.field);
    if (!ftsField) {
      throw new InvalidSchemaError(
        `fts.field "${fts.field}" not declared in scalarFields`,
        { data: { ftsField: fts.field } },
      );
    }
    if (ftsField.dataType !== 'STRING') {
      throw new InvalidSchemaError(
        `fts.field "${fts.field}" must be STRING type, got: ${ftsField.dataType}`,
        { data: { ftsField: fts.field, dataType: ftsField.dataType } },
      );
    }
  }

  // V-07 路径存在性
  if (dbPathExists) {
    throw new CollectionAlreadyExistsError(
      `dbPath already exists: ${config.dbPath} (ZVecCreateAndOpen requires non-existent path)`,
      { data: { dbPath: config.dbPath } },
    );
  }
}

// ─── open 校验（O-02 ~ O-05，O-01 由 worker 内 zvec 错误映射承担） ───

export function validateOpenConfig(
  config: ZvecEngineOpenConfig,
  persistedSchema: PersistedSchema,
): void {
  // O-02 embedding 维度 vs 持久化维度
  if (config.embedding.dimension !== persistedSchema.dimension) {
    throw new DimensionMismatchError(
      `embedding.dimension (${config.embedding.dimension}) !== persisted dimension (${persistedSchema.dimension})`,
      { data: { embeddingDim: config.embedding.dimension, persistedDim: persistedSchema.dimension } },
    );
  }

  // O-03 持久化 metric 限定
  if (persistedSchema.metric !== 'COSINE') {
    throw new SchemaMismatchError(
      `persisted metric must be 'COSINE', got: ${persistedSchema.metric}`,
      { data: { metric: persistedSchema.metric } },
    );
  }

  // O-04 schemaAssert 逐项比对
  if (config.schemaAssert) {
    assertSchemaMatch(config.schemaAssert, persistedSchema);
  }
}

export function assertSchemaMatch(
  assert: SchemaAssert,
  persisted: PersistedSchema,
): void {
  if (assert.dimension !== undefined && assert.dimension !== persisted.dimension) {
    throw new SchemaMismatchError(
      `schemaAssert.dimension (${assert.dimension}) !== persisted (${persisted.dimension})`,
      { data: { field: 'dimension', expected: assert.dimension, actual: persisted.dimension } },
    );
  }
  if (assert.metric !== undefined && assert.metric !== persisted.metric) {
    throw new SchemaMismatchError(
      `schemaAssert.metric (${assert.metric}) !== persisted (${persisted.metric})`,
      { data: { field: 'metric', expected: assert.metric, actual: persisted.metric } },
    );
  }
  if (assert.scalarFields !== undefined) {
    const persistedMap = new Map(persisted.scalarFields.map((sf) => [sf.name, sf]));
    for (const expected of assert.scalarFields) {
      const actual = persistedMap.get(expected.name);
      if (!actual) {
        throw new SchemaMismatchError(
          `schemaAssert.scalarFields: field "${expected.name}" not found in persisted schema`,
          { data: { field: expected.name } },
        );
      }
      if (actual.dataType !== expected.dataType) {
        throw new SchemaMismatchError(
          `schemaAssert.scalarFields["${expected.name}"].dataType: expected ${expected.dataType}, got ${actual.dataType}`,
          { data: { field: expected.name, expected: expected.dataType, actual: actual.dataType } },
        );
      }
    }
  }
  if (assert.fts !== undefined) {
    if (!persisted.fts) {
      throw new SchemaMismatchError(
        `schemaAssert.fts: persisted schema has no fts config`,
        { data: { field: 'fts' } },
      );
    }
    if (assert.fts.field !== persisted.fts.field) {
      throw new SchemaMismatchError(
        `schemaAssert.fts.field: expected ${assert.fts.field}, got ${persisted.fts.field}`,
        { data: { field: 'fts.field', expected: assert.fts.field, actual: persisted.fts.field } },
      );
    }
    if (assert.fts.tokenizer !== persisted.fts.tokenizer) {
      throw new SchemaMismatchError(
        `schemaAssert.fts.tokenizer: expected ${assert.fts.tokenizer}, got ${persisted.fts.tokenizer}`,
        { data: { field: 'fts.tokenizer', expected: assert.fts.tokenizer, actual: persisted.fts.tokenizer } },
      );
    }
  }
}

// ─── zvec 原始错误 → 类型化异常（S-01 §3.5） ───

/**
 * 将 worker 内 zvec 抛出的原始错误映射为本模块类型化异常。
 * 未识别的错误原样返回（不包装），避免误分类。
 */
export function mapZvecOpenError(err: unknown, dbPath: string): Error {
  if (err instanceof ZvecEngineError) return err;
  const e = err as { message?: string; code?: string };
  const msg = (e?.message ?? String(err)).toLowerCase();

  if (/can't lock|cannot lock|lock.*read-write|lock.*read-only/.test(msg)) {
    return new CollectionLockedException(
      `collection locked by another process: ${dbPath}`,
      { data: { dbPath, origin: e?.message } },
    );
  }
  if (/not exist|not found|enoent|no such file/.test(msg)) {
    return new CollectionNotFoundError(
      `collection not found: ${dbPath}`,
      { data: { dbPath, origin: e?.message } },
    );
  }
  if (/corrupt|invalid|parse|deserialize|malformed/.test(msg)) {
    return new CollectionCorruptedException(
      `collection corrupted: ${dbPath}`,
      { data: { dbPath, origin: e?.message } },
    );
  }
  // 未识别：原样返回
  return err instanceof Error ? err : new Error(String(err));
}
