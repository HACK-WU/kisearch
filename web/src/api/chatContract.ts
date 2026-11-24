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
 *
 * 已登记的批次边界变更（与后端 `chat-contract.ts` 头部同源）：
 *   · 批次 2（2026-10-08）：`tool_start` 的 `query`/`mode` 改可选、新增可选 `args`
 *   · REQ-20261009-002（2026-10-09）：新增 `ChatRef` 与 `ChatMessage.refs?`（用户手动引用）
 *     ↳ 同日修订：注入方式由「独立 system 块」改为「附在本轮 user 消息末尾」（后端内部行为，
 *       **形状与常量未变**，前端无需适配）
 *   · skill 按需加载（2026-10-13）：新增 SSE 事件 `skill`（`CHAT_EVENT_TYPES` 12 → 13 类）；
 *     `ChatProgressStep` 增可选 `kind`/`skillId`/`skillDescription`/`chars`/`alreadyLoaded`；
 *     `PromptSkill` 增 `description`；`PromptConfigLimits` 增两个描述上限字段
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

/**
 * 用户手动引用的知识库文档片段（REQ-20261009-002 需求 B）—— 与后端同形状副本。
 *
 * 与 `SourceRef` 的分工：`SourceRef` 是检索产物（后端产出）；`ChatRef` 是用户指定
 * （前端产出，带选中的原文片段，后端不读原文）。
 */
export interface ChatRef {
  group: string;
  /** 文档名（= relation） */
  doc: string;
  /** 引用的正文：片段 = 划选原文；整篇 = 按预算截断后的正文（按 CHAT_REF_TEXT_MAX 截断后上送） */
  text: string;
  /**
   * 引用类型（2026-11-20 新增，**可选**）：缺省 = 划选的片段；`'doc'` = 整篇文档。
   * 与后端 `chat-contract.ts` 手工同源，改一处必须同步另一处。
   */
  kind?: 'doc';
  /** 整篇文档的原文总字数（仅 `kind='doc'` 有意义）：用于提示「原文 M 字，已截断至 N 字」 */
  totalChars?: number;
}

/** 单次提问的引用条数上限（UI 据此禁用「加入」） */
export const CHAT_REF_MAX_COUNT = 5;
/** 单条引用文本上限（字符）：超出时前端截断并提示 */
export const CHAT_REF_TEXT_MAX = 2000;
/** 全部引用文本合计上限（字符，与后端一致） */
export const CHAT_REF_TOTAL_MAX = 6000;

/** 单次提问可 `/` 点名的 skill 个数上限（与后端 `CHAT_SKILLS_MAX` 手工同源） */
export const CHAT_SKILLS_MAX = 5;

/**
 * 工具入参的**展示用**扁平摘要（与后端 `ChatToolArgsDisplay` 对齐）。
 *
 * · 大字段 `module_info` / `edits` / `text` / `items` 不进来，字符串值 ≤60 字符；
 * · 生成中（SSE `tool_start.args`）与落盘回看（`ChatProgressStep.args`）是**同一份产物**，
 *   界面必须渲染成同一个 JSON，不得各拼一套（否则刷新前后两副面孔）。
 */
export type ChatToolArgsDisplay = Record<string, string | number | boolean>;

/** 本次工具实际返回的文本；仅超过总字符预算时截断，模型与页面共用。 */
export interface ChatToolResponse {
  text: string;
  originalChars: number;
  truncated: boolean;
  /** 本次序列化使用的字符上限（配置生效值，REQ-20261015-001）；旧记录缺失 → 回退为不显示具体上限的文案 */
  limit?: number;
}

/** 检索过程步骤摘要（与后端 `chat-contract.ts` 的 `ChatProgressStep` 对齐；**落盘**，刷新后仍可展示） */
export interface ChatProgressStep {
  phase: 'start' | 'end';
  /** 步骤类别（2026-10-13）：缺省/`'tool'` = MCP 工具调用；`'skill'` = skill 正文按需加载 */
  kind?: 'tool' | 'skill';
  /** 本步发生时已发出的正文字符数（interleave 锚点，与后端契约对齐；旧数据缺省 = 0） */
  afterChars?: number;
  /** 工具名（如 `ki_search`）/ skill 步骤时为 skill 名称 */
  name?: string;
  mode?: string;
  /** 检索词（`tool_start` 带，仅检索类；后端落盘前截断 200 字符，旧记录无此字段） */
  query?: string;
  /** 工具入参摘要（`tool_start` 带，结构化；旧记录无此字段） */
  args?: ChatToolArgsDisplay;
  hits?: number;
  /** 有界工具返回；旧记录缺失时仅展示摘要。 */
  response?: ChatToolResponse;
  durationMs?: number;
  error?: string;
  /** skill 步骤：skill id（`use_skill` 的调用键） */
  skillId?: string;
  /** skill 步骤：加载时该 skill 的描述 */
  skillDescription?: string;
  /** skill 步骤：加载入上下文的正文**字符数**（不是命中数） */
  chars?: number;
  /** skill 步骤：本会话此前已加载过（本次未重复注入） */
  alreadyLoaded?: boolean;
}

/**
 * 用户上传图片的元数据（REQ-20261123-006；与后端 `ChatImageRef` 同形状）。
 *
 * ★ 只有元数据，**没有 base64**：字节由
 *   `GET /api/chat/conversations/:id/images/:imgId` 单独取，前端用 URL 直接做缩略图。
 */
export interface ChatImageRef {
  /** 文件名唯一段（后端生成） */
  id: string;
  /** `image/png` / `image/jpeg` / `image/webp` */
  mime: string;
  bytes: number;
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
  /** 用户本轮提问手动引用的文档片段（仅 user 消息；与 assistant 的 `sources` 语义不同） */
  refs?: ChatRef[];
  /**
   * 用户本轮上传的图片（仅 user 消息，REQ-20261123-006）。
   *
   * 渲染：用 `/api/chat/conversations/{id}/images/{image.id}` 取字节；
   * 历史轮的图不进上游（后端降级为占位），但**页面仍显示缩略图**（用户视角它是存在过的）。
   */
  images?: ChatImageRef[];
  /**
   * 用户本轮用 `/` 斜杠**点名**的 skill id（2026-11-12，仅 user 消息）。
   *
   * ⚠️ 与 `ConversationFile.loadedSkillIds`（会话级、每轮重放）**严格区分**：
   * 本字段是单轮语义，后端只把对应正文注入该条消息所属的那一轮，不写会话级清单。
   */
  skills?: string[];
  /**
   * 上下文用量（**字符数**，REQ-20261013-001）= 最后一次 `context` 事件（该轮请求基数）
   * + 本轮回答正文字符数。旧会话无此字段 → 前端按"无数据"渲染（不显示 0）。
   */
  contextChars?: number;
  /** 上一次请求时的分量明细（同上口径；旧会话缺失） */
  contextParts?: ContextCharsParts;
}

/**
 * 上下文用量分量（**字符数**，与后端 `chat-contract.ts::ContextCharsParts` 同形状）。
 *
 * · 计入：system 组 / 历史 user（含当轮引用块）/ 历史 assistant / 工具返回
 * · **不计入**：`reasoning`（永不进上游 messages）、`sources`（展示用）
 * · `refs` 是 `user` 的**子集**（仅明细展示，不重复计入总数）
 */
export interface ContextCharsParts {
  system: number;
  user: number;
  assistant: number;
  tool: number;
  refs: number;
}

/**
 * 会话压缩记录（REQ-20261013-001 R8）。
 *
 * · `summary` 非空 = 摘要式；为 `null` = 截断式（早期消息被移出，**无模型时的降级形态**）
 * · `backup` 是压缩前会话备份的文件名（撤销入口据此恢复）
 */
export interface ConversationCompaction {
  at: string;
  mode: 'summary' | 'truncate';
  coveredCount: number;
  summary: string | null;
  /** 压缩前后**消息部分**字符数（不含 system / 工具返回） */
  charsBefore: number;
  charsAfter: number;
  /**
   * 压缩后**下一次请求的上下文字符数**（后端按与 `context` 事件同一口径重算）。
   * 面板在「压缩发生时间晚于上一条 assistant 消息」时优先用它 —— 否则刚压完仍显示旧值。
   */
  contextChars?: number;
  backup: string;
}

/**
 * 注入快照（skill 按需加载，2026-10-13）—— 与后端 `chat-contract.ts` 同形状副本。
 *
 * 新建会话**首轮**把「skill 目录 + 基础提示词 + 硬性规则」固化进会话，之后每轮从快照拼装、
 * 不再读对话配置 ⇒ 配置改动的生效范围是「下一个新建会话」。**不含 skill 正文**。
 */
export interface PromptInjectionSnapshot {
  version: 1;
  at: string;
  /** 恒定注入的 system 文本块（顺序即注入顺序） */
  blocks: string[];
  /** 可被 `use_skill` 调用的 skill id（快照生成时启用中的条目） */
  skillIds: string[];
}

export interface ConversationFile {
  version: 1;
  id: string;
  scope: string;
  /**
   * 会话归属（REQ-20261103-001）：session 用户 id；local-admin / token 为 null；旧会话缺省。
   * 2026-11-15 补：后端早已下发，前端副本漏了这两个字段 → 契约对齐测试恒红（既有漂移，非本次引入）。
   */
  ownerUserId?: string | null;
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
  /** 手动压缩记录（REQ-20261013-001 R8；旧会话无此字段） */
  compaction?: ConversationCompaction;
  /** 注入快照（2026-10-13；旧会话无此字段 → 下一轮按当前配置补建一次） */
  injected?: PromptInjectionSnapshot;
  /** 已加载 skill 的 id（会话级；每轮重放） */
  loadedSkillIds?: string[];
}

export interface ConversationSummary {
  id: string;
  scope: string;
  /** 会话归属（REQ-20261103-001）；2026-11-15 补齐，与后端 chat-contract.ts 对齐 */
  ownerUserId?: string | null;
  title: string;
  archived: boolean;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string;
  corrupted: boolean;
}

// ─────────────────────────────────────────────────────────────
// 1.5 ki_ask 问答（REQ-20261116-003）：来源分组列表 + 只读详情
//     后端契约见 design/S02、S03；数据来自 `GET /api/chat/agent-asks[/:id]`，
//     本段类型与后端响应逐字段对齐。
// ─────────────────────────────────────────────────────────────

/** 来源组类型：本机 MCP 连接 / 某个 MCP Token */
export type AgentAskGroupKind = 'local' | 'token';

/** 列表项（只含摘要，不含消息正文） */
export interface AgentAskSummary {
  id: string;
  /** 首条 user 消息截断；无 user 消息时为「（空问答）」 */
  title: string;
  /** 问答轮次 = user 消息条数 */
  rounds: number;
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
  /** 保留期截止（createdAt + 7 天） */
  retainUntil: string;
  /** 剩余保留天数；<=1 时列表显示「仅剩 1 天」 */
  retainDaysLeft: number;
  /**
   * 续接 TTL（10 分钟）已过。
   * ★ 列表**不展示**：几乎所有历史条目都满足，恒亮即无信息量（design-review #4）。
   */
  contextExpired: boolean;
  corrupted: boolean;
}

/** 一个来源组（本地连接 / 某个 Token） */
export interface AgentAskGroup {
  /** `local` 或 `token:<tokenId>` */
  id: string;
  kind: AgentAskGroupKind;
  /** 展示名：Token 分组取**当前** Token 名（改名即跟随）；已删除时取快照名 */
  label: string;
  tokenId?: string;
  tokenDeleted: boolean;
  /** 组内总条数（不分页） */
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
  items: AgentAskSummary[];
}

/** 详情里的一条消息：比主会话的 ChatMessage 少了 progress/reasoning 等展示物 */
export interface AgentAskMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  /** 仅 user：本轮提问背景（ki_ask 的 background 入参） */
  background?: string;
  /** 仅 assistant：来源引用（净化后，最多 15 条） */
  sources?: SourceRef[];
}

export interface AgentAskDetail {
  id: string;
  scope: string;
  origin: { kind: AgentAskGroupKind; tokenId?: string; label: string; tokenDeleted: boolean };
  createdAt: string;
  lastActiveAt: string;
  retainUntil: string;
  messages: AgentAskMessage[];
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
   * · 检索类工具（ki_search）带 `query` + `mode`；
   * · 其余工具带 `args`（结构化入参摘要，2026-11-11 由 `k=v` 串改为对象）
   * · 三者均**可选** —— 渲染按存在性分支，不得假设必有
   */
  | { type: 'tool_start'; name: string; query?: string; mode?: RetrievalMode; args?: ChatToolArgsDisplay }
  | { type: 'tool_end'; hits: number; durationMs: number; error?: string; response?: ChatToolResponse }
  /**
   * skill 正文按需加载（2026-10-13 新增；**可多次**，每次一个 skill）。
   *
   * · **单事件**（加载是进程内瞬时动作，无 start/end 配对）→ 时间线上就是一行；
   * · `alreadyLoaded` = 本会话此前已加载（本次未重复注入）；
   * · 失败（未知 id / 已禁用）同样带 `error`，**不中断生成**（模型改道继续答）。
   */
  | {
      type: 'skill';
      id: string;
      name: string;
      description: string;
      /** 加载入上下文的正文字符数；失败时为 0 */
      chars: number;
      alreadyLoaded?: boolean;
      error?: string;
    }
  | { type: 'sources'; sources: SourceRef[] }
  | { type: 'degraded'; reason: DegradedReason; message: string }
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  /**
   * 上下文用量（**字符口径**，REQ-20261013-001）：每轮上游请求**之前**发出，
   * **可多次**（工具轮次后基数变大）→ 消费方取最后一次。
   * `chars` = 各分量之和；分量口径见 `ContextCharsParts`。
   */
  | { type: 'context'; chars: number; parts: ContextCharsParts }
  | { type: 'usage'; promptTokens: number; completionTokens: number; reasoningTokens?: number }
  | {
      type: 'done';
      messageId: string;
      finishReason: string;
      sources: SourceRef[];
      warning?: 'tool-rounds-exhausted' | 'conversation-too-long';
      /**
       * 因**时间预算**（而非轮次）触发的收口（REQ-20261113-001，与后端同源）。
       * 目前只有 `ki_ask` 会产生；前端**不消费**该字段（沿用 `warning` 的提示口径），
       * 此处声明是为保持「契约两侧副本一致」——缺了它就成了静默漂移。
       */
      budgetExhausted?: boolean;
    }
  | { type: 'aborted'; messageId: string }
  | { type: 'error'; code: string; error: string; retryable?: boolean };

export const CHAT_EVENT_TYPES = [
  'meta', 'context', 'tool_start', 'tool_end', 'skill', 'sources', 'degraded',
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
  // ── 图片能力（REQ-20261123-006）──
  /** 是否支持读图（`llm.supportsImages`）；缺省（旧 daemon）= 不支持 */
  supportsImages?: boolean;
  /** 单图字节上限（生效值，字节） */
  maxImageBytes?: number;
  /** 单消息张数上限（生效值） */
  maxImagesPerMessage?: number;
  code: string | null;
  supportsTools: boolean;
  /** = `!ackRequired`；与 supportsTools 正交（见 api/config.md 对照表） */
  retrievalEnabled: boolean;
  ackRequired: boolean;
  maxToolRounds: number;
  /**
   * 上下文上限的**生效值**（**字符数**；REQ-20261013-001 / REQ-20261014-001）。
   *
   * 三级优先链：对话配置层的**用户覆盖值** → `config.yaml` 的 `llm.contextChars`（部署默认）→ 内置 1000K。
   * 只作占比分母，**不得**当作模型真实窗口（模型按 token 计）。
   */
  contextChars: number;
  /** 三级链的后两级（部署默认）；「恢复默认」的目标值。旧 daemon 不返回 → 回退用 `contextChars`。 */
  contextCharsDefault?: number;
  /** 是否启用了用户覆盖值。旧 daemon 下为 undefined（未知，不显示"自定义"标记）。 */
  contextCharsOverridden?: boolean;
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
  /**
   * 规范描述（SKILL.md 的 description，2026-10-13 新增）：AI 判断"要不要加载它"的唯一依据，
   * 也是恒注入目录里展示的内容。上限见 `PromptConfigLimits.skillDescMaxChars`。
   * 旧配置缺该字段时服务端归一化为空串（目录回退正文摘要）。
   */
  description: string;
  content: string;
  /** 内置条目：可改内容、可禁用、**不可删除**（服务端强校验，前端据此隐藏删除入口） */
  builtin: boolean;
  enabled: boolean;
  /** 内置条目是否被改过；缺省（历史配置）= 未知，界面标「内置已更新」引导恢复默认（2026-11-19） */
  edited?: boolean;
  /** 最后修改时间（ISO）；未改过时等于内置默认时间戳 */
  at: string;
}

export interface PromptConfig {
  version: 1;
  prompt: { content: string; at: string };
  skills: PromptSkill[];
  /** 工具名 → 是否暴露给 AI（批次 2 起真实生效：保存后下一次提问即生效） */
  tools: Record<string, boolean>;
  /**
   * **用户覆盖的上下文上限**（字符数，REQ-20261014-001）。
   *
   * **缺省 = 未覆盖** ⇒ 生效值取服务端三级链的后两级（`config.yaml` 的 `llm.contextChars`
   * → 内置 1000K）。「恢复默认」= **删掉本字段**（不是写 1000K）。
   */
  contextChars?: number;
  /**
   * **用户覆盖的工具返回字符上限**（REQ-20261015-001）。
   * 缺省 = 未覆盖 → 服务端内置 10000（「恢复默认」目标值读 `limits.toolResponseCharsDefault`）。
   */
  toolResponseChars?: number;
  /**
   * **用户覆盖的检索条数默认值**（REQ-20261015-001）。
   * 语义 = 「AI 未传 `limit` 时使用的条数」，**不是上限**（上限由服务端代码常量约束）。
   * 缺省 = 未覆盖 → 服务端内置 5（读 `limits.searchHitsDefault`）。
   */
  searchHitsPerCall?: number;
  /**
   * **用户覆盖的思考级别**（REQ-20261016-001 · OpenAI 通用协议顶层 `reasoning_effort`，纯透传）。
   * 三级链第一级：本值 → `config.yaml` 的 `llm.reasoningEffort`（部署默认档）→ **不下发**。
   * 缺省 = 未覆盖；面板的「跟随配置默认（不覆盖）」= **删除本字段**（哨兵 `__follow_default__` 不落盘）。
   */
  reasoningEffort?: string;
  /**
   * **能力级提示词 · AI 分析**（2026-11-15）。
   *
   * ⚠️ 当前**没有消费方**（AI 分析尚未接入，事件页只弹方案说明）：改了不产生行为。
   * 界面必须如实标注「未接入 · 改动暂不生效」，不得显示成已生效（检查点 F1）。
   * 缺省 = 未覆盖 → 用 `defaults.analysisPrompt.content`（服务端已填内置文案）。
   */
  analysisPrompt?: CapabilityPrompt;
  /** **能力级提示词 · AI 查找**（@deprecated：2026-11-16 起由 `find.prompt` 取代，仅作读取兼容与镜像）。 */
  findPrompt?: CapabilityPrompt;
  /** **AI 分析独立配置域**（REQ-20261113-003 · S-01） */
  analysis?: AnalysisConfig;
  /**
   * **AI 查找独立配置域**（REQ-20261116-005）。
   *
   * ⚠️ 生效范围：`ranges` 对快速通道立即生效；其余字段只在**深度通道**读取。
   * 一期后端 `capabilities.findDeep=false` 时，设置页据此把后者标为「深度查找上线后生效」。
   */
  find?: FindConfig;
  /** AI 预取（REQ-20261118-004） */
  recall?: RecallSectionConfig;
}

export interface AnalysisTargetConfig {
  defaultDir?: string;
  byScope: Record<string, string>;
}

export interface AnalysisConfig {
  targetDirs: AnalysisTargetConfig;
  prompt: CapabilityPrompt;
  skills: PromptSkill[];
  tools: Record<string, boolean>;
  /**
   * 分析前预取（2026-11-19）：程序在开始分析前调一次 `ki_recall`，把「建议先读哪几篇」注入上下文。
   * 旧后端不返回该字段 → 按「开启、上限 5」处理。
   */
  recall?: { enabled: boolean; limit: number };
  /**
   * 思考级别。
   *
   * ⚠️ 2026-11-18：原 `maxRounds` / `maxFiles` 预算已整体取消，后端不再读取。
   */
  reasoningEffort?: string;
}

/** AI 分析工具分组（只读默认开；`danger` 组默认关、开启需二次确认） */
export interface AnalysisToolGroup {
  key: 'code-read' | 'kb-read' | 'kb-write';
  label: string;
  names: string[];
  descs?: Record<string, string>;
  /**
   * 危险组：默认关闭、开启需确认（REQ-20261123-004）。
   *
   * 可选 —— 旧版 daemon 不返回该字段，此时按只读组（默认开）处理。
   */
  danger?: boolean;
}

/** 能力级提示词载体（与后端 `CapabilityPrompt` 同形状） */
export interface CapabilityPrompt {
  content: string;
  at: string;
  /** 内置条目是否被用户改过；false = 读取时跟随代码升级（2026-11-19） */
  edited?: boolean;
}

/** AI 查找 · 检索范围（`extraScopes` 不含"当前事件所在库"，它恒定在范围内） */
export interface FindRangeConfig {
  /** 额外放开的检索单元（scope 名或视图名）；上限读 `limits.findMaxTargets` */
  extraScopes: string[];
  /** 预留（本期不实现、界面不暴露、校验时忽略）：按事件所在库覆盖 `extraScopes` */
  byScope?: Record<string, string[]>;
}

/** AI 查找独立配置域（与后端 `FindConfig` 同形状） */
/**
 * **AI 预取**配置域（REQ-20261118-004），与 find 同级、物理独立。
 *
 * 与 find 的差异：没有 `ranges`（范围由调用方 scope 决定）；多 `maxRounds` / `toolResponseChars`
 * （预取是多轮读正文的循环，这两项直接决定能不能在 45s 内跑完）。
 */
export interface RecallSectionConfig {
  prompt: CapabilityPrompt;
  skills: Array<{ id: string; name: string; description: string; content: string; builtin: boolean; enabled: boolean; at: string }>;
  tools: Record<string, boolean>;
  reasoningEffort?: string;
  maxRounds: number;
  toolResponseChars: number;
}

export interface FindConfig {
  ranges: FindRangeConfig;
  /** 检索定位提示词（深度通道注入；快速通道不读） */
  prompt: CapabilityPrompt;
  /** AI 查找专属 skill（与对话 / 分析的 skill 互相独立） */
  skills: PromptSkill[];
  /** 工具名 → 是否暴露；键必须是 `findToolGroups` 展开后的名字 */
  tools: Record<string, boolean>;
  /**
   * 思考级别（缺省 = 跟随部署默认）。
   *
   * ⚠️ 2026-11-18：原 `maxRounds` / `maxCandidates` / `timeoutMs` 预算已整体取消，
   *    后端不再读取（旧配置残留静默忽略）。
   */
  reasoningEffort?: string;
  /**
   * 单次查找允许 AI 调用的工具次数上限（2026-11-19）。
   *
   * **没有"不限制"档**：缺省按 `limits.findToolCallsDefault` 算（服务端补齐，默认 15）。
   * 计数口径 = 真正执行的工具调用数，与过程面板的 `metrics.calls` 同源；
   * 上下界与默认值都读 `limits`，前端不硬编码。
   */
  maxToolCalls?: number;
}

export interface PromptConfigLimits {
  promptMaxChars: number;
  skillMaxChars: number;
  skillNameMaxChars: number;
  /** 描述硬上限（超过即服务端拒绝保存） */
  skillDescMaxChars: number;
  /** 描述建议长度（只用于字数提示，不是闸门） */
  skillDescSuggestedChars: number;
  maxSkills: number;
  /** 上下文上限的硬上界（字符数）；与 `contextUsage.ts::CONTEXT_CHARS_MAX` 手工同源 */
  contextCharsMax: number;
  // ── 工具预算（REQ-20261015-001）：前端不硬编码任何数字，一律读这里 ──
  /** 工具返回上限的下界（字符数） */
  toolResponseCharsMin?: number;
  /** 工具返回上限的上界（字符数） */
  toolResponseCharsMax?: number;
  /** 工具返回上限的内置默认（字符数；「恢复默认」的目标值） */
  toolResponseCharsDefault?: number;
  /** 检索条数下界 */
  searchHitsMin?: number;
  /** 检索条数上界（= AI 可自主传值的硬上界） */
  searchHitsMax?: number;
  /** 检索条数的内置默认（「恢复默认」的目标值） */
  searchHitsDefault?: number;
  /**
   * 能力级提示词上限（字符；2026-11-15）。
   * **缺失 = 旧版 daemon 不返回** → 设置页据此 fail-loud 提示「后端可能未重启」，
   * 而不是让用户以为保存成功（新字段会被旧服务端静默丢弃）。
   */
  analysisPromptMaxChars?: number;
  findPromptMaxChars?: number;
  /**
   * AI 查找范围上限（REQ-20261116-005）；缺失 = 旧版 daemon。
   *
   * ⚠️ 2026-11-18：分析与检索的轮次 / 文件 / 候选 / 超时预算上下界已整体取消，
   *    服务端不再下发，前端也不再有对应的输入框。
   */
  findMaxTargets?: number;
  /**
   * AI 查找 · 工具调用次数上限的边界与默认值（2026-11-19）。
   * **缺失 = 旧版 daemon 不认这个配置项** → 设置页据此提示重启，而不是让用户以为设上了。
   * `findToolCallsDefault` 是「恢复默认」的目标值（这项没有"不限制"档，必须给）。
   */
  findMinToolCalls?: number;
  findMaxToolCalls?: number;
  findToolCallsDefault?: number;
  /** AI 预取：轮次与单次工具结果字符的上下界（REQ-20261118-004） */
  recallMaxRoundsMin?: number;
  recallMaxRoundsMax?: number;
  recallToolCharsMin?: number;
  recallToolCharsMax?: number;
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
  /**
   * 上下文上限的**部署默认**（= `config.yaml` 的 `llm.contextChars`，缺省内置 1000K）。
   * 「恢复默认」的目标值 —— 前端不写死 1000K。旧版 daemon 不返回 → 回退前端常量。
   */
  contextCharsDefault?: number;
  // ── 思考级别（REQ-20261016-001）：4 个字段全部**可选** —— 旧版 daemon 不返回 ──
  /**
   * 可选档位清单（= `config.yaml` 的 `llm.reasoningEfforts`）。
   * ⚠️ **缺失 = 运维未配置**（面板禁用并指引）；`[]` = 显式空清单（另一条文案）—— 两者语义不同。
   */
  reasoningEffortOptions?: string[];
  /** 部署默认档（= `llm.reasoningEffort`）；不写死前端常量 */
  reasoningEffortDefault?: string;
  /** **生效档位** = 覆盖值 ?? 部署默认档；缺失 = 不下发该参数 */
  reasoningEffort?: string;
  /** 是否使用了用户覆盖值（决定"自定义 / 默认"徽标与「恢复默认」可用性）；**旧版 daemon 缺失** */
  reasoningEffortOverridden?: boolean;
  toolGroups: PromptToolGroup[];
  /** AI 分析专属工具分组、思考级别与数据源快捷路径 */
  analysisToolGroups?: AnalysisToolGroup[];
  analysisReasoningEffort?: string;
  analysisReasoningEffortOverridden?: boolean;
  datasourceDirs?: Record<string, { type: 'directory' | 'git'; dir: string }>;
  // ── AI 查找（REQ-20261116-005）：全部可选，旧版 daemon 不返回 ──
  /** 查找专属工具分组（只有知识库只读四件套，不含 fs_*） */
  findToolGroups?: AnalysisToolGroup[];
  /** 查找 skill ↔ 工具依赖（`skillId → 工具名`）；由服务端下发，前端不抄一份 */
  findSkillRequiredTools?: Record<string, string>;
  findReasoningEffort?: string;
  findReasoningEffortOverridden?: boolean;
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
