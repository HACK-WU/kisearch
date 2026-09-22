/**
 * types.ts —— ZvecEngine 公共类型定义
 *
 * 与设计文档对齐：
 *   - S-01 §4b 配置结构（ZvecEngineConfig / ZvecEngineOpenConfig / ScalarFieldDef / FtsConfig / SchemaAssert）
 *   - S-01 §4b 持久化结构（PersistedSchema）
 *   - S-01 §4b 文档输入（DocInput / ScalarValue）
 *   - S-02 §4b Filter
 *   - S-05 §4b 检索请求（SearchOptions 等）与 Hit
 *   - S-06 §4b WriteResult / WriteErrorCode / CollectionInfo / Doc / ProbeResult
 */

import type { EmbeddingProvider } from './embedding/provider.js';
import type { EmbeddingBatch, EmbeddingScheduler, BatchPersistOutcome } from './embedding/batch-scheduler.js';

// ─── 基础标量 ───

export type ScalarValue = string | number | boolean;

// ─── Schema（S-01 §4b） ───

export interface ScalarFieldDef {
  name: string;
  dataType: 'STRING' | 'BOOL' | 'INT32' | 'INT64' | 'FLOAT' | 'DOUBLE' | 'UINT32' | 'UINT64';
  indexed?: boolean;
}

export interface FtsConfig {
  field: string;
  tokenizer: 'standard' | 'whitespace' | 'jieba';
  filters?: ('lowercase' | 'ascii_folding' | 'stemmer')[];
  jiebaDictDir?: string;
}

export interface SchemaAssert {
  dimension?: number;
  metric?: 'COSINE';
  scalarFields?: ScalarFieldDef[];
  fts?: FtsConfig;
}

export interface ZvecEngineConfig {
  dbPath: string;
  collection: {
    name: string;
    /** Hybrid collection 才提供 dense schema；FTS-only collection 省略。 */
    denseField?: string;
    dimension?: number;
    metric?: 'COSINE';
    denseDataType?: 'FP32' | 'FP16';
    scalarFields: ScalarFieldDef[];
    fts?: FtsConfig;
  };
  /** FTS-only collection 不需要 embedding provider。 */
  embedding?: EmbeddingProvider;
}

export interface ZvecEngineOpenConfig {
  dbPath: string;
  collectionName: string;
  embedding?: EmbeddingProvider;
  readOnly?: boolean;
  schemaAssert?: SchemaAssert;
}

export interface PersistedSchema {
  name: string;
  denseField?: string;
  dimension?: number;
  metric?: string;
  denseDataType?: string;
  scalarFields: ScalarFieldDef[];
  fts?: FtsConfig;
}

// ─── 文档（S-01 §4b / S-06 §4b） ───

export interface DocInput {
  id: string;
  text?: string;
  vector?: number[];
  fields?: Record<string, ScalarValue>;
}

export interface Doc {
  id: string;
  vector?: number[];
  fields?: Record<string, ScalarValue>;
  text?: string;
}

// ─── Filter（S-02 §4b） ───

export type Filter =
  | { field: string; op: '==' | '!=' | '>' | '<' | '>=' | '<='; value: ScalarValue }
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter };

// ─── 检索（S-05 §4b） ───

export interface SearchOptions {
  topk?: number;
  filter?: Filter;
  outputFields?: string[];
  includeVector?: boolean;
}

export interface SemanticSearchReq extends SearchOptions {
  queryText: string;
}

export interface VectorSearchReq extends SearchOptions {
  vector: number[];
}

export interface FtsSearchReq extends SearchOptions {
  match: string;
}

export interface HybridSearchReq extends SearchOptions {
  /**
   * 语义侧文本（内部 embed 成 vector）。与 `vector` 互斥。
   */
  queryText?: string;
  /**
   * 语义侧预计算向量。与 `queryText` 互斥。
   */
  vector?: number[];
  /**
   * 关键词侧串（独立字段，不与 queryText/vector 互斥）。
   */
  fts?: string;
  rerank?: {
    type: 'rrf' | 'weighted';
    weights?: Record<string, number>;
    rankConstant?: number;
  };
}

export interface Hit {
  id: string;
  /**
   * 归一化相关性分：越大越相关。
   * - vector 路（COSINE）：1/(1+distance)，值域 [1/3, 1]
   * - fts 路：BM25 原值
   * - hybrid 路：RRF/加权融合分
   */
  score: number;
  queryType: 'vector' | 'fts' | 'hybrid';
  fields: Record<string, ScalarValue>;
  text?: string;
  vector?: number[];
}

// ─── 写入结果（S-06 §4b） ───

export type WriteErrorCode =
  | 'EMBEDDING_FAILED'
  | 'EMBED_ITEM_MAPPING_INVALID'
  | 'ID_CONFLICT'
  | 'NOT_FOUND'
  | 'ZVEC_WRITE_ERROR'
  | 'UNKNOWN';

export interface WriteResult {
  ok: number;
  failed: number;
  attempted?: number;
  errors?: Array<{ id: string; code: WriteErrorCode; reason: string }>;
  /** provider/调度器因取消而未启动或丢弃的条目数。 */
  cancelled?: number;
  cancelledItems?: string[];
  failedItems?: string[];
  /** zvec 已成功但上层元数据回调未完成的条目数。 */
  metadataPending?: number;
  metadataPendingItems?: string[];
  status?: 'succeeded' | 'partial' | 'failed' | 'cancelled';
}

export interface VectorWriteBatchPersistedEvent {
  sequence: number;
  items: Array<{ docId: string; inputIndex: number; memoryId?: string }>;
  zvecPersisted: number;
  failed: number;
}

export interface ZvecWriteOptions {
  scheduler?: EmbeddingScheduler;
  abortSignal?: AbortSignal;
  onProgress?: (progress: {
    phase: 'embedding' | 'vectorize' | 'persist';
    done: number;
    total: number;
    persisted?: number;
    failed?: number;
    metadataPending?: number;
    cancelled?: number;
  }) => void;
  onBatchPersisted?: (
    event: VectorWriteBatchPersistedEvent,
    batch: EmbeddingBatch<DocInput>,
  ) => Promise<BatchPersistOutcome | void> | BatchPersistOutcome | void;
}

// ─── 集合信息（S-06 §4b） ───

export interface CollectionInfo {
  name: string;
  dimension?: number;
  metric?: 'COSINE';
  denseDataType?: 'FP32' | 'FP16';
  docCount: number;
  scalarFields: ScalarFieldDef[];
  fts?: FtsConfig;
  locked?: boolean;
}

// ─── probe（S-06 §4a） ───

export type ProbeResult =
  | { exists: false; locked: false; healthy: false; error: 'NOT_FOUND' }
  | { exists: true; locked: boolean; healthy: true }
  | { exists: true; locked: false; healthy: false; error: 'CORRUPTED' | 'UNKNOWN' };
