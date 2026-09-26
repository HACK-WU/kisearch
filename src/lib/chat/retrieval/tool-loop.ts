/**
 * 工具调用循环（S07 §3.4 / §3.7）
 *
 * 本模块是 **D13 的核心：检索问答的编排者**。产出物是 SSE 事件流，
 * 由 `chat-routes.ts` 原样转发（路由层不做业务判断）。
 *
 * ═══ 流程（实现须严格按此顺序）═══
 * ```text
 * 1. 构造 messages：system(检索 skill + 会话 systemPrompt) + 历史(仅 content) + 本轮 user
 * 2. round = 0
 * 3. loop:
 *     上游流 →
 *       ├─ content 流   → 直接转发 {type:'content'}（边收边发）
 *       ├─ reasoning 流 → 转发 {type:'reasoning'}（**不落盘**）
 *       └─ 回合结束：
 *           ├─ 有 tool_calls 且 round < maxRounds →
 *           │    · 发 {type:'tool_start', name, query, mode}
 *           │    · runKbSearch（★ 内部入队）
 *           │    · 发 {type:'tool_end', hits, durationMs}
 *           │    · 投影 → 追加 assistant(tool_calls) + tool(projection) 消息
 *           │    · round += 1 → 继续 loop
 *           └─ 无 tool_calls（或达上限）→ 结束
 * 4. 落盘 assistant 消息（content + sources）
 * ```
 *
 * ═══ 四条硬约束 ═══
 * 1. **`reasoning` 绝不进 `messages`**（N12）
 * 2. **`sources` 只落来源引用，原始检索结果不落盘/不回传**（N22）
 * 3. **达 `maxRounds` 后强制作答**（N19）—— 不发错误，直接进入"无 tool_calls"分支
 * 4. **`tool` 消息内容必须是瘦身投影**（原始结果会显著放大上下文）
 *
 * ═══ 通用语义契约 ═══
 * · 前置：`llm.supportsTools !== false`；隐私已确认（`kbDisclosureAck === true`）
 * · 后置：产出以 `done` 或 `error` 结尾的完整事件序（见 chat-contract 的 `CHAT_EVENT_ORDER_RULES`）
 * · 空值：检索无命中 → 不发 `sources`（**不发空数组**），由 skill 反幻觉规则引导模型如实作答
 * · 错误：检索抛错 → **不中断生成**，发 `{type:'tool_end', error}` 后继续（模型可见失败并自行说明）
 * · 中止：`signal` 触发 → 发 `{type:'aborted'}`，已累积内容由调用方落盘（`aborted:true`）
 * · 幂等：非幂等
 * · 并发：同会话由 `chat-store` 的会话锁串行；**生成期间不持锁**
 * · 事务：单会话单次落盘
 * · 副作用：检索（只读，入 coordinator）+ 上游调用 + 最终落盘
 *
 * ═══ ★ 实现级发现（前置门① 实测，必须照此实现 —— `gate1-verification.md` §2）═══
 * a. **一次响应的 N 个 `tool_calls` 必须回 N 条 `tool` 消息**（各自 `tool_call_id` 一一对应）。
 *    漏一个 → 模型认为"工具没答完" → 继续请求 → 表现为**循环不收敛**。实测首轮返回 2 个。
 * b. **单次往返不够，必须有循环**（实测模型在已有结果时仍连续 3 轮请求工具）。
 * c. ★ **「强制作答」= 拿掉 `tools` 参数再调一次**，**不是截断**：
 *    截断会得到**空终答**（达上限前每轮 content 均为 0 字，模型还没产出就结束）。
 *
 * @see design/S07_检索与工具调用_DESIGN.md
 */

import { CHAT_BUDGET, type ChatEvent, type ConversationFile, type SourceRef } from '../chat-contract.js';
import {
  streamChat,
  resolveLlmStatus,
  ChatDisabledError,
  LlmTimeoutError,
  ToolsUnsupportedError,
  type ChatTurn,
} from '../llm-client.js';
import { loadConfig } from '../../config.js';
import { newMessageId } from '../chat-store.js';
import {
  buildSystemMessages,
  buildAutoRetrievalContext,
  KB_SEARCH_TOOL,
  KB_SEARCH_TOOL_NAME,
} from './retrieval-skill.js';
import { parseToolCallArguments, runKbSearch } from './kb-search-tool.js';
import { toToolProjection, toSourceRefs } from './projection.js';

export interface ToolLoopInput {
  scope: string;
  /** 会话（含历史消息；构造上游 messages 时**只用 content**） */
  conv: ConversationFile;
  /** 本轮用户输入（可能来自新增或编辑重发） */
  userText: string;
  /** 会话自定义 system prompt */
  convSystemPrompt: string;
  signal?: AbortSignal;
}

/** 运行期上下文（从配置解析；不改变冻结的 ToolLoopInput 签名） */
interface LoopRuntime {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  requestTimeoutMs: number;
  firstByteTimeoutMs: number;
  maxToolRounds: number;
  supportsTools: boolean;
  enabled: boolean;
  reason: string | null;
}

function resolveRuntime(): LoopRuntime {
  const cfg = loadConfig();
  const status = resolveLlmStatus(cfg, cfg._configPath ?? '');
  const llm = cfg.llm;
  return {
    baseURL: llm?.baseURL ?? '',
    apiKey: llm?.apiKey ?? '',
    model: llm?.model ?? '',
    temperature: llm?.temperature,
    maxTokens: llm?.maxTokens,
    requestTimeoutMs: llm?.requestTimeoutMs ?? CHAT_BUDGET.requestTimeoutMs,
    firstByteTimeoutMs: llm?.firstByteTimeoutMs ?? CHAT_BUDGET.firstByteTimeoutMs,
    maxToolRounds: status.maxToolRounds,
    supportsTools: status.supportsTools,
    enabled: status.enabled,
    reason: status.reason,
  };
}

/** 本轮 assistant 消息 id（`meta` 与 `done` 共用同一 id） */
function messageIdFor(conv: ConversationFile): string {
  return newMessageId(conv.seq + conv.messages.length + 1);
}

/**
 * ★ 构造上游 messages —— **只含 content**（N12 reasoning 隔离的结构性保证）。
 *
 * 历史消息的 `sources` / `timing` / `usage` 一律不参与（它们是给人看的，不是上游输入）。
 */
function buildUpstreamMessages(input: ToolLoopInput): ChatTurn[] {
  const msgs: ChatTurn[] = [];
  for (const m of buildSystemMessages(input.convSystemPrompt)) {
    msgs.push({ role: 'system', content: m.content });
  }
  for (const m of input.conv.messages) {
    // ★ 只取 role + content：ChatMessage 本身不含 reasoning，此处再做一次显式白名单
    msgs.push({ role: m.role, content: m.content });
  }
  msgs.push({ role: 'user', content: input.userText });
  return msgs;
}

/** 把工具调用投影文本序列化为 tool 消息内容（★ 硬约束 4：必须是瘦身投影） */
function toolMessageContent(projection: ReturnType<typeof toToolProjection>): string {
  return JSON.stringify(projection);
}

/** 判断 signal 是否已中止 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * 工具路径：模型自行决定是否检索（R18/R19）。
 *
 * 产出的事件序（正常）：
 * `meta → [tool_start → tool_end]* → reasoning* → content* → sources? → usage → done`
 *
 * ⚠️ **不落盘**：本函数只产出事件流；内容落盘由调用方（`chat-routes.ts`）在流结束后执行，
 *    以便复用"生成期间不持锁"的两段式加锁（S02 §3.3）。
 */
export async function* runToolLoop(input: ToolLoopInput): AsyncGenerator<ChatEvent> {
  const runtime = resolveRuntime();
  const messageId = messageIdFor(input.conv);

  // ★ meta 必须是首帧（CHAT_EVENT_ORDER_RULES）
  yield { type: 'meta', conversationId: input.conv.id, messageId, model: runtime.model || 'unknown' };

  // 上游不可用（未配置模型）：**不静默按普通对话作答**（N17）——
  // 退化为"预检索一次 + degraded 明示"，保证事件序完整且用户知情。
  if (!runtime.enabled || !runtime.supportsTools) {
    yield* degradedPath(input, runtime, messageId, {
      reason: !runtime.enabled ? 'retrieval-unavailable' : 'tools-unsupported',
    });
    return;
  }

  yield* toolLoopPath(input, runtime, messageId);
}

/** 工具循环主路径（llm 就绪且支持 tools） */
async function* toolLoopPath(
  input: ToolLoopInput,
  runtime: LoopRuntime,
  messageId: string,
): AsyncGenerator<ChatEvent> {
  const messages = buildUpstreamMessages(input);
  const maxRounds = runtime.maxToolRounds;

  let round = 0;
  // ⚠️ 本函数**不聚合 content/reasoning**：二者已通过事件流出，由调用方（chat-routes）
  //    边收边转发并聚合落盘。理由：① reasoning 不落盘（D7），聚合无意义；
  //    ② content 聚合在调用方，才能与"aborted 时落已产出部分"共用同一份缓冲。
  let sources: SourceRef[] = [];
  let usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number } | undefined;
  let finishReason = 'stop';
  let roundsExhausted = false;
  /**
   * `degraded` 是否已发出。
   *
   * ★ 契约要求 `degraded` **至多一次**（`CHAT_EVENT_ORDER_RULES.degradedAtMostOnce`）。
   *   本循环有两条可能来源（语义侧降级 / 检索失败），共用此闸门 → 取**最先触发者**。
   *   原先只有语义侧一条，且未加闸门；补上检索失败分支后闸门成为必需。
   */
  let degradedSent = false;
  const llmOpts = {
    baseURL: runtime.baseURL,
    apiKey: runtime.apiKey,
    model: runtime.model,
    temperature: runtime.temperature,
    maxTokens: runtime.maxTokens,
  };

  while (true) {
    if (isAborted(input.signal)) {
      yield { type: 'aborted', messageId };
      return;
    }

    // ★ 硬约束 3 + 实现细节 c：达上限后**拿掉 tools 再调一次**（不是截断）
    const reachedLimit = round >= maxRounds;
    if (reachedLimit) roundsExhausted = true;

    let pendingCalls: Array<{ id: string; name: string; arguments: string }> = [];

    try {
      for await (const part of streamChat(messages, {
        tools: reachedLimit ? undefined : [KB_SEARCH_TOOL],
        signal: input.signal,
        requestTimeoutMs: runtime.requestTimeoutMs,
        firstByteTimeoutMs: runtime.firstByteTimeoutMs,
        llm: llmOpts,
      })) {
        switch (part.type) {
          case 'reasoning':
            // reasoning 仅转发、**永不进 messages**（N12）；此处也不落盘（D7）
            yield { type: 'reasoning', text: part.text };
            break;
          case 'content':
            yield { type: 'content', text: part.text };
            break;
          case 'usage':
            usage = {
              promptTokens: part.promptTokens,
              completionTokens: part.completionTokens,
              ...(part.reasoningTokens !== undefined ? { reasoningTokens: part.reasoningTokens } : {}),
            };
            break;
          case 'tool_calls':
            pendingCalls = part.calls;
            break;
          case 'done':
            finishReason = part.finishReason;
            break;
        }
      }
    } catch (err) {
      // ★ 实现细节 c 的触发点之一：上游明确不支持 tools → 预检索降级
      if (err instanceof ToolsUnsupportedError) {
        yield* degradedPath(input, runtime, messageId, { reason: 'tools-unsupported' });
        return;
      }
      if (err instanceof LlmTimeoutError) {
        // first-byte 超时与整体超时对用户是同一类故障 → 统一用 `LLM_TIMEOUT`
        // （**不引入新错误码**：错误码是前端的映射依据，新增码会造成映射缺项）
        yield { type: 'error', code: 'LLM_TIMEOUT', error: err.message, retryable: true };
        return;
      }
      if (err instanceof ChatDisabledError) {
        yield* degradedPath(input, runtime, messageId, { reason: 'retrieval-unavailable' });
        return;
      }
      if (isAborted(input.signal)) {
        yield { type: 'aborted', messageId };
        return;
      }
      yield { type: 'error', code: 'LLM_UPSTREAM_ERROR', error: (err as Error).message, retryable: true };
      return;
    }

    // ★ 建连阶段被中止的二次判定。
    //   `streamChat` 在 signal 已中止时是**静默 return（不抛）**（见 `llm-client.ts` 的 catch），
    //   若此处不补判，会落到下面的"无工具调用 → break" → `finalize({aborted:false})` → 发 `done`，
    //   用户在"等首字节"阶段点停止将拿不到 `aborted`，落盘也会写 `aborted:false`。
    if (isAborted(input.signal)) {
      yield { type: 'aborted', messageId };
      return;
    }

    // 无工具调用（或已拿掉 tools 强制作答）→ 结束循环
    if (reachedLimit || pendingCalls.length === 0) {
      break;
    }

    // ★ 实现细节 a：N 个 tool_calls 必须回 N 条 tool 消息
    const assistantToolCalls = pendingCalls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: c.arguments },
    }));
    messages.push({ role: 'assistant', content: '', tool_calls: assistantToolCalls });

    const roundSources: SourceRef[] = [];

    for (const call of pendingCalls) {
      // 参数解析失败 → 该调用记为错误（不中断生成，模型可见失败并自行说明）
      let parsed = null as null | { query: string; mode?: 'fulltext' | 'hybrid'; limit?: number };
      let parseError: string | null = null;
      try {
        parsed = parseToolCallArguments(call.arguments);
      } catch (err) {
        parseError = (err as Error).message;
      }

      const query = parsed?.query ?? '';
      const mode = parsed?.mode ?? 'hybrid';

      yield { type: 'tool_start', name: call.name || KB_SEARCH_TOOL_NAME, query, mode };

      if (parseError) {
        // 解析失败：发 tool_end 带 error（★ 抛错也必须发，否则前端永久停留在"正在检索…"）
        yield { type: 'tool_end', hits: 0, durationMs: 0, error: parseError };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: parseError }),
        });
        continue;
      }

      const startedAt = Date.now();
      let result: Awaited<ReturnType<typeof runKbSearch>> | null = null;
      let runError: string | null = null;
      try {
        result = await runKbSearch(input.scope, parsed!);
      } catch (err) {
        runError = (err as Error).message;
      }
      const durationMs = Date.now() - startedAt;

      if (runError || !result || result.ok !== true) {
        const errText = runError ?? (result && result.ok === false ? result.error : '检索失败');
        yield { type: 'tool_end', hits: 0, durationMs, error: errText };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: errText }),
        });
        // ★ 检索不可用：不中断生成，但按 N17 **明示**（原先注释这么写、实现却没有发事件 →
        //   用户会把"没检索"当成"检索了但没找到"）。受 `degradedSent` 闸门约束，至多一次。
        if (!degradedSent) {
          degradedSent = true;
          yield { type: 'degraded', reason: 'retrieval-unavailable', message: '本次未检索' };
        }
        continue;
      }

      // 成功：投影 → tool 消息（★ 硬约束 4：瘦身投影，绝不回传原始结果）
      const projection = toToolProjection(result);
      yield { type: 'tool_end', hits: projection.hits.length, durationMs };
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolMessageContent(projection),
      });

      // ★ 硬约束 2：只累积投影后的来源引用（原始结果不落盘、不回传）
      const refs = toSourceRefs(result);
      if (refs.length > 0) roundSources.push(...refs);

      // 语义侧降级透传（不让用户误以为用了语义检索）—— 同样受至多一次的闸门约束
      if (result.degraded === true && !degradedSent) {
        degradedSent = true;
        yield { type: 'degraded', reason: 'semantic-degraded', message: '语义检索降级为全文' };
      }
    }

    if (roundSources.length > 0) sources = dedupeSources([...sources, ...roundSources]);

    round += 1;
  }

  yield* finalize({
    sources,
    usage,
    finishReason,
    messageId,
    aborted: false,
    roundsExhausted,
    conversationTooLong: input.conv.messages.length + 2 > 500,
  });
}

/** 预检索降级路径：daemon 代跑一次检索 + 明示（T10） */
async function* degradedPath(
  input: ToolLoopInput,
  runtime: LoopRuntime,
  messageId: string,
  ctx: { reason: 'tools-unsupported' | 'retrieval-unavailable' },
): AsyncGenerator<ChatEvent> {
  let sources: SourceRef[] = [];
  let usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number } | undefined;
  let finishReason = 'stop';

  // 1. daemon 代跑一次检索（query = userText，mode = hybrid，limit = 5）
  let projection = null as ReturnType<typeof toToolProjection> | null;
  let retrievalOk = false;

  try {
    const result = await runKbSearch(input.scope, {
      query: input.userText,
      mode: 'hybrid',
      limit: CHAT_BUDGET.maxHitsPerCall,
    });
    if (result.ok === true) {
      projection = toToolProjection(result);
      sources = toSourceRefs(result);
      retrievalOk = true;
    }
  } catch {
    retrievalOk = false;
  }

  // ★ 无论走哪条分支都发 tool_start → tool_end 成对（前端不会永久停留在"正在检索…"）
  //   且在模型不支持工具时也如实反映"daemon 代跑了一次检索"
  yield { type: 'tool_start', name: KB_SEARCH_TOOL_NAME, query: input.userText, mode: 'hybrid' };
  yield retrievalOk
    ? { type: 'tool_end', hits: projection!.hits.length, durationMs: 0 }
    : { type: 'tool_end', hits: 0, durationMs: 0, error: '检索不可用' };

  // 3. degraded 明示（至多一次；N17 不得静默）
  yield {
    type: 'degraded',
    reason: retrievalOk ? ctx.reason : 'retrieval-unavailable',
    message: retrievalOk ? '本次未使用工具检索' : '本次未检索',
  };

  // 2. 投影后作为上下文注入（拼在本轮 user 消息之前），并让模型作答
  const messages = buildUpstreamMessages(input);
  if (retrievalOk && projection) {
    const contextText = buildAutoRetrievalContext(JSON.stringify(projection));
    // 插到本轮 user 之前（保持 system 在最前）
    messages.splice(messages.length - 1, 0, { role: 'user', content: contextText });
  } else if (!retrievalOk) {
    // 4. 检索本身失败 → **不注错**，靠 skill 反幻觉规则 2 保证模型前置「本次未检索」
    messages.splice(messages.length - 1, 0, {
      role: 'user',
      content: '【提示】本次检索不可用，请在回答开头明确说明「本次未检索」，不要用自身知识冒充知识库内容。',
    });
  }

  if (runtime.enabled && runtime.baseURL && runtime.apiKey && runtime.model) {
    try {
      for await (const part of streamChat(messages, {
        // ★ 明确不带 tools（降级路径）
        signal: input.signal,
        requestTimeoutMs: runtime.requestTimeoutMs,
        firstByteTimeoutMs: runtime.firstByteTimeoutMs,
        llm: {
          baseURL: runtime.baseURL,
          apiKey: runtime.apiKey,
          model: runtime.model,
          temperature: runtime.temperature,
          maxTokens: runtime.maxTokens,
        },
      })) {
        if (part.type === 'reasoning') yield { type: 'reasoning', text: part.text };
        else if (part.type === 'content') {
          yield { type: 'content', text: part.text };
        } else if (part.type === 'usage') {
          usage = {
            promptTokens: part.promptTokens,
            completionTokens: part.completionTokens,
            ...(part.reasoningTokens !== undefined ? { reasoningTokens: part.reasoningTokens } : {}),
          };
        } else if (part.type === 'done') {
          finishReason = part.finishReason;
        }
      }
    } catch (err) {
      if (isAborted(input.signal)) {
        yield { type: 'aborted', messageId };
        return;
      }
      // 上游失败：已产出的内容与已明示的 degraded 保留，以 done 收尾（不静默）
      finishReason = 'error';
    }
  } else {
    // 模型不可用：不发 content（上游接不上，也不编造回答）；事件序仍完整
    finishReason = 'stop';
  }

  yield* finalize({ sources, usage, finishReason, messageId, aborted: false, roundsExhausted: false, conversationTooLong: false });
}

/** 收尾事件：sources?（无来源不发，且至多一次）→ usage? → done */
async function* finalize(p: {
  sources: SourceRef[];
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number };
  finishReason: string;
  messageId: string;
  aborted: boolean;
  roundsExhausted: boolean;
  conversationTooLong: boolean;
}): AsyncGenerator<ChatEvent> {
  // ★ sources 至多一次且在 done 之前；**无来源不发**（而非发空数组）
  if (p.sources.length > 0) {
    yield { type: 'sources', sources: p.sources };
  }
  if (p.usage) {
    yield { type: 'usage', ...p.usage };
  }
  const warning = p.roundsExhausted
    ? 'tool-rounds-exhausted' as const
    : p.conversationTooLong
      ? 'conversation-too-long' as const
      : undefined;
  if (p.aborted) {
    yield { type: 'aborted', messageId: p.messageId };
    return;
  }
  yield {
    type: 'done',
    messageId: p.messageId,
    finishReason: p.finishReason,
    sources: p.sources,
    ...(warning ? { warning } : {}),
  };
}

/** 来源引用去重（同 group/doc/lineStart 只留一条） */
function dedupeSources(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const r of refs) {
    const key = `${r.group}\u0000${r.doc}\u0000${r.lineStart}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.slice(0, CHAT_BUDGET.maxHitsPerCall);
}

/**
 * 预检索降级路径（T10 已拍板：**预检索一次 + 明示**）。
 *
 * 触发条件（任一）：
 * · `llm.supportsTools === false`（用户手填）
 * · 上游首次返回工具不支持类错误（`ToolsUnsupportedError`）
 * · 工具循环连续 2 轮检索均抛错（检索不可用）
 *
 * 行为：
 * 1. daemon 代跑一次检索（`query = userText`，`mode = hybrid`，`limit = 5`）
 * 2. 投影后作为**上下文注入**（拼在本轮 user 消息之前）
 * 3. 发 `{type:'degraded', reason:'tools-unsupported'|'retrieval-unavailable'}`
 * 4. 检索本身失败 → **不注错**，改发 `reason:'retrieval-unavailable'`，
 *    并由 skill 反幻觉规则 2 保证模型前置「本次未检索」
 */
export async function* runPreRetrievalFallback(input: ToolLoopInput): AsyncGenerator<ChatEvent> {
  const runtime = resolveRuntime();
  const messageId = messageIdFor(input.conv);
  yield { type: 'meta', conversationId: input.conv.id, messageId, model: runtime.model || 'unknown' };
  yield* degradedPath(input, runtime, messageId, {
    reason: runtime.supportsTools ? 'retrieval-unavailable' : 'tools-unsupported',
  });
}
