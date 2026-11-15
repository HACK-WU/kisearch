/**
 * 知识治理 · 前端契约副本
 *
 * ⚠️ **本文件是 `src/lib/governance-contract.ts` 的副本**，两份形状必须一致。
 *
 * 为什么是副本而不是 import：`web/tsconfig.json` 的 `include` 只含 `web/src`
 * （前端是独立 package，从未引用过后端代码），跨包引用会把两端构建耦合在一起。
 * 与既有的 `web/src/api/chatContract.ts` 采用同一模式。
 *
 * 形状一致性由 `test/governance-contract.test.ts` 机械比对：接口名集合 + 每个接口的
 * 字段名与可选性。**改动任一侧 → 该测试变绿前不得交付**。
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
}

export interface RefSearchStepDto {
  name: 'understand' | 'extract' | 'search' | 'exclude' | 'rank';
  ms: number;
  metrics: Record<string, number | string>;
  detail?: Record<string, unknown>;
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
