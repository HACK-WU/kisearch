/**
 * path-search.ts —— 路径向量语义搜索模块（Vector Adapter 版）
 *
 * 封装 vectorSearch 调用，用于 Group 路径和 Relation 名称的语义模糊匹配。
 * 当精确匹配失败时，通过向量语义搜索找到最接近的真实路径。
 *
 * 设计要点：
 *   - 使用 tags 过滤 ki-path / ki-relation，避免与 kb-import 内容向量混淆
 *   - 底层走 hybridSearch（RRF 融合分），返回 top-1 候选
 *   - ⚠️ 阈值语义变更：mem 版基于余弦分（0-1）阈值 0.75；vector 版返回 RRF 融合分
 *     （量级远小于 1），故默认阈值改为 0（接受 top-1），由调用方（group-resolve /
 *     get-module-info）对候选路径做存在性二次校验来保证质量。
 *   - 任何异常（网络/服务不可用/API 失败）静默降级返回 null
 */

import { vectorSearch } from './vector-client.js';

// ─── 类型 ───

export interface PathSearchResult {
  /** 是否找到有效近似匹配（score ≥ 阈值） */
  matched: boolean;
  /** 匹配到的原始文本（存储的完整 text） */
  rawText: string;
  /** 从 rawText 中提取的路径/名称 */
  extractedPath: string;
  /** 向量匹配分数（RRF 融合分） */
  score: number;
}

// ─── 常量 ───

// RRF 融合分量级远小于 1，不能沿用 mem 余弦阈值 0.75，默认 0（接受 top-1，由下游校验兜底）
const DEFAULT_THRESHOLD = 0;

// ─── 主函数 ───

/**
 * 搜索路径向量（Group 路径或 Relation 名称）
 *
 * @param query     用户输入的路径/名称
 * @param tag       搜索标签：ki-path 或 ki-relation
 * @param scope     当前 scope
 * @param threshold 匹配阈值，默认 0（RRF 分，由下游存在性校验兜底质量）
 * @returns         搜索结果；服务不可用/失败返回 null（调用方应静默降级）
 */
export async function searchPath(
  query: string,
  tag: 'ki-path' | 'ki-relation',
  scope: string,
  threshold: number = DEFAULT_THRESHOLD
): Promise<PathSearchResult | null> {
  if (!query || !query.trim()) return null;

  try {
    const results = await vectorSearch({
      scope,
      query,
      tags: tag,
      limit: 1,
    });

    if (!results.length) {
      return { matched: false, rawText: '', extractedPath: '', score: 0 };
    }

    const top = results[0];
    const score = top.score ?? 0;
    const content = top.content;
    const extractedPath = extractPathFromContent(content, tag);

    if (score >= threshold) {
      return {
        matched: true,
        rawText: content,
        extractedPath,
        score,
      };
    }

    return { matched: false, rawText: content, extractedPath: '', score };
  } catch (err) {
    // 静默降级：所有异常统一返回 null
    process.stderr.write(`[path-search] 搜索失败，跳过向量兜底: ${(err as Error).message}\n`);
    return null;
  }
}

// ─── 辅助函数 ───

/**
 * 从向量文本中提取路径/名称
 *
 * ki-path 格式: "告警系统设计 告警收敛机制 | 告警收敛,降噪"
 *   → 提取: "告警系统设计/告警收敛机制"（空格转回斜杠）
 *
 * ki-relation 格式: "告警收敛服务 | Group: 告警系统设计 告警处理服务 | 收敛,去重"
 *   → 提取: "告警收敛服务"（Relation 名称部分）
 */
function extractPathFromContent(content: string, tag: 'ki-path' | 'ki-relation'): string {
  if (!content) return '';

  // 可能给 text 加上 【标签:xxx】 前缀，先剥离
  const text = content.replace(/^【标签:[^】]*】\s*/, '');

  if (tag === 'ki-path') {
    // 取 | 之前的路径部分，空格转回 /
    const pathPart = text.split('|')[0].trim();
    return pathPart.replace(/\s+/g, '/');
  }

  // ki-relation: 取第一个 | 之前的名称部分
  const namePart = text.split('|')[0].trim();
  return namePart;
}
