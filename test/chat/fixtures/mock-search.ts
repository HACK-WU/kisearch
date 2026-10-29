import type { SearchResult } from '../../../src/search.js';

/** Portable retrieval fixtures: no dependency on ignored delivery artifacts or user data. */
export function mockSearchResult(kind: 'ok' | 'empty' | 'degraded' = 'ok'): SearchResult {
  return {
    ok: true,
    scope: 'kisearch',
    total: kind === 'empty' ? 0 : 8,
    ...(kind === 'degraded' ? { degraded: true } : {}),
    results: kind === 'empty' ? [] : Array.from({ length: 8 }, (_, i) => ({
      group: 'kisearch',
      relation: i === 0 ? 'ki_search 用法' : `文档 ${i + 1}`,
      memoryId: `fixture-${i}`,
      score: 1,
      indexType: 'dense' as const,
      content: '知识库检索用法',
      matches: [{ lineStart: 12 + i, lineEnd: 18 + i, excerpt: '知识库检索用法。'.repeat(120) }],
      originalExcerpt: '知识库检索用法。'.repeat(120),
    })),
  };
}

export function mockSearchResultWithoutLines(): SearchResult {
  return {
    ok: true, scope: 'kisearch', total: 1,
    results: [{ group: 'kisearch', relation: '文档级来源', memoryId: 'no-lines', score: 1, content: '没有可映射行号的内容', original: '没有可映射行号的内容' }],
  };
}
