/**
 * 工具调用循环（批次 2：注册表驱动的通用工具循环）
 *
 * 本模块是生成编排者。产出物是 SSE 事件流，由 `chat-routes.ts` 原样转发。
 *
 * ═══ 流程 ═══
 * ```text
 * 1. 构造 messages：system(注入块 + 会话 systemPrompt) + 历史(仅 content) + 本轮 user
 * 2. round = 0
 * 3. loop:
 *     上游流 →
 *       ├─ content 流   → 直接转发 {type:'content'}（边收边发）
 *       ├─ reasoning 流 → 转发 {type:'reasoning'}（**不落盘**）
 *       └─ 回合结束：
 *           ├─ 有 tool_calls 且 round < maxRounds →
 *           │    · 发 {type:'tool_start', name, query?/mode?/args?}
 *           │    · 注册表 handler 执行（★ 内部排队 + 超时）
 *           │    · 发 {type:'tool_end', hits, durationMs}
 *           │    · 有界返回 → 追加 assistant(tool_calls) + tool(response) 消息
 *           │    · round += 1 → 继续 loop
 *           └─ 无 tool_calls（或达上限）→ 结束
 * 4. 落盘 assistant 消息（content + sources）
 * ```
 *
 * ═══ 批次 2 关键变化（决策 D1~D5）═══
 * · 工具面 = 注册表（14 个真实 MCP 工具）∩ PromptConfig.tools 开关；
 *   默认只读 6 个，写 6 / 删 2 需配置层显式开启。
 * · kb_search 退役（D4）：检索由 ki_search 承担，命中仍投影 sources（R7 不退化）。
 * · 降级路径反转（D2）：不支持工具 / 上游不可用时**纯聊天 + 明示**，不再预检索。
 * · 契约泛化（D5）：tool_start 的 query/mode 改可选，非检索工具带 args 摘要。
 *
 * ═══ 四条硬约束（沿用）═══
 * 1. **`reasoning` 绝不进 `messages`**（N12）
 * 2. **`sources` 只落来源引用，工具返回总长度最多 10000 字符，页面与模型共用**（N22）
 * 3. **达 `maxRounds` 后强制作答**（N19）—— 拿掉 tools 再调一次，不是截断
 * 4. **`tool` 消息内容必须是有界工具返回**（原始结果会显著放大上下文）
 *
 * ═══ 通用语义契约 ═══
 * · 前置：`llm.supportsTools !== false`；隐私已确认（`kbDisclosureAck === true`）
 * · 后置：产出以 `done` 或 `error` 结尾的完整事件序（见 chat-contract 的 `CHAT_EVENT_ORDER_RULES`）
 * · 空值：检索无命中 → 不发 `sources`（**不发空数组**），由 skill 反幻觉规则引导模型如实作答
 * · 错误：工具抛错 → **不中断生成**，发 `{type:'tool_end', error}` 后继续（模型可见失败并自行说明）；
 *   检索类工具失败额外发一次 `degraded`（N17 明示，至多一次）；其他工具失败不升级为 degraded
 * · 中止：`signal` 触发 → 发 `{type:'aborted'}`，已累积内容由调用方落盘（`aborted:true`）
 * · 并发：同会话由 `chat-store` 的会话锁串行；**生成期间不持锁**；工具执行经 coordinator 与同 scope 读写互斥
 * · 副作用：工具执行（读/写经 coordinator 排队）+ 上游调用 + 最终落盘
 *
 * ═══ ★ 实现级发现（前置门① 实测，必须照此实现）═══
 * a. **一次响应的 N 个 `tool_calls` 必须回 N 条 `tool` 消息**（各自 `tool_call_id` 一一对应）。
 * b. **单次往返不够，必须有循环**（实测模型在已有结果时仍连续 3 轮请求工具）。
 * c. ★ **「强制作答」= 拿掉 `tools` 参数再调一次**，**不是截断**。
 *
 * @see .plans/2026-10-08-chat-mcp-tools-batch2/plan.md
 */

import { CHAT_BUDGET, type ChatEvent, type ConversationFile, type SourceRef } from '../chat-contract.js';
import type { SearchResult } from '../../../search.js';
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
import { buildSystemMessages } from './retrieval-skill.js';
import { promptConfigSystemBlocks, readPromptConfig } from '../prompt-config.js';
import { enabledChatToolEntries, getChatTool, type ChatMcpToolEntry, type ChatToolArgs } from '../mcp-tool-registry.js';
import { toSourceRefs } from './projection.js';
import { serializeToolResponse } from './tool-response.js';

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
  /**
   * system 注入块（批次 1：由对话配置层产出）。
   * 放进 runtime 而非 `ToolLoopInput`，理由与其余运行期字段一致：**不改冻结的输入签名**。
   */
  systemBlocks: readonly string[];
  /**
   * 启用的工具入口（批次 2：注册表 ∩ `PromptConfig.tools` 开关）。
   * 生成期间工具面固定（配置变更从下一次提问生效 —— 与批次 1「保存后下一次提问生效」口径一致）。
   */
  toolEntries: readonly ChatMcpToolEntry[];
}

function resolveRuntime(): LoopRuntime {
  const cfg = loadConfig();
  const status = resolveLlmStatus(cfg, cfg._configPath ?? '');
  const llm = cfg.llm;
  const promptConfig = readPromptConfig(cfg).config;
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
    // 页面与运行时使用同一配置：未保存时采用默认 skill + 基础规则，已保存时保持用户配置。
    systemBlocks: promptConfigSystemBlocks(promptConfig),
    // ★ 工具开关首次被消费（批次 2）：默认只读 6 个；用户关掉的即时生效于下一次提问
    toolEntries: enabledChatToolEntries(promptConfig.tools),
  };
}

/**
 * 本轮 assistant 消息 id（`meta` 与 `done` 共用同一 id）。
 *
 * ★ 必须与 `appendMessage` 锁内的 id 归一化同规则：`m{conv.seq + 1}`。
 *   旧实现用 `seq + messages.length + 1` 预估——`seq` 本身就是最后一条消息的序号，
 *   两者几乎必然不同 → 前端 `done` 校正 id 时列表 key 跳变、刚渲染的气泡整棵
 *   重挂载（收尾"闪一下"的根因之一）。落盘若被并发写入抢先，`done` 仍带真实
 *   `savedId` 兜底校正。
 */
function messageIdFor(conv: ConversationFile): string {
  return newMessageId(conv.seq + 1);
}

/**
 * ★ 构造上游 messages —— **只含 content**（N12 reasoning 隔离的结构性保证）。
 *
 * 历史消息的 `sources` / `timing` / `usage` 一律不参与（它们是给人看的，不是上游输入）。
 */
function buildUpstreamMessages(input: ToolLoopInput, systemBlocks: readonly string[]): ChatTurn[] {
  const msgs: ChatTurn[] = [];
  for (const m of buildSystemMessages(input.convSystemPrompt, systemBlocks)) {
    msgs.push({ role: 'system', content: m.content });
  }
  for (const m of input.conv.messages) {
    // ★ 只取 role + content：ChatMessage 本身不含 reasoning，此处再做一次显式白名单
    msgs.push({ role: m.role, content: m.content });
  }
  // ★ 路由的三种 mode 都会让 conv.messages 以本轮 user 结束，再传入相同 userText：
  //     - append-user：锁内 appendMessage 先落盘，再 `conv: convAfterPrep` + `userText`
  //     - regenerate：仅为生成构造截至末条 user 的快照，旧回答留在磁盘直到提交
  //     - edit：truncateAfterAndEdit 后 conv 末条是编辑后的该条 user
  //   若此处无条件再 push 一次，上游就会出现**两条相同的 user 消息**（且构成连续同角色
  //   `user,user` —— 部分 OpenAI 兼容上游会因此直接 400，另一些会令模型复述提问）。
  //   故仅在 conv 末条**不是**本轮这条 user 文本时才追加；这同时兼容「conv 未含本轮 user」
  //   的调用形状（既有 store/skill 级单测就是这么构造 conv 的）。
  //
  // ★ 本函数守住的不变量：**返回数组的末条恒为本轮 user 消息**（两条分支都成立——
  //   命中守卫时由 conv 末条提供，未命中时由下方 push 提供）。
  //   `degradedPath` 的 `messages.splice(messages.length - 1, 0, …)`（本文件下方）依赖它把
  //   检索上下文插到「本轮 user 之前」；改动本函数时必须同时看那处，否则注入位置会错位。
  //   回归用例见 `test/chat/multi-turn-context.test.ts`（含降级路径）。
  //
  // 已知限制（可接受）：判据用「content 全等」。若某调用方传入的 conv **不含**本轮 user，
  //   而历史末条恰好是**文本完全相同**的旧消息，则本轮不再追加——此时上游末条仍是同一段文本，
  //   语义等价（差别仅在该文本归属哪一轮）。路由的三条链路（append-user / regenerate / edit）
  //   都已让生成快照包含本轮 user，不会走到这个形态。
  const last = input.conv.messages[input.conv.messages.length - 1];
  const alreadyIncluded = last !== undefined && last.role === 'user' && last.content === input.userText;
  if (!alreadyIncluded) {
    msgs.push({ role: 'user', content: input.userText });
  }
  return msgs;
}


/** 判断 signal 是否已中止 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** 取消仍须交出已获得引用，供路由保存部分回答时保持出处。 */
function* abortedEvents(messageId: string, sources: SourceRef[], usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number }): Generator<ChatEvent> {
  if (sources.length > 0) yield { type: 'sources', sources };
  if (usage) yield { type: 'usage', ...usage };
  yield { type: 'aborted', messageId };
}

/** 停止等待只读工具；底层作业仍受 coordinator 管理，迟到结果不再消费。 */
function awaitWithAbort<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(new Error('已停止'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('已停止'));
    signal.addEventListener('abort', onAbort, { once: true });
    // 两个分支均注册，底层作业在中止后失败也不会产生未处理拒绝。
    Promise.resolve().then(() => signal.aborted ? Promise.reject(new Error('已停止')) : work()).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
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

  // 上游不可用（未配置模型）或模型不支持工具：**不静默按普通对话作答**（N17）——
  // 纯聊天 + degraded 明示，保证事件序完整且用户知情（批次 2 决策 D2）。
  if (!runtime.enabled || !runtime.supportsTools) {
    yield* pureChatPath(input, runtime, messageId, !runtime.enabled ? 'retrieval-unavailable' : 'tools-unsupported');
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
  const messages = buildUpstreamMessages(input, runtime.systemBlocks);
  const maxRounds = runtime.maxToolRounds;
  // ★ 启用工具面（注册表 ∩ 配置层开关）；空集 = 用户全关 → 不带 tools（纯聊天，
  //   属用户显式配置、非故障，不发 degraded）
  const toolDefs = runtime.toolEntries.map((e) => e.def);

  let round = 0;
  // 路由聚合整个回答以落盘；本模块仅聚合单次上游响应正文供工具续轮使用。
  // reasoning 始终只转发，不参与上游 messages。
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
      yield* abortedEvents(messageId, sources, usage);
      return;
    }

    // ★ 硬约束 3 + 实现细节 c：达上限后**拿掉 tools 再调一次**（不是截断）
    const reachedLimit = round >= maxRounds;
    if (reachedLimit) roundsExhausted = true;

    let pendingCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let roundContent = '';

    try {
      for await (const part of streamChat(messages, {
        tools: reachedLimit || toolDefs.length === 0 ? undefined : toolDefs,
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
            roundContent += part.text;
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
      // ★ 实现细节 c 的触发点之一：上游明确不支持 tools → 纯聊天降级（批次 2 决策 D2）
      if (err instanceof ToolsUnsupportedError) {
        yield* pureChatPath(input, runtime, messageId, 'tools-unsupported');
        return;
      }
      if (err instanceof LlmTimeoutError) {
        // first-byte 超时与整体超时对用户是同一类故障 → 统一用 `LLM_TIMEOUT`
        // （**不引入新错误码**：错误码是前端的映射依据，新增码会造成映射缺项）
        yield { type: 'error', code: 'LLM_TIMEOUT', error: err.message, retryable: true };
        return;
      }
      if (err instanceof ChatDisabledError) {
        yield* pureChatPath(input, runtime, messageId, 'retrieval-unavailable');
        return;
      }
      if (isAborted(input.signal)) {
        yield* abortedEvents(messageId, sources, usage);
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
      yield* abortedEvents(messageId, sources, usage);
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
    messages.push({ role: 'assistant', content: roundContent, tool_calls: assistantToolCalls });

    for (const call of pendingCalls) {
      if (isAborted(input.signal)) {
        yield* abortedEvents(messageId, sources, usage);
        return;
      }

      // 未知工具（模型幻觉出未暴露的工具名）：也必须回 tool 消息（实现细节 a），
      // 让模型可见失败并自行改道，不得静默丢调用 → 否则循环不收敛。
      const entry = getChatTool(call.name);
      if (!entry) {
        const errText = `未知工具 ${call.name || '(未命名)'}：不在本次暴露的工具列表中，请仅使用系统提供的工具`;
        const response = serializeToolResponse({ error: errText });
        yield { type: 'tool_start', name: call.name || 'unknown', ...(call.arguments ? { args: call.arguments.slice(0, 80) } : {}) };
        yield { type: 'tool_end', hits: 0, durationMs: 0, error: errText, response };
        messages.push({ role: 'tool', tool_call_id: call.id, content: response.text });
        continue;
      }

      // 参数解析失败 → 该调用记为错误（不中断生成，模型可见失败并自行说明）
      let parsed: ChatToolArgs | null = null;
      let parseError: string | null = null;
      try {
        parsed = entry.parse(call.arguments);
      } catch (err) {
        parseError = (err as Error).message;
      }

      const desc = parsed ? entry.describe(parsed) : {};
      yield {
        type: 'tool_start',
        name: entry.name,
        ...(desc.query !== undefined ? { query: desc.query } : {}),
        ...(desc.mode !== undefined ? { mode: desc.mode } : {}),
        ...(desc.args ? { args: desc.args } : {}),
      };

      if (parseError || !parsed) {
        // 解析失败：发 tool_end 带 error（★ 抛错也必须发，否则前端永久停留在"正在调用…"）
        const response = serializeToolResponse({ error: parseError ?? '参数解析失败' });
        yield { type: 'tool_end', hits: 0, durationMs: 0, error: parseError ?? '参数解析失败', response };
        messages.push({ role: 'tool', tool_call_id: call.id, content: response.text });
        continue;
      }

      const startedAt = Date.now();
      let result: unknown = null;
      let runError: string | null = null;
      try {
        result = await awaitWithAbort(() => entry.run(input.scope, parsed!), input.signal);
      } catch (err) {
        runError = (err as Error).message;
      }
      const durationMs = Date.now() - startedAt;
      if (isAborted(input.signal)) {
        yield { type: 'tool_end', hits: 0, durationMs, error: '已停止' };
        yield* abortedEvents(messageId, sources, usage);
        return;
      }

      // 结果归一：底层 execute 多以 {ok:false,error} 表示业务失败（不抛）→ 统一提取为 runError
      let hits = 0;
      if (!runError && result !== null && typeof result === 'object') {
        const r = result as { ok?: unknown; error?: unknown; results?: unknown[] };
        if (r.ok === false) {
          runError = typeof r.error === 'string' && r.error.length > 0 ? r.error : '工具执行失败';
        } else if (Array.isArray(r.results)) {
          hits = r.results.length;
        }
      }

      // 页面与模型共用实际返回文本，仅施加总字符预算。
      // ★ 失败也序列化**原始结果**（ok:false 的 JSON 含 error/code/details，模型可见失败详情；
      //   与旧行为一致），仅当执行抛错（result 为空）时退化为 {error} 摘要。
      const response = serializeToolResponse(result !== null ? result : { error: runError ?? '工具执行失败' });
      yield { type: 'tool_end', hits, durationMs, ...(runError ? { error: runError } : {}), response };
      messages.push({ role: 'tool', tool_call_id: call.id, content: response.text });

      if (runError) {
        // ★ 检索类工具失败：按 N17 **明示**（degraded 至多一次闸门）。
        //   其他工具失败由模型可见的 tool_end.error 承载，不升级为 degraded。
        if (entry.producesSources === true && !degradedSent) {
          degradedSent = true;
          yield { type: 'degraded', reason: 'retrieval-unavailable', message: '本次检索未成功' };
        }
        continue;
      }

      if (entry.producesSources === true) {
        const sr = result as SearchResult;
        // ★ 硬约束 2：来源引用单独累积（仅检索类工具，R7 不退化）
        const refs = toSourceRefs(sr);
        if (refs.length > 0) sources = dedupeSources([...sources, ...refs]);
        // 语义侧降级透传（不让用户误以为用了语义检索）—— 同样受至多一次的闸门约束
        if (sr && sr.ok === true && sr.degraded === true && !degradedSent) {
          degradedSent = true;
          yield { type: 'degraded', reason: 'semantic-degraded', message: '语义检索降级为全文' };
        }
      }
    }

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

/**
 * 纯聊天降级路径（批次 2 决策 D2，**反转** S07 §3.7 / T10 的预检索方案）。
 *
 * 触发条件（任一）：
 * · `llm.supportsTools === false`（用户手填）
 * · 上游返回工具不支持类错误（`ToolsUnsupportedError`）
 * · LLM 未配置 / `ChatDisabledError`（`retrieval-unavailable`，无 content）
 *
 * 行为：
 * 1. 发 `degraded` 明示（N17 不得静默；**不发 tool_start/tool_end** —— 本次没有任何工具执行）
 * 2. 注入一条 system 提示，让模型在回答开头说明「本次未检索知识库」
 * 3. 不带 tools 调上游，按纯对话作答
 */
async function* pureChatPath(
  input: ToolLoopInput,
  runtime: LoopRuntime,
  messageId: string,
  reason: 'tools-unsupported' | 'retrieval-unavailable',
): AsyncGenerator<ChatEvent> {
  let usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number } | undefined;
  let finishReason = 'stop';

  yield {
    type: 'degraded',
    reason,
    message: reason === 'tools-unsupported'
      ? '本次模型不支持工具调用，按纯对话回答（未检索知识库）'
      : '模型不可用，本次未检索',
  };

  const messages = buildUpstreamMessages(input, runtime.systemBlocks);
  // 系统提示插在既有 system 块之后、历史消息之前（无 system 块时置顶）
  let sysCount = 0;
  while (sysCount < messages.length && messages[sysCount].role === 'system') sysCount += 1;
  messages.splice(sysCount, 0, {
    role: 'system',
    content: '【提示】本次对话未接入知识库工具。请正常回答用户问题，并在回答开头简要说明「本次未检索知识库」；不得假装有检索结果，不得虚构知识库内容。',
  });

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
        yield* abortedEvents(messageId, [], usage);
        return;
      }
      // 降级描述能力缺失，不代表上游失败可以冒充正常完成。
      const code = err instanceof LlmTimeoutError
        ? 'LLM_TIMEOUT'
        : err instanceof ChatDisabledError ? 'CHAT_DISABLED' : 'LLM_UPSTREAM_ERROR';
      const retryable = err instanceof ChatDisabledError
        ? false
        : (err as { retryable?: boolean }).retryable !== false;
      yield { type: 'error', code, error: (err as Error).message, retryable };
      return;
    }
  } else {
    // 模型不可用：不发 content（上游接不上，也不编造回答）；事件序仍完整
    finishReason = 'stop';
  }

  yield* finalize({ sources: [], usage, finishReason, messageId, aborted: isAborted(input.signal), roundsExhausted: false, conversationTooLong: false });
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
  // 单次命中数在工具请求参数中限制；最终引用集合不能丢弃后续轮次的来源。
  return out;
}
