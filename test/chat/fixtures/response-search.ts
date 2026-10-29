/** 注册表夹具（批次 2）：tool-loop 经 jiti 别名 `../mcp-tool-registry.js` 指到本文件。
 *  仅提供 ki_search 入口，run 行为由各测试自行定义（本文件被 tool-response-integrity 使用）。
 *  ⚠️ 夹具是独立最小实现（不经真实 registry）⇒ **真实模块新增/变更导出时必须同步本文件**，
 *     否则 alias 替换后调用即抛错（2026-10-15 实际踩过：缺 applyBudgetDefault 让工具类测试整条挂掉）。 */
import type { ToolDef } from '../../../src/lib/chat/llm-client.js';

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
  // 硬上界（REQ-20261015-001 由 5 放开到 50）—— 与真实 spec 的 `maxHitsPerCallHardMax` 同源口径
  if (Number.isFinite(limit)) out.limit = Math.min(Math.max(Math.floor(limit), 1), 50);
  return out;
}

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

/** 预算补全（REQ-20261015-001）：语义与真实注册表的 `applyBudgetDefault` 一致（见文件头同步说明）。 */
export function applyBudgetDefault(name: string, args: Record<string, unknown>, hitsDefault: number): Record<string, unknown> {
  if (name !== 'ki_search' || args.limit !== undefined) return args;
  return { ...args, limit: hitsDefault };
}
