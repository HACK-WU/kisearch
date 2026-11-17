/**
 * analysis-ask-runner.ts —— 事件「追问这次分析」执行器（2026-11-17 · S-06 / B2）
 *
 * 定位：对**已定稿的分析结果**答疑，不是"再分析一遍"。
 * 因此：
 *   · **不给工具**、不读仓库（snippet 不进上下文，避免预算失控）；
 *   · 上下文 = 事件摘要 + 结论 + 候选前 5 + 已确认前 5 + 最近 2 轮问答；
 *   · 限流与并发沿用 `ki_ask`（10 次/60s、并发 2），**共享进程级并发闸**；
 *   · 硬超时到点：已有文本 → 200 + `truncated:true` 并落库；一个字都没有 → 504。
 *
 * 闸门顺序（与 S06 §3.5 一致）：事件存在 → 草稿存在 → 归一后是否 running → 问题长度
 * → 模型可用/已确认外发 → 限流/并发 → 组装上下文 → 调用 → 落库。
 */

import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { resolveLlmStatus, streamChat, type ChatTurn } from '../chat/llm-client.js';
import { acquireAskSlot, releaseAskSlot } from '../chat/ask/ask-limiter.js';
import { ASK_HARD_BUDGET_MS, ASK_QUESTION_MAX_CHARS } from '../chat/ask/ask-contract.js';
import { GovernanceError } from '../governance-errors.js';
import { isAnalysisActive, readNormalizedAnalysisDoc } from './analysis-runner.js';
import { appendAskTurn, readAskDoc } from './analysis-ask-store.js';
import type { AnalysisAskTurn, EventAnalysisAskDoc } from './types.js';

/** 单条回答上限（超长截断；模板另外要求 ≤400 字） */
export const ASK_ANSWER_MAX_CHARS = 4000;
const CONCLUSION_CHARS = 1200;
const CANDIDATES_USED = 5;
const CONFIRMED_USED = 5;
const HISTORY_TURNS = 2;
const HISTORY_Q_CHARS = 200;
const HISTORY_A_CHARS = 400;
const DESC_CHARS = 800;

/** 供治理层传进来的最小事件形状（避免把 events/types 的完整 EventRecord 拖进来） */
export interface AskTargetEvent {
  id: string;
  shortId?: number;
  title: string;
  description?: string | null;
}

export interface AskEventAnalysisArgs {
  question: string;
  /** 限流主体：HTTP 层无身份，固定 'local'（与 ki_ask 共享窗口，见 S06 §3.3） */
  principalKey?: string;
  /**
   * 流式增量回调（SSE 通道用）：每收到一段模型文本就回调一次。
   * 注意：回调抛错不得影响主流程（HTTP 层已写成"写失败即断开"，由调用方保证）。
   */
  onDelta?: (text: string) => void;
  deps?: {
    loadConfigFn?: typeof loadConfig;
    resolveLlmStatusFn?: typeof resolveLlmStatus;
    streamChatFn?: typeof streamChat;
    nowFn?: () => number;
    hardTimeoutMs?: number;
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 把本次分析压成受字数上限约束的上下文（无工具、无 snippet） */
function buildContext(args: {
  event: AskTargetEvent;
  draft: NonNullable<ReturnType<typeof readNormalizedAnalysisDoc>['draft']>;
  confirmed: Array<{ file: string; line: number; why: string }>;
  history: AnalysisAskTurn[];
}): { text: string; stats: { conclusionChars: number; candidatesUsed: number; confirmedUsed: number; historyUsed: number } } {
  const { event, draft, confirmed, history } = args;
  const conclusion = draft.conclusion ?? '';
  const cands = draft.candidates.slice(0, CANDIDATES_USED);
  const locs = confirmed.slice(0, CONFIRMED_USED);
  const recent = history.slice(-HISTORY_TURNS);

  const lines: string[] = [
    `<event>`,
    `标题：${event.title}`,
    event.description?.trim() ? `描述：${clip(event.description.trim(), DESC_CHARS)}` : '描述：（空）',
    `</event>`,
  ];
  if (conclusion) {
    lines.push('<conclusion>', clip(conclusion, CONCLUSION_CHARS), '</conclusion>');
  }
  if (cands.length) {
    lines.push('<candidates>');
    for (const c of cands) {
      lines.push(`- ${c.file}:${c.line}｜${clip(c.why, 200)}｜置信度 ${c.confidence}`);
    }
    lines.push('</candidates>');
  }
  if (locs.length) {
    lines.push('<confirmed>');
    for (const l of locs) lines.push(`- ${l.file}:${l.line}｜${clip(l.why, 200)}`);
    lines.push('</confirmed>');
  }
  if (recent.length) {
    lines.push('<history>');
    for (const t of recent) {
      lines.push(`问：${clip(t.question, HISTORY_Q_CHARS)}`);
      lines.push(`答：${clip(t.answer, HISTORY_A_CHARS)}`);
    }
    lines.push('</history>');
  }

  return {
    text: lines.join('\n'),
    stats: {
      conclusionChars: conclusion ? Math.min(conclusion.length, CONCLUSION_CHARS) : 0,
      candidatesUsed: cands.length,
      confirmedUsed: locs.length,
      historyUsed: recent.length,
    },
  };
}

export async function askEventAnalysis(
  scope: string,
  event: AskTargetEvent,
  args: AskEventAnalysisArgs,
): Promise<{ turn: AnalysisAskTurn; doc: EventAnalysisAskDoc }> {
  const deps = args.deps;
  const now = (deps?.nowFn ?? (() => Date.now()))();
  const question = args.question.trim();

  // ① 草稿必须存在（未分析就没有可追问的上下文）
  const analysis = readNormalizedAnalysisDoc(scope, event.id);
  if (!analysis.draft) {
    throw new GovernanceError('ANALYSIS_DRAFT_NOT_FOUND', '这次事件还没有分析结果，无法追问');
  }
  // ② 运行中不追问（归一后的 running 才算，僵尸 draft 视为已失败）
  if (analysis.draft.status === 'running' && isAnalysisActive(scope, event.id)) {
    throw new GovernanceError('ANALYSIS_ALREADY_RUNNING', '分析仍在进行中，等完成后可追问');
  }
  // ③ 问题长度
  if (!question) {
    throw new GovernanceError('ANALYSIS_ASK_QUESTION_TOO_LONG', '问题不能为空');
  }
  if (question.length > ASK_QUESTION_MAX_CHARS) {
    throw new GovernanceError(
      'ANALYSIS_ASK_QUESTION_TOO_LONG',
      `问题过长（${question.length} 字），上限 ${ASK_QUESTION_MAX_CHARS} 字`,
      { limit: ASK_QUESTION_MAX_CHARS },
    );
  }

  // ④ 模型可用 + 已确认外发（与 AI 分析共用同一套闸门口径）
  const cfg = (deps?.loadConfigFn ?? loadConfig)();
  const llmStatus = (deps?.resolveLlmStatusFn ?? resolveLlmStatus)(cfg, cfg._configPath ?? '');
  if (llmStatus.ackRequired) {
    throw new GovernanceError('ANALYSIS_DISCLOSURE_REQUIRED', '尚未确认知识库内容外发给上游模型，请先完成隐私确认');
  }
  if (!llmStatus.enabled) {
    throw new GovernanceError('ANALYSIS_LLM_UNAVAILABLE', llmStatus.reason ?? '未配置 LLM 模型，无法追问');
  }

  // ⑤ 限流 + 并发（共享 ki_ask 的进程级闸门）
  const principalKey = args.principalKey ?? 'local';
  const slot = acquireAskSlot(principalKey, scope);
  if (!slot.ok) {
    const rate = slot.code === 'ASK_RATE_LIMITED';
    throw new GovernanceError(
      rate ? 'ANALYSIS_ASK_RATE_LIMITED' : 'ANALYSIS_ASK_BUSY',
      rate
        ? `追问太频繁，请 ${slot.retryAfterSec}s 后再试`
        : `同时进行的追问过多，请 ${slot.retryAfterSec}s 后再试`,
      { retryAfterSec: slot.retryAfterSec },
    );
  }

  try {
    const history = readAskDoc(scope, event.id).turns;
    const ctx = buildContext({ event, draft: analysis.draft, confirmed: analysis.confirmed, history });

    const messages: ChatTurn[] = [
      {
        role: 'system',
        content: [
          '你是这次事件分析结果的答疑助手。只能用下面给定的上下文回答，',
          '上下文不足时明确说明缺少什么，**不要臆造文件路径、行号或结论**。',
          '回答用中文、力求简洁（不超过 400 字），不要输出代码块。',
        ].join(''),
      },
      { role: 'user', content: `${ctx.text}\n\n<question>\n${question}\n</question>` },
    ];

    const controller = new AbortController();
    const hardMs = deps?.hardTimeoutMs ?? ASK_HARD_BUDGET_MS;
    const timer = setTimeout(() => controller.abort(), hardMs);
    let answer = '';
    let truncated = false;
    let promptTokens = 0;
    let completionTokens = 0;
    try {
      const stream = (deps?.streamChatFn ?? streamChat)(messages, {
        signal: controller.signal,
        llm: {
          baseURL: cfg.llm?.baseURL ?? '',
          apiKey: cfg.llm?.apiKey ?? '',
          model: cfg.llm?.model ?? '',
          temperature: cfg.llm?.temperature,
          maxTokens: cfg.llm?.maxTokens,
        },
      });
      for await (const part of stream) {
        if (part.type === 'content') {
          answer += part.text;
          args.onDelta?.(part.text);
        } else if (part.type === 'usage') {
          promptTokens += part.promptTokens ?? 0;
          completionTokens += part.completionTokens ?? 0;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) throw err;
      // 硬超时：有内容就保留（与 ki_ask 同口径），无内容才算失败
      truncated = true;
    } finally {
      clearTimeout(timer);
    }

    const text = answer.trim();
    if (!text) {
      throw new GovernanceError('ANALYSIS_ASK_TIMEOUT', '回答超时且未产生内容，请重试');
    }

    const turn: AnalysisAskTurn = {
      id: `ask_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      question,
      answer: text.slice(0, ASK_ANSWER_MAX_CHARS),
      runId: analysis.draft.runId,
      at: now,
      ...(truncated ? { truncated: true } : {}),
      usage: { promptTokens, completionTokens },
      context: ctx.stats,
    };
    const saved = await appendAskTurn(scope, event.id, turn);
    return { turn, doc: saved.doc };
  } finally {
    // 所有出口都必须释放并发闸，否则并发计数泄漏、后续调用全被判 BUSY
    releaseAskSlot();
  }
}
