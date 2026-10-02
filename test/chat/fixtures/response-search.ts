export { parseToolCallArguments } from '../../../src/lib/chat/retrieval/kb-search-tool.js';

export async function runKbSearch(scope: string, args: { query: string }) {
  if (args.query.includes('error')) return { ok: false, error: 'fixture unavailable', code: 'FIXTURE_ERROR', details: { retryable: false } };
  return {
    ok: true, scope, total: 8, metadata: { source: 'actual response', flags: [true, null] },
    results: Array.from({ length: 8 }, (_, i) => ({
      group: 'reference', relation: `doc-${i}`, lineStart: 1, lineEnd: 2, score: i / 10,
      originalExcerpt: args.query.includes('large') ? '😀原文'.repeat(4000) : '完整证据'.repeat(80),
    })),
  };
}
