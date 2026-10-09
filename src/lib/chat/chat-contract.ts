/**
 * 聊天模块 · 契约层（**形状 SSOT**）
 *
 * 本文件是 REQ-20260924-001 的契约载体：
 *   - 数据模型 / SSE 事件协议 / 配置形状 / 预算常量 / 错误码
 *   - 由 `design/S07` + `api/INDEX.md` + `api/retrieval.md` + `api/config.md` 定稿
 *
 * ⚠️ 契约约束（实现方必读）：
 *   1. 本文件在骨架期【冻结】，实现期**一字不改**；变更须回 design 并走批次边界
 *      （唯一已批准的批次边界变更：**批次 2（2026-10-08）** —— `tool_start` 的
 *        `query`/`mode` 改**可选**、新增可选 `args`，承载非检索类 MCP 工具；
 *        决策 D5，见 `.plans/2026-10-08-chat-mcp-tools-batch2/plan.md`。
 *        其余形状未动；前端副本与 contract-parity 已同步）
 *   2. 前端有同形状副本 `web/src/api/chatContract.ts`（两端是独立 package，无法互相 import）
 *      → 形状一致性由 `tests/contract/SR-02/contract-parity.test.mjs` 机械保证
 *   3. 所有 stub 实现带「桩标记」，供桩残留扫描（标记模式见 `.delivery/stub-pattern`）
 *      ⚠️ **本注释刻意不写完整字面量**：契约文件若含完整模式串，会被桩残留扫描命中 → 自我误报
 *
 * @see design/S07_检索与工具调用_DESIGN.md
 */

// ─────────────────────────────────────────────────────────────
// 1. 数据模型（S-02 §3.2 + §9.1）
// ─────────────────────────────────────────────────────────────

/** 来源引用：可点击定位的检索产物（S07 §3.5） */
export interface SourceRef {
  group: string;
  /** = SearchHit.relation（文档名） */
  doc: string;
  /** 1-based；chunk fallback 无法映射时为 0（UI 不得显示 "0-0"） */
  lineStart: number;
  /** 含端；无法映射时为 0 */
  lineEnd: number;
  /** ≤200 字，供刷新后展示引用摘要 */
  snippet: string;
}

/** 本次工具实际返回的文本；仅超过总字符预算时截断，模型与页面共用。 */
export interface ChatToolResponse {
  text: string;
  originalChars: number;
  truncated: boolean;
}

/**
 * 检索过程步骤（**步骤级摘要**，落盘进 `ChatMessage.progress`）。
 *
 * 为什么要有：工具步骤原先只活在 `streaming.progress`（内存），`streamEnd` 一清空就没了 ——
 * 用户生成中看着"正在检索知识库…"，生成完（甚至没刷新页面）就什么都不剩，无法自证
 * AI 到底检索了几次（真机走查 #11）。
 *
 * ⚠️ 与 `ChatMessage` 的两条结构性不变量不冲突：
 *   · **不是 reasoning**：工具调用信息与有界返回，不含思考文本；
 *   · **返回正文有界**：保留实际工具返回，仅超过 10000 字符时截断。
 *
 * 形状与 SSE 的 `tool_start` / `tool_end` 事件对齐，便于前端复用同一套文案渲染。
 */
export interface ChatProgressStep {
  phase: 'start' | 'end';
  /**
   * 本步发生时**已发出的正文字符数**（interleave 锚点）：
   * 渲染时把正文按各行的 afterChars 切段，调用痕迹插在"哪句话之后"就显示在哪句话下面。
   * 旧数据无此字段 → 视为 0（集中在正文前，维持旧行为）。
   */
  afterChars?: number;
  /** 工具名（如 `ki_search`） */
  name?: string;
  /** 检索模式（`tool_start` 带） */
  mode?: string;
  /** 命中条数（`tool_end` 带） */
  hits?: number;
  /** 有界工具返回；旧记录缺失时仅展示摘要。 */
  response?: ChatToolResponse;
  durationMs?: number;
  /** 工具报错文本（仅失败步骤；这是"说人话"的失败原因，不含片段正文） */
  error?: string;
}

/**
 * 会话消息。
 *
 * ⚠️ 两条结构性不变量（不得违反）：
 *   - **不含 `reasoning`**（D7 不落盘；且它是上游 messages 的来源，从结构上保证"思考永不回传"）
 *   - 不落无界检索原始结果；`progress.response` 最多 10000 字符，`sources` 用于定位
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  // 以下仅 assistant 且生成完成/中止时写入
  aborted?: boolean;
  finishReason?: string;
  timing?: { ttfbMs: number | null; firstContentMs: number | null; totalMs: number };
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number };
  /** S-02 §9.1：来源引用（v2 新增） */
  sources?: SourceRef[];
  /** 检索过程步骤摘要（生成结束后仍可回看；见 `ChatProgressStep` 的边界说明） */
  progress?: ChatProgressStep[];
}

/** 会话文件（S-02 §3.2） */
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

/** 会话列表项（S-02 §3.4） */
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
// 2. SSE 事件协议（api/retrieval.md §1）
// ─────────────────────────────────────────────────────────────

/** 降级原因（三类互斥，取最先触发者） */
export type DegradedReason = 'tools-unsupported' | 'retrieval-unavailable' | 'semantic-degraded';

/** 检索模式（S07 §3.2） */
export type RetrievalMode = 'fulltext' | 'hybrid';

/** SSE 事件（判别联合，前端按 `type` 分派） */
export type ChatEvent =
  | { type: 'meta'; conversationId: string; messageId: string; model: string; discardedCount?: number; userMessageId?: string }
  /**
   * 工具调用开始（批次 2 泛化，D5）：
   * · 检索类工具（ki_search）带 `query` + `mode`（旧行为）
   * · 其余工具带 `args`（服务端生成的参数摘要，大字段已排除）
   * · `query`/`mode`/`args` 均可选 —— 前端按存在性渲染，不得假设必有
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

/** 事件类型名（供契约测试遍历） */
export const CHAT_EVENT_TYPES = [
  'meta', 'tool_start', 'tool_end', 'sources', 'degraded',
  'reasoning', 'content', 'usage', 'done', 'aborted', 'error',
] as const;

/**
 * 事件顺序约束（api/retrieval.md §1.2，**契约测试须覆盖**）
 *
 * - `tool_start` / `tool_end` 必须成对（工具抛错也要发 `tool_end` 带 error）
 * - `sources` 至多一次且在 `done` 之前（无来源时**不发**，而非发空数组）
 * - `degraded` 至多一次
 * - 正常序：meta → tool_start → tool_end → [tool_start → tool_end]* → reasoning* → content* → sources → usage → done
 */
export const CHAT_EVENT_ORDER_RULES = {
  toolStartMustPairWithEnd: true,
  sourcesAtMostOnce: true,
  sourcesBeforeDone: true,
  degradedAtMostOnce: true,
} as const;

// ─────────────────────────────────────────────────────────────
// 3. 配置形状（api/config.md，含 v2 字段）
// ─────────────────────────────────────────────────────────────

export interface ChatConfigOk {
  ok: true;
  enabled: boolean;
  model: string | null;
  /** 仅主机名，绝不回传 apiKey 或完整 URL 路径 */
  baseURLHost: string | null;
  configPath: string;
  requestTimeoutMs: number | null;
  reason: string | null;
  code: string | null;
  // ── v2（D13）──────────────────────────────
  /** 决定走【工具路径】还是【预检索降级路径】；**不决定能否检索** */
  supportsTools: boolean;
  /** 检索问答是否可用 = `!ackRequired`（与 supportsTools **正交**，前端最易写错处） */
  retrievalEnabled: boolean;
  /** 未确认隐私 → 面板阻塞发送（T12） */
  ackRequired: boolean;
  maxToolRounds: number;
}

// ─────────────────────────────────────────────────────────────
// 4. 预算常量（S07 §3.4 · T11 拍板）
// ─────────────────────────────────────────────────────────────

export const CHAT_BUDGET = {
  /**
   * 工具调用轮次上限（T11 原为 3；**2026-09-30 用户裁决取消约束** → Infinity）。
   * 一句一检的长节奏不该被截断；防失控由模型自然停手 / 用户中止 / 请求超时兜底。
   * ⚠️ Infinity 经 JSON 序列化为 null：消费方只做展示/比较，不做算术（见 retrieval-skill 规则 4）。
   */
  maxToolRounds: Number.POSITIVE_INFINITY,
  /** 单次检索返回条数上限（T11） */
  maxHitsPerCall: 5,
  /** 工具返回总长度上限；不按字段或单条片段裁剪。 */
  maxToolResponseChars: 10000,
  /** 旧投影兼容函数的单片段截断长度（S07 §3.4） */
  snippetChars: 300,
  /** `sources[].snippet` 落盘截断长度（S07 §3.5） */
  sourceSnippetChars: 200,
  /** 整体超时（D13 后重估：180s → 300s） */
  requestTimeoutMs: 300_000,
  /** 首块超时（只约束"建立连接并收到首个 chunk"，不约束工具轮次） */
  firstByteTimeoutMs: 30_000,
} as const;

// ─────────────────────────────────────────────────────────────
// 5. 错误码（api/INDEX.md §3，**按模块分段**）
// ─────────────────────────────────────────────────────────────

/**
 * chat 模块错误码。
 *
 * 分段约定：`1xxx` 配置 / `2xxx` 会话 / `3xxx` 消息与生成 / `4xxx` 检索与隐私
 */
export const CHAT_ERROR_CODES = {
  // 1xxx 配置
  CHAT_DISABLED: 'CHAT_DISABLED',
  // 2xxx 会话
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  CONVERSATION_INVALID: 'CONVERSATION_INVALID',
  CONVERSATION_GENERATING: 'CONVERSATION_GENERATING',
  CHAT_WRITE_FAILED: 'CHAT_WRITE_FAILED',
  // 3xxx 消息与生成
  MESSAGE_INVALID: 'MESSAGE_INVALID',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  LLM_UPSTREAM_ERROR: 'LLM_UPSTREAM_ERROR',
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_RATE_LIMITED: 'LLM_RATE_LIMITED',
  // 4xxx 检索与隐私
  DISCLOSURE_REQUIRED: 'DISCLOSURE_REQUIRED',
  KB_IMAGE_MISSING: 'KB_IMAGE_MISSING',
} as const;

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[keyof typeof CHAT_ERROR_CODES];
