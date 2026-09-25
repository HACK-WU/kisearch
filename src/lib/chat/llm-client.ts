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
import type { KiConfig } from '../config.js';

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

/** v2 默认预算（SSOT = chat-contract 的 CHAT_BUDGET；此处只取所需两项，避免循环 import 语义混淆） */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOOL_ROUNDS = 3;

/** 未就绪时的统一形状（v2 字段仍需返回，前端据以统一渲染禁用态） */
function notReady(reason: string, maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS): LlmStatus {
  return {
    enabled: false,
    model: null,
    baseURLHost: null,
    requestTimeoutMs: null,
    reason,
    code: 'CHAT_DISABLED',
    supportsTools: false,
    retrievalEnabled: false,
    ackRequired: false,
    maxToolRounds,
  };
}

/**
 * 解析 `config.llm` 就绪状态（**不缓存** —— 配置热更新后下次请求即生效）。
 *
 * · `enabled:false` 时 `reason` 为人话、`code` 为 `CHAT_DISABLED`
 * · 只暴露 host，**绝不回传 apiKey 或完整 URL 路径**
 *
 * ⚠️ `apiKey` 已在 `config.ts::parseAndExpand` 预解析（支持 `${ENV}`），此处不再重复解析 ——
 *    避免两处解析规则漂移（S01 §3 的"为什么这样写"末条）。
 */
export function resolveLlmStatus(cfg: unknown, configPath: string): LlmStatus {
  void configPath;
  const llm = (cfg as KiConfig | undefined)?.llm;

  if (!llm?.baseURL || !llm?.model || !llm?.apiKey) {
    return notReady('未配置模型：请在配置文件的 llm 段填写 baseURL / model / apiKey');
  }

  let host: string;
  try {
    host = new URL(llm.baseURL).host;
  } catch {
    return notReady(`baseURL 不是合法 URL：${llm.baseURL}`);
  }

  const supportsTools = llm.supportsTools ?? true;   // T10：默认开（不支持时降级，不是禁用）
  const ackRequired = llm.kbDisclosureAck !== true;  // T12：未确认 → 阻塞发送

  return {
    enabled: true,
    model: llm.model,
    baseURLHost: host,
    requestTimeoutMs: llm.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    reason: null,
    code: null,
    supportsTools,
    retrievalEnabled: !ackRequired,   // ★ 确认后即可检索（工具路径或预检索降级路径）
    ackRequired,
    maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
  };
}

/** 组装 API-01 的响应（含 4 个 v2 字段） */
export function toChatConfigOk(status: LlmStatus, configPath: string): ChatConfigOk {
  return {
    ok: true,
    enabled: status.enabled,
    model: status.model,
    baseURLHost: status.baseURLHost,
    configPath,
    requestTimeoutMs: status.requestTimeoutMs,
    reason: status.reason,
    code: status.code,
    supportsTools: status.supportsTools,
    retrievalEnabled: status.retrievalEnabled,
    ackRequired: status.ackRequired,
    maxToolRounds: status.maxToolRounds,
  };
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
  /** 调用方注入的配置（缺省由参数直接给出；tool-loop 从会话上下文传入） */
  llm?: { baseURL: string; apiKey: string; model: string; temperature?: number; maxTokens?: number };
}

/** 连续 JSON 解析失败超过该值即中断（S01 §5） */
const MAX_PARSE_FAILURES = 10;

/** 上游工具不支持类错误的识别（宽松匹配，避免漏判导致降级路径失效） */
function looksLikeToolsUnsupported(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  const b = body.toLowerCase();
  if (!b.includes('tool') && !b.includes('function')) return false;
  return (
    b.includes('not support') ||
    b.includes('unsupported') ||
    b.includes('does not support') ||
    b.includes('is not available') ||
    b.includes('unknown parameter') ||
    b.includes('invalid parameter') ||
    b.includes('unrecognized')
  );
}

/** 解析上游错误码 → 本地错误类型映射（S01 §5） */
function mapUpstreamError(status: number, body: string): Error {
  if (status === 429) return new LlmUpstreamError(`上游限流（HTTP 429）：${truncate(body, 200)}`, true);
  if (status === 401 || status === 403) {
    return new LlmUpstreamError(`上游凭据无效（HTTP ${status}）：${truncate(body, 200)}（提示：凭据无效）`, false);
  }
  return new LlmUpstreamError(`上游异常（HTTP ${status}）：${truncate(body, 200)}`, status >= 500);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
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
  const llm = opts?.llm;
  if (!llm?.baseURL || !llm?.apiKey || !llm?.model) {
    throw new ChatDisabledError('未配置模型：请在配置文件的 llm 段填写 baseURL / model / apiKey');
  }

  const overallMs = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const firstByteMs = opts?.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;

  // 中止：外部 signal 与本地超时 controller 联动
  const local = new AbortController();
  const onExternalAbort = (): void => local.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) local.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let firstByteTimer: NodeJS.Timeout | undefined;
  let overallTimer: NodeJS.Timeout | undefined;
  let timedOut: 'first-byte' | 'overall' | null = null;
  let sawFirstChunk = false;

  const clearTimers = (): void => {
    if (firstByteTimer) clearTimeout(firstByteTimer);
    if (overallTimer) clearTimeout(overallTimer);
    firstByteTimer = undefined;
    overallTimer = undefined;
  };

  firstByteTimer = setTimeout(() => {
    if (!sawFirstChunk) {
      timedOut = 'first-byte';
      local.abort();
    }
  }, firstByteMs);
  overallTimer = setTimeout(() => {
    timedOut = 'overall';
    local.abort();
  }, overallMs);

  const body: Record<string, unknown> = {
    model: llm.model,
    messages: messages.map((m) => {
      // ★ reasoning 隔离（N12）：只挑白名单字段，绝不透传任何思考内容
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      return out;
    }),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts?.tools && opts.tools.length > 0) body.tools = opts.tools;
  if (llm.temperature !== undefined) body.temperature = llm.temperature;
  if (llm.maxTokens !== undefined) body.max_tokens = llm.maxTokens;
  // ⚠️ 不传 max_tokens 是默认行为（S01 §3：该上游 reasoning token 与 max_tokens 关系不确定）

  let resp: Response;
  try {
    resp = await fetch(`${llm.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: local.signal,
    });
  } catch (err) {
    clearTimers();
    if (opts?.signal) opts.signal.removeEventListener?.('abort', onExternalAbort);
    if (timedOut) throw new LlmTimeoutError(timedOut);
    if (opts?.signal?.aborted) return;             // 用户中止：静默结束，由调用方落盘已累积内容
    throw new LlmUpstreamError(`上游连接失败：${(err as Error).message}`, true);
  }

  if (!resp.ok) {
    clearTimers();
    if (opts?.signal) opts.signal.removeEventListener?.('abort', onExternalAbort);
    const text = await resp.text().catch(() => '');
    if (looksLikeToolsUnsupported(resp.status, text)) {
      throw new ToolsUnsupportedError(`上游不支持 function calling（HTTP ${resp.status}）：${truncate(text, 200)}`);
    }
    throw mapUpstreamError(resp.status, text);
  }
  if (!resp.body) {
    clearTimers();
    throw new LlmUpstreamError('上游未返回流式响应体（可能返回了非 SSE JSON 错误体）', true);
  }

  // ── 逐块解析 SSE ──
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let parseFailures = 0;

  /** ★ tool_calls 按 index 累积（首块给 id/name，后续拼 arguments 片段） */
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason = 'stop';
  let usageEmitted: { promptTokens: number; completionTokens: number; reasoningTokens?: number } | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!sawFirstChunk) {
        sawFirstChunk = true;
        if (firstByteTimer) {
          clearTimeout(firstByteTimer);
          firstByteTimer = undefined;
        }
      }
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分帧；上游可能用 \n\n 或 \r\n\r\n
      let sep = findFrameBoundary(buffer);
      while (sep !== -1) {
        const frame = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep.length);
        const payload = extractDataPayload(frame);
        if (payload !== null) {
          if (payload === '[DONE]') {
            // 上游流结束标记
          } else {
            try {
              const chunk = JSON.parse(payload) as UpstreamChunk;
              const emitted = handleChunk(chunk, toolAcc);
              for (const part of emitted.parts) yield part;
              if (emitted.finishReason) finishReason = emitted.finishReason;
              if (emitted.usage) usageEmitted = emitted.usage;
            } catch {
              parseFailures += 1;
              if (parseFailures > MAX_PARSE_FAILURES) {
                throw new LlmUpstreamError(
                  `上游 chunk 连续解析失败超过 ${MAX_PARSE_FAILURES} 次（可能返回了非 SSE 内容）`,
                  false,
                );
              }
            }
          }
        }
        sep = findFrameBoundary(buffer);
      }
    }
  } catch (err) {
    clearTimers();
    if (opts?.signal) opts.signal.removeEventListener?.('abort', onExternalAbort);
    if (err instanceof LlmUpstreamError) throw err;
    if (err instanceof ToolsUnsupportedError) throw err;
    if (timedOut) throw new LlmTimeoutError(timedOut);
    if (opts?.signal?.aborted || local.signal.aborted) {
      // 中止：把已累积的 tool_calls 交出去，内容由调用方落盘为 aborted:true
      if (toolAcc.size > 0) yield { type: 'tool_calls', calls: sortedCalls(toolAcc) };
      return;
    }
    throw new LlmUpstreamError(`读取上游流失败：${(err as Error).message}`, true);
  } finally {
    clearTimers();
    if (opts?.signal) opts.signal.removeEventListener?.('abort', onExternalAbort);
  }

  // 回合结束：先补发已累积的 tool_calls，再给 done
  if (toolAcc.size > 0) {
    yield { type: 'tool_calls', calls: sortedCalls(toolAcc) };
    // finish_reason 由上游给出（通常 'tool_calls'）；若上游缺省则按有工具调用判定
    if (finishReason === 'stop') finishReason = 'tool_calls';
  }
  if (usageEmitted) yield { type: 'usage', ...usageEmitted };
  yield { type: 'done', finishReason };
}

/** 上游 chunk 的最小形状（只声明用到的字段） */
interface UpstreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null;
}

function sortedCalls(acc: Map<number, { id: string; name: string; arguments: string }>): Array<{ id: string; name: string; arguments: string }> {
  return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({ id: v.id, name: v.name, arguments: v.arguments }));
}

/** 处理单个上游 chunk：产出分片并更新 tool_calls 累积器 */
function handleChunk(
  chunk: UpstreamChunk,
  toolAcc: Map<number, { id: string; name: string; arguments: string }>,
): {
  parts: LlmStreamPart[];
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number };
} {
  const parts: LlmStreamPart[] = [];
  let finishReason: string | undefined;

  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (delta) {
    // ★ reasoning_content → reasoning 分片（仅转发，永不回传上游）
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      parts.push({ type: 'reasoning', text: delta.reasoning_content });
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      parts.push({ type: 'content', text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        // ★ 按 index 累积：缺 index 时按 0 处理（部分上游首块省略 index）
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const prev = toolAcc.get(idx) ?? { id: '', name: '', arguments: '' };
        // 首块给 id/name；后续块只给 arguments 片段 → 用 ?? 保留已有值，绝不覆盖为空
        const id = tc.id ?? prev.id;
        const name = tc.function?.name ?? prev.name;
        const argsFragment = tc.function?.arguments ?? '';
        toolAcc.set(idx, { id, name, arguments: prev.arguments + argsFragment });
      }
    }
  }
  if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
    finishReason = choice.finish_reason;
  }

  let usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number } | undefined;
  if (chunk.usage) {
    const u = chunk.usage;
    usage = {
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
    };
    const rt = u.completion_tokens_details?.reasoning_tokens;
    if (typeof rt === 'number') usage.reasoningTokens = rt;
  }

  return { parts, finishReason, usage };
}

/** 在缓冲区中找帧边界（\n\n 或 \r\n\r\n），返回起点与长度 */
function findFrameBoundary(buf: string): { index: number; length: number } | -1 {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a < 0 && b < 0) return -1;
  if (a >= 0 && (b < 0 || a <= b)) return { index: a, length: 2 };
  return { index: b, length: 4 };
}

/** 从一帧中提取 `data:` 载荷（多行 data 按 SSE 规范用 \n 连接；无 data 行返回 null） */
function extractDataPayload(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// 错误类型（供上层映射为错误码 / 触发降级）
// ─────────────────────────────────────────────────────────────

export class ChatDisabledError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'ChatDisabledError';
  }
}

export class LlmUpstreamError extends Error {
  constructor(public readonly detail: string, public readonly retryable = true) {
    super(detail);
    this.name = 'LlmUpstreamError';
  }
}

export class LlmTimeoutError extends Error {
  constructor(public readonly phase: 'first-byte' | 'overall') {
    super(phase === 'first-byte' ? '上游首块超时' : '上游整体超时');
    this.name = 'LlmTimeoutError';
  }
}

/** 上游明确表示不支持 function calling —— **供 S07 §3.7 预检索降级捕获**（不作为 502） */
export class ToolsUnsupportedError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = 'ToolsUnsupportedError';
  }
}

/** 供上层构造 tool_start 事件使用 */
export interface ResolvedToolCall {
  id: string;
  name: string;
  query: string;
  mode: RetrievalMode;
}
