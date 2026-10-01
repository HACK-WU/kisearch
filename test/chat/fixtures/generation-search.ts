/** Search fixture used by the real tool loop's cross-round citation regression. */
export { parseToolCallArguments } from '../../../src/lib/chat/retrieval/kb-search-tool.js';
const waitKey = Symbol.for('ki.chat.test.waiting-search');
const registry = globalThis as unknown as Record<symbol, { entered: boolean; release?: () => void }>;
export const waitingSearch = registry[waitKey] ?? (registry[waitKey] = { entered: false });
export async function runKbSearch(_scope: string, args: { query: string }) {
  if (args.query === 'wait') {
    waitingSearch.entered = true;
    await new Promise<void>((resolve) => { waitingSearch.release = resolve; });
  }
  const docs = args.query === 'first' ? ['a', 'b', 'c', 'd', 'e'] : ['e', 'f', 'g', 'h', 'i'];
  return {
    ok: true, scope: 'default', results: docs.map((doc) => ({
      group: 'reference', relation: doc, lineStart: 1, lineEnd: 2, originalExcerpt: `evidence ${doc}`,
    })),
  };
}
