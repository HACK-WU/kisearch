/**
 * ask-runner.ts —— 一次性问答执行器（REQ-20261113-001 · S-01）
 *
 * ═══ 它做什么 ═══
 * 构造一个**只存在于内存**的会话骨架 → 带 `maxToolRounds` 与 `budgetMs` 驱动既有的
 * `runToolLoop` → 把事件流聚合成 `AskResult`。**不建会话、不读历史、不落盘。**
 *
 * ═══ 它不做什么（前置责任分工，见 S-01 §4a.2）═══
 * 隐私确认（`kbDisclosureAck`）、scope 校验、限流都由 S-02 在调用前完成。
 * 任何绕过 S-02 直接调用本函数的新入口，必须自行补上这三道闸门 ——
 * 否则等于绕过"知识库内容外发确认"。
 *
 * ═══ 三道保证 ═══
 * 1. **不落盘**：`conv` 是内存对象；`runToolLoop` 本身不写盘（`tool-loop.ts` 文件头契约）。
 * 2. **内层只读**：由调用方传 `capabilities` 限定（S-02 固定传 `knowledge.read`）；
 *    本函数**不自行放宽**。
 * 3. **不递归**：内层工具面来自 `CHAT_MCP_TOOLS`，其中不含 `ki_ask`。
 *
 * ═══ 预算 ═══
 * · 软预算（`ASK_SOFT_BUDGET_MS`）= 检索阶段上限，到点复用 tool-loop 的
 *   「拿掉 tools 再调一次」= **强制作答**（能收口作答，不是硬切）。
 * · 硬预算（`ASK_HARD_BUDGET_MS`）= 整次问答兜底，到点 abort 上游并用已累积内容作答。
 *   之所以不用硬预算兜全部：硬切会丢掉已生成内容，用户等 45s 却拿到失败。
 */

import { loadConfig } from '../../config.js';
import {
  ChatDisabledError,
  LlmTimeoutError,
  LlmUpstreamError,
  ToolsUnsupportedError,
  resolveLlmStatus,
} from '../llm-client.js';
import { runToolLoop } from '../retrieval/tool-loop.js';
import type { ConversationFile, SourceRef } from '../chat-contract.js';
import {
  ASK_CONTEXT_MAX_CHARS,
  ASK_CONTEXT_MAX_MESSAGES,
  ASK_HARD_BUDGET_MS,
  ASK_MAX_ROUNDS_DEFAULT,
  ASK_MAX_ROUNDS_LIMIT,
  ASK_SOFT_BUDGET_MS,
  type AskInput,
  type AskResult,
} from './ask-contract.js';
import {
  appendAskTurn,
  askSessionExpiresAt,
  createAskSession,
  deleteAskSession,
  isAskSessionExpired,
  readAskSession,
  type AskSessionFile,
  type AskSessionMessage,
} from './ask-store.js';

/**
 * 失败收尾：丢掉**本次新建**的短会话（因为它的 id 不会返回给调用方，成了无主文件）。
 *
 * 为什么需要：`resolveAskSession` 会**先建会话再跑问答**（否则拿不到 `contextId`），
 * 而失败（上游超时 / 5xx / 中断）时若不清理，每次失败都会在盘上留一个 `ka-*.json`，
 * 只能等 10 分钟后的 GC。上游抽风时会堆一片。
 *
 * ⚠️ 判定只看 `resumed`，**不看有没有部分答案**：
 * · 失败路径的 `contextId` **不会返回给调用方**（对外只给 `{ok:false,code,message}`），
 *   所以这个文件对谁都没用 —— 即使里面存了半截答案，也没人知道它的 id；
 * · 反之若在这里保留，就是"看不见也续不上"的无主文件，纯占盘。
 * · 续接的绝不能删 —— 那是调用方还在用的历史（`resumed === true` 直接跳过）。
 */
function discardEmptySession(scope: string, contextId: string, resumed: boolean): void {
  if (resumed || contextId.length === 0) return;
  deleteAskSession(scope, contextId);
}

/** 统一失败形状（`ok:false`，不外抛） */
function failure(
  partial: Pick<
    AskResult,
    'answer' | 'sources' | 'sourcesTotal' | 'rounds' | 'truncated' | 'contextId' | 'expiresAt' | 'resumed'
  > & {
    startedAt: number;
    truncatedReason?: AskResult['truncatedReason'];
    degraded?: AskResult['degraded'];
    usage?: AskResult['usage'];
  },
  error: NonNullable<AskResult['error']>,
): AskResult {
  return {
    ok: false,
    answer: partial.answer,
    sources: partial.sources,
    sourcesTotal: partial.sourcesTotal,
    contextId: partial.contextId,
    expiresAt: partial.expiresAt,
    resumed: partial.resumed,
    rounds: partial.rounds,
    elapsedMs: Date.now() - partial.startedAt,
    truncated: partial.truncated,
    ...(partial.truncatedReason ? { truncatedReason: partial.truncatedReason } : {}),
    ...(partial.degraded ? { degraded: partial.degraded } : {}),
    ...(partial.usage ? { usage: partial.usage } : {}),
    error,
  };
}

/** 抛出的异常 → `ASK_*` 错误码（文案不含上游原文细节，原文只进 daemon 日志） */
function mapThrown(err: unknown): { code: string; message: string; retryable: boolean } {
  if (err instanceof ChatDisabledError) {
    return { code: 'ASK_LLM_NOT_READY', message: err.message, retryable: false };
  }
  if (err instanceof ToolsUnsupportedError) {
    return { code: 'ASK_TOOLS_UNSUPPORTED', message: err.message, retryable: false };
  }
  if (err instanceof LlmTimeoutError) {
    return { code: 'ASK_LLM_TIMEOUT', message: err.message, retryable: true };
  }
  if (err instanceof LlmUpstreamError) {
    return { code: 'ASK_LLM_UPSTREAM', message: err.message, retryable: true };
  }
  return {
    code: 'ASK_INTERNAL',
    message: err instanceof Error ? err.message : '问答内部错误',
    retryable: true,
  };
}

/**
 * 轮次上限解析：配置越界 → `null`（由调用方 fail-loud）。
 *
 * 为什么不静默钳制：用户改了配置却没生效，是最难查的一类问题（S-01 §3.2 决策）。
 */
function resolveMaxRounds(configured: number | undefined): number | null {
  if (configured === undefined) return ASK_MAX_ROUNDS_DEFAULT;
  if (!Number.isInteger(configured) || configured < 1 || configured > ASK_MAX_ROUNDS_LIMIT) {
    return null;
  }
  return configured;
}

/**
 * 来源条数上限（2026-11-13 实测后加）：
 * 复杂问题累积到 40 条 `sources`（≈6KB），远超答案本体（1~2KB），
 * 对外部 AI 只是噪声与 token 负担。取前 15 条足够覆盖主要依据。
 */
const ASK_MAX_SOURCES = 15;

/**
 * 净化来源：丢掉**空投影**并截断。
 *
 * `{group:'x', doc:'', lineStart:0, snippet:''}` 这类条目来自 chunk fallback
 * （无法映射到具体文档与行号），对调用方毫无定位价值，只占 token。
 * ⚠️ 只影响 `ki_ask` 的输出，不改 `tool-loop` / 页面侧的 sources 契约。
 */
function sanitizeSources(list: SourceRef[]): SourceRef[] {
  const cleaned = list.filter((s) => s.doc.trim().length > 0 || s.snippet.trim().length > 0);
  return cleaned.slice(0, ASK_MAX_SOURCES);
}

// ── 二期：短会话解析（S-03 §4.3）────────────────────────────

type SessionResolution =
  | { ok: true; session: AskSessionFile; history: AskSessionMessage[]; resumed: boolean }
  | { ok: false; error: NonNullable<AskResult['error']> };

/**
 * 解析或创建短会话。
 *
 * **判定顺序固定**：不存在 → 非本人 → 已过期 → 超预算。
 * 先判归属再判过期，是为了不让"拿别人的过期 ID"探测到"它曾经存在"
 * （否则 `EXPIRED` 与 `FORBIDDEN` 的差异就是一个存在性侧信道）。
 *
 * 不传 `contextId` ⇒ 新建一个空会话（并把 id 返回给调用方，供下次追问）。
 */
async function resolveAskSession(
  input: AskInput,
  ownerKey: string,
  ttlMs: number,
): Promise<SessionResolution> {
  if (input.contextId === undefined || input.contextId.length === 0) {
    const created = await createAskSession(input.scope, ownerKey);
    return { ok: true, session: created, history: [], resumed: false };
  }

  const existing = await readAskSession(input.scope, input.contextId);
  if (existing === null) {
    return {
      ok: false,
      error: {
        code: 'ASK_CONTEXT_NOT_FOUND',
        message: `上下文「${input.contextId}」不存在（或已清理）：不传 context_id 即可开启新会话。`,
        retryable: false,
      },
    };
  }
  if (existing.ownerKey !== ownerKey) {
    return {
      ok: false,
      error: {
        code: 'ASK_CONTEXT_FORBIDDEN',
        message: '该上下文不属于当前凭据：请用创建它的那个 Token 续接，或不传 context_id 开启新会话。',
        retryable: false,
      },
    };
  }
  if (isAskSessionExpired(existing, ttlMs)) {
    deleteAskSession(input.scope, existing.id);
    return {
      ok: false,
      error: {
        code: 'ASK_CONTEXT_EXPIRED',
        message: `上下文已过期（最后一次交互超过 ${Math.round(ttlMs / 60_000)} 分钟）：请开启新会话并带上必要上文。`,
        retryable: false,
      },
    };
  }

  const chars = existing.messages.reduce((sum, m) => sum + m.content.length, 0);
  if (existing.messages.length + 2 > ASK_CONTEXT_MAX_MESSAGES) {
    return {
      ok: false,
      error: {
        code: 'ASK_CONTEXT_BUDGET_EXCEEDED',
        message: `该上下文已累积 ${existing.messages.length} 条消息（上限 ${ASK_CONTEXT_MAX_MESSAGES}）：请开启新会话。`,
        retryable: false,
      },
    };
  }
  if (chars + input.question.length > ASK_CONTEXT_MAX_CHARS) {
    return {
      ok: false,
      error: {
        code: 'ASK_CONTEXT_BUDGET_EXCEEDED',
        message: `该上下文已累积 ${chars} 字符（上限 ${ASK_CONTEXT_MAX_CHARS}）：请开启新会话。`,
        retryable: false,
      },
    };
  }

  return { ok: true, session: existing, history: existing.messages, resumed: true };
}

/** 内存会话骨架：**13 个必填字段**（`chat-contract.ts` 的 `ConversationFile`），可选字段一律不设 */
function buildMemoryConv(scope: string, history: readonly AskSessionMessage[]): ConversationFile {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: `ka-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    scope,
    title: '',
    systemPrompt: '',
    archived: false,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    seq: 0,
    messageCount: history.length,
    lastMessagePreview: history.length > 0 ? history[history.length - 1]!.content.slice(0, 40) : '',
    // 回放只取 role + content（S-03 §3.2 决策）：reasoning / sources 是展示物，
    // 回放会放大上下文且违反 N12
    messages: history.map((m, index) => ({
      id: `m${index + 1}`,
      role: m.role,
      content: m.content,
      at: m.at,
    })),
  };
}

/**
 * 执行一次独立问答。**不抛**：所有失败归一为 `{ok:false, error}`。
 */
export async function runAsk(input: AskInput): Promise<AskResult> {
  const startedAt = Date.now();
  /**
   * 前置失败（未配置模型 / 不支持 tools）时还没建立短会话，
   * 但 `AskResult.contextId`/`expiresAt` 是必填字段 ⇒ 用空串表示"本次未建立"，
   * 不凭空造一个 id（否则调用方拿它续接必然 NOT_FOUND，等于埋一个假线索）。
   */
  const empty = {
    answer: '', sources: [] as SourceRef[], sourcesTotal: 0, rounds: 0, truncated: false,
    contextId: '', expiresAt: '', resumed: false,
  };

  // ① 就绪闸门（不发起上游请求）
  const cfg = loadConfig();
  const status = resolveLlmStatus(cfg, cfg._configPath ?? '');
  if (!status.enabled) {
    return failure({ ...empty, startedAt }, {
      code: 'ASK_LLM_NOT_READY',
      message: status.reason ?? '未配置模型：请在配置文件的 llm 段填写 baseURL / model / apiKey',
      retryable: false,
    });
  }
  if (!status.supportsTools) {
    return failure({ ...empty, startedAt }, {
      code: 'ASK_TOOLS_UNSUPPORTED',
      message: '当前模型未启用工具调用（llm.supportsTools=false）：ki_ask 依赖内部检索才能基于知识库作答，'
        + '不会退回"无依据的纯聊天"。请在配置中启用工具调用，或改用 ki_search 自行检索。',
      retryable: false,
    });
  }

  const maxRounds = resolveMaxRounds(status.askMaxRounds);
  if (maxRounds === null) {
    return failure({ ...empty, startedAt }, {
      code: 'ASK_INTERNAL',
      message: `llm.askMaxRounds 配置越界（应为 1~${ASK_MAX_ROUNDS_LIMIT} 的整数）：请修正配置后重试`,
      retryable: false,
    });
  }

  // ② 短会话（二期）：新建或续接，顺带做归属 / 过期 / 预算判定
  const ownerKey = input.principalKey ?? 'local';
  const ttlMs = status.askSessionTtlMs;
  const resolution = await resolveAskSession(input, ownerKey, ttlMs);
  if (!resolution.ok) return failure({ ...empty, startedAt }, resolution.error);

  const contextId = resolution.session.id;
  let expiresAt = askSessionExpiresAt(resolution.session, ttlMs);
  const resumed = resolution.resumed;

  // ③ 内存会话骨架（**回放历史**）+ 硬预算/外部信号联动
  const conv = buildMemoryConv(input.scope, resolution.history);
  const controller = new AbortController();
  let hardBudgetHit = false;
  const onOuterAbort = (): void => controller.abort();
  if (input.signal?.aborted === true) controller.abort();
  else input.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const hardTimer = setTimeout(() => {
    hardBudgetHit = true;
    controller.abort();
  }, ASK_HARD_BUDGET_MS);
  hardTimer.unref?.();

  // ③ 驱动既有工具循环
  let answer = '';
  let sources: SourceRef[] = [];
  let rounds = 0;
  let truncated = false;
  let truncatedReason: AskResult['truncatedReason'];
  let degraded: AskResult['degraded'];
  let usage: AskResult['usage'];
  let aborted = false;

  const snapshot = () => ({
    answer,
    sources: sanitizeSources(sources),
    // 净化**前**的条数（供调用方知道有来源被过滤/截断）
    sourcesTotal: sources.length,
    contextId, expiresAt, resumed,
    rounds, truncated, startedAt,
    ...(truncatedReason ? { truncatedReason } : {}),
    ...(degraded ? { degraded } : {}),
    ...(usage ? { usage } : {}),
  });

  try {
    for await (const ev of runToolLoop({
      scope: input.scope,
      conv,
      userText: input.question,
      convSystemPrompt: '',
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      // 始终传内部 controller：它已与 input.signal 联动（任一触发即中止）
      signal: controller.signal,
      maxToolRounds: maxRounds,
      budgetMs: ASK_SOFT_BUDGET_MS,
    })) {
      switch (ev.type) {
        case 'content':
          answer += ev.text;
          break;
        case 'tool_end':
          // 语义 = 内层工具**调用次数**（一次响应可含多个 tool_calls），不是模型往返轮数
          rounds += 1;
          break;
        case 'sources':
          sources = ev.sources;
          break;
        case 'usage':
          usage = {
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
            ...(ev.reasoningTokens !== undefined ? { reasoningTokens: ev.reasoningTokens } : {}),
          };
          break;
        case 'degraded':
          degraded = { reason: ev.reason, message: ev.message };
          break;
        case 'aborted':
          aborted = true;
          break;
        case 'done':
          if (Array.isArray(ev.sources)) sources = ev.sources;
          if (ev.warning === 'tool-rounds-exhausted') {
            truncated = true;
            truncatedReason = 'round-limit';
          }
          // 预算优先：同时命中时以"时间用尽"归因（S-01 §4a.2 聚合规则）
          if (ev.budgetExhausted === true) {
            truncated = true;
            truncatedReason = 'time-budget';
          }
          break;
        case 'error':
          discardEmptySession(input.scope, contextId, resumed);
          return failure(snapshot(), {
            code: ev.code === 'LLM_UPSTREAM_ERROR' ? 'ASK_LLM_UPSTREAM' : 'ASK_INTERNAL',
            message: ev.error,
            retryable: ev.retryable !== false,
          });
        default:
          // meta / context / tool_start / reasoning / skill：不进 AskResult
          break;
      }
    }
  } catch (err) {
    discardEmptySession(input.scope, contextId, resumed);
    return failure(snapshot(), mapThrown(err));
  } finally {
    clearTimeout(hardTimer);
    input.signal?.removeEventListener('abort', onOuterAbort);
  }

  // ④ 中止收尾：有内容就是"截断的部分答案"，无内容才判超时
  //    （先净化来源，保证后面每条 return 路径都用同一份干净数据）
  const sourcesTotal = sources.length;
  sources = sanitizeSources(sources);
  if (aborted || controller.signal.aborted) {
    if (answer.length > 0) {
      return {
        ok: true,
        answer,
        sources,
        sourcesTotal,
        rounds,
        elapsedMs: Date.now() - startedAt,
        truncated: true,
        truncatedReason: 'hard-timeout',
        contextId, expiresAt, resumed,
        ...(degraded ? { degraded } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    discardEmptySession(input.scope, contextId, resumed);
    return failure(snapshot(), {
      code: 'ASK_TIMEOUT',
      message: hardBudgetHit
        ? `问答超过 ${Math.round(ASK_HARD_BUDGET_MS / 1000)} 秒硬预算且未产出任何内容：建议缩小问题范围后重试`
        : '问答已被调用方中止，且未产出任何内容',
      retryable: true,
    });
  }

  // ⑤ 追加本轮到短会话 ⇒ `writeJson` 刷新 `updatedAt` ⇒ TTL 顺延（滑动）
  //   **只写成功的问答**：中止/失败的答案不写 —— 残缺答案留在上下文里会污染下一轮
  if (answer.length > 0) {
    const at = new Date().toISOString();
    const updated = await appendAskTurn(input.scope, contextId, [
      { role: 'user', content: input.question, at },
      { role: 'assistant', content: answer, at },
    ]);
    // null = 文件已被 GC 删掉或写失败 ⇒ 本次答案照给，调用方下次续接会拿到 NOT_FOUND
    if (updated !== null) expiresAt = askSessionExpiresAt(updated, ttlMs);
  }

  return {
    ok: true,
    answer,
    sources,
    sourcesTotal,
    contextId,
    expiresAt,
    resumed,
    rounds,
    elapsedMs: Date.now() - startedAt,
    truncated,
    ...(truncatedReason ? { truncatedReason } : {}),
    ...(degraded ? { degraded } : {}),
    ...(usage ? { usage } : {}),
  };
}
