/**
 * 聊天模块 · 契约层（**形状 SSOT**）
 *
 * 本文件是 REQ-20260924-001 的契约载体：
 *   - 数据模型 / SSE 事件协议 / 配置形状 / 预算常量 / 错误码
 *   - 由 `design/S07` + `api/INDEX.md` + `api/retrieval.md` + `api/config.md` 定稿
 *
 * ⚠️ 契约约束（实现方必读）：
 *   1. 本文件在骨架期【冻结】，实现期**一字不改**；变更须回 design 并走批次边界
 *      （已批准的批次边界变更：
 *        · **批次 2（2026-10-08）** —— `tool_start` 的 `query`/`mode` 改**可选**、新增可选
 *          `args`，承载非检索类 MCP 工具；决策 D5，
 *          见 `.plans/2026-10-08-chat-mcp-tools-batch2/plan.md`。
 *        · **REQ-20261009-002（2026-10-09）** —— 新增 `ChatRef` 与 `ChatMessage.refs?`
 *          （用户手动引用文档片段，软提示注入；不改 `ki_search` 工具面），见
 *          `CodeWikiHub/kisearch/requirements/2026-10-09-全屏阅读与AI对话协同及文档引用/`。
 *          **修订（同日·bug 修复）**：`ChatRef` 的注入方式由「独立 system 块」改为
 *          「附在本轮 user 消息末尾」——形状未动（字段/常量不变），前端副本无需改代码。
 *        · **skill 按需加载（2026-10-13）** —— 三类边界变更：
 *          ① 新增 SSE 事件 `skill`（AI 通过 `use_skill` 加载 skill 正文；加载是**进程内瞬时动作**，
 *             故为**单事件、无 start/end 配对**），`CHAT_EVENT_TYPES` 由 12 类变 13 类；
 *          ② `ChatProgressStep` 新增**可选** `kind`（`'tool' | 'skill'`，缺省 = `'tool'`）、
 *             `skillId` / `skillDescription` / `chars` —— 旧记录按工具行渲染，零兼容负担；
 *          ③ `ConversationFile` 新增**可选** `injected`（首轮注入快照：提示词只在**新建会话**时读配置，
 *             后续轮次从快照拼装）与 `loadedSkillIds`（会话级已加载 skill，每轮重放，避免模型反复加载）。
 *          见 `.plans/2026-10-13-chat-skill-on-demand/plan.md`。
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

/**
 * 用户手动引用的知识库文档片段（REQ-20261009-002 需求 B）。
 *
 * ⚠️ 与 `SourceRef` 的分工（语义不同，不可混用）：
 *   `SourceRef` = **检索产物**（后端产出，带 chunk 映射出的行号与 ≤200 字摘要）；
 *   `ChatRef` = **用户指定**（前端产出，带用户选中的原文片段；后端**不读原文**）。
 *
 * · 上送：随 `POST /conversations/:id/messages` 请求体的 `refs` 数组
 * · 生效：软提示 —— tool-loop 把引用附录附在**本轮 user 消息末尾**（"优先依据以下内容作答"），
 *   模型仍可检索全库；**不改** `ki_search` 工具面（避免放宽参数失控面）。
 *   ★ 2026-10-09 修订：原为「注入一条 system 块」，实测上游会把该 system 块误认为
 *   最新的用户输入（thinking 出现"最后一条 user 是空的"），导致答非所问；
 *   改为并入本轮 user 后对照实验正常（详见 `retrieval/tool-loop.ts` 的 `renderRefsBlock`）
 * · 落盘：写进 user 消息的 `refs`，供刷新 / 切会话后回显
 */
export interface ChatRef {
  group: string;
  /** 文档名（= relation） */
  doc: string;
  /** 用户选中的片段原文（前端按 CHAT_REF_TEXT_MAX 截断；后端对总量做预算校验） */
  text: string;
}

/** 单次提问的引用条数上限（前端据此禁用「加入」，后端据此拒绝超限请求） */
export const CHAT_REF_MAX_COUNT = 5;
/** 单条引用文本上限（字符）；超长由前端截断并提示 */
export const CHAT_REF_TEXT_MAX = 2000;
/** 全部引用文本合计上限（字符）：并入本轮 user 消息前的总预算保护 */
export const CHAT_REF_TOTAL_MAX = 6000;

/** 本次工具实际返回的文本；仅超过总字符预算时截断，模型与页面共用。 */
export interface ChatToolResponse {
  text: string;
  originalChars: number;
  truncated: boolean;
  /**
   * 本次序列化使用的字符上限（配置生效值；REQ-20261015-001）。
   * 旧记录（改造前落盘）缺失 → 消费方回退为"不显示具体上限"的文案。
   */
  limit?: number;
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
 * skill 加载步骤（2026-10-13）复用本结构：`kind: 'skill'` + `skillId`/`skillDescription`/`chars`。
 */
export interface ChatProgressStep {
  phase: 'start' | 'end';
  /**
   * 步骤类别（2026-10-13 新增，**可选**）：
   * · 缺省 / `'tool'` = MCP 工具调用（旧记录即此，前端按工具行渲染）
   * · `'skill'` = AI 通过 `use_skill` 加载 skill 正文（与工具行**样式区分**）
   */
  kind?: 'tool' | 'skill';
  /**
   * 本步发生时**已发出的正文字符数**（interleave 锚点）：
   * 渲染时把正文按各行的 afterChars 切段，调用痕迹插在"哪句话之后"就显示在哪句话下面。
   * 旧数据无此字段 → 视为 0（集中在正文前，维持旧行为）。
   */
  afterChars?: number;
  /** 工具名（如 `ki_search`）/ skill 步骤时为 skill 名称 */
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
  /** skill 步骤：skill id（`use_skill` 的调用键） */
  skillId?: string;
  /** skill 步骤：加载时该 skill 的描述（供展开查看"当时为什么用它"） */
  skillDescription?: string;
  /** skill 步骤：加载入上下文的正文**字符数**（不是命中数） */
  chars?: number;
  /** skill 步骤：本会话此前已加载过（本次**未重复注入**；前端据此弱化展示） */
  alreadyLoaded?: boolean;
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
  /**
   * 用户在本轮提问时**手动引用**的文档片段（REQ-20261009-002）。
   * 仅 user 消息写入；assistant 的检索来源仍在 `sources` —— 两者语义不同，不得互相替代。
   */
  refs?: ChatRef[];
  /**
   * 上下文用量（**字符数**，REQ-20261013-001）。
   * = 最后一次 `context` 事件（该轮请求基数）+ 本轮反问正文长度 → 语义为"此刻会话已占用"，
   * 即下一轮请求的历史规模近似。旧会话无此字段（前端据此回退到"无数据"态）。
   */
  contextChars?: number;
  /** 上一条的分量明细（同上口径；旧会话缺失） */
  contextParts?: ContextCharsParts;
}

/**
 * 会话压缩记录（REQ-20261013-001 R8 · 手动压缩上下文）。
 *
 * · `summary` 非空 = **摘要式**：覆盖 `coveredCount` 条早期消息，摘要作为独立 system 块持续注入；
 * · `summary` 为 null = **截断式**：早期消息直接丢弃（**未配置模型**时的降级形态，必须明示用户）；
 * · `backup` 是压缩前的会话文件副本（撤销用）；**不得**在无备份的情况下压缩。
 */
export interface ConversationCompaction {
  /** 压缩发生时间（ISO） */
  at: string;
  mode: 'summary' | 'truncate';
  /** 被移出 messages 的消息条数 */
  coveredCount: number;
  /** 摘要正文；截断式为 null */
  summary: string | null;
  /** 压缩前 / 后的**会话消息部分**字符数（不含 system 组与工具返回；摘要计入压缩后） */
  charsBefore: number;
  charsAfter: number;
  /**
   * 压缩后**下一次请求的上下文字符数**（后端按与 `context` 事件同一口径重算：
   * system 组 + 保留消息 + 摘要块）。
   *
   * ★ 为什么必须有：压缩会移除消息，但**保留的那条 assistant 消息上仍写着压缩前的
   *   `contextChars`**（它是"那次请求时"的规模）。前端若直接沿用，用户刚压完却看到
   *   占比不降甚至更高 —— 数字说谎比没数字更糟。缺失（旧记录 / 无投影能力）时前端回退旧值。
   */
  contextChars?: number;
  /** 压缩前会话备份的**文件名**（相对会话目录） */
  backup: string;
}

/**
 * 注入快照（skill 按需加载，2026-10-13）：新建会话**首轮**把「skill 目录 + 基础提示词 + 硬性规则」
 * 固化进会话，之后每轮从快照拼装、**不再读对话配置**。
 *
 * 为什么快照而不是每轮读配置（用户裁决 2026-10-13）：
 * · 提示词"只注入一次"→ 同一会话的行为可复现，不被中途改配置影响；
 * · 配置改动的生效范围 = **下一个新建会话**（UI 需明示）。
 *
 * ⚠️ **不含 skill 正文**（只含目录与可调用 id 列表）：正文按 `skillIds` 从当前配置按需读取，
 *    否则 20 × 8000 字的正文会把会话文件撑爆（护栏 #4）。
 */
export interface PromptInjectionSnapshot {
  version: 1;
  /** 快照生成时刻（ISO） */
  at: string;
  /** 恒定注入的 system 文本块（顺序即注入顺序） */
  blocks: string[];
  /** 可被 `use_skill` 调用的 skill id（= 快照生成时**启用**的条目，顺序 = 配置顺序） */
  skillIds: string[];
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
  /** 手动压缩记录（REQ-20261013-001 R8；旧会话无此字段） */
  compaction?: ConversationCompaction;
  /** 注入快照（2026-10-13；旧会话无此字段 → 下一轮按当前配置补建一次） */
  injected?: PromptInjectionSnapshot;
  /** 已加载 skill 的 id（会话级；每轮重放，避免模型"忘掉"或反复加载） */
  loadedSkillIds?: string[];
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

/**
 * 上下文用量分量（**字符数**，REQ-20261013-001）。
 *
 * · 口径：该轮**真实构造的上游 messages** 的内容长度（不是"落盘消息求和"）
 * · 计入：system 组 / 历史 user / 历史 assistant / 工具返回
 * · **不计入**：`reasoning`（N12 永不进 messages）、`sources`（展示用）
 * · `refs` 是 `user` 的**子集**（当轮引用附录块），仅供明细展示，不重复计入总数
 */
export interface ContextCharsParts {
  system: number;
  user: number;
  assistant: number;
  tool: number;
  refs: number;
}

/** SSE 事件（判别联合，前端按 `type` 分派） */
export type ChatEvent =
  | { type: 'meta'; conversationId: string; messageId: string; model: string; discardedCount?: number; userMessageId?: string }
  /**
   * 上下文用量（字符口径，REQ-20261013-001）：
   * · 每轮上游请求**之前**发出 —— 首个 `context` 即"本轮请求的上下文基数"，
   *   比 token 口径的 `usage`（只在本轮流末尾）早一整个回答时长，前端据此可立即展示；
   * · 工具轮次后基数变化会**再次**发出 ⇒ **可多次，取最后一次**；
   * · `chars` = 各分量之和。
   */
  | { type: 'context'; chars: number; parts: ContextCharsParts }
  /**
   * 工具调用开始（批次 2 泛化，D5）：
   * · 检索类工具（ki_search）带 `query` + `mode`（旧行为）
   * · 其余工具带 `args`（服务端生成的参数摘要，大字段已排除）
   * · `query`/`mode`/`args` 均可选 —— 前端按存在性渲染，不得假设必有
   */
  | { type: 'tool_start'; name: string; query?: string; mode?: RetrievalMode; args?: string }
  | { type: 'tool_end'; hits: number; durationMs: number; error?: string; response?: ChatToolResponse }
  /**
   * skill 正文加载（2026-10-13 新增；**可多次**，每次一个 skill）。
   *
   * · **单事件**：加载是进程内瞬时动作（读配置 + 拼块），不需要 start/end 配对 ——
   *   与 `tool_start`/`tool_end` 的配对不变量无关；
   * · `alreadyLoaded` = 本会话此前已加载过（本次未重复注入，前端据此可弱化展示）；
   * · 失败（未知 id / 已禁用）同样发本事件并带 `error`，**不中断生成**（模型可见失败并改道）。
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

/** 事件类型名（供契约测试遍历；`skill` 为 2026-10-13 新增，共 13 类） */
export const CHAT_EVENT_TYPES = [
  'meta', 'context', 'tool_start', 'tool_end', 'skill', 'sources', 'degraded',
  'reasoning', 'content', 'usage', 'done', 'aborted', 'error',
] as const;

/**
 * 事件顺序约束（api/retrieval.md §1.2，**契约测试须覆盖**）
 *
 * - `tool_start` / `tool_end` 必须成对（工具抛错也要发 `tool_end` 带 error）
 * - `sources` 至多一次且在 `done` 之前（无来源时**不发**，而非发空数组）
 * - `degraded` 至多一次
 * - `context` **可多次**（每轮请求前一次），消费方取最后一次；必在 `done` 之前
 * - `skill` **可多次、无配对要求**（单事件；加载失败也发事件带 error）；必在 `done` 之前
 * - 正常序：meta → context → tool_start → tool_end → [skill | context → tool_start → tool_end]* → reasoning* → content* → sources → usage → done
 */
export const CHAT_EVENT_ORDER_RULES = {
  toolStartMustPairWithEnd: true,
  sourcesAtMostOnce: true,
  sourcesBeforeDone: true,
  degradedAtMostOnce: true,
  /** `context` 可多次，但必须全部出现在 `done` 之前 */
  contextBeforeDone: true,
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
  /**
   * 上下文上限的**生效值**（**字符数**；REQ-20261013-001 / REQ-20261014-001）。
   *
   * 三级优先链：**对话配置层的用户覆盖值** → `config.yaml` 的 `llm.contextChars`（部署默认）→ 内置 1000K。
   * 前端只用它作占比分母，**不得**当作模型真实窗口（模型按 token 计）。
   */
  contextChars: number;
  /**
   * 三级链的后两级（= **部署默认**）：前端「恢复默认」的目标值。
   *
   * 为什么不写死 1000K：运维可在 `config.yaml` 把默认设成别的值，此时"恢复默认"应回到
   * 那个值而不是 1000K（REQ-20261014-001）。
   * 旧 daemon 不返回本字段 → 前端回退用 `contextChars`（等价）。
   */
  contextCharsDefault?: number;
  /** 是否启用了用户覆盖值（前端据此显示"自定义"标记）。旧 daemon 下为 undefined（视为未知）。 */
  contextCharsOverridden?: boolean;
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
  /**
   * 单次检索条数的**内置默认**（T11）。
   * REQ-20261015-001 起：可被对话配置的 `searchHitsPerCall` 覆盖「AI 未传 limit 时的条数」；
   * 同时仍是页面 sources 投影的取条上限 —— 两者**刻意同值**（投影口径不随配置变化）。
   */
  maxHitsPerCall: 5,
  /** `ki_search.limit` 的**硬上界**（代码常量，用户不可配）—— 模型自主传值的天花板（REQ-20261015-001） */
  maxHitsPerCallHardMax: 50,
  /** 工具返回总长度的**内置默认**（可被对话配置覆盖；不按字段或单条片段裁剪） */
  maxToolResponseChars: 10000,
  /** 工具返回上限的配置边界（服务端强校验）：低于下限几乎必然截断，高于上限无实际意义 */
  toolResponseCharsMin: 1000,
  toolResponseCharsMax: 100_000,
  /**
   * 证据回放的**轮数上限**（REQ-20261015-001 · S-02；D3 双预算之一）。
   * 暂不做用户配置（见设计 S-02 §10 Q1）。
   */
  replayTurns: 5,
  /**
   * 证据回放的**正文总字符上限**（D3 双预算之二）。
   * ⚠️ 10000 是 **demo 实测校准值**：20000 时 TTFB +40%（超 +30% 判据），故下调。
   */
  replayMaxChars: 10_000,
  /** 旧投影兼容函数的单片段截断长度（S07 §3.4） */
  snippetChars: 300,
  /** `sources[].snippet` 落盘截断长度（S07 §3.5） */
  sourceSnippetChars: 200,
  /** 整体超时（D13 后重估：180s → 300s） */
  requestTimeoutMs: 300_000,
  /** 首块超时（只约束"建立连接并收到首个 chunk"，不约束工具轮次） */
  firstByteTimeoutMs: 30_000,
  /**
   * 上下文上限的**内置兜底值**（**字符数**，= 1000K；REQ-20261013-001）。
   *
   * 单位口径：K = 1000 字符（故 1000K = 1,000,000 字符）。
   * 三级优先链的**最后一级**（REQ-20261014-001）：
   *   对话配置层的用户覆盖值 → `config.yaml` 的 `llm.contextChars` → 本值。
   * **仅用于占比与阈值预警**，不代表模型 token 窗口
   * —— 字符口径偏保守（中文 ≈1 token/1~1.5 字，英文/代码 ≈1 token/3~4 字）。
   */
  defaultContextChars: 1_000_000,
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
