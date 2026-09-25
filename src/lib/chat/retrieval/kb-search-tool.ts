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
import { CHAT_BUDGET, type RetrievalMode } from '../chat-contract.js';

/** 模型传参（仅 3 个字段，见 retrieval-skill.ts 的"为什么只有 3 个参数"） */
export interface KbSearchArgs {
  query: string;
  mode?: RetrievalMode;
  limit?: number;
}

/**
 * 解析模型给出的 `arguments` JSON 字符串。
 *
 * · 非法 JSON → 抛 `Error`（由 tool-loop 转 `tool_end.error`，**不静默返回空查询**）
 * · 缺 `query` 或为空白 → 同上
 * · `limit` 越界 → **钳制**到 `[1, CHAT_BUDGET.maxHitsPerCall]`（不报错，模型无需懂上限）
 * · `mode` 非法 → 回落 `hybrid`（默认档，见 T9）
 */
export function parseToolCallArguments(raw: string): KbSearchArgs {
  throw new Error(`STUB:SR-01:parseToolCallArguments`);
}

/**
 * 执行检索（★ 入队）。
 *
 * 实现骨架：
 * ```ts
 * return getSharedOperationCoordinator().submit(
 *   { operation: 'chat-kb-search', params: { scope } },
 *   () => executeSearch({ scope, query: args.query, mode: args.mode ?? 'hybrid',
 *                         limit: Math.min(args.limit ?? CHAT_BUDGET.maxHitsPerCall,
 *                                         CHAT_BUDGET.maxHitsPerCall) }),
 *   [scope],
 * );
 * ```
 */
export async function runKbSearch(scope: string, args: KbSearchArgs): Promise<SearchResult> {
  throw new Error(`STUB:SR-01:runKbSearch`);
}
