/**
 * 事件与事件类型 · 实体类型（S-02 契约层）
 *
 * 本文件在 B0 期只含**类型**，无任何实现；B3 起由 `events/store.ts` 等落地。
 *
 * 关键约束（改任何字段前先读 design/S02）：
 *   - 事件位置存 `stageKey`（稳定），`stageIndex` 只是展示冗余；
 *   - `closedAt` 是收口唯一权威，**不能**用「是否停在末位」推导；
 *   - `terminalAction` 是**类型级**字段，不挂阶段。
 */

/** 检索可见性三档；不是布尔 —— 只关 dense 时 FTS 仍会命中 */
export type Visibility = 'full' | 'fts-only' | 'hidden';

export interface EventStage {
  /** 稳定标识（`st_1`…）：拖动排序 / 改名都不改它 */
  key: string;
  /** 可改 */
  name: string;
  /** 首次名称，改名后保留用于历史展示兜底（Q6） */
  originalName?: string;
  visibility: Visibility;
  /** 停用：不可进入；**末位不可停用**（否则事件永远收不了口） */
  disabled?: boolean;
}

export interface EventTypeRecord {
  id: string;
  scope: string;
  name: string;
  /**
   * 类型用途说明（≤200 字，可选）。
   * 为什么是类型级而不是阶段级：阶段名已自解释，描述只回答「这类事件装什么」；
   * 它同时是 AI 选型的唯一语义依据（`ki_event_type_list` 透传），缺了只能按名字猜。
   */
  description?: string;
  builtin: boolean;
  /** 有序；末位 = 终态 */
  stages: EventStage[];
  /** 类型级终态动作：收口时关联文档去留 */
  terminalAction: 'keep' | 'trash';
  /**
   * 预留字段：未收口兜底天数（默认 90，null 关闭）。
   *
   * **当前没有任何清理任务消费它**（事件 #76）：全仓只在声明、内置类型赋值、
   * create/update 入参、DTO 与 MCP 透传里出现，配了不会让事件自动收口。
   * 留字段是为了将来真做清理时不用改存储格式与接口；在那之前别把它当保障 ——
   * 末位阶段被停用的事件确实只能人工在页面捞。
   */
  fallbackDays: number | null;
  /** 乐观锁（N12：两个标签页同时编辑） */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export const EVENT_DESCRIPTION_MAX_CHARS = 4000;

/**
 * 事件「预期效果」的上限（2026-11-24）。
 *
 * 与描述同为 4000：两者是同一段叙事的两个面（现象/证据 vs 修好后应当是什么样），
 * 用户在一处写长、另一处写短没有真实理由，分成两个数字只会让「为什么这个能写 4000、
 * 那个只能写 2000」变成每次都要解释的问题。
 */
export const EVENT_EXPECTED_EFFECT_MAX_CHARS = 4000;

/**
 * 事件类型描述的上限（2026-11-23 REQ-20261123-007）。
 * 与事件的 4000 字刻意不同：类型描述是「一句话说清装什么」，长到需要分段说明
 * 就说明该写进事件的 description。200 字约等于类型 tab 下方两行。
 */
export const EVENT_TYPE_DESCRIPTION_MAX_CHARS = 200;

export interface EventRecord {
  id: string;
  /** 展示编号 `#3`；per-scope 单调递增，**删除后不复用** */
  shortId: number;
  scope: string;
  title: string;
  /** 可选事件描述（REQ-20261113-003 · S-03）：纯文本/Markdown，≤ 4000 字 */
  description?: string;
  /**
   * 可选「预期效果」（2026-11-24）：修好之后应当看到什么 / 怎么算收口，≤ 4000 字。
   *
   * 与 `description` 的分工是**叙事位置**而不是形式：描述装「现象与证据」（报错原文、
   * 复现条件、已排除方向），本字段装「可核验的预期结果」。分开存是为了让 AI 分析
   * 能拿到「期望达成什么」而不是只看到「哪里坏了」，也让收口时有对照物。
   *
   * 与 `description` 一样会进 AI 分析上下文（主分析 + recall 预取 + 追问），
   * 因此同样受 prompt 注入防护约束。
   */
  expectedEffect?: string;
  typeId: string;
  stageKey: string;
  /** 展示冗余：读时按 stageKey 反查重算，不在写入侧当作依据 */
  stageIndex: number;
  /** 收口唯一权威；非空即已收口 */
  closedAt: number | null;
  /**
   * 置顶时间（2026-11-19）：非空 = 已置顶，缺省 = 未置顶（老数据无需迁移）。
   *
   * 记时间而不是布尔：置顶区要按「最近置顶在上」排，布尔给不出顺序。
   * **不参与 `updatedAt`** —— 置顶是列表偏好，不是内容变更，混进去会让
   * 「最近更新」排序莫名变化（用户会以为数据被动过）。
   */
  pinnedAt?: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface EventStageLog {
  eventId: string;
  /** null = 创建事件 */
  fromKey: string | null;
  toKey: string;
  at: number;
  by: 'user' | 'ai';
  note?: string;
  /** 状态写失败时记 aborted（仅诊断用） */
  status?: 'committed' | 'aborted';
}

/** `_types.json` */
export interface EventTypesDoc {
  version: 1;
  revision: number;
  types: EventTypeRecord[];
}

/** `_meta.json` */
export interface EventsMeta {
  version: 1;
  nextShortId: number;
}

/**
 * 参考文档（S-05）。
 *
 * 与「关联文档」的区别：关联文档靠 `Relation.eventId` 指向事件，可见性随阶段变；
 * 参考文档只是**一条引用记录**，可见性取被引文档自身，加入/移除**不修改被引文档任何字段**
 * （A13 红线：操作前后该 Relation 的分片条目必须字节级不变）。
 */
export interface EventRefDoc {
  scope: string;
  /**
   * 文档**实际所在库**（REQ-20261116-005 跨库引用）。
   *
   * 缺省 = `scope`（事件所在库），因此 2026-11-16 之前写下的 `refs.json`
   * 无需迁移；读写两侧统一用 `sourceScope ?? scope` 归一。
   * 去重与删除的 key 必须含本字段，否则跨库同名文档会被静默跳过或删错。
   */
  sourceScope?: string;
  group: string;
  name: string;
  addedBy: 'ai' | 'manual';
  addedAt: number;
  /** ai 加入时记录当时分数，便于复现"为什么它被选中" */
  score?: number;
}

/** `{eventId}.refs.json` */
export interface RefsDoc {
  version: 1;
  eventId: string;
  refs: EventRefDoc[];
  updatedAt: number;
  /**
   * 最近一次「AI 查找」的结论（2026-11-19）。
   *
   * 为什么落在这里而不是事件主体：它是**查找产物的注脚**，与 refs 同生命周期
   * （加入参考文档后仍要能回看「当初为什么加」），且不影响事件流转的低频写。
   * 只在用户**确认加入**时写一次；不随每次查找覆盖。
   */
  lastFind?: {
    summary: string;
    uncertainties?: string[];
    at: number;
  };
}

// ─── 事件源码分析（REQ-20261113-003 · S-03）─────────────────

/**
 * `cancelled` = 用户主动点了「停止」且一条候选都没来得及产出。
 * 与 `failed` 区分开：失败是系统/上游的错，取消是人的决定，前端文案与引导都不同
 * （失败可能指向「去配置」，取消只该给「重新分析」）。
 */
export type AnalysisRunStatus = 'running' | 'ready' | 'partial' | 'failed' | 'cancelled';

export interface AnalysisCandidate {
  id: string;
  file: string;
  line: number;
  endLine?: number;
  snippet: string;
  why: string;
  confidence: number;
}

export interface AnalysisStepCall {
  kind: 'tool' | 'skill';
  name: string;
  label: string;
  ms: number;
  note?: string;
  /** 调用入参（已截断 300 字；skill 调用可能为空） */
  args?: string;
  /** 工具返回（已截断 2000 字；note 记的是错误/降级摘要，不是返回体） */
  response?: string;
  /**
   * 返回长度，用于 UI 标「已截断」。注意序列化层已先按 10k 截过一次，
   * 所以超过 10k 的返回这里记的是 10k 级别（UI 用「约」表述）。
   */
  responseChars?: number;
}

export interface AnalysisStepRecord {
  name: string;
  title: string;
  ms: number;
  metrics: Record<string, number | string>;
  detail?: Record<string, unknown>;
  /**
   * 这一步里模型的思考片段（reasoning 流）。上限见 `THINKING_MAX_CHARS`（20 000 字，
   * 2026-11-18 由 2000 放宽 —— 思考是纯文本给人读的，只作异常兜底）。
   * 旧数据无该字段；只在模型真的产出 reasoning 时写入。
   */
  thinking?: string;
  /**
   * `thinking` 截断前的原始字符数（2026-11-18）。
   * 与 `AnalysisStepCall.responseChars` 同口径：前端据此提示「已截断（原文 N 字）」，
   * 避免用户把"截断后的 2000 字"当成模型只想了这么多。
   */
  thinkingChars?: number;
  calls?: AnalysisStepCall[];
}

export interface AnalysisStats {
  turns: number;
  filesRead: number;
  tokens: number;
  ms: number;
}

/**
 * 「分析结论」因果链的节点类型（2026-11-19）。数组顺序即阅读顺序：
 * 现象 → 直接原因 → 根本原因 → 影响面 → 建议；缺哪层就跳过，不硬造。
 */
export type ConclusionNodeKind = 'symptom' | 'cause' | 'root' | 'impact' | 'fix';

/**
 * 结论链上一个节点。
 *
 * 引入原因：`conclusion` 曾是一段 300 字散文（根因 + 影响 + 修复方向揉在一起），
 * 读者要自己切分，且没有任何位置可以挂代码引用。分层后每层一句话，
 * 前端的因果链渲染（竖轨 + 类型标签）才有数据可用。
 */
export interface ConclusionNode {
  kind: ConclusionNodeKind;
  /** 一句话（≤200 字，不含换行）；可用反引号包裹符号名，禁止代码块 */
  text: string;
  /** 位置引用 `file:line`（相对 targetDir）；必须指向本轮真实候选，见 pruneChainRefs */
  ref?: string;
  /** 只允许挂在 root：触发条件 / 反例（≤3 条，每条 ≤120 字） */
  branches?: string[];
}

/**
 * 结论来源（2026-11-23 · REQ-20261123-009）。
 *
 * 缺省（`undefined`）= `'ai'`：历史文件没有该字段，读盘不做迁移、不写回，
 * 前端 `draft.source ?? 'ai'` 判定。`'external'` 表示由 MCP 上传，无分析过程
 * （`steps: []` / `stats` 全 0 / 不设 `editedAt`）。
 */
export type AnalysisSource = 'ai' | 'external';

export interface AnalysisDraft {
  runId: string;
  bootId?: string;
  status: AnalysisRunStatus;
  targetDir: string;
  commit: string | null;
  errorCode?: string;
  errorMessage?: string;
  /**
   * 分析结论的**一句话总结**（根因是什么 + 影响多大 + 往哪修；模板只要求"一句话"，硬上限 4000 字）。
   * 旧文件或模型未给出时为 null；解析层按 `CONCLUSION_MAX_CHARS`（4000）兜底。
   * 细节看 `chain`；`chain` 为空时前端仍按纯文本渲染本字段（老事件兼容）。
   */
  conclusion: string | null;
  /**
   * 结论的因果链（2026-11-19）：2~5 个节点。
   * 旧文件没有该字段 → 读盘归一为 `[]`，前端回退渲染 `conclusion` 纯文本。
   */
  chain: ConclusionNode[];
  /**
   * 数据链路（2026-11-24 · REQ-20261124-001）：多行文本树，**换行有语义**。
   *
   * 键可缺（不写 null）：旧文件本就没有该键，缺省即「本次结论没有链路」。
   * 前端用等宽 `<pre>` 原样渲染，不做 Markdown、不把 `file:line` 变成可点胶囊。
   * 归一在 `data-flow.ts`（CRLF 统一、行尾空白清理、连续空行压缩、40 行 / 3000 字截断）。
   */
  dataFlow?: string;
  /**
   * **运行中当前这一轮**的思考实时片段（2026-11-18）。
   *
   * 在此之前 thinking 只在该轮工具跑完后随 step 一次性落盘 —— 用户看到的是"一轮跳一次"，
   * 长思考时过程区长时间没有动静。这里按 ~1s 节流增量写，供前端边跑边渲染。
   * 该轮结束（step 入队）与收尾写盘时**必须清空**，否则会与 step.thinking 重复展示。
   */
  liveThinking?: { round: number; text: string; chars: number };
  candidates: AnalysisCandidate[];
  unconfirmed: string[];
  steps: AnalysisStepRecord[];
  stats: AnalysisStats;
  startedAt: number;
  updatedAt: number;
  /**
   * 人工修订时间戳（2026-11-23 · REQ-20261123-001）。
   *
   * 存在即表示三块产物（结论 / 未确认点 / 已确认位置）被人工改过；重跑会重建 draft，
   * 因此该字段自然消失（= 修订标识在重新分析后清掉）。**只记时间不记人**（无 per-user 身份）。
   */
  editedAt?: number;
  /** 结论来源（2026-11-23）；缺省 = 'ai'。外部上传**不设** `editedAt`，用它区分 */
  source?: AnalysisSource;
  /** 外部上传时间戳（ms）；仅 `source === 'external'` 出现 */
  importedAt?: number;
  /** 外部来源标识（如 MCP 客户端名）；仅 `source === 'external'` 出现，用于回读与排障 */
  sourceClient?: string;
}

export interface ConfirmedCodeLocation {
  id: string;
  file: string;
  line: number;
  endLine?: number;
  snippet: string;
  why: string;
  confidence: number;
  targetDir: string;
  commit: string | null;
  confirmedAt: number;
}

/** `{eventId}.analysis.json` */
export interface EventAnalysisDoc {
  version: 1;
  eventId: string;
  draft: AnalysisDraft | null;
  confirmed: ConfirmedCodeLocation[];
  updatedAt: number;
}

/** 一轮「追问这次分析」的问答（B2） */
export interface AnalysisAskTurn {
  id: string;
  question: string;
  answer: string;
  /** 该轮所依据的分析 runId（= 提问时的 draft.runId） */
  runId: string | null;
  at: number;
  /** 硬超时保留部分答案时为 true（有内容就不算失败） */
  truncated?: boolean;
  usage?: { promptTokens: number; completionTokens: number };
  /** 本次追问调用过的工具（去重计数，仅审计/回看；不落工具响应正文） */
  toolCalls?: Array<{ name: string; at: number }>;
  context?: {
    conclusionChars: number;
    candidatesUsed: number;
    confirmedUsed: number;
    historyUsed: number;
    /** 已挂文档清单条数（决策 C 的审计字段） */
    attachedDocsUsed?: { members: number; refs: number };
  };
  /**
   * 本轮末端给出的结论补丁（2026-11-23 · S03）。
   *
   * 缺省 = 模型没给 / 解析失败 / 与当前结论无差异（三种都按"没有补丁"处理）。
   * `conclusion` **必非空**：补丁不允许清空结论 —— 清空不是"给新结论"。
   */
  proposal?: AskProposal & { /** 生成时刻（审计用） */ at: number };
  /** 用户是否采纳了本轮补丁（覆盖成功时由 PATCH 回写，审计用） */
  proposalAccepted?: boolean;
}

/** 追问末端的结论补丁（S03）：只覆盖结论两块，不含未确认点 / 位置 */
export interface AskProposal {
  conclusion: string;
  chain: ConclusionNode[];
  /**
   * 数据链路（2026-11-24 · REQ-20261124-001）：**缺省 = 本条补丁不改链路**。
   *
   * 与外部上传正相反（那边缺省 = 清空）：追问是「沿当前结论继续」，模型多数轮次并不想
   * 动链路，清空会让用户每次追问都丢链路（S03 §7 决策）。解析层已 `normalizeDataFlow`
   * 归一，归一后为空的不写进 patch —— 所以这里出现就一定是非空文本。
   */
  dataFlow?: string;
  /** 模型给的一句话说明，仅展示 */
  reason: string;
}

/** 追问记录落点：`{scope}/.events/{eventId}.ask.json`（独立于 .analysis.json） */
export interface EventAnalysisAskDoc {
  version: 1;
  eventId: string;
  turns: AnalysisAskTurn[];
  updatedAt: number;
}

/**
 * 进行中追问的一步过程（2026-11-23 · #82）。
 *
 * 与 SSE 的 `step` 事件同形，但落盘后要在「用户切页回来」时重建过程区，
 * 因此只保留渲染必需的四个字段（不带工具响应正文）。
 */
export interface AskRunningStep {
  id: string;
  kind: 'thinking' | 'tool' | 'answer';
  label: string;
  text: string;
  at: number;
}

/**
 * 进行中的追问运行态：`{scope}/.events/{eventId}.ask.running.json`。
 *
 * 为什么需要它：追问是「一次 HTTP 请求上的 SSE 流」，进行中那一轮原先只活在前端
 * 组件内存（`AskBlock` 的 `pending`/`steps`）、服务端只在**整轮结束**才 `appendAskTurn`，
 * 于是切页 / 刷新后那一轮从界面上消失（数据最终会落盘，但回来时看不到、也不会自动补）。
 *
 * 约定：
 * 1. **不是历史记录**：不参与 `EventAnalysisAskDoc.turns`、不受条数/字节上限约束；
 * 2. **结束即删**：成功、失败、异常三条出口都删（由 runner 的 finally 保证）；
 * 3. `answer`/`steps` 是**节流快照**（默认 800ms），只为让回来的人先看到半截，最终正文仍以落库的 turn 为准；
 * 4. 超过 `ASK_RUNNING_STALE_MS` 没更新的视为僵尸（进程被杀留下的），读时按无运行态处理并顺手删。
 */
export interface AnalysisAskRunning {
  version: 1;
  /** 运行态唯一标识：结束删除时用它确认「文件里这条还是不是我自己」（防并发误删） */
  id: string;
  eventId: string;
  question: string;
  /** 该轮所依据的分析 runId；前端据此与当前草稿比对（分析被重跑则不续接） */
  runId: string | null;
  startedAt: number;
  updatedAt: number;
  answer: string;
  steps: AskRunningStep[];
}
