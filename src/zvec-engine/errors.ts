/**
 * errors.ts —— ZvecEngine 类型化异常
 *
 * 与设计文档对齐：S-06 §4b
 *
 * 约定：
 *   - 所有基座异常继承 ZvecEngineError，调用方可 instanceof 统一识别
 *   - code/data 与 worker-protocol SerializedError 一一对应，支持跨线程反序列化重建
 */

export interface ZvecEngineErrorOptions {
  code?: string;
  data?: Record<string, unknown>;
  cause?: unknown;
}

/** Typed systemic failure that tells callers to stop all remaining vector batches. */
export type VectorizationStopKind =
  | 'dimension'
  | 'configuration'
  | 'authentication'
  | 'provider-unavailable'
  | 'resource'
  | 'collection-unwritable'
  | 'metadata'
  | 'unknown';

export interface VectorizationStopReason {
  kind: VectorizationStopKind;
  code: string;
  phase: 'embedding' | 'persist';
  reason: string;
}

export function classifyVectorizationStop(
  error: Error,
  phase: VectorizationStopReason['phase'],
): VectorizationStopReason {
  const candidate = error as Error & { code?: string; data?: Record<string, unknown> };
  const code = candidate.code ?? error.name ?? 'UNKNOWN';
  const status = typeof candidate.data?.status === 'number'
    ? candidate.data.status
    : Number(/^HTTP_(\d{3})$/.exec(code)?.[1] ?? 0);
  let kind: VectorizationStopKind;
  if (error.name === 'DimensionMismatchError' || candidate.data?.expectedDim !== undefined || code === 'VECTOR_DIMENSION_MISMATCH') {
    kind = 'dimension';
  } else if (status === 401 || status === 403 || /AUTH|API_KEY|CREDENTIAL/i.test(code)) {
    kind = 'authentication';
  } else if (code === 'VECTORIZE_RESOURCE_ADMISSION') {
    kind = 'resource';
  } else if (phase === 'persist') {
    kind = code === 'METADATA_PERSIST_FAILED' ? 'metadata' : 'collection-unwritable';
  } else if (code === 'NETWORK' || code === 'TIMEOUT' || status === 429 || status >= 500) {
    kind = 'provider-unavailable';
  } else {
    kind = 'configuration';
  }
  return { kind, code, phase, reason: error.message };
}

export class ZvecEngineError extends Error {
  readonly code?: string;
  readonly data?: Record<string, unknown>;

  constructor(message: string, options?: ZvecEngineErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = options?.code;
    this.data = options?.data;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

// ─── Schema / 配置类 ───

export class DimensionMismatchError extends ZvecEngineError {}
export class InvalidSchemaError extends ZvecEngineError {}
export class InvalidDocInputError extends ZvecEngineError {}
export class InvalidSearchError extends ZvecEngineError {}
export class InvalidFilterError extends ZvecEngineError {}
export class SchemaMismatchError extends ZvecEngineError {}
/**
 * update 联动规则违反（批级抛出，不进 errors[]）：
 *   - update 只传 vector 不传 text 且集合配置了 FTS（避免向量更新而 FTS 索引停留旧原文，
 *     导致 ftsSearch/hybridSearch 漏召回且无告警，见 §4.5 update 联动规则）
 *   - update 缺 dense vector（Z-03：zvec updateSync 要求 dense vector 必填；
 *     "仅传 fields 只改标量"在 zvec 0.6.0 下不可实现，须提供 vector 或 text 重嵌）
 */
export class InconsistentUpdateError extends ZvecEngineError {}

// ─── 集合生命周期类 ───

export class CollectionNotFoundError extends ZvecEngineError {}
export class CollectionLockedException extends ZvecEngineError {}
export class CollectionCorruptedException extends ZvecEngineError {}
export class CollectionAlreadyExistsError extends ZvecEngineError {}

// ─── Embedding 类（@internal，不在 index.ts 导出） ───

/** @internal */
export class EmbeddingError extends ZvecEngineError {}
/** @internal */
export class EmbeddingConfigError extends ZvecEngineError {}

// ─── Worker 类（@internal，不在 index.ts 导出） ───

/** @internal */
export class WorkerSpawnError extends ZvecEngineError {}
/** @internal */
export class WorkerCrashedError extends ZvecEngineError {}
/** @internal */
export class WorkerUnavailableError extends ZvecEngineError {}
/** @internal */
export class WorkerProtocolError extends ZvecEngineError {}
/** @internal */
export class CloseTimeoutError extends ZvecEngineError {}

// ─── 异常名称 → 构造器映射（供 worker-protocol deserializeError 使用） ───

export const ERROR_CONSTRUCTORS: Record<string, new (message: string, options?: ZvecEngineErrorOptions) => ZvecEngineError> = {
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
  EmbeddingError,
  EmbeddingConfigError,
  WorkerSpawnError,
  WorkerCrashedError,
  WorkerUnavailableError,
  WorkerProtocolError,
  CloseTimeoutError,
};
