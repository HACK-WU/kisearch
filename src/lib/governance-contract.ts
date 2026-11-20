/**
 * 知识治理 · 对外契约（**形状 SSOT**）
 *
 * 本文件是 `/api/governance/*` 响应体的权威定义。
 * 前端副本：`web/src/api/governanceContract.ts`（web 是独立 package，不跨包 import）。
 * 两份形状一致性由 `test/governance-contract.test.ts` 机械比对，**任一侧改动都会红**。
 *
 * **覆盖边界（2026-11-20 校正）**：
 *   · 已纳入：与 HTTP 响应对应的 DTO；`ki_event_get` 的详情体（`EventDetailResponseDto`）。
 *   · **未纳入**：`ki_event_list` 的返回体 —— 它与 HTTP 列表是**两套形状**
 *     （含 `type` 对象 / `visibility` / `closed` / 分析摘要等），且尚无契约类型，
 *     改动时不要照 HTTP 的 `EventListItem` 改。
 *   · 约束不止"两份副本一致"：实现层的响应组装函数返回类型直接标注本文件的 DTO
 *     （如 `src/lib/events/event-view.ts`），改动会被 tsc 拦下；
 *     `test/governance-contract-live.test.ts` 另守一条"契约必须被实现 import"。
 *
 * 改动规则：
 *   1. 字段只增不改名；确需改名要先改本文件 + 前端副本 + 测试，并回写 design/S06；
 *   2. 时间一律毫秒时间戳（number），不返回 ISO 字符串；
 *   3. 分页一律 `PageResult`（items/total/hasMore），不另造形状。
 */

export type LifecycleKindDto = 'wiki' | 'temp' | 'event';
export type VisibilityDto = 'full' | 'fts-only' | 'hidden';

export interface PageResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

export interface VisibilitySummary {
  full: number;
  ftsOnly: number;
  hidden: number;
}

/**
 * 事件类型的摘要。
 *
 * 现状（2026-11-20 核对）：**没有消费方** —— HTTP 列表已不含 `type` 对象（只有 `typeName`），
 * MCP `ki_event_list` 返回的 `{ id, name }` 是它的子集但未标注本类型。
 * 保留是为后续把两条列表口径统一时复用；不要因为"看起来有人用"就照它改列表响应。
 */
export interface EventTypeSummary {
  id: string;
  name: string;
  builtin: boolean;
}

export interface EventStageSummary {
  key: string;
  name: string;
  index: number;
  visibility: VisibilityDto;
}

/**
 * 列表里的成员文档预览。
 *
 * 只有定位三元组里的 `group` / `name`（`scope` 由列表项的 `scope` 给）：
 * 逐篇可见性不在这里，汇总档位见 `visibilitySummary`。
 * 2026-11-20 修正：此前声明了 `visibility`，实现层从不产出（幽灵字段）。
 */
export interface PreviewDoc {
  group: string;
  name: string;
}

export interface EventRefSummary {
  id: string;
  shortId: number;
  title: string;
  stageName: string;
  visibility: VisibilityDto;
}

/**
 * `GET /governance/events` 列表项（视图合并时同形状，`scope` 是成员库而非视图名）。
 *
 * 2026-11-20 按真实响应逐字段校正：删掉 `type`（整个类型对象）、`docCount`、`refCount`
 * 三个实现层从不产出的幽灵字段；补上 `scope`/`typeId`/`typeName`/`stageKey`/`stageIndex`/
 * `description`/`revision`/`createdAt`/`memberTotal` 九个一直在返回却未被声明的字段。
 * 约束通道见 `src/lib/events/event-view.ts`（返回类型即本接口）。
 *
 * **仅 HTTP 列表**：MCP `ki_event_list` 是另一套形状（`shortId` 带 `#`、含 `type` 对象 /
 * `visibility` / `closed` / 分析摘要，无 `scope`/`revision`/`visibilitySummary`），
 * 别拿本接口去校 MCP 的返回体。
 */
export interface EventListItem {
  id: string;
  shortId: number;
  /** 事件所属库：详情 / refs / analysis 都靠它定位 */
  scope: string;
  title: string;
  description?: string;
  typeId: string;
  /** 类型名；类型被删除时为 null */
  typeName: string | null;
  stageKey: string;
  stageIndex: number;
  closedAt: number | null;
  /** 置顶时间；缺省 = 未置顶（2026-11-19）。置顶项在列表里恒排最前 */
  pinnedAt?: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  stage: EventStageSummary;
  /** 已绑定成员文档总数（`docsPreview` 可能只是前几条） */
  memberTotal: number;
  docsPreview: PreviewDoc[];
  visibilitySummary: VisibilitySummary;
}

export interface ClassificationRow {
  scope: string;
  group: string;
  name: string;
  lifecycle: LifecycleKindDto;
  expiresAt?: number;
  remainDays?: number;
  event?: EventRefSummary;
  /** null = 旧数据没有该字段（与 false 语义不同：不能据此判定为可编辑） */
  isImported: boolean | null;
  editable: boolean;
}

export interface LifecycleKindOption {
  kind: LifecycleKindDto;
  label: string;
  meaning: string;
  /** 仅 temp：可选天数（快捷项）+ 合法区间 */
  ttlOptions?: number[];
  min?: number;
  max?: number;
  /** 仅 event：需要绑定事件的提示 */
  requires?: string;
  hint?: string;
}

export interface PresetDto {
  id: string;
  name: string;
  kind: 'wiki' | 'temp';
  ttlDays?: number;
  builtin: boolean;
}

export interface EffectiveDefault {
  kind: 'wiki' | 'temp';
  ttlDays?: number;
  source: 'group' | 'fallback-wiki';
}

export interface LifecycleListResponse {
  ok: true;
  scope: string;
  group?: string;
  effectiveDefault: EffectiveDefault;
  kinds: LifecycleKindOption[];
  presets: PresetDto[];
}

export interface EventStageDto {
  key: string;
  name: string;
  originalName?: string;
  visibility: VisibilityDto;
  disabled?: boolean;
}

export interface EventTypeDto {
  id: string;
  name: string;
  builtin: boolean;
  stages: EventStageDto[];
  terminalAction: 'keep' | 'trash';
  fallbackDays: number | null;
  revision: number;
}

export interface StageRef {
  key: string;
  name: string;
  index: number;
}

export interface TransitionVisibility {
  mode: VisibilityDto;
  dense: boolean;
  fts: boolean;
}

export interface TransitionResult {
  ok: true;
  from: StageRef;
  to: StageRef;
  closed: boolean;
  affected: { docs: number };
  visibility: TransitionVisibility;
  pending: VisibilityDto[];
  logWarning: string | null;
}

export type TrashReasonDto = 'temp-expired' | 'event-closed' | 'event-expired' | 'manual';

export interface TrashItemDto {
  group: string;
  name: string;
  reason: TrashReasonDto;
  deletedAt: number;
  expiresAt: number;
  /** 原期限长度；缺失（存量）时为回退值 7 并置 ttlAssumed */
  ttlDays: number;
  ttlAssumed: boolean;
  restoreCount: number;
  sizeBytes: number;
  hasAssets: boolean;
  dirName: string;
}

export interface RestoredDoc {
  group: string;
  name: string;
}

export interface RestoreResult {
  ok: true;
  restored: RestoredDoc;
  lifecycle: LifecycleKindDto;
  expiresAt?: number;
  ttlDays?: number;
  expiresAtChanged: boolean;
  rebuild: 'pending' | 'done' | 'failed';
  restoreCount: number;
  hint?: string;
}

export interface RefDocDto {
  group: string;
  name: string;
  /** 文档实际所在库；缺省 = 事件所在库（老数据） */
  sourceScope?: string;
  addedBy: 'ai' | 'manual';
  addedAt: number;
  /** 被引文档已不存在（N10：保留并标失效，不静默消失） */
  stale: boolean;
  /** stale 的原因：doc-deleted = 文档被删；scope-missing = 源库已不存在或无权限 */
  staleReason?: 'doc-deleted' | 'scope-missing';
  visibility: VisibilityDto;
}

export interface RefCandidateDto {
  /** 通道来源：fast = 确定性五步，deep = LLM 深度查找；决定前端默认勾选策略 */
  origin: 'fast' | 'deep';
  /** 候选文档所在库（视图检索时是成员库）；单库时等于请求 scope */
  scope: string;
  group: string;
  name: string;
  /** fast：同批次 min-max 相对分；deep：源库内最后一次命中分（0 = 未检索到，不代表无关） */
  score: number;
  /** 源库内分数名次（1 = 库内最高）；deep 通道无检索分时省略 */
  rankInScope?: number;
  /** 原始检索分（跨库不可比，仅供排障） */
  rawScore?: number;
  why: string;
  matchedKeywords: string[];
  /** score < 0.6：默认不勾，但保留给人判断（deep 通道默认勾选不按此判定） */
  weak: boolean;
  /** 该文档**自身**的检索可见性（不是事件阶段档位）；候选行直接展示它 */
  visibility: VisibilityDto;
  /** visibility='hidden' 时给出原因与来源事件（前端据此禁用勾选或强提示） */
  visibilityReason?: { kind: 'event-open' | 'event-closed'; eventId: string; shortId: number; title: string };
  /** 去重前的 chunk 命中数（>1 表示多个正文片段命中同一篇） */
  chunkHits: number;
}

/** 一步里真实发生的调用（过程面板的调用行）；**只记真的调了东西的**，本地计算不记 */
export interface RefSearchCallDto {
  kind: 'tool' | 'skill';
  /** 机器名（给人核对，如 ki_search） */
  name: string;
  /** 人话动作名 */
  label: string;
  ms: number;
  note?: string;
  /** 调用入参（已截断 300 字；skill 调用可能为空） */
  args?: string;
  /** 工具返回（已截断 2000 字；note 记的是错误/降级摘要，不是返回体） */
  response?: string;
  /** 返回原文长度（用于 UI 标「已截断（原文 N 字）」）；无 response 时不写 */
  responseChars?: number;
}

export interface RefSearchStepDto {
  /**
   * `tools` / `verify` 是深度通道（REQ-20261116-005）新增的两步：
   * 前者每轮一条（带真实工具调用行），后者是"模型输出 → 三重校验"。
   * 快速通道仍然只有前五个，前端据此渲染同一套面板。
   */
  name: 'understand' | 'extract' | 'search' | 'exclude' | 'rank' | 'tools' | 'verify';
  ms: number;
  metrics: Record<string, number | string>;
  detail?: Record<string, unknown>;
  /**
   * 这一步里模型的思考片段（reasoning 流），单步截断 2000 字。
   * 旧数据无该字段；只在模型真的产出 reasoning 时写入。
   */
  thinking?: string;
  /** `thinking` 截断前的原始字符数（2026-11-18）：> thinking.length 时前端提示「已截断」 */
  thinkingChars?: number;
  calls?: RefSearchCallDto[];
}

export interface RefExcluded {
  associated: string[];
  added: string[];
}

export interface RefSearchResultDto {
  candidates: RefCandidateDto[];
  steps: RefSearchStepDto[];
  excluded: RefExcluded;
  total: number;
  durationMs: number;
  /** 实际发给检索的 query（过程面板展示用，不让前端自己拼） */
  query: string;
  /** 本次实际参与检索的单元（库名或视图名），顺序 = [事件库, ...extraScopes] */
  targets?: string[];
  /** 配置里存在但本次被剔除的项（无权限 / 已不存在 / 视图无成员） */
  skippedTargets?: Array<{ name: string; reason: 'forbidden' | 'missing' | 'view-members-changed' }>;
  /** 部分 target 检索失败（其余结果仍有效；全部失败才是 503） */
  targetErrors?: Array<{ name: string; error: string }>;
  /** 多库时按库的文档数（total 为各库之和，单库时省略） */
  totalByScope?: Array<{ scope: string; docs: number }>;
  /** 深度通道：模型给出但未通过校验的项数 */
  unconfirmedCount?: number;
  /**
   * 深度通道：被校验剔除的**明细**（`unconfirmedCount` 的数量来源）。
   * `reason` 是机器码，前端翻人话展示（`out-of-scope` / `not-found` / `already-used` / `malformed` / `truncated`）。
   */
  unconfirmed?: Array<{ group: string; name: string; sourceScope?: string; reason: string }>;
  /**
   * 深度通道：模型输出是否为可解析的候选数组。
   * `false` 表示"模型没给出结果"，前端文案要与"确实没有相关文档"区分。
   */
  parsed?: boolean;
  /**
   * 深度通道：模型写的整体结论（3 句以内）。
   * 0 候选时必须说明「查了什么、为什么没有」——与"确实没有相关文档"区分开。
   */
  summary?: string;
  /**
   * 深度通道：模型判断不了的点（与 `unresolved` / `needMore` 不同：这些不需要调用方补信息，
   * 只是如实交代不确定性）。
   */
  uncertainties?: string[];
  /**
   * 深度通道：模型提到但**未通过校验**（没读全正文 / 与已读清单重复）而被剔除的条数。
   * 面板据此解释"总结里说有几篇、候选却是空的"这种情况，避免看起来像 bug。
   */
  droppedCount?: number;
  /**
   * 提前结束，结果不完整：`timeout` = 硬超时；`budget` = 工具调用次数用尽（2026-11-19）。
   * `usedCalls` = 已执行的工具调用次数（面板据此说"用满 N 次"）。
   *
   * 注：`rounds` 是轮次预算时代的取值，2026-11-18 取消轮次预算后已无产出方。
   */
  partial?: { reason: 'rounds' | 'timeout' | 'budget'; usedRounds: number; usedCalls?: number };
  /** 0 候选的原因；有候选时省略。前端据此区分空态文案 */
  reason?: 'no-keywords' | 'empty-scope' | 'no-hits' | 'all-excluded';
  /** 实际检索模式：fulltext = 语义侧不可用已降级，面板必须如实显示 */
  mode?: 'hybrid' | 'fulltext';
  degraded?: boolean;
  degradedReason?: string;
}

export interface VisibilityFailureDto {
  relation: string;
  group: string;
  kind: 'dense' | 'fts' | 'relation' | 'path';
  code: string;
  message: string;
  attempts: number;
  at: number;
}

export interface StaleRefDto {
  eventId: string;
  group: string;
  name: string;
}

export interface OrphanedEventDto {
  eventId: string;
  typeId: string;
}

export interface ZombieDocDto {
  group: string;
  name: string;
  useCount: number;
  lastUsedTime: number | null;
}

export interface DiagnosticsBundle {
  visibilityFailures: VisibilityFailureDto[];
  staleRefs: StaleRefDto[];
  orphanedEvents: OrphanedEventDto[];
  zombieDocs: ZombieDocDto[];
}

export interface CountsResponse {
  ok: true;
  classify: number;
  eventsOpen: number;
  trash: number;
}

// ─── 事件源码分析（REQ-20261113-003 · S-03）─────────────────

export type AnalysisRunStatusDto = 'running' | 'ready' | 'partial' | 'failed' | 'cancelled';

export interface AnalysisCandidateDto {
  id: string;
  file: string;
  line: number;
  endLine?: number;
  snippet: string;
  why: string;
  confidence: number;
}

export interface AnalysisStepCallDto {
  kind: 'tool' | 'skill';
  name: string;
  label: string;
  ms: number;
  note?: string;
  /** 调用入参（已截断 300 字；skill 调用可能为空） */
  args?: string;
  /** 工具返回（已截断 2000 字；note 记的是错误/降级摘要，不是返回体） */
  response?: string;
  /** 返回原文长度（用于 UI 标「已截断（原文 N 字）」）；无 response 时不写 */
  responseChars?: number;
}

export interface AnalysisStepDto {
  name: string;
  title: string;
  ms: number;
  metrics: Record<string, number | string>;
  detail?: Record<string, unknown>;
  /**
   * 这一步里模型的思考片段（reasoning 流），单步截断 2000 字。
   * 旧数据无该字段；只在模型真的产出 reasoning 时写入。
   */
  thinking?: string;
  /** `thinking` 截断前的原始字符数（2026-11-18）：> thinking.length 时前端提示「已截断」 */
  thinkingChars?: number;
  calls?: AnalysisStepCallDto[];
}

export interface AnalysisStatsDto {
  turns: number;
  filesRead: number;
  tokens: number;
  ms: number;
}

export type ConclusionNodeKindDto = 'symptom' | 'cause' | 'root' | 'impact' | 'fix';

/** 结论因果链上的一个节点（2026-11-19） */
export interface ConclusionNodeDto {
  kind: ConclusionNodeKindDto;
  text: string;
  /** `file:line`，仅在指向真实候选时出现 */
  ref?: string;
  /** 仅 root 有：触发条件 / 反例 */
  branches?: string[];
}

export interface AnalysisDraftDto {
  runId: string;
  bootId?: string;
  status: AnalysisRunStatusDto;
  targetDir: string;
  commit: string | null;
  errorCode?: string;
  errorMessage?: string;
  /** 分析结论的一句话总结；旧数据 / 模型未给出时为 null */
  conclusion: string | null;
  /** 结论因果链；旧数据为空数组（此时前端只渲染 conclusion 纯文本） */
  chain: ConclusionNodeDto[];
  /**
   * 运行中当前这一轮的思考实时片段（2026-11-18）：后端按 ~1s 节流增量写，轮结束 / 收尾时置 undefined。
   * 有值即表示「这一轮还在想」，前端用它渲染流式思考块（只在 running 期间出现）。
   */
  liveThinking?: { round: number; text: string; chars: number };
  candidates: AnalysisCandidateDto[];
  unconfirmed: string[];
  steps: AnalysisStepDto[];
  stats: AnalysisStatsDto;
  startedAt: number;
  updatedAt: number;
}

export interface ConfirmedCodeLocationDto {
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

export interface EventAnalysisDto {
  draft: AnalysisDraftDto | null;
  confirmed: ConfirmedCodeLocationDto[];
  /** 是否还有可继续的分析断点（2026-11-20）；前端据此显示「继续分析」 */
  resumeAvailable?: boolean;
}

/** 一轮「追问这次分析」的问答（B2） */
export interface AnalysisAskTurnDto {
  id: string;
  question: string;
  answer: string;
  runId: string | null;
  at: number;
  /** 硬超时保留部分答案时为 true */
  truncated?: boolean;
  usage?: { promptTokens: number; completionTokens: number };
  /** 本次追问调用过的工具（去重计数；旧记录无此字段） */
  toolCalls?: Array<{ name: string; at: number }>;
  context?: {
    conclusionChars: number;
    candidatesUsed: number;
    confirmedUsed: number;
    historyUsed: number;
    attachedDocsUsed?: { members: number; refs: number };
  };
}

export interface EventAnalysisAskDto {
  turns: AnalysisAskTurnDto[];
  total: number;
  /** 记录是否曾因字节/条数上限被裁剪 */
  truncated: boolean;
  activeRunId: string | null;
}

export interface CodeLocationPreviewDto {
  file: string;
  line: number;
  endLine?: number;
  why: string;
  commit: string | null;
}

// ─── 事件关联文档（REQ-20261116-004 · S-01）───

export interface MemberRefDto {
  group: string;
  name: string;
}

export interface MemberSkipDto extends MemberRefDto {
  reason: 'already-bound' | 'duplicate-in-request';
}

export interface MemberFailureDto extends MemberRefDto {
  code: string;
  error: string;
}

export interface MemberVisibilityFailureDto extends MemberRefDto {
  kind: 'dense' | 'fts' | 'relation' | 'path';
  error: string;
}

/** `POST /governance/events/:id/members` 响应（部分失败也是 200，看 failed[]） */
export interface EventMemberChangeResult {
  ok: true;
  scope: string;
  eventId: string;
  shortId: number;
  visibility: { mode: VisibilityDto; dense: boolean; fts: boolean };
  bound: MemberRefDto[];
  skipped: MemberSkipDto[];
  failed: MemberFailureDto[];
  /** 已绑定成功但索引摘除失败（文档仍可能被检索到） */
  visibilityFailed?: MemberVisibilityFailureDto[];
  pending: string[];
  hint: string;
}

/** `DELETE /governance/events/:id/members` 响应 */
export interface EventMemberRemovalResult {
  ok: true;
  scope: string;
  eventId: string;
  removed: MemberRefDto;
  lifecycle: 'wiki';
  visibility: { mode: VisibilityDto; dense: boolean; fts: boolean };
  pending: string[];
  hint: string;
}

/** 手动添加文档的搜索命中（`GET /governance/docs/search`） */
export interface DocSearchHit {
  group: string;
  name: string;
  visibility: VisibilityDto;
  /** 该文档已绑在**另一个未收口事件**上：前端禁用并标注，后端仍兜底拒绝 */
  event?: { id: string; shortId: number; title: string };
}

/** `POST /governance/events` 的绑定报告（创建时一并挂文档） */
export interface CreateEventBinding {
  docs: {
    bound: MemberRefDto[];
    skipped: MemberSkipDto[];
    failed: MemberFailureDto[];
    visibilityFailed: MemberVisibilityFailureDto[];
  };
  refs: {
    added: number;
    addedList: MemberRefDto[];
    skipped: Array<MemberRefDto & { reason: 'duplicate' | 'already-associated' }>;
    failed: MemberFailureDto[];
  };
}

export interface CreateEventResult {
  ok: true;
  scope: string;
  event: unknown;
  binding: CreateEventBinding;
  visibility: { mode: VisibilityDto; dense: boolean; fts: boolean };
  pending: string[];
  hint?: string;
}

// ─── 单事件详情（2026-11-20 补齐：此前详情整体形状完全没有契约）─────────────
//
// 消费方：MCP `ki_event_get`（服务层 `src/lib/events/event-detail.ts`）。
// 约束通道：该文件的 `EventDetailView` 就是本接口的 alias，字段一改 tsc 立即报错。
// 体积纪律：`analysis.draft` 是**精简版**（不含 steps / candidates 正文），
// 候选只给 `candidateTotal` 计数 —— 详情响应会被 AI 上下文整段吃掉。

/** 文档定位三元组：取正文时必须三者齐全（跨库引用看 `scope`） */
export interface DocRefDto {
  scope: string;
  group: string;
  name: string;
}

/** 详情里的 event 块（`shortId` 带 `#` 前缀，与列表项的裸数字不同） */
export interface EventDetailEventDto {
  id: string;
  shortId: string;
  title: string;
  description: string | null;
  closed: boolean;
  closedAt: number | null;
  /** 置顶时间；null = 未置顶 */
  pinnedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** 详情里的 type 块（含完整阶段链与禁用/当前标记） */
export interface EventDetailTypeDto {
  id: string;
  name: string;
  terminalAction: 'keep' | 'trash';
  fallbackDays: number | null;
  stages: Array<{
    key: string;
    name: string;
    visibility: string;
    disabled: boolean;
    current: boolean;
  }>;
}

/** 详情里的 stage 块（当前阶段 + 该档位的可见性说明） */
export interface EventDetailStageDto {
  key: string;
  name: string;
  index: number;
  visibility: string;
  /** 人话说明：这一阶段的事件能被怎么检索到 */
  legend: string;
}

/** 详情 members 块里的成员文档 */
export interface MemberItemDto extends DocRefDto {
  /** 是否由本事件导入（false = 原本就在库里、被引用） */
  isImported: boolean;
}

/** 详情 refs 块里的参考文档 */
export interface RefItemDto extends DocRefDto {
  addedBy: 'ai' | 'manual';
  addedAt: number;
  /** 被引文档已不存在（保留并标失效，不静默消失） */
  stale: boolean;
  staleReason?: 'doc-deleted' | 'scope-missing';
  visibility: string;
}

/** 详情 analysis.confirmed 里的已确认代码位置 */
export interface ConfirmedLocationDto {
  file: string;
  line: number;
  endLine?: number;
  why: string;
  confidence: number;
  /** 分析时的 commit；历史位置可能为 null */
  commit: string | null;
  confirmedAt: number;
  /** 代码快照（`location_snippet_limit=0` 时省略） */
  snippet?: string;
}

/** 详情 logs 块里的阶段流转日志 */
export interface EventLogDto {
  at: number;
  /** null = 创建事件 */
  fromKey: string | null;
  toKey: string;
  by: 'user' | 'ai';
  note?: string;
  status?: 'committed' | 'aborted';
}

/** 详情 analysis.draft 的精简版（**不含** steps / candidates 正文） */
export interface AnalysisDraftSummaryDto {
  status: string;
  conclusion: string | null;
  /** 结论因果链；旧数据为空数组，前端回退渲染 `conclusion` 纯文本 */
  chain: ConclusionNodeDto[];
  unconfirmed: string[];
  commit: string | null;
  startedAt: number;
  updatedAt: number;
  errorCode?: string;
  errorMessage?: string;
}

/** 详情 analysis 块 */
export interface EventAnalysisDetailDto {
  /** 分析目标目录；`confirmed[].file` 是相对它的路径 */
  targetDir: string | null;
  draft: AnalysisDraftSummaryDto | null;
  /** 候选**正文**不返回，只给计数（0 与 null 含义不同：null = 从未分析过） */
  candidateTotal: number;
  /** 仅在「候选数 ≠ 已确认数」时出现，说明还有几个候选没确认 */
  candidateNote?: string;
  confirmed: { total: number; items: ConfirmedLocationDto[]; note?: string };
}

/**
 * 单事件详情响应（`ki_event_get` 返回体）。
 *
 * 每块都带 `total`，被截断时给 `note`：让调用方知道"还有多少没显示"。
 */
export interface EventDetailResponseDto {
  event: EventDetailEventDto;
  type: EventDetailTypeDto | null;
  stage: EventDetailStageDto;
  members: { total: number; items: MemberItemDto[]; note?: string };
  refs: { total: number; items: RefItemDto[]; note?: string };
  analysis: EventAnalysisDetailDto;
  logs: { total: number; items: EventLogDto[]; note?: string };
}
