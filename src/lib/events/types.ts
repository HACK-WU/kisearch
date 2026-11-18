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
  builtin: boolean;
  /** 有序；末位 = 终态 */
  stages: EventStage[];
  /** 类型级终态动作：收口时关联文档去留 */
  terminalAction: 'keep' | 'trash';
  /** 未收口兜底天数（默认 90，null 关闭） */
  fallbackDays: number | null;
  /** 乐观锁（N12：两个标签页同时编辑） */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export const EVENT_DESCRIPTION_MAX_CHARS = 4000;

export interface EventRecord {
  id: string;
  /** 展示编号 `#3`；per-scope 单调递增，**删除后不复用** */
  shortId: number;
  scope: string;
  title: string;
  /** 可选事件描述（REQ-20261113-003 · S-03）：纯文本/Markdown，≤ 4000 字 */
  description?: string;
  typeId: string;
  stageKey: string;
  /** 展示冗余：读时按 stageKey 反查重算，不在写入侧当作依据 */
  stageIndex: number;
  /** 收口唯一权威；非空即已收口 */
  closedAt: number | null;
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
   * 这一步里模型的思考片段（reasoning 流），单步截断 2000 字。
   * 旧数据无该字段；只在模型真的产出 reasoning 时写入。
   */
  thinking?: string;
  calls?: AnalysisStepCall[];
}

export interface AnalysisStats {
  turns: number;
  filesRead: number;
  tokens: number;
  ms: number;
}

export interface AnalysisDraft {
  runId: string;
  bootId?: string;
  status: AnalysisRunStatus;
  targetDir: string;
  commit: string | null;
  errorCode?: string;
  errorMessage?: string;
  /**
   * 分析结论（根因判断 + 影响 + 建议方向，不含代码块）。
   * 旧文件或模型未给出时为 null；解析层硬上限 2000 字（模板要求 ≤300）。
   */
  conclusion: string | null;
  candidates: AnalysisCandidate[];
  unconfirmed: string[];
  steps: AnalysisStepRecord[];
  stats: AnalysisStats;
  startedAt: number;
  updatedAt: number;
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
  context?: {
    conclusionChars: number;
    candidatesUsed: number;
    confirmedUsed: number;
    historyUsed: number;
  };
}

/** 追问记录落点：`{scope}/.events/{eventId}.ask.json`（独立于 .analysis.json） */
export interface EventAnalysisAskDoc {
  version: 1;
  eventId: string;
  turns: AnalysisAskTurn[];
  updatedAt: number;
}
