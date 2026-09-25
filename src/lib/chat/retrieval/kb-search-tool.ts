/**
 * 检索工具执行器（S07 §3.2 / §3.6）
 *
 * ═══ ★ 排队口径（本文件是**入队点**）═══
 * 检索会读 zvec / local KB / relations-cache → **必须与同 scope 写操作共用
 * `OperationCoordinator`**（约定见 `src/lib/mcp-http-api.ts:318-322`）。
 *
 * 为什么入队点在这里而不是 HTTP 路由层：
 *   ① 生成请求本身（12s 长流）**不入队** —— 入队会阻塞同 scope 的检索与导入
 *   ② 只有**检索这一步**入队
 *   ③ 预检索降级路径（S07 §3.7）也复用本函数 → 入队点必须跟着函数走
 *
 * ═══ 通用语义契约 ═══
 * · 前置：`scope` 已校验；`args.query` 非空
 * · 后置：返回 `executeSearch` 原始结果（**不在此处投影** —— 投影是调用方的事）
 * · 空值：无命中返回 `{ok:true, results:[]}`，**不抛错**（由 skill 反幻觉规则处理）
 * · 错误：检索不可用 → 返回 `{ok:false,...}`（**不抛**，由 tool-loop 转 `degraded` 事件）
 * · 幂等：是（只读）
 * · 并发：经 coordinator 排队，与同 scope 写操作互斥
 * · 事务：无
 * · 副作用：仅读
 *
 * ═══ 硬约束 ═══
 * · **复用 `executeSearch`，不新建检索链路**（R18）；不绕 HTTP / MCP 自调用
 * · `scope` 由 daemon 注入，**不来自模型参数**（N23）
 * · `limit` 强制 ≤ `CHAT_BUDGET.maxHitsPerCall`（R21）
 *
 * @see design/S07_检索与工具调用_DESIGN.md §3.2 / §3.6
 */

import { executeSearch, type SearchResult } from '../../../search.js';
import { getSharedOperationCoordinator } from '../../operation-coordinator.js';
import { runWithConfigSnapshot, loadConfig } from '../../config.js';
import { CHAT_BUDGET, type RetrievalMode } from '../chat-contract.js';

/** 模型传参（仅 3 个字段，见 retrieval-skill.ts 的"为什么只有 3 个参数"） */
export interface KbSearchArgs {
  query: string;
  mode?: RetrievalMode;
  limit?: number;
}

/** 工具调用入队标识（日志与队列观测用） */
export const KB_SEARCH_OPERATION = 'chat-kb-search';

/**
 * 参数的允许形状（供 parseToolCallArguments 做严格解析）
 *
 * ⚠️ 只接受这 3 个键：模型若多传（如 `scope`），属越界参数 → 静默忽略
 * （不报错：报错会让模型陷入"参数错了再试"的循环；N23 的安全性由 **schema 不暴露** 保证）
 */
const ALLOWED_KEYS = new Set(['query', 'mode', 'limit']);

/**
 * 解析模型给出的 `arguments` JSON 字符串。
 *
 * · 非法 JSON → 抛 `Error`（由 tool-loop 转 `tool_end.error`，**不静默返回空查询**）
 * · 缺 `query` 或为空白 → 同上
 * · `limit` 越界 → **钳制**到 `[1, CHAT_BUDGET.maxHitsPerCall]`（不报错，模型无需懂上限）
 * · `mode` 非法 → 回落 `hybrid`（默认档，见 T9）
 */
export function parseToolCallArguments(raw: string): KbSearchArgs {
  // 空串 / 空白：多为上游把 arguments 拼丢，视为解析失败（不静默空查询）
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('kb_search 参数为空：期望 JSON 对象 {"query": "..."}');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`kb_search 参数不是合法 JSON：${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('kb_search 参数应为 JSON 对象');
  }

  const parsedObj = parsed as Record<string, unknown>;
  // 越界参数（如模型幻觉出的 `scope`）：**静默丢弃**，不报错。
  // 理由：报错会让模型陷入"参数错了→改参数→再试"的循环（N19 要求收敛）；
  // N23 的跨 scope 安全性由【工具 schema 不暴露 scope】+【此处白名单取键】双重保证 ——
  // 即使模型强行传入 `scope`，它也不会进入 args，更不会传到 executeSearch。
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsedObj)) {
    if (ALLOWED_KEYS.has(k)) obj[k] = v;
  }

  const rawQuery = obj.query;
  if (typeof rawQuery !== 'string' || rawQuery.trim().length === 0) {
    throw new Error('kb_search 缺少 query（或 query 为空白）');
  }

  const args: KbSearchArgs = { query: rawQuery.trim() };

  // mode：非法/缺失 → 回落 hybrid（默认档，T9）
  const rawMode = obj.mode;
  if (rawMode === 'fulltext' || rawMode === 'hybrid') {
    args.mode = rawMode;
  } else {
    args.mode = 'hybrid';
  }

  // limit：越界 → 钳制到 [1, maxHitsPerCall]（不报错）
  const rawLimit = obj.limit;
  if (rawLimit !== undefined && rawLimit !== null) {
    const n = typeof rawLimit === 'number' ? rawLimit : Number(rawLimit);
    if (Number.isFinite(n)) {
      const floored = Math.floor(n);
      args.limit = Math.min(Math.max(floored, 1), CHAT_BUDGET.maxHitsPerCall);
    } else {
      args.limit = CHAT_BUDGET.maxHitsPerCall;
    }
  }

  return args;
}

/**
 * 执行检索（★ 入队）。
 *
 * 实现骨架（见 S07 §3.6）：
 * ```ts
 * return getSharedOperationCoordinator().submit(
 *   { operation: 'chat-kb-search', params: { scope } },
 *   () => executeSearch({ scope, query: args.query, mode: args.mode ?? 'hybrid',
 *                         limit: Math.min(args.limit ?? CHAT_BUDGET.maxHitsPerCall,
 *                                         CHAT_BUDGET.maxHitsPerCall) }),
 *   [scope],
 * );
 * ```
 *
 * ⚠️ 配置快照：`executeSearch` 内部会 `loadConfig()` 取 embedding 超时等；
 *    这里用 `runWithConfigSnapshot(loadConfig(), ...)` 把**当前请求的配置**固定住，
 *    避免队列出队后回到"磁盘最新配置"导致同一次请求前后不一致。
 */
export async function runKbSearch(scope: string, args: KbSearchArgs): Promise<SearchResult> {
  const limit = Math.min(args.limit ?? CHAT_BUDGET.maxHitsPerCall, CHAT_BUDGET.maxHitsPerCall);
  const mode: RetrievalMode = args.mode ?? 'hybrid';
  const config = loadConfig();

  try {
    const outcome = await getSharedOperationCoordinator().submit(
      { operation: KB_SEARCH_OPERATION, params: { scope } },
      () => runWithConfigSnapshot(config, () =>
        executeSearch({ scope, query: args.query, mode, limit })),
      [scope],
    );
    return outcome.result as SearchResult;
  } catch (err) {
    // 错误：检索不可用 → 返回 {ok:false}（**不抛**，由 tool-loop 转 degraded 事件，N17）
    return { ok: false, error: (err as Error).message };
  }
}
