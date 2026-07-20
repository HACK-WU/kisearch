/**
 * index.ts —— ZvecEngine 公开导出门面
 *
 * 与设计文档对齐：S-06 §4a（修订版）
 *
 * 导出策略：
 *   - 引擎类 + 类型 + EmbeddingProvider/SiliconFlowProvider
 *   - 异常：仅导出 v5 §4.5 契约的 11 种核心类型化异常 + 基类
 *   - Worker 系列 / Embedding 系列属内部实现细节（@internal），不导出
 */

export { ZvecEngine } from './engine.js';

export type {
  // 配置
  ZvecEngineConfig,
  ZvecEngineOpenConfig,
  ScalarFieldDef,
  FtsConfig,
  SchemaAssert,
  PersistedSchema,
  // 文档
  DocInput,
  Doc,
  ScalarValue,
  // Filter
  Filter,
  // 检索
  SearchOptions,
  SemanticSearchReq,
  VectorSearchReq,
  FtsSearchReq,
  HybridSearchReq,
  Hit,
  // 写入
  WriteResult,
  WriteErrorCode,
  // 集合
  CollectionInfo,
  ProbeResult,
} from './types.js';

export { SiliconFlowProvider } from './embedding/siliconflow.js';
export type { SiliconFlowProviderConfig } from './embedding/siliconflow.js';
export type { EmbeddingProvider, EmbedOptions } from './embedding/provider.js';

export {
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
} from './errors.js';
