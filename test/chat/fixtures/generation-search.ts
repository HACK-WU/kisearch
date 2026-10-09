/** 注册表夹具（批次 2）：tool-loop 经 jiti 别名 `../mcp-tool-registry.js` 指到本文件。
 *  仅提供 ki_search 入口；run 支持 "wait" 门控（供中止测试挂起）。
 *  被 tool-cancellation-integrity / tool-source-integrity 使用。 */
import type { ToolDef } from '../../../src/lib/chat/llm-client.js';

const waitKey = Symbol.for('ki.chat.test.waiting-search');
const registry = globalThis as unknown as Record<symbol, { entered: boolean; release?: () => void }>;
export const waitingSearch = registry[waitKey] ?? (registry[waitKey] = { entered: false });

const KI_SEARCH_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'ki_search',
    description: 'fixture ki_search',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
};

function parseKiSearch(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('ki_search 参数为空：期望 JSON 对象');
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ki_search 参数应为 JSON 对象');
  const obj = parsed as Record<string, unknown>;
  const q = obj.query;
  if (typeof q !== 'string' || q.trim().length === 0) throw new Error('ki_search 缺少必填参数 query');
  const out: Record<string, unknown> = { query: q };
  if (obj.mode === 'fulltext' || obj.mode === 'hybrid') out.mode = obj.mode;
  const limit = Number(obj.limit);
  if (Number.isFinite(limit)) out.limit = Math.min(Math.max(Math.floor(limit), 1), 5);
  return out;
}

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

const kiSearchEntry = {
  name: 'ki_search',
  def: KI_SEARCH_DEF,
  readOnly: true,
  producesSources: true,
  parse: parseKiSearch,
  run: (scope: string, args: Record<string, unknown>) => runKbSearch(scope, args as { query: string }),
  describe: (args: Record<string, unknown>) => ({ query: args.query as string, mode: args.mode as string | undefined }),
};

export function getChatTool(name: string) {
  return name === 'ki_search' ? kiSearchEntry : undefined;
}

export function enabledChatToolEntries(tools: Record<string, boolean>) {
  return tools.ki_search === true ? [kiSearchEntry] : [];
}
