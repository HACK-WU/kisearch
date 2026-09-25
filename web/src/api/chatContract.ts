/**
 * 聊天模块 · 前端契约副本
 *
 * ⚠️ **本文件是 `src/lib/chat/chat-contract.ts` 的前端副本**，两者形状必须一致。
 *
 * 为什么是副本而不是 import：
 *   `web/tsconfig.json` 的 `include` 只含 `web/src`（前端是独立 package，从未引用过后端代码），
 *   强行跨包引用会耦合两端构建。因此采用「各写一份 + 契约测试机械比对」。
 *
 * 形状一致性由 `tests/contract/SR-02/contract-parity.test.mjs` 保证（**骨架期为红**）。
 * 改动任一侧 → 该测试变绿前不得交付。
 */

// ─────────────────────────────────────────────────────────────
// 1. 数据模型（与后端 ChatMessage / ConversationFile 同形状）
// ─────────────────────────────────────────────────────────────

/** 来源引用：点击可打开原文并高亮（R20） */
export interface SourceRef {
  group: string;
  doc: string;
  /** 1-based；为 0 表示"只能定位到文档级"（UI 不得显示 "0-0"） */
  lineStart: number;
  lineEnd: number;
  /** ≤200 字引用摘要 */
  snippet: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  aborted?: boolean;
  finishReason?: string;
  timing?: { ttfbMs: number | null; firstContentMs: number | null; totalMs: number };
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number };
  /** 来源引用（刷新后仍可展示） */
  sources?: SourceRef[];
}

export interface ConversationFile {
  version: 1;
  id: string;
  scope: string;
  title: string;
  systemPrompt: string;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
  messageCount: number;
  lastMessagePreview: string;
  messages: ChatMessage[];
}

export interface ConversationSummary {
  id: string;
  scope: string;
  title: string;
  archived: boolean;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string;
  corrupted: boolean;
}

// ─────────────────────────────────────────────────────────────
// 2. SSE 事件协议（前端按 `type` 分派，不做重排）
// ─────────────────────────────────────────────────────────────

export type DegradedReason = 'tools-unsupported' | 'retrieval-unavailable' | 'semantic-degraded';

export type RetrievalMode = 'fulltext' | 'hybrid';

export type ChatEvent =
  | { type: 'meta'; conversationId: string; messageId: string; model: string; discardedCount?: number }
  | { type: 'tool_start'; name: string; query: string; mode: RetrievalMode }
  | { type: 'tool_end'; hits: number; durationMs: number; error?: string }
  | { type: 'sources'; sources: SourceRef[] }
  | { type: 'degraded'; reason: DegradedReason; message: string }
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; reasoningTokens?: number }
  | {
      type: 'done';
      messageId: string;
      finishReason: string;
      sources: SourceRef[];
      warning?: 'tool-rounds-exhausted' | 'conversation-too-long';
    }
  | { type: 'aborted'; messageId: string }
  | { type: 'error'; code: string; error: string; retryable?: boolean };

export const CHAT_EVENT_TYPES = [
  'meta', 'tool_start', 'tool_end', 'sources', 'degraded',
  'reasoning', 'content', 'usage', 'done', 'aborted', 'error',
] as const;

// ─────────────────────────────────────────────────────────────
// 3. 配置形状（前端据此渲染 4 种状态）
// ─────────────────────────────────────────────────────────────

export interface ChatConfigOk {
  ok: true;
  enabled: boolean;
  model: string | null;
  baseURLHost: string | null;
  configPath: string;
  requestTimeoutMs: number | null;
  reason: string | null;
  code: string | null;
  supportsTools: boolean;
  /** = `!ackRequired`；与 supportsTools 正交（见 api/config.md 对照表） */
  retrievalEnabled: boolean;
  ackRequired: boolean;
  maxToolRounds: number;
}

// ─────────────────────────────────────────────────────────────
// 4. 降级提示文案（前端唯一来源，避免多处硬编码不一致）
// ─────────────────────────────────────────────────────────────

/**
 * `degraded` 事件 → 用户可见文案。
 *
 * ⚠️ **必须可见，不得静默**（N17）：用户看不到标记就会把"没检索"当成"检索了但没找到"。
 */
export const DEGRADED_LABELS: Record<DegradedReason, string> = {
  'tools-unsupported': '本次未使用工具检索',
  'retrieval-unavailable': '本次未检索',
  'semantic-degraded': '语义检索降级为全文',
};
