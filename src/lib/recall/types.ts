/**
 * recall/types.ts —— 任务前上下文预取（`ki_recall`）的类型与**预算常量唯一真源**。
 *
 * 定位：本文件只放「跨模块共用的形状」与「预算数值」，不放判定逻辑。
 *   - 形状：`RecallRequest` / `RecallCandidate` / `CoreRecallResult` / 跳过项 / 下一步动作
 *   - 预算：targets 上限、候选上限、检索 topK、每库配额、线索上限（P4 定稿，之后只改这一处）
 *
 * ⚠️ 契约约束（改之前先看 S-01/S-02 设计）：
 *   1. `RecallCandidate.scope` 恒为**物理库**（视图已展开）——`nextActions` 直接拿它调
 *      `ki_get_module_info`，视图名在那里不可用。
 *   2. 跨库同类候选**不合并**，用 `alsoIn` 提示同名文档；`alsoIn` 只能由已通过可见性
 *      过滤的候选集合推导（hidden 不得经它泄漏）。
 *   3. `scope` 必填：服务端不设默认库，范围只有入参一个来源（2026-11-18 拍板）。
 */

import type { SkippedTargetReason } from '../events/find-targets.js';
import type { Visibility } from '../events/types.js';

// ─── 预算（P4：横切约定与非功能预算）────────────────────────────

/** 单次调用参与检索的范围单元上限（超出截断并进 skipped{truncated}） */
export const MAX_TARGETS = 6;
/**
 * 展开视图后的**物理库**上限（IO 成本口径：检索次数 = 2 × physicalTargets）。
 *
 * 与 `MAX_TARGETS` 分开的理由：一个视图可以含很多成员，`MAX_TARGETS` 限的是「调用方点了几个」，
 * 限不住「最终要查几个库」——后者才是延迟与配额的真实成本。
 */
export const MAX_PHYSICAL = 12;
/** schema 允许传入的 scope 个数上限（> MAX_TARGETS 的部分在解析时截断） */
export const MAX_SCOPE_INPUT = 8;
/** 候选条数：默认值与硬上限 */
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 20;
/** 每个 target 的检索取回条数（进入归一化前的候选池大小） */
export const SEARCH_TOP_K = 20;
/** 每个 target 最终进入候选清单的条数上限（防单库刷屏） */
export const PER_SCOPE_CAP = 3;
/** 语义查询块上限 */
export const MAX_BLOCKS = 4;
/** 精确线索上限 */
export const MAX_TOKENS = 12;
/** `nextActions` 给出几条建议阅读动作 */
export const TOP_ACTIONS = 3;
/**
 * tier1（「名字含线索」的最高相关级）的**检索强度下限**（2026-11-18 真机补）。
 *
 * 只判「名字里有没有关键词」会把弱命中抬到第一：实测 M2 的 top1 是库内第 28、
 * 相对分 0.16 的文档，仅因为名字里有个 `api`。故 tier1 还要满足其中一条。
 */
export const TIER1_MAX_RANK = 10;
export const TIER1_MIN_SCORE = 0.5;
/** 入参字符/条数上限（与工具 schema 一致） */
export const TASK_MAX_CHARS = 2000;
export const HINTS_MAX = 10;
export const HINT_MAX_CHARS = 200;
export const EXCLUDE_MAX = 50;
/** 单条 reason 的字符上限（防理由比候选还长） */
export const WHY_MAX_CHARS = 80;

// ─── 请求 ────────────────────────────────────────────────────

export interface RecallRequest {
  /** **必填**：库名或视图名，≥1 项（工具层已把 string|string[] 归一化为数组） */
  scope: string[];
  /** 任务画像：目标 / 涉及 / 现象 / 期望，2-3 句 */
  task: string;
  /** 强线索：文件路径 / 报错码 / 模块名 / 接口名 */
  hints?: string[];
  /** 已读清单：`scope::group::name` 或 `group::name`（省略 scope = 任意库） */
  exclude?: string[];
  /** 候选条数上限（1..MAX_LIMIT） */
  limit: number;
}

// ─── 结果 ────────────────────────────────────────────────────

/** 候选清单里的一条（`scope` 恒为物理库） */
export interface RecallCandidate {
  scope: string;
  group: string;
  name: string;
  /** 库内相对分位：该库本批次最高 1.00、最低 0.00（**跨库不可比**） */
  score: number;
  /** 库内名次，1 = 该库最高；跨库比较只认它 */
  rankInScope: number;
  /** 命中线索 / 库内名次 / 同名提示 / 「仅语义相近」 */
  why: string;
  /** 其他库里存在同名文档（只提示，不合并、不代选权威） */
  alsoIn?: string[];
  visibility: Visibility;
  /** score < 0.6（前端/调用方可据此降权，不据此丢弃） */
  weak: boolean;
  /** 同一文档在本次检索里被几个分块命中（0 = 未统计） */
  chunkHits: number;
}

/** 被剔除的范围单元（理由含 `truncated` = 超出 MAX_TARGETS 被截断） */
export type RecallSkipReason = SkippedTargetReason | 'truncated';

export interface RecallSkipped {
  name: string;
  reason: RecallSkipReason;
}

/** 缺失的信息维度（数据，不是反问） */
export interface NeedMoreItem {
  field: 'symptom' | 'errorCode' | 'module';
  hint: string;
}

/**
 * **模型通道**的候选（REQ-20261118-004）。
 *
 * 与 `RecallCandidate`（种子/确定性通道的产物）区别有三：
 *   · 没有分数 / 名次 —— 模型不看分，它看的是正文内容
 *   · `why` 由模型写（"它对任务的哪一部分有用"），不是服务端拼的命中理由
 *   · `evidence` 标明读到的是全文还是片段（只有 `ki_get_module_info` 未截断才算 full）
 */
export interface RecallHit {
  scope: string;
  group: string;
  name: string;
  why: string;
  evidence: 'full' | 'snippet';
}

/** 建议的下一步读取动作（参数可直接调 `ki_get_module_info`） */
export interface NextAction {
  tool: 'ki_get_module_info';
  args: { scope: string; group: string; relation: string; max_chars: number };
  why: string;
}

/** 内核产出（工具层在这一层之上加 channel / degraded / cached / nextActions 等） */
export interface CoreRecallResult {
  /** 实际参与检索的 target（视图保留视图名） */
  targets: string[];
  /** 配置/兜底来源被剔除的项 */
  skipped: RecallSkipped[];
  /** 调用方**显式传入**却不存在/无权的项 —— 由工具层决定报错（人点名必须报错） */
  forbiddenRequested: RecallSkipped[];
  /** 实际发给检索的 query（过程可复核） */
  query: string;
  candidates: RecallCandidate[];
  /** 因 hidden 被剔除的条数（只给数，不给名字） */
  excludedHidden: number;
  /** 因已读清单/文档已不存在被剔除的条数 */
  dropped: number;
  needMore: NeedMoreItem[];
  /** 是否因 MAX_TARGETS 截断 */
  truncated: boolean;
  durationMs: number;
  /** 超时但有部分候选 */
  partial?: boolean;
}

/**
 * 线索抽取的三段输出（**分强弱是关键**，2026-11-18 真机改）：
 *   - `blocks`：语义块（8~40 字），长句整段；
 *   - `strong`：**精确线索**——hints / 文件路径 / 错误码 / 英文标识符。区分度最高，主检索只用它；
 *   - `weak`：中文 2~4 字窗口。**噪声大**，只作兜底与理由，绝不能混进主 query
 *     （实测混入后会得到「删除一 除一篇 一篇文…」这类碎片，把强线索稀释掉）。
 * `tokens` = strong + weak，仅为兼容既有消费方（`why` 的命中匹配、needMore 判据）。
 */
export interface RecallTerms {
  blocks: string[];
  strong: string[];
  weak: string[];
  tokens: string[];
}
