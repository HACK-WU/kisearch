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
import type { VectorizationStopReason } from './errors.js';

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
  /**
   * 额外返回分路原始分（`Hit.routeScores`）。
   *
   * 打开后引擎改为「逐路查询 + 自行融合」，排序结果与原生多路融合一致，
   * 但能多带出「向量路绝对相似度 / 字面路 BM25」——跨库合并靠它做加权，
   * 不必再单独跑一轮全文检索。
   */
  withRouteScores?: boolean;
  /**
   * 库内评分算法（仅 `withRouteScores=true` 时生效）。
   *
   * - `dynamic-ratio`：库内直接算出最终分并按最终分截断 —— 公式只依赖名次分的量级，
   *   不含候选池最大值，所以库内算完即可跨库比较；
   * - 其余：只带出分路分数，仍按融合分截断，由上层统一重排。
   */
  ranking?: 'weighted' | 'dynamic-ratio' | 'semantic-first' | 'calibrated-semantic' | 'calibrated-adaptive';
  /** 语义补充系数（calibrated-semantic 专用） */
  semanticBonus?: number;
  /** 只保留被向量路召回的文档（单库语义检索用） */
  requireSemanticRecall?: boolean;
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
  /**
   * hybrid 且请求了 `withRouteScores` 时的**分路原始分**：`[向量路, 字面路]`。
   *
   * 向量路是绝对相似度（1/(1+distance)），字面路是 BM25 原值 —— 两者都带绝对意义，
   * 上层做跨库合并时可以直接用它们，**不必再跑一轮检索**去取字面分。
   * 某一路没召回该文档时，该位为 0。
   */
  routeScores?: number[];
  /** 名次分（两路 `Σ 1/(k+rank)`）；用于展示分数构成 */
  rrf?: number;
  /** 定标加权分（不含语义补充）；用于展示分数构成 */
  baseScore?: number;
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
  /** 已确认系统性错误后未尝试的条目，不等同于失败或用户取消。 */
  notProcessed?: number;
  notProcessedItems?: string[];
  failedItems?: string[];
  /** zvec 已成功但上层元数据回调未完成的条目数。 */
  metadataPending?: number;
  metadataPendingItems?: string[];
  status?: 'succeeded' | 'partial' | 'failed' | 'cancelled';
  stopReason?: VectorizationStopReason;
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
  /** 各向量字段的索引完成度（0~1）；S-02 暴露，用于判定"索引是否已建" */
  indexCompleteness?: Record<string, number>;
  scalarFields: ScalarFieldDef[];
  fts?: FtsConfig;
  locked?: boolean;
}

// ─── probe（S-06 §4a） ───

export type ProbeResult =
  | { exists: false; locked: false; healthy: false; error: 'NOT_FOUND' }
  | { exists: true; locked: boolean; healthy: true }
  | { exists: true; locked: false; healthy: false; error: 'CORRUPTED' | 'UNKNOWN' };
