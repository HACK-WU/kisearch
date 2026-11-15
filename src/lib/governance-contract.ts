/**
 * 知识治理 · 对外契约（**形状 SSOT**）
 *
 * 本文件是 `/api/governance/*` 与 `ki_event_*` 工具返回体的权威定义。
 * 前端副本：`web/src/api/governanceContract.ts`（web 是独立 package，不跨包 import）。
 * 两份形状一致性由 `test/governance-contract.test.ts` 机械比对，**任一侧改动都会红**。
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

export interface PreviewDoc {
  group: string;
  name: string;
  visibility: VisibilityDto;
}

export interface EventRefSummary {
  id: string;
  shortId: number;
  title: string;
  stageName: string;
  visibility: VisibilityDto;
}

export interface EventListItem {
  id: string;
  shortId: number;
  title: string;
  type: EventTypeSummary;
  stage: EventStageSummary;
  closedAt: number | null;
  docCount: number;
  docsPreview: PreviewDoc[];
  visibilitySummary: VisibilitySummary;
  refCount: number;
  updatedAt: number;
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
  addedBy: 'ai' | 'manual';
  addedAt: number;
  /** 被引文档已不存在（N10：保留并标失效，不静默消失） */
  stale: boolean;
  visibility: VisibilityDto;
}

export interface RefCandidateDto {
  group: string;
  name: string;
  /** 同批次 min-max 归一化后的相对分（0~1），不是绝对相似度 */
  score: number;
  why: string;
  matchedKeywords: string[];
  /** score < 0.6：默认不勾，但保留给人判断 */
  weak: boolean;
  /** 该文档**自身**的检索可见性（不是事件阶段档位）；候选行直接展示它 */
  visibility: VisibilityDto;
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
}

export interface RefSearchStepDto {
  name: 'understand' | 'extract' | 'search' | 'exclude' | 'rank';
  ms: number;
  metrics: Record<string, number | string>;
  detail?: Record<string, unknown>;
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
