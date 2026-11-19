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

/**
 * 背景长度上限（字符，REQ-20261115-001 · R3）。
 *
 * **语义是「简短前提」**：项目 / 版本 / 环境 / 约束 / 已试过的方案。2000 ≈ 1000 汉字，
 * 足以容纳 20~30 行报错摘要；再长就不是背景而是「材料」，应改用 `ki_search` 取片段。
 *
 * ⚠️ 与 `ASK_QUESTION_MAX_CHARS` **各自独立校验**（不合并计算）：
 * 两者语义不同，合并会让"问得长"挤掉"交代前提"的空间，反之亦然。
 */
export const ASK_BACKGROUND_MAX_CHARS = 2000;

/** 内层工具循环的默认轮次上限（可被 `llm.askMaxRounds` 覆盖） */
export const ASK_MAX_ROUNDS_DEFAULT = 6;
/**
 * 轮次上限的可配置上界。
 * 配置越界（<1 或 >本值）→ fail-loud（`config-schema` 校验报错），**不静默钳制**。
 */
export const ASK_MAX_ROUNDS_LIMIT = 12;
// ── 二期（S-03）：短会话续接 + 滑动 TTL ─────────────────────────────
/**
 * 短会话 TTL：默认 10 分钟，可配置上限 60 分钟。
 *
 * **滑动口径**：以最后一次交互（`updatedAt`，由 `writeJson` 自动打戳）起算，
 * 不是创建时间 —— 用户连续追问会不断顺延（S-03 §3.2 决策）。
 */
export const ASK_SESSION_TTL_DEFAULT_MS = 600_000;
export const ASK_SESSION_TTL_LIMIT_MS = 3_600_000;
/**
 * 上下文预算：单条短会话累积的消息条数与字符总量上限。
 *
 * **超限显式报错而不是静默截断**（R17）—— 截断会让模型基于"残缺历史"作答，
 * 而调用方并不知道自己丢了上下文。
 */
/**
 * 问答来源（REQ-20261116-003 · S-01）：这次问答是从哪条 MCP 通道发起的。
 *
 * · `local` = 本机免 Token 连接（`ownerKey === 'local'`）；
 * · `token` = 远程 Token：`tokenId` 是稳定标识（改名不变），`tokenLabel` 是**落盘时的名称快照**
 *   —— Token 被删除后，列表仍能显示「已删除的 Token（codex）」而不是「未知」。
 *
 * ⚠️ 与 `ownerKey` 的分工：`ownerKey` 服务**续接归属校验**（谁能续），本类型服务**来源展示与分组**。
 *    两者当前取值相同（tokenId / 'local'），但语义不同，不要合并。
 */
export interface AskOrigin {
  kind: 'local' | 'token';
  tokenId?: string;
  tokenLabel?: string;
}

/**
 * 列表态保留天数默认值（REQ-20261116-003 · S-01）。
 *
 * 与续接 TTL **分离**，两者回答不同问题：
 * · `ASK_SESSION_TTL_DEFAULT_MS`（10 分钟滑动）→ `context_id` 还能不能续接；
 * · 本常量（按 `createdAt` 起算，不滑动）→ 文件何时被 GC 删掉。
 * 配置项：`llm.askSessionRetainDays`（1~365，越界 fail-loud）。
 */
export const ASK_SESSION_RETAIN_DEFAULT_DAYS = 7;

export const ASK_CONTEXT_MAX_MESSAGES = 20;
export const ASK_CONTEXT_MAX_CHARS = 60_000;

/** 软预算：检索阶段到点改为强制作答（不再发起新的工具轮） */
export const ASK_SOFT_BUDGET_MS = 25_000;
/** 硬预算：整次问答兜底，到点 abort 上游并用已累积内容作答 */
export const ASK_HARD_BUDGET_MS = 45_000;

/**
 * 事件「追问这次分析」的工具循环轮次上限（2026-11-19 追问带工具再调查）。
 *
 * 与 `ASK_MAX_ROUNDS_DEFAULT`（`ki_ask`，6 轮）分开：追问是针对**单条已定稿分析**的轻调查，
 * 5 轮足够；且它的上下文已含结论/候选，不需要像 `ki_ask` 那样穷举。
 * 达上限走"移除 tools 强制作答"路径（与 tool-loop 的 DSML 收口同口径），不是截断。
 */
export const ASK_TOOL_MAX_ROUNDS = 5;

/** `runAsk` 入参 */
export interface AskInput {
  /** 单个知识库名（S-02 已校验形态与存在性；一期不接受视图名/逗号多库） */
  scope: string;
  /** 用户问题原文（非空由 S-02 校验） */
  question: string;
  /**
   * **一次性问题背景**（可选，REQ-20261115-001）：项目 / 版本 / 环境 / 约束 / 已试方案等简短前提。
   *
   * · 生效范围：**只对本轮**（拼进本轮 user 消息），**不写入短会话**（拍板 §10-1）；
   * · 缺省 / 空串 ⇒ 行为与改造前**逐字节一致**（R1 的硬约束）；
   * · 长度由工具面按 `ASK_BACKGROUND_MAX_CHARS` 校验，本层不再判（与 `question` 同一分工）。
   */
  background?: string;
  /**
   * 续接：传回上一次返回的 `contextId`；**缺省 = 全新问答**（一期语义，行为与一期逐字段一致）。
   *
   * 传了但不存在 / 已过期 / 非本人 → 专用错误码，**绝不静默当新会话**（S-03 §4.3）。
   */
  contextId?: string;
  /**
   * 调用方键（`tokenId` / `'local'`），用于短会话**归属校验**与审计。
   * 缺省 `'local'`（单测或回环直连）。
   */
  principalKey?: string;
  /**
   * 来源标识（REQ-20261116-003 · S-01）：**由工具面构造并下传**。
   *
   * 为什么在工具面构造：只有 `mcp-tools/ask.ts` 同时握有 `principalKey` 与 Token 记录
   * （`listTokens()`）；`ask-runner` 保持纯执行器，不依赖 `mcp-token`。
   * 缺省按 `principalKey` 推导（单测 / 回环直连 → `local`）。
   */
  origin?: AskOrigin;
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
  /**
   * 本次问答的短会话 id（二期）：首轮即新建，续接时为传入值。
   * 调用方下次**追问**时传回即可复用历史；不传则每次都是全新问答。
   */
  contextId: string;
  /** 短会话过期时刻（ISO，= `updatedAt + ttlMs`，每次交互后顺延） */
  expiresAt: string;
  /** 本次是否真的复用了历史（`false` = 新建会话或续接失败但已降级为新建 —— 后者不会发生） */
  resumed: boolean;
}
