/**
 * schema/builder.ts —— ZvecEngineConfig → ZVecCollectionSchema 转换
 *
 * 与设计文档对齐：S-01 §4a
 *
 * 关键映射：
 *   - denseField → ZVecVectorSchema（HNSW + COSINE + FP32/FP16）
 *   - scalarFields → ZVecFieldSchema（indexed=true → INVERT 倒排）
 *   - fts → 对应 scalarField 加 FtsIndexParam（tokenizer 强制显式）
 *   - 标量类型名 → ZVecDataType 数字枚举
 */

import {
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  type ZVecFieldSchema,
  type ZVecVectorSchema,
  type ZVecInvertIndexParams,
  type ZVecFtsIndexParams,
  type ZVecHnswIndexParams,
} from '@zvec/zvec';
import { InvalidSchemaError } from '../errors.js';
import type { FtsConfig, ScalarFieldDef, ZvecEngineConfig, ZvecEngineOpenConfig } from '../types.js';

const SCALAR_DATA_TYPE_MAP: Record<ScalarFieldDef['dataType'], ZVecDataType> = {
  STRING: ZVecDataType.STRING,
  BOOL: ZVecDataType.BOOL,
  INT32: ZVecDataType.INT32,
  INT64: ZVecDataType.INT64,
  FLOAT: ZVecDataType.FLOAT,
  DOUBLE: ZVecDataType.DOUBLE,
  UINT32: ZVecDataType.UINT32,
  UINT64: ZVecDataType.UINT64,
} as const;

export function buildCollectionSchema(config: ZvecEngineConfig): ZVecCollectionSchema {
  const { name, denseField, dimension, metric, denseDataType, scalarFields, fts } = config.collection;

  const vectorDataType =
    denseDataType === 'FP16' ? ZVecDataType.VECTOR_FP16 : ZVecDataType.VECTOR_FP32;

  const hnswParams: ZVecHnswIndexParams = {
    indexType: ZVecIndexType.HNSW,
    metricType: metric === 'COSINE' ? ZVecMetricType.COSINE : ZVecMetricType.UNDEFINED,
  };
  if (hnswParams.metricType === ZVecMetricType.UNDEFINED) {
    throw new InvalidSchemaError(`unsupported metric: ${metric} (only COSINE is supported)`);
  }

  const vectors: ZVecVectorSchema[] = [
    {
      name: denseField,
      dataType: vectorDataType,
      dimension,
      indexParams: hnswParams,
    },
  ];

  const fields: ZVecFieldSchema[] = scalarFields.map((sf) => {
    const isFtsField = fts !== undefined && fts.field === sf.name;
    let indexParams: ZVecInvertIndexParams | ZVecFtsIndexParams | undefined;
    if (isFtsField) {
      indexParams = buildFtsIndexParams(fts);
    } else if (sf.indexed) {
      indexParams = {
        indexType: ZVecIndexType.INVERT,
        enableRangeOptimization: false,
      };
    }
    return {
      name: sf.name,
      dataType: SCALAR_DATA_TYPE_MAP[sf.dataType],
      nullable: true,
      ...(indexParams ? { indexParams } : {}),
    };
  });

  return new ZVecCollectionSchema({ name, vectors, fields });
}

function buildFtsIndexParams(fts: FtsConfig): ZVecFtsIndexParams {
  const extraParams: Record<string, unknown> = {};
  if (fts.jiebaDictDir) {
    extraParams.jieba_dict_dir = fts.jiebaDictDir;
  }
  return {
    indexType: ZVecIndexType.FTS,
    tokenizerName: fts.tokenizer,
    filters: fts.filters ?? ['lowercase'],
    extraParams: Object.keys(extraParams).length > 0 ? JSON.stringify(extraParams) : '',
  };
}

export function collectionNameOf(config: ZvecEngineConfig | ZvecEngineOpenConfig): string {
  if ('collection' in config) return config.collection.name;
  return config.collectionName;
}
