/**
 * search/normalize.ts —— score 归一化
 *
 * 与设计文档对齐：S-05 §3.3 / §3.4 / §4a
 *
 *   - vector 路（COSINE）：score = 1 / (1 + distance)，distance ∈ [0,2] → score ∈ [1/3, 1]
 *   - fts 路：BM25 原值（zvec 已"越大越相关"），不转换
 *   - hybrid 路：RRF 融合分，不转换
 *   - distance 异常（<0 或 >2）clamp 到 [0,2]；NaN/undefined → 该 Hit 丢弃
 */

import { SchemaMismatchError } from '../errors.js';
import type { Hit, ScalarValue } from '../types.js';
import type { RawHitPayload } from '../worker-protocol.js';

export function normalizeVectorScore(distance: number, metric: 'COSINE'): number {
  if (metric !== 'COSINE') {
    throw new SchemaMismatchError(
      `normalizeVectorScore only supports COSINE, got: ${metric}`,
      { data: { metric } },
    );
  }
  const clamped = Math.max(0, Math.min(2, distance));
  return 1 / (1 + clamped);
}

export interface ToHitOptions {
  queryType: 'vector' | 'fts' | 'hybrid';
  metric: 'COSINE';
  includeVector?: boolean;
}

/**
 * 把 worker 返回的 RawHitPayload 转为 Hit。
 * vector 路：distance → score；fts/hybrid 路：score 直通。
 * distance 为 NaN/undefined 时返回 null（调用方应丢弃）。
 */
export function toHit(raw: RawHitPayload, opts: ToHitOptions): Hit | null {
  let score: number;
  if (opts.queryType === 'vector') {
    if (raw.distance === undefined || Number.isNaN(raw.distance)) {
      return null;
    }
    score = normalizeVectorScore(raw.distance, opts.metric);
  } else {
    if (raw.score === undefined || Number.isNaN(raw.score)) {
      return null;
    }
    score = raw.score;
  }

  const hit: Hit = {
    id: raw.id,
    score,
    queryType: opts.queryType,
    fields: raw.fields as Record<string, ScalarValue>,
    text: raw.text,
  };
  if (opts.includeVector && raw.vector) {
    hit.vector = Array.from(raw.vector);
  }
  return hit;
}
