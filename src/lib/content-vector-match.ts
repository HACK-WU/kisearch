/**
 * 内容向量（tag ∈ {`ki-search`, 文档自定义 tag}）的**归属判定与 docId 重算**（唯一实现）。
 *
 * 为什么需要独立一层：内容向量的 docId = `sha256(正文 + scope + tag)`，**与 group / relation
 * 无关**，而写入侧只在成功时把 docId 回写 cache。一旦补写失败、tag 变更或写入形态切换，
 * cache 的 `memoryIds` 就会指向不存在的 id —— 此时「删掉/摘掉这篇文档的内容向量」只剩两条路：
 *
 *   ① **重算 docId**（精确，不调用 embedding）：正文在手就能算回整篇形态的全部 docId；
 *   ② **语义检索 + 归属判定**（兜底，需要 embedding）：检索命中后判断该条是否属于这篇。
 *
 * 两条路都被 `delete-relation`（删除文档）与 `visibility-index`（hidden 摘除）使用。
 * 判据必须同源：分叉的后果是「删除删得掉、hidden 摘不掉」，或反过来。
 *
 * 已知局限（务必知情，不要假装覆盖）：导入型文档的内容向量是按 chunkSize 切开的多条
 * `chunk` 文本，若正文被清洗过，重算与「正文包含」都可能失配；这类残留只能显式报出
 * 让用户 `ki scope clear --tags` / 重建索引处置。
 */

import { generateDocId } from './vector-client.js';

/**
 * 判据生效的最短文本长度。
 *
 * 太短的片段会把「共享模板头 / 目录 / 引用整段他人原文」误判成本篇内容 —— 误删他人向量
 * 需要重建索引才能恢复，比漏删一条孤儿严重得多。chunkSize 默认 1000，正常 chunk 远长于
 * 这个阈值；只有末尾残片可能更短，此时宁可漏删并让调用方在 reason 里报缺口。
 */
export const MIN_CONTENT_MATCH_LEN = 40;

/** 检索兜底单次取回的候选数（tag 多的库里 20 条会被别的文档挤满） */
export const CONTENT_FALLBACK_SEARCH_LIMIT = 50;

/** 内容向量可能用到的 tag 集合：默认 tag + 文档自定义 tag（与 sync-relation 写入集合一致） */
export function contentVectorTags(tags?: string[]): string[] {
  return [...new Set(['ki-search', ...(tags ?? []).filter((t) => Boolean(t) && t !== 'ki-search')])];
}

/** 按正文重算内容向量的全部 docId（整篇形态；每个 tag 一条） */
export function recomputeContentVectorIds(scope: string, content: string, tags?: string[]): string[] {
  if (!content) return [];
  return contentVectorTags(tags).map((tag) => generateDocId(content, scope, tag));
}

/**
 * 从 local KB 的条目值里取正文（结构：`string | { moduleInfo | content }`）。
 *
 * 三态语义：`null` = 条目不存在或形态不认识（调用方据此放弃重算并保持 fail-loud，
 * 不要当成「空正文」继续算一个必然不命中的 docId）。
 */
export function extractKbBody(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as { moduleInfo?: unknown; content?: unknown };
    if (typeof obj.moduleInfo === 'string') return obj.moduleInfo;
    if (typeof obj.content === 'string') return obj.content;
  }
  return null;
}

/** 只依赖检索结果的最小形状（避免把 vector-client 的完整类型泄漏到调用方） */
export interface ContentVectorHit {
  memoryId: string;
  content?: string;
  tag?: string;
}

export interface ContentVectorMatchParams {
  relation: string;
  /** 删除/摘除前读到的正文；null/undefined 表示取不到（只能用标题判据） */
  body?: string | null;
  /**
   * 同组其他文档的正文 —— 用于排除「公共段落」造成的误判。
   * 一条命中若同时被别的文档正文包含，说明它无法唯一归属，直接放弃（记 `ambiguous`）：
   * 误删他人向量不可逆（要重建索引），漏一条孤儿还能被 reason 显式报出。
   */
  siblingBodies?: string[];
}

export interface ContentVectorMatchResult {
  hits: ContentVectorHit[];
  /** 其中靠「正文比对」命中的条数（诊断用：>0 说明标题判据本来就会漏） */
  bodyMatched: number;
  /** 因同时命中其他文档正文而放弃的条数（歧义） */
  ambiguous: number;
}

/** 标题判据的边界：relation 后必须是非字母数字字符（中英文均排除）或行尾 */
const TITLE_BOUNDARY = '(?=[^a-zA-Z0-9\\u4e00-\\u9fa5]|$)';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从检索命中里挑出「属于这篇文档的内容向量」。
 *
 * 判据（任一命中即归属；`ki-relation` / `ki-path` 一律排除 —— 它们由专职函数清理，
 * 混进来既重复又会让对方事后误报"未删除"）：
 *  ① 正文比对：`正文包含 content`，且该 content **不被同组其他文档正文包含**（排除公共段落）。
 *     内容向量存的就是正文本身或它按 chunkSize 切出的片段，因此这是最可靠的归属证据。
 *  ② 标题前缀（历史判据，退路）：relation 名以 `# ` / `### ` / 行首出现。
 *     正文标题与 relation 名不一致时必然匹配不上 —— 这正是「删完仍能搜到」的直接原因，
 *     所以它只能当退路，不能当唯一判据；且必须有最小长度，避免短串撞车。
 */
export function pickContentVectorHits(
  hits: ContentVectorHit[],
  params: ContentVectorMatchParams,
): ContentVectorMatchResult {
  const body = (params.body ?? '').trim();
  const siblingBodies = (params.siblingBodies ?? []).filter((item): item is string => Boolean(item));
  const titlePatterns = [
    new RegExp(`^#\\s*${escapeRegExp(params.relation)}${TITLE_BOUNDARY}`, 'mu'),
    new RegExp(`^###\\s*${escapeRegExp(params.relation)}${TITLE_BOUNDARY}`, 'mu'),
    new RegExp(`^${escapeRegExp(params.relation)}${TITLE_BOUNDARY}`, 'mu'),
  ];
  const matched: ContentVectorHit[] = [];
  let bodyMatched = 0;
  let ambiguous = 0;

  for (const hit of hits) {
    if (hit.tag === 'ki-relation' || hit.tag === 'ki-path') continue;
    const clean = (hit.content || '').replace(/^【标签:[^】]*】\s*/, '');
    const text = clean.trim();
    if (text.length < MIN_CONTENT_MATCH_LEN) continue;

    if (body && body.includes(text)) {
      if (siblingBodies.some((other) => other.includes(text))) {
        ambiguous += 1;
        continue;
      }
      bodyMatched += 1;
      matched.push(hit);
      continue;
    }
    if (titlePatterns.some((pattern) => pattern.test(clean))) matched.push(hit);
  }

  return { hits: matched, bodyMatched, ambiguous };
}
