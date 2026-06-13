/**
 * path-search.ts —— 路径向量语义搜索模块
 *
 * 封装 mem search 调用，用于 Group 路径和 Relation 名称的语义模糊匹配。
 * 当精确匹配失败时，通过向量语义搜索找到最接近的真实路径。
 *
 * 设计要点：
 *   - 使用 --tags 过滤 ki-path / ki-relation，避免与 kb-import 内容向量混淆
 *   - score ≥ 阈值（默认 0.75）才视为有效匹配
 *   - 任何异常（超时/进程错误/API 失败）静默降级返回 null
 *   - 超时 15s，适合交互式查询场景
 */

import { execFileSync } from 'child_process';

// ─── 类型 ───

export interface PathSearchResult {
  /** 是否找到有效近似匹配（score ≥ 阈值） */
  matched: boolean;
  /** 匹配到的原始文本（mem 存储的完整 text） */
  rawText: string;
  /** 从 rawText 中提取的路径/名称 */
  extractedPath: string;
  /** 向量匹配分数 */
  score: number;
}

interface MemSearchJsonResult {
  details?: {
    count?: number;
    memories?: Array<{
      id: string;
      text: string;
      score?: number;
      sources?: {
        vector?: {
          score: number;
          rank?: number;
        };
      };
    }>;
  };
}

// ─── 常量 ───

const DEFAULT_THRESHOLD = 0.75;
const SEARCH_TIMEOUT_MS = 15_000;

// ─── 主函数 ───

/**
 * 搜索路径向量（Group 路径或 Relation 名称）
 *
 * @param query     用户输入的路径/名称
 * @param tag       搜索标签：ki-path 或 ki-relation
 * @param scope     当前 scope
 * @param threshold 匹配阈值，默认 0.75
 * @returns         搜索结果；超时/失败返回 null（调用方应静默降级）
 */
export function searchPath(
  query: string,
  tag: 'ki-path' | 'ki-relation',
  scope: string,
  threshold: number = DEFAULT_THRESHOLD
): PathSearchResult | null {
  if (!query || !query.trim()) return null;

  try {
    const stdout = execFileSync(
      'mem',
      [
        'search', query,
        '--scope', scope,
        '--tags', tag,
        '--limit', '1',
        '--json',
      ],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SEARCH_TIMEOUT_MS,
      }
    );

    const json = parseSearchJson(stdout);
    const memories = json?.details?.memories;
    if (!memories?.length) {
      return { matched: false, rawText: '', extractedPath: '', score: 0 };
    }

    const top = memories[0];
    // 优先使用 vector score（纯嵌入余弦相似度），fallback 到 hybrid score
    const score = top.sources?.vector?.score ?? top.score ?? 0;
    const content = top.text;
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
    const e = err as Error & { killed?: boolean; code?: string };
    const isTimeout = e.killed || e.code === 'ETIMEDOUT';
    if (isTimeout) {
      process.stderr.write(`[path-search] 搜索超时(${SEARCH_TIMEOUT_MS}ms)，跳过向量兗底\n`);
    } else {
      process.stderr.write(`[path-search] 搜索失败，跳过向量兗底: ${e.message}\n`);
    }
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

  // mem search 可能给 text 加上 【标签:xxx】 前缀，先剥离
  let text = content.replace(/^【标签:[^】]*】\s*/, '');

  if (tag === 'ki-path') {
    // 取 | 之前的路径部分，空格转回 /
    const pathPart = text.split('|')[0].trim();
    return pathPart.replace(/\s+/g, '/');
  }

  // ki-relation: 取第一个 | 之前的名称部分
  const namePart = text.split('|')[0].trim();
  return namePart;
}

function parseSearchJson(stdout: string): MemSearchJsonResult | null {
  const trimmed = stdout.trim();
  try {
    // mem --json 输出以 { 开头（前面可能有 info 行），不以 [ 开头
    if (trimmed.startsWith('{')) {
      return JSON.parse(trimmed);
    }
    // 从末尾找最后一个 JSON 对象
    const lastBrace = trimmed.lastIndexOf('\n{');
    if (lastBrace >= 0) {
      return JSON.parse(trimmed.slice(lastBrace + 1));
    }
    return null;
  } catch {
    return null;
  }
}
