/**
 * ask-contract.ts —— 一次性问答（`ki_ask`）的契约与预算常量（S-01 §4a.1）
 *
 * ═══ 这是什么 ═══
 * `ki_ask` 的一次调用 = 一次**独立**问答：不建会话、不读历史、不落盘。
 * 本文件只有类型与常量，无副作用、无 IO —— 便于 S-02（工具面）与单测同时引用。
 *
 * ═══ 三个预算（为什么是这三个值）═══
 * · `ASK_MAX_ROUNDS_DEFAULT = 6`：实测 3 轮可答好事实类问题、11 轮为排查类、
 *   36 轮（62.4s）属"穷举清单"——后者更适合外部 AI 直接调 `ki_search`。
 *   6 轮 ≈ 15~20s，给最后作答与序列化留足余量。
 * · `ASK_SOFT_BUDGET_MS = 25s`：检索阶段到点改为**强制作答**（复用 tool-loop
 *   既有的「拿掉 tools 再调一次」机制），仍能产出完整可读答案。
 * · `ASK_HARD_BUDGET_MS = 45s`：整次问答兜底。MCP 客户端对单次 tools/call 有
 *   **60s 硬超时**（SDK `DEFAULT_REQUEST_TIMEOUT_MSEC`），45s 保证在客户端侧
 *   失败之前由我们自己收口并返回已累积内容。
 *
 * ═══ 不变量 ═══
 * · `runAsk` **不抛**：所有失败归一为 `{ok:false, error}`。
 * · `runAsk` 不做隐私确认 / scope / 限流校验（由 S-02 在调用前完成）。
 * · `rounds` 是**内层工具调用次数**，不等于模型往返轮数（一次响应可含多个 tool_calls）。
 */

import type { Capability } from '../../auth/capabilities.js';
import type { SourceRef } from '../chat-contract.js';

/**
 * 问题长度上限（字符）。
 *
 * ⚠️ 与对话侧 `chat-routes.ts::MESSAGE_MAX_LEN`（20000）**有意不同**：
 * · 对话是人在打字，长上下文是常态；
 * · 问答的调用方是 AI，它完全可能把整段代码/日志贴进 question（20K 字符 ≈ 10K token 直接进上游）。
 * 这种输入更适合 `ki_search` 取片段。超限 **fail-loud** 而不是静默截断 —— 截断会改变问题意图，
 * 而调用方拿到答案时并不知道自己被截断了。
 */
export const ASK_QUESTION_MAX_CHARS = 4000;

/** 内层工具循环的默认轮次上限（可被 `llm.askMaxRounds` 覆盖） */
export const ASK_MAX_ROUNDS_DEFAULT = 6;
/**
 * 轮次上限的可配置上界。
 * 配置越界（<1 或 >本值）→ fail-loud（`config-schema` 校验报错），**不静默钳制**。
 */
export const ASK_MAX_ROUNDS_LIMIT = 12;
/** 软预算：检索阶段到点改为强制作答（不再发起新的工具轮） */
export const ASK_SOFT_BUDGET_MS = 25_000;
/** 硬预算：整次问答兜底，到点 abort 上游并用已累积内容作答 */
export const ASK_HARD_BUDGET_MS = 45_000;

/** `runAsk` 入参 */
export interface AskInput {
  /** 单个知识库名（S-02 已校验形态与存在性；一期不接受视图名/逗号多库） */
  scope: string;
  /** 用户问题原文（非空由 S-02 校验） */
  question: string;
  /**
   * **内层工具面的能力上界**（不是"调用方权限校验"）。
   *
   * S-02 固定传 `new Set(['knowledge.read'])` ⇒ 内层只能看到 6 个只读工具，
   * 与 `PromptConfig.tools` 里用户是否打开写/删工具无关。
   * 缺省 = 不过滤（仅限单测直接调用；生产入口必须传）。
   */
  capabilities?: ReadonlySet<Capability>;
  /** 调用方中止信号（S-02 的硬超时也会并入此信号） */
  signal?: AbortSignal;
}

/** `runAsk` 结果（**不抛异常**，失败走 `ok:false`） */
export interface AskResult {
  ok: boolean;
  /** markdown 正文；`truncated` 时仍是完整可读的部分答案 */
  answer: string;
  /** 已去重的来源引用（无命中时为空数组，**不输出空占位**） */
  sources: SourceRef[];
  /**
   * 净化（丢弃空投影 + 截断到 `ASK_MAX_SOURCES` 条）**前**的来源条数。
   *
   * `sourcesTotal > sources.length` ⇒ 有来源被过滤或截断。**必须暴露**：
   * 否则调用方只看到 15 条，会以为"证据就这么多"，把"我们截断了"误读成"答案依据充分"。
   */
  sourcesTotal: number;
  /**
   * **内层工具调用次数**（按 `tool_end` 计）。
   * ⚠️ 不等于模型往返轮数：一次响应可含 N 个 `tool_calls`，故本值可能大于实际轮次；
   * 用于审计与截断归因，**不用于预算计算**。
   */
  rounds: number;
  /** 本层实测耗时（含强制作答），S-02 用于审计 */
  elapsedMs: number;
  /** 因轮次上限或软/硬预算提前收口 */
  truncated: boolean;
  /** 收口原因（`truncated=false` 时缺省）；S-02 原样透传给调用方 */
  truncatedReason?: 'round-limit' | 'time-budget' | 'hard-timeout';
  /** 降级说明（**仅检索工具失败时**产生；模型不支持 tools 已改为直接拒绝） */
  degraded?: { reason: string; message: string };
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number };
  /** 失败时缺省 ok:false + error；**对外形状由 S-02 展平为 `{ok,code,message,retryable}`** */
  error?: { code: string; message: string; retryable: boolean };
}
