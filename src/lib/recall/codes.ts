/**
 * recall/codes.ts —— `ki_recall` 的错误码**唯一真源**。
 *
 * 两段式，别合并：
 *   - **内核码**（`RecallKernelErrorCode`）：S-01 只看「范围/模型/执行」出了什么事，不关心对外语义；
 *   - **工具码**（`RECALL_TOOL_CODES`）：MCP 客户端只看得到它，必须自带原因 + 出路文案。
 *
 * 为什么不直接抛工具码：内核要能在工具层之外被单测（也避免"内核开始关心 MCP 语义"）。
 * 映射只有一张表（`toolCodeForKernel`），新增内核码时 TS 会逼你补映射（穷尽 switch）。
 *
 * ⚠️ `TOKEN_MODEL_FORBIDDEN` **不在本文件**：它由 `lib/mcp-tools/tool-access.ts` 统一定义，
 *    所有「模型消耗型」工具共用同一个码。
 *
 * 2026-11-18（REQ-20261118-004）变更：
 *   · 删 `MODE_UNAVAILABLE`（不再有通道可选）与 `BUSY`（并发槽取消）
 *   · 新增 `MODEL_UNAVAILABLE` / `DISCLOSURE_REQUIRED` / `TOOLS_UNSUPPORTED` 三态 ——
 *     三者都是**直接不可用**（不降级），且对外文案统一引导「改用 ki_search 自己查」
 */

export type RecallKernelErrorCode =
  /** 未传 scope（必填） */
  | 'SCOPE_REQUIRED'
  /** 传入的 scope 既不是库也不是视图 */
  | 'SCOPE_UNKNOWN'
  /** 传入的 scope 存在但无授权 */
  | 'SCOPE_FORBIDDEN'
  /** 全部 target 被剔除（权限/缺失/超限） */
  | 'NO_TARGETS'
  /** 每个 target 的检索都失败了 */
  | 'ALL_TARGETS_FAILED'
  /** 模型未配置 / 不合法 URL */
  | 'MODEL_UNAVAILABLE'
  /** 知识库内容外发未确认（`llm.kbDisclosureAck !== true`） */
  | 'DISCLOSURE_REQUIRED'
  /** 模型不支持 function calling（`llm.supportsTools === false`） */
  | 'TOOLS_UNSUPPORTED';

export const RECALL_TOOL_CODES = {
  TASK_INVALID: 'RECALL_TASK_INVALID',
  HINTS_INVALID: 'RECALL_HINTS_INVALID',
  SCOPE_REQUIRED: 'RECALL_SCOPE_REQUIRED',
  SCOPE_UNKNOWN: 'RECALL_SCOPE_UNKNOWN',
  SCOPE_FORBIDDEN: 'RECALL_SCOPE_FORBIDDEN',
  TARGETS_EMPTY: 'RECALL_TARGETS_EMPTY',
  MODEL_UNAVAILABLE: 'RECALL_MODEL_UNAVAILABLE',
  DISCLOSURE_REQUIRED: 'RECALL_DISCLOSURE_REQUIRED',
  TOOLS_UNSUPPORTED: 'RECALL_TOOLS_UNSUPPORTED',
  THROTTLED: 'RECALL_THROTTLED',
  TIMEOUT: 'RECALL_TIMEOUT',
  INTERNAL: 'RECALL_INTERNAL',
} as const;

export type RecallToolCode = (typeof RECALL_TOOL_CODES)[keyof typeof RECALL_TOOL_CODES];

/** 可重试的码（调用方据此决定要不要退避重试；不可重试的**重试也没用**） */
export const RETRYABLE_TOOL_CODES: ReadonlySet<RecallToolCode> = new Set<RecallToolCode>([
  RECALL_TOOL_CODES.THROTTLED,
  RECALL_TOOL_CODES.TIMEOUT,
  RECALL_TOOL_CODES.INTERNAL,
]);

/** 内核码 → 工具码（穷尽映射：新增内核码时 TS 会报缺分支） */
export function toolCodeForKernel(code: RecallKernelErrorCode): RecallToolCode {
  switch (code) {
    case 'SCOPE_REQUIRED':
      return RECALL_TOOL_CODES.SCOPE_REQUIRED;
    case 'SCOPE_UNKNOWN':
      return RECALL_TOOL_CODES.SCOPE_UNKNOWN;
    case 'SCOPE_FORBIDDEN':
      return RECALL_TOOL_CODES.SCOPE_FORBIDDEN;
    case 'NO_TARGETS':
      return RECALL_TOOL_CODES.TARGETS_EMPTY;
    case 'MODEL_UNAVAILABLE':
      return RECALL_TOOL_CODES.MODEL_UNAVAILABLE;
    case 'DISCLOSURE_REQUIRED':
      return RECALL_TOOL_CODES.DISCLOSURE_REQUIRED;
    case 'TOOLS_UNSUPPORTED':
      return RECALL_TOOL_CODES.TOOLS_UNSUPPORTED;
    case 'ALL_TARGETS_FAILED':
      return RECALL_TOOL_CODES.INTERNAL;
  }
}

/**
 * 内核错误。**只在 S-01 内部抛**；工具层捕获后按 `toolCodeForKernel` 转成对外码。
 *
 * `message` 面向维护者（服务端日志），对外文案由工具层按工具码生成 —— 不要把对外文案放这里，
 * 否则同一个码在两处各写一份必然漂移。
 */
export class RecallKernelError extends Error {
  readonly code: RecallKernelErrorCode;

  constructor(code: RecallKernelErrorCode, message: string) {
    super(message);
    this.name = 'RecallKernelError';
    this.code = code;
  }
}
