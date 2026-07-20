/**
 * search/router.ts —— 检索请求路由（退化矩阵）
 *
 * 与设计文档对齐：S-05 §3.2 / §3.3 / §3.5
 *
 * 退化矩阵：
 *   - 有 fts 且有 queryText/vector → multiQuery 两路 RRF（queryType='hybrid'）
 *   - 缺 fts → 退单路向量（queryType='vector'）
 *   - 缺 queryText/vector → 退单路 FTS（queryType='fts'）
 *   - 三者皆缺 → InvalidSearchError
 *   - queryText + vector 同传 → InvalidSearchError（互斥）
 */

import { InvalidSearchError } from '../errors.js';
import type {
  FtsSearchReq,
  HybridSearchReq,
  SemanticSearchReq,
  VectorSearchReq,
} from '../types.js';
import type { MultiQueryPayload, QueryPayload } from '../worker-protocol.js';

const MAX_TOPK = 1000;
const DEFAULT_TOPK = 10;
const MAX_TEXT_LEN = 10_000;

export interface RouterContext {
  denseField: string;
  ftsField?: string;
  dimension: number;
}

export interface RoutedSearch {
  kind: 'query' | 'multiQuery';
  payload: QueryPayload | MultiQueryPayload;
  queryType: 'vector' | 'fts' | 'hybrid';
  needsEmbed: boolean;
  embedTexts?: string[];
}

type AnySearchReq = SemanticSearchReq | VectorSearchReq | FtsSearchReq | HybridSearchReq;

export function routeSearch(req: AnySearchReq, ctx: RouterContext): RoutedSearch {
  validateCommon(req);

  if ('match' in req) {
    return routeFts(req, ctx);
  }

  const hybrid = req as HybridSearchReq;
  const hasQueryText = typeof hybrid.queryText === 'string' && hybrid.queryText.length > 0;
  const hasVector = Array.isArray(hybrid.vector) && hybrid.vector.length > 0;
  const hasFts = typeof hybrid.fts === 'string' && hybrid.fts.length > 0;

  if (hasQueryText && hasVector) {
    throw new InvalidSearchError(
      'queryText and vector are mutually exclusive in search requests',
    );
  }

  if (hasVector) {
    validateVectorDimension(hybrid.vector!, ctx.dimension);
  }
  if (hasQueryText) {
    validateTextLength(hybrid.queryText!);
  }
  if (hasFts) {
    validateTextLength(hybrid.fts!);
    if (!ctx.ftsField) {
      throw new InvalidSearchError('collection has no fts config (fts query requires fts field)');
    }
  }

  if (hasFts && (hasQueryText || hasVector)) {
    // hybrid 两路
    return {
      kind: 'multiQuery',
      payload: {
        queries: [
          {
            fieldName: ctx.denseField,
            vector: hasVector ? Float32Array.from(hybrid.vector!) : undefined,
          },
          {
            fieldName: ctx.ftsField!,
            ftsMatchString: hybrid.fts!,
          },
        ],
        topk: req.topk ?? DEFAULT_TOPK,
        rerankRrf: hybrid.rerank?.type === 'weighted' ? undefined : { rankConstant: hybrid.rerank?.rankConstant ?? 60 },
        rerankWeighted: hybrid.rerank?.type === 'weighted'
          ? { weights: weightsToArray(hybrid.rerank.weights, [ctx.denseField, ctx.ftsField!]) }
          : undefined,
        outputFields: req.outputFields,
        includeVector: req.includeVector ?? false,
      } as MultiQueryPayload,
      queryType: 'hybrid',
      needsEmbed: hasQueryText,
      embedTexts: hasQueryText ? [hybrid.queryText!] : undefined,
    };
  }

  if (hasQueryText || hasVector) {
    // 单路向量
    return {
      kind: 'query',
      payload: {
        fieldName: ctx.denseField,
        vector: hasVector ? Float32Array.from(hybrid.vector!) : undefined,
        topk: req.topk ?? DEFAULT_TOPK,
        outputFields: req.outputFields,
        includeVector: req.includeVector ?? false,
      } as QueryPayload,
      queryType: 'vector',
      needsEmbed: hasQueryText,
      embedTexts: hasQueryText ? [hybrid.queryText!] : undefined,
    };
  }

  if (hasFts) {
    return routeFts({ match: hybrid.fts!, ...req }, ctx);
  }

  throw new InvalidSearchError(
    'search request must provide at least one of: queryText / vector / fts / match',
  );
}

function routeFts(req: FtsSearchReq, ctx: RouterContext): RoutedSearch {
  if (!ctx.ftsField) {
    throw new InvalidSearchError('collection has no fts config (fts query requires fts field)');
  }
  validateTextLength(req.match);
  return {
    kind: 'query',
    payload: {
      fieldName: ctx.ftsField,
      ftsMatchString: req.match,
      topk: req.topk ?? DEFAULT_TOPK,
      outputFields: req.outputFields,
      includeVector: req.includeVector ?? false,
    } as QueryPayload,
    queryType: 'fts',
    needsEmbed: false,
  };
}

function validateCommon(req: AnySearchReq): void {
  const topk = req.topk ?? DEFAULT_TOPK;
  if (!Number.isInteger(topk) || topk <= 0) {
    throw new InvalidSearchError(`topk must be positive integer, got: ${topk}`);
  }
  if (topk > MAX_TOPK) {
    throw new InvalidSearchError(`topk exceeds max ${MAX_TOPK}, got: ${topk}`);
  }
}

function validateVectorDimension(vector: number[], dimension: number): void {
  if (vector.length !== dimension) {
    throw new InvalidSearchError(
      `vector dimension mismatch: expected ${dimension}, got ${vector.length}`,
      { data: { expected: dimension, actual: vector.length } },
    );
  }
}

function validateTextLength(text: string): void {
  if (text.length === 0) {
    throw new InvalidSearchError('text must not be empty');
  }
  if (text.length > MAX_TEXT_LEN) {
    throw new InvalidSearchError(`text exceeds max length ${MAX_TEXT_LEN}, got: ${text.length}`);
  }
}

function weightsToArray(
  weights: Record<string, number> | undefined,
  fieldOrder: string[],
): number[] {
  if (!weights) {
    throw new InvalidSearchError('rerank.type=weighted requires weights');
  }
  return fieldOrder.map((f) => {
    const w = weights[f];
    if (typeof w !== 'number') {
      throw new InvalidSearchError(`rerank.weights missing entry for field "${f}"`);
    }
    return w;
  });
}
