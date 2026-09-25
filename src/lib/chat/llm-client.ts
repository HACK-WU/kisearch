/**
 * LLM 客户端（S-01 + §9 v2）
 *
 * ═══ 通用语义契约 ═══
 * · 前置：`config.llm` 就绪（`resolveLlmStatus().enabled === true`），否则抛 `ChatDisabledError`
 * · 出参分流：`reasoning_content` → `reasoning` 事件（**仅转发**）；`content` → `content`；`usage` → `usage`
 * · ★ **不变量**：`reasoning` 永不进入 `messages`（N12）——实测单次思考可达 2635 字，
 *   误回传同时放大成本与延迟，并诱导模型复述自己的推理
 * · 空值：上游缺 `reasoning_content` 字段 → 按普通流处理（**不视为异常**，避免误伤非 reasoning 模型）
 * · 错误：上游 4xx/5xx → `LlmUpstreamError`；连续 >10 块 JSON 解析失败 → 同上
 * · 超时：双层 —— `firstByteTimeoutMs` 只约束"建立连接并收到首个 chunk"；
 *   `requestTimeoutMs` 约束整体（**不约束工具轮次**，工具预算见 tool-loop）
 * · 中止：接受 `AbortSignal`；中止后**返回已累积内容**，由调用方落盘为 `aborted:true`
 * · 幂等：非幂等（每次调用都是一次上游请求）
 * · 副作用：仅出网到用户自配的上游；不落盘、不改本地状态
 *
 * ═══ v2 增量（D13）═══
 * · 支持 `tools` 参数透传；**无 `tools` 时行为与 v1 完全一致**（回归点）
 * · 流式 `delta.tool_calls` 必须**按 `index` 累积拼接**（首块给 id/name，后续块给 arguments 片段）
 *   —— 这是流式 function calling 的标准陷阱，**不可用"最后一块覆盖"的写法**
 * · 识别"tools not supported"类上游错误 → 抛 `ToolsUnsupportedError`（供预检索降级分支捕获）
 *
 * @see design/S01_模型配置与后端chat代理_DESIGN.md §9
 */

import type { ChatConfigOk, RetrievalMode } from './chat-contract.js';

// ─────────────────────────────────────────────────────────────
// 配置状态
// ─────────────────────────────────────────────────────────────

/** 工具轮次上限（**SSOT = `chat-contract.ts` 的 `CHAT_BUDGET.maxToolRounds`**，此处仅再导出） */
export { CHAT_BUDGET as LLM_BUDGET } from './chat-contract.js';

export interface LlmStatus {
  enabled: boolean;
  model: string | null;
  baseURLHost: string | null;
  requestTimeoutMs: number | null;
  reason: string | null;
  code: string | null;
  /** 决定走【工具路径】还是【预检索降级路径】；**不决定能否检索** */
  supportsTools: boolean;
  /** = `!ackRequired`（与 supportsTools 正交） */
  retrievalEnabled: boolean;
  ackRequired: boolean;
  maxToolRounds: number;
}

/**
 * 解析 `config.llm` 就绪状态（**不缓存** —— 配置热更新后下次请求即生效）。
 *
 * · `enabled:false` 时 `reason` 为人话、`code` 为 `CHAT_DISABLED`
 * · 只暴露 host，**绝不回传 apiKey 或完整 URL 路径**
 */
export function resolveLlmStatus(cfg: unknown, configPath: string): LlmStatus {
  throw new Error(`STUB:SR-01:resolveLlmStatus`);
}

/** 组装 API-01 的响应（含 4 个 v2 字段） */
export function toChatConfigOk(status: LlmStatus, configPath: string): ChatConfigOk {
  throw new Error(`STUB:SR-01:toChatConfigOk`);
}

// ─────────────────────────────────────────────────────────────
// 流式调用
// ─────────────────────────────────────────────────────────────

/** 上游消息（**只含 `content`**，不含 reasoning） */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 仅 assistant 且本轮发起了工具调用时存在 */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  /** 仅 role=tool */
  tool_call_id?: string;
}

/** 工具定义（OpenAI function-calling 格式；实际 schema 见 retrieval-skill.ts） */
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type LlmStreamPart =
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; reasoningTokens?: number }
  /** 回合结束时产出，供 tool-loop 消费 */
  | { type: 'tool_calls'; calls: Array<{ id: string; name: string; arguments: string }> }
  | { type: 'done'; finishReason: string };

export interface StreamChatOptions {
  tools?: ToolDef[];
  signal?: AbortSignal;
  /** 覆盖配置中的超时（测试用） */
  requestTimeoutMs?: number;
  firstByteTimeoutMs?: number;
}

/**
 * 调用 `${baseURL}/chat/completions`（`stream:true`, `stream_options.include_usage`），
 * 逐块解析上游 SSE 并产出归一化分片。
 *
 * **实现要点**：`delta.tool_calls` 按 `index` 累积（见文件头 v2 增量第 2 条）。
 */
export async function* streamChat(
  messages: ChatTurn[],
  opts?: StreamChatOptions,
): AsyncGenerator<LlmStreamPart> {
  throw new Error(`STUB:SR-01:streamChat`);
}

// ─────────────────────────────────────────────────────────────
// 错误类型（供上层映射为错误码 / 触发降级）
// ─────────────────────────────────────────────────────────────

export class ChatDisabledError extends Error {
  constructor(public readonly reason: string) {
    super(`STUB:SR-01:ChatDisabledError`);
  }
}

export class LlmUpstreamError extends Error {
  constructor(public readonly detail: string, public readonly retryable = true) {
    super(`STUB:SR-01:LlmUpstreamError`);
  }
}

export class LlmTimeoutError extends Error {
  constructor(public readonly phase: 'first-byte' | 'overall') {
    super(`STUB:SR-01:LlmTimeoutError`);
  }
}

/** 上游明确表示不支持 function calling —— **供 S07 §3.7 预检索降级捕获**（不作为 502） */
export class ToolsUnsupportedError extends Error {
  constructor(public readonly detail: string) {
    super(`STUB:SR-01:ToolsUnsupportedError`);
  }
}

/** 供上层构造 tool_start 事件使用 */
export interface ResolvedToolCall {
  id: string;
  name: string;
  query: string;
  mode: RetrievalMode;
}
