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

/** 检索过程步骤摘要（与后端 `chat-contract.ts` 的 `ChatProgressStep` 对齐；**落盘**，刷新后仍可展示） */
/** 本次工具实际返回的文本；仅超过总字符预算时截断，模型与页面共用。 */
export interface ChatToolResponse {
  text: string;
  originalChars: number;
  truncated: boolean;
}

export interface ChatProgressStep {
  phase: 'start' | 'end';
  /** 本步发生时已发出的正文字符数（interleave 锚点，与后端契约对齐；旧数据缺省 = 0） */
  afterChars?: number;
  name?: string;
  mode?: string;
  hits?: number;
  /** 有界工具返回；旧记录缺失时仅展示摘要。 */
  response?: ChatToolResponse;
  durationMs?: number;
  error?: string;
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
  /** 检索过程步骤摘要（走查 #11：落盘 → 刷新/切会话后仍可回看"检索了几次"） */
  progress?: ChatProgressStep[];
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
  | { type: 'meta'; conversationId: string; messageId: string; model: string; discardedCount?: number; userMessageId?: string }
  /**
   * 工具调用开始（批次 2 泛化）：
   * · 检索类工具（ki_search）带 `query` + `mode`；其余工具带 `args`（参数摘要）
   * · 三者均**可选** —— 渲染按存在性分支，不得假设必有
   */
  | { type: 'tool_start'; name: string; query?: string; mode?: RetrievalMode; args?: string }
  | { type: 'tool_end'; hits: number; durationMs: number; error?: string; response?: ChatToolResponse }
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
// 3b. 对话配置层（提示词 / Skill / 工具开关）—— 与 `src/lib/chat/prompt-config.ts` 对齐
//
// ⚠️ 上限（字数 / 条数）与工具分组**都不在此硬编码**：一律用 `GET /prompt-config`
//    返回的 `limits` / `toolGroups`。工具名的 SSOT 在服务端（`src/lib/mcp-tools/`），
//    前端另写一份清单必然会随工具增减而漂移。
// ─────────────────────────────────────────────────────────────

export interface PromptSkill {
  id: string;
  name: string;
  content: string;
  /** 内置条目：可改内容、可禁用、**不可删除**（服务端强校验，前端据此隐藏删除入口） */
  builtin: boolean;
  enabled: boolean;
  /** 最后修改时间（ISO）；未改过时等于内置默认时间戳 */
  at: string;
}

export interface PromptConfig {
  version: 1;
  prompt: { content: string; at: string };
  skills: PromptSkill[];
  /** 工具名 → 是否暴露给 AI（批次 2 起真实生效：保存后下一次提问即生效） */
  tools: Record<string, boolean>;
}

export interface PromptConfigLimits {
  promptMaxChars: number;
  skillMaxChars: number;
  skillNameMaxChars: number;
  maxSkills: number;
}

/** 工具分组（顺序 = 只读 → 写入 → 删除；`danger` 组默认关闭、开启需二次确认） */
export interface PromptToolGroup {
  key: 'read' | 'write' | 'delete';
  label: string;
  danger: boolean;
  names: string[];
  /** 工具短描述（走查 #7；服务端 `MCP_TOOL_GROUPS.descs` 下发，UI 文案非工具契约。
   *  可选：旧版 daemon 响应无此字段，前端必须容忍缺失而不是假设一定有 */
  descs?: Record<string, string>;
}

export interface PromptConfigOk {
  ok: true;
  config: PromptConfig;
  /** 内置默认（「恢复默认」直接回填用，前端不复制一份默认文案） */
  defaults: PromptConfig;
  limits: PromptConfigLimits;
  toolGroups: PromptToolGroup[];
  /** 非 null = 配置文件有问题且**已回退默认**（必须可见，不得静默） */
  issue: string | null;
}

export interface PromptConfigSaveOk {
  ok: true;
  config: PromptConfig;
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
  // 批次 2（D2）：不支持工具 → 纯聊天（不再预检索），如实告知
  'tools-unsupported': '本次未检索知识库（模型不支持工具调用，按纯对话回答）',
  // 原为「本次未检索」—— 与实际语义不符：该 reason 表示"检索请求未成功"（可能已调用多次后失败），
  // 说"未检索"会让用户以为压根没搜，且与「已达检索轮次上限」并列时看似自相矛盾（真机走查 #10）
  'retrieval-unavailable': '本次检索未成功',
  'semantic-degraded': '语义检索降级为全文',
};
