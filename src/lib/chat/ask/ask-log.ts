/**
 * ask-log.ts —— `ki_ask` 的审计出口（REQ-20261113-001 · S-02 §4a.4）
 *
 * ═══ 为什么不复用 `chat-log.ts` ═══
 * `chat-log` 的字段白名单是**会话语义**（`convId` / `msgId` 是它的关联键），
 * 问答没有会话；若为问答往那里加 `rounds` / `elapsedMs` / `questionChars`，
 * 会让**所有对话链路**的日志契约承担问答字段，且脱敏口径也要分叉。
 *
 * ═══ 硬约束（与 chat-log 同源）═══
 * · 输出：**单行 JSON 到 stderr**（不污染 stdout —— daemon 的 stdout 走日志文件/协议）
 * · 🔴 **绝不打印**：问题正文、答案正文、检索片段、apiKey
 *   —— 只记 `questionChars`（长度）与计数类字段
 * · 出口统一走本函数：脱敏 + 字段白名单**只有这一处**，散落调用点漏一处即等于漏全部
 *
 * ═══ 使用点（S-02 §4a.3）═══
 * · 成功 / 失败 → `chat.ask.done` / `chat.ask.error`
 * · 限流拒绝 → `chat.ask.throttled`（在 finally 之前、返回 403/429 之前打）
 */

/** 事件名（与 S-02 §4a.3 的调用点一一对应） */
export const ASK_LOG_EVENTS = {
  DONE: 'chat.ask.done',
  ERROR: 'chat.ask.error',
  THROTTLED: 'chat.ask.throttled',
} as const;

export type AskLogEvent = (typeof ASK_LOG_EVENTS)[keyof typeof ASK_LOG_EVENTS];

/** 审计字段（**白名单**：只有这些键会出现在输出里） */
export interface AskLogFields {
  /** 落点知识库（不含视图成员，问答一期只支持单库） */
  scope: string;
  /**
   * 调用方键：`tokenId` / `userId` / `'local'`。
   * ⚠️ 是**标识符**不是凭据；用于限流归属与追溯，不含密钥。
   */
  principalKey: string;
  /** 内层工具调用次数（≠ 模型往返轮数，见 `AskResult.rounds` 注释） */
  rounds?: number;
  /** 本层实测耗时（毫秒，含强制作答） */
  elapsedMs?: number;
  /** 是否因轮次/预算提前收口 */
  truncated?: boolean;
  /** 收口原因（与 `AskResult.truncatedReason` 同源） */
  truncatedReason?: string;
  /** 问题**字符数**（★ 只记长度，绝不记正文） */
  questionChars?: number;
  /** 规范化错误码（`ASK_*`） */
  code?: string;
  /** 是否可重试 */
  retryable?: boolean;
  promptTokens?: number;
  completionTokens?: number;
}

/** 输出字段顺序（固定，便于日志并排比较与 grep） */
const FIELD_ORDER: readonly (keyof AskLogFields)[] = [
  'scope', 'principalKey', 'rounds', 'elapsedMs', 'truncated', 'truncatedReason',
  'questionChars', 'code', 'retryable', 'promptTokens', 'completionTokens',
];

/** 高置信度敏感形态（纵深防御：即便调用方误传也在出口遮罩） */
const SECRET_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g;

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SECRET_PATTERN, '[REDACTED]');
  return value;
}

/**
 * 写一条审计。**不抛**（审计是旁路，写失败不得影响问答主流程）。
 */
export function askLog(event: AskLogEvent, fields: AskLogFields): void {
  try {
    const payload: Record<string, unknown> = { evt: event, at: new Date().toISOString() };
    for (const key of FIELD_ORDER) {
      const value = fields[key];
      if (value === undefined) continue;
      payload[key] = sanitize(value);
    }
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // 审计失败不得影响主流程（S-02 §6）：连 stderr 都写不进去时静默
  }
}
