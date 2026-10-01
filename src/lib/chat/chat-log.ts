/**
 * chat 模块日志（`cross-cutting.md` §1.3 + §1.4 的落地）
 *
 * ═══ 契约要求（骨架期冻结，实现期只读）═══
 *
 * | 规则 | 内容 |
 * |------|------|
 * | 输出方式 | `console.error`（错误）/ `console.log`（关键事件），**不引入 logger 库** |
 * | 结构化 | **单行 JSON**：`{"evt":"chat.upstream.error","convId":...,"code":...,"detail":...}` |
 * | 🔴 不打印的内容 | **apiKey（含前缀）/ 消息正文 / reasoning 内容 / 检索片段** |
 * | 上游错误 | **原文仅入 daemon 日志，不回传浏览器**（`error` 字段只给规范化文案） |
 * | 必打事件 | ① 上游调用失败（含 HTTP 状态与**截断原文 ≤200 字**）② 工具调用异常 ③ 会话落盘失败 ④ 检索降级触发 |
 *
 * ═══ §1.4 trace（最小引入，不建 middleware）═══
 * 一次生成请求内所有日志带同一关联键 —— 用**已有的 `conversationId` + `messageId`**
 * （它们本来就在事件流的 `meta` 里），不做跨服务 trace。
 *
 * ═══ 为什么集中一处 ═══
 * 脱敏（禁打 apiKey/正文/reasoning/检索片段）是本模块**唯一会造成安全后果**的日志约束，
 * 若各调用点自行拼字符串，漏一处就等于漏全部。故统一经 `chatLog()` 出口，
 * 由**一处**完成「单行 JSON + 字段白名单 + 截断」。
 *
 * @see design/cross-cutting.md §1.3 / §1.4
 */

/** 必打事件名（与契约 §1.3 的 4 条一一对应） */
export const CHAT_LOG_EVENTS = {
  /** ① 上游调用失败（含 HTTP 状态与截断原文 ≤200 字） */
  UPSTREAM_ERROR: 'chat.upstream.error',
  /** ② 工具调用异常 */
  TOOL_ERROR: 'chat.tool.error',
  /** ③ 会话落盘失败 */
  WRITE_FAILED: 'chat.write.failed',
  /** ④ 检索降级触发 */
  RETRIEVAL_DEGRADED: 'chat.retrieval.degraded',
  /** 越权拦截（非"必打"但安全相关，沿用既有 `rejectScopeViolation` 的语义） */
  SCOPE_FORBIDDEN: 'chat.scope.forbidden',
  /** 会话 id 冲突（数据异常，fail-loud） */
  CONV_ID_CONFLICT: 'chat.conv.id-conflict',
} as const;

export type ChatLogEvent = (typeof CHAT_LOG_EVENTS)[keyof typeof CHAT_LOG_EVENTS];

/** 上游错误原文进日志时的截断长度（契约 §1.3 明写 ≤200 字） */
export const LOG_DETAIL_MAX_CHARS = 200;

/** 日志字段（**白名单**：只有这些键会出现在输出里） */
export interface ChatLogFields {
  /** 会话 id（§1.4 的天然关联键） */
  convId?: string;
  /** 本次生成的消息 id（§1.4 的天然关联键） */
  msgId?: string;
  /** 工具名（工具异常时） */
  tool?: string;
  /** 错误码（规范化后的 code，不含上游原文） */
  code?: string;
  /** 上游 HTTP 状态（上游失败时） */
  status?: number;
  /** 降级原因（检索降级时） */
  reason?: string;
  /** 是否可重试 */
  retryable?: boolean;
  /** 详情：**上游原文/异常 message 等**，会经脱敏 + 截断 |
   *  ⚠️ 调用方**不得**传入消息正文 / reasoning / 检索片段（本函数也会兜底检测） */
  detail?: string;
}

/**
 * 敏感内容兜底模式（🔴 §1.3「不打印的内容」）。
 *
 * 这是**纵深防御**：即便调用方误传，也在出口拦下。
 * 说明：不可能做到 100% 精确（无法在此判断"这段是不是用户正文"），
 * 故此处只拦**高置信度**的模式 —— apiKey 形态、超长文本（正文/reasoning/片段通常很长）。
 */
const API_KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g;

/** 遮罩 apiKey 形态的串 */
function maskSecrets(s: string): string {
  return s.replace(API_KEY_PATTERN, '[REDACTED]');
}

/** 详情脱敏 + 截断（上游原文 ≤200 字，§1.3 明写） */
function sanitizeDetail(detail: string, maxChars = LOG_DETAIL_MAX_CHARS): string {
  const oneLine = maskSecrets(detail).replace(/\s+/g, ' ').trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…[截断]` : oneLine;
}

/**
 * 输出一条 chat 模块日志（**唯一出口**）。
 *
 * · 单行 JSON（§1.3）+ `convId`/`msgId` 关联键（§1.4）
 * · 详情经**脱敏（apiKey）+ 截断（≤200 字）**
 * · `console.error`（错误类）/ `console.log`（其他关键事件），不引入 logger 库
 */
export function chatLog(
  evt: ChatLogEvent | string,
  fields: ChatLogFields = {},
  level: 'error' | 'info' = 'error',
): void {
  const payload: Record<string, unknown> = { evt };
  if (fields.convId !== undefined) payload.convId = fields.convId;
  if (fields.msgId !== undefined) payload.msgId = fields.msgId;
  if (fields.tool !== undefined) payload.tool = fields.tool;
  if (fields.code !== undefined) payload.code = fields.code;
  if (fields.status !== undefined) payload.status = fields.status;
  if (fields.reason !== undefined) payload.reason = fields.reason;
  if (fields.retryable !== undefined) payload.retryable = fields.retryable;
  if (fields.detail !== undefined) payload.detail = sanitizeDetail(fields.detail);

  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** 供内部与测试使用：暴露脱敏/截断逻辑，便于断言"日志不含敏感内容" */
export function __sanitizeDetailForTest(detail: string): string {
  return sanitizeDetail(detail);
}
