import { Fragment } from 'react';

/**
 * 检索文本工具：语义检索页（SearchPage）与浏览页全文检索（BrowsePage）共用。
 *
 * 背景：此前两页各有一份实现——SearchPage 按 FTS 分隔符拆多词、片段 480 字；
 * BrowsePage 只按空白拆词、片段 320 字，导致同一关键词在两处的高亮与片段口径不一致。
 * 统一到这里后，"命中高亮 + 命中位置片段"两页行为一致。
 */

/** 正则转义：查询词直接进 RegExp 前必须过一遍 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 中文高频功能词/疑问词：它们参与后端 FTS 匹配，但作为**前端高亮词**会让正文满屏噪音
 * （例：搜「什么需要注册中心」时，"什么""需要"在技术文档里遍地都是，高亮 20 处却都不指向答案）。
 * 剔除后剩下的「注册中心」这类实词，才是用户真正想看的位置。
 */
const CJK_STOP_TERMS = new Set([
  '什么', '怎么', '怎样', '如何', '为何', '为什', '哪些', '哪个', '哪里', '是否', '能否', '可以',
  '需要', '应该', '请问', '一下', '我们', '你们', '他们', '这个', '那个', '这些', '那些',
  '以及', '并且', '但是', '因为', '所以', '如果', '那么', '还是', '或者', '就是', '一个', '没有',
]);

/**
 * 拆分查询词，供「结果高亮 / 片段定位 / 正文高亮导航」共用。
 * - 英文、数字：按空白与标点拆成整词
 * - 中文：中文无空格，后端靠分词器；前端只能用 2~4 字滑窗做近似。
 *   滑窗产生的跨词噪声（如「么需要注」）在正文里匹配不到，无害；
 *   高频功能词按上方停用表剔除，避免高亮泛滥。
 */
export function splitSearchTerms(query: string): string[] {
  const chunks = query.trim().split(/[\s_.,，。:：;；!?！？()[\]{}-]+/).filter(Boolean);
  const terms = new Set<string>();
  for (const chunk of chunks) {
    if (!/[\u4e00-\u9fff]/.test(chunk)) {
      terms.add(chunk);
      continue;
    }
    // 单字中文查询：用户明确只搜一个字，直接采用（噪音风险由用户承担）
    if (chunk.length === 1) {
      terms.add(chunk);
      continue;
    }
    for (let n = Math.min(4, chunk.length); n >= 2; n -= 1) {
      for (let i = 0; i + n <= chunk.length; i += 1) {
        const term = chunk.slice(i, i + n);
        if (!CJK_STOP_TERMS.has(term)) terms.add(term);
      }
    }
  }
  return [...terms];
}

/** 单篇文本内 2 字词的最大允许命中数：超过即视为该文档的高频泛词 */
const SHORT_TERM_HIT_LIMIT = 6;

/** 统计 needle 在 haystack 中的出现次数；超过 limit 立即返回（只需判断"是否超限"） */
function countOccurrences(haystack: string, needle: string, limit: number): number {
  if (!needle) return 0;
  const lower = haystack.toLowerCase();
  const target = needle.toLowerCase();
  let count = 0;
  let index = lower.indexOf(target);
  while (index >= 0 && count <= limit) {
    count += 1;
    index = lower.indexOf(target, index + target.length);
  }
  return count;
}

/**
 * 依据**当前文本**自适应收紧词表：2 字词若在本文本里出现次数超过阈值，说明它是该文档的高频泛词
 * （而非本次查询的特征词），剔除。
 *
 * 例：搜「什么需要注册中心」——「注册」在一篇讲服务注册的文档里出现 14 次，高亮它等于铺屏；
 * 而在只提过两三次的文档里保留，保证不漏真实命中。
 */
export function selectHighlightTerms(query: string, text: string): string[] {
  return splitSearchTerms(query).filter(
    (term) => term.length > 2 || countOccurrences(text, term, SHORT_TERM_HIT_LIMIT) <= SHORT_TERM_HIT_LIMIT,
  );
}

/** 全文检索结果中高亮查询词；无有效词时原样返回 */
export function highlightMatch(text: string, query: string): JSX.Element {
  // 长词优先：4 字词命中后，其内部的 2 字词不会在同一位置重复标记
  const terms = selectHighlightTerms(query, text)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (terms.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${terms.join('|')})`, 'gi');
  return (
    <>
      {text.split(pattern).map((part, index) =>
        terms.some((term) => new RegExp(`^${term}$`, 'i').test(part)) ? (
          <mark key={index} className="ki-search-hit-mark">
            {part}
          </mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** 将全文结果裁剪到命中词附近，避免整篇原文的开头把命中位置挤出可视区域。 */
export function makeSearchSnippet(content: string, query: string, maxLength = 480): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  const lower = normalized.toLowerCase();
  const firstMatch =
    selectHighlightTerms(query, normalized)
      .map((term) => lower.indexOf(term.toLowerCase()))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? -1;
  const start = firstMatch > 120 ? firstMatch - 120 : 0;
  const end = Math.min(normalized.length, start + maxLength);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
}
