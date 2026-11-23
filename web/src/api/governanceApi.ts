/**
 * governanceApi.ts —— `/api/governance/*` 客户端（REQ-20261113-004 · S-07）
 *
 * 约定（与后端 `governance-http.ts` 一一对应）：
 * · 响应外壳 `{ok:true,...}` / `{ok:false,code,error,details?}`；
 * · 失败统一抛 `GovernanceApiError`，**保留 `code`** —— 页面要按码分支
 *   （`REVISION_CONFLICT` 提示刷新、`RESTORE_NAME_CONFLICT` 行内报错），
 *   只给一句 message 的化页面只能显示"操作失败"；
 * · `lifecycle` 三档与后端一致：`wiki | temp | event`；期限用**相对天数** `ttlDays`。
 */

import type {
  AnalysisAskTurnDto,
  AnalysisDraftDto,
  ConclusionNodeDto,
  ConfirmedCodeLocationDto,
  EventAnalysisDto,
  RefCandidateDto,
  RefSearchCallDto,
  RefSearchResultDto,
  RefSearchStepDto,
} from './governanceContract';

export type LifecycleKind = 'wiki' | 'temp' | 'event';
export type Visibility = 'full' | 'fts-only' | 'hidden';

/**
 * 单事件参考文档上限（与服务端 `src/lib/events/refs-service.ts` 的 `REF_LIMIT` 同口径）。
 *
 * 前端只用它做**展示与预检**（「还能加几篇」、禁用提交），真正的拒绝在服务端
 * （`REF_LIMIT_EXCEEDED`）—— 前端永远不是防线。
 */
export const REF_LIMIT = 50;
export type TrashReason = 'temp-expired' | 'event-closed' | 'event-expired' | 'manual';

export class GovernanceApiError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'GovernanceApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function req<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  /**
   * 可取消 + 可超时（REQ-20261116-005）：深度查找要等 10–45s，
   * 没有 signal 的话"关弹窗 / 点停止"根本中断不了请求，用户只能干等。
   *
   * 超时与主动 abort **必须可区分**：超时要提示（可能改用快速查找），
   * 主动取消要静默（用户已经决定不要了）。
   */
  const { timeoutMs, ...rest } = init ?? {};
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs) : null;
  const incoming = rest.signal;
  const signal = incoming ? AbortSignal.any([incoming, ctrl.signal]) : ctrl.signal;
  try {
    const res = await fetch(path, {
      ...rest,
      signal,
      headers: { 'Content-Type': 'application/json', ...(rest.headers ?? {}) },
    });
    let payload: Record<string, unknown> = {};
    try {
      payload = (await res.json()) as Record<string, unknown>;
    } catch {
      // 非 JSON 响应（网关/代理错误页）按状态码报错
    }
    if (!res.ok || payload.ok === false) {
      throw new GovernanceApiError(
        String(payload.error ?? `HTTP ${res.status}`),
        res.status,
        typeof payload.code === 'string' ? payload.code : undefined,
        payload.details,
      );
    }
    return payload as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── 分类 ─────────────────────────────────────────────

export interface LifecycleListResponse {
  ok: true;
  scope: string;
  group: string | null;
  kinds: Array<{ kind: LifecycleKind; label: string; ttlOptions: number[]; min?: number; max?: number }>;
  presets: Array<{ id: string; name: string; kind: LifecycleKind; ttlDays?: number }>;
  groupDefaults: Record<string, { kind: LifecycleKind; ttlDays?: number }>;
  effectiveDefault?: { kind: LifecycleKind; ttlDays?: number; source?: string };
}

export function listLifecycle(scope: string, group?: string): Promise<LifecycleListResponse> {
  const params = new URLSearchParams({ scope });
  if (group) params.set('group', group);
  return req<LifecycleListResponse>(`/api/governance/lifecycle/list?${params.toString()}`);
}

export interface ApplyLifecycleResult {
  ok: true;
  scope: string;
  lifecycle: LifecycleKind;
  source: string;
  expiresAt?: number;
  ttlDays?: number;
  eventId?: string;
  /** 改分类后实际生效的检索档位（event 文档按阶段算） */
  visibility?: Visibility;
  /** 需异步补写的索引类别；非空时提示"索引补齐中" */
  pending?: string[];
}

export function applyLifecycle(
  scope: string,
  args: { group: string; name: string; lifecycle?: LifecycleKind; ttlDays?: number; eventId?: string },
): Promise<ApplyLifecycleResult> {
  return req<ApplyLifecycleResult>('/api/governance/lifecycle/apply', {
    method: 'POST',
    body: JSON.stringify({ scope, ...args }),
  });
}

// ─── 事件类型 ─────────────────────────────────────────

export interface EventStageView {
  key: string;
  name: string;
  index: number;
  visibility: Visibility;
  disabled: boolean;
  originalName?: string;
}

export interface EventTypeView {
  id: string;
  name: string;
  builtin: boolean;
  terminalAction: 'keep' | 'trash';
  fallbackDays: number | null;
  revision: number;
  stages: EventStageView[];
  /** 视图模式下：类型所属库（`et_1` 每库都有，裸 id 必撞车） */
  scope?: string;
  /** 视图模式下：`${scope}:${id}`，前端下拉/筛选都用它 */
  typeKey?: string;
}

export function listEventTypes(scope: string): Promise<{
  ok: true;
  scope: string;
  types: EventTypeView[];
  view?: string;
  members?: string[];
  buckets?: Array<{ scope: string; total?: number; error?: string }>;
}> {
  return req(`/api/governance/event-types?${new URLSearchParams({ scope }).toString()}`);
}

export interface StagePatch {
  /** 已有阶段必须带 key；新增阶段**不带** key（服务端生成 st_N） */
  key?: string;
  name: string;
  visibility: Visibility;
  disabled?: boolean;
}

export function updateEventType(
  scope: string,
  id: string,
  patch: {
    revision: number;
    name?: string;
    stages?: StagePatch[];
    terminalAction?: 'keep' | 'trash';
    fallbackDays?: number | null;
  },
): Promise<{ ok: true; type: EventTypeView }> {
  return req(`/api/governance/event-types/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ scope, ...patch }),
  });
}

// ─── 事件 ─────────────────────────────────────────────

export interface EventView {
  id: string;
  shortId: number;
  title: string;
  description?: string;
  typeId: string;
  typeName?: string | null;
  /** 视图模式下：事件所属库（详情 / refs / analysis 都靠它定位） */
  scope?: string;
  stageKey: string;
  stageIndex: number;
  closedAt: number | null;
  /** 置顶时间；有值 = 已置顶（2026-11-19）。缺省与 null 都表示未置顶 */
  pinnedAt?: number | null;
  revision: number;
  /** 创建时间（列表按创建时间排序时使用；后端 `...item.event` 一直有下发，此前前端未声明） */
  createdAt?: number;
  /** 最后更新时间（列表第二行显示「N 小时前」） */
  updatedAt?: number;
  stage?: { key: string; name: string; index: number; visibility: Visibility };
  memberTotal?: number;
  docsPreview?: Array<{ group: string; name: string }>;
}

export interface EventListResponse extends GovernanceViewMeta {
  ok: true;
  scope: string;
  total: number;
  hasMore: boolean;
  events: EventView[];
}

export function listEvents(
  scope: string,
  opts: { status?: 'open' | 'closed' | 'all'; type?: string; q?: string; limit?: number; offset?: number; includePinned?: boolean } = {},
): Promise<EventListResponse> {
  const params = new URLSearchParams({ scope, status: opts.status ?? 'open' });
  if (opts.type) params.set('type', opts.type);
  if (opts.q) params.set('q', opts.q);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  // 置顶免疫状态/类型筛选（2026-11-19）：仅事件页开启，其他调用方不受影响
  if (opts.includePinned) params.set('includePinned', '1');
  return req<EventListResponse>(`/api/governance/events?${params.toString()}`);
}

export interface CreateEventBindingView {
  docs: {
    bound: Array<{ group: string; name: string }>;
    skipped: Array<{ group: string; name: string; reason: 'already-bound' | 'duplicate-in-request' }>;
    failed: Array<{ group: string; name: string; code: string; error: string }>;
    visibilityFailed: Array<{ group: string; name: string; kind: 'dense' | 'fts' | 'relation' | 'path'; error: string }>;
  };
  refs: {
    added: number;
    addedList: Array<{ group: string; name: string }>;
    skipped: Array<{ group: string; name: string; reason: 'duplicate' | 'already-associated' }>;
    failed: Array<{ group: string; name: string; code: string; error: string }>;
  };
}

/** 创建事件（可一次带上关联文档与参考文档） */
export function createEvent(
  scope: string,
  args: {
    title: string;
    description?: string;
    typeId: string;
    stageKey?: string;
    docs?: Array<{ group: string; name: string }>;
    refs?: Array<{ group: string; name: string }>;
  },
): Promise<{
  ok: true;
  scope: string;
  event: EventView;
  binding: CreateEventBindingView;
  visibility: { mode: Visibility; dense: boolean; fts: boolean };
  pending: string[];
  hint?: string;
}> {
  return req('/api/governance/events', {
    method: 'POST',
    body: JSON.stringify({ scope, ...args }),
  });
}

// ─── 关联文档（成员）──────────────────────────────────

export interface MemberChangeResult {
  ok: true;
  scope: string;
  eventId: string;
  shortId: number;
  visibility: { mode: Visibility; dense: boolean; fts: boolean };
  bound: Array<{ group: string; name: string }>;
  skipped: Array<{ group: string; name: string; reason: 'already-bound' | 'duplicate-in-request' }>;
  failed: Array<{ group: string; name: string; code: string; error: string }>;
  visibilityFailed?: Array<{ group: string; name: string; kind: 'dense' | 'fts' | 'relation' | 'path'; error: string }>;
  pending: string[];
  hint: string;
}

export function addMembers(
  scope: string,
  eventId: string,
  docs: Array<{ group: string; name: string }>,
): Promise<MemberChangeResult> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/members`, {
    method: 'POST',
    body: JSON.stringify({ scope, docs }),
  });
}

export function removeMember(
  scope: string,
  eventId: string,
  group: string,
  name: string,
): Promise<{
  ok: true;
  scope: string;
  eventId: string;
  removed: { group: string; name: string };
  lifecycle: 'wiki';
  visibility: { mode: Visibility; dense: boolean; fts: boolean };
  pending: string[];
  hint: string;
}> {
  const params = new URLSearchParams({ scope, group, name });
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/members?${params.toString()}`, {
    method: 'DELETE',
  });
}

export function updateEvent(
  scope: string,
  eventId: string,
  patch: { title?: string; description?: string; revision: number },
): Promise<{ ok: true; event: EventView }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ scope, ...patch }),
  });
}

/**
 * 置顶 / 取消置顶（2026-11-19）。幂等：连点两次都返回 200。
 *
 * 为什么不复用 `updateEvent`：那条路径要 `revision` 且会 bump `updatedAt`，
 * 而置顶是列表偏好 —— 不该被乐观锁挡，也不该改动「最近更新」排序。
 */
export function setEventPinned(
  scope: string,
  eventId: string,
  pinned: boolean,
): Promise<{ ok: true; scope: string; event: EventView; pinned: boolean; hint: string }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/pin`, {
    method: 'POST',
    body: JSON.stringify({ scope, pinned }),
  });
}

export interface TransitionResult {
  ok: true;
  scope: string;
  event: EventView;
  from: { key: string; name: string; index: number };
  to: { key: string; name: string; index: number };
  closed: boolean;
  affected: { docs: number; failed: number };
  visibility: { mode: Visibility; dense: boolean; fts: boolean };
  pending: string[];
  terminalAction?: 'keep' | 'trash';
}

export function setEventStage(scope: string, event: string, stage: string, note?: string): Promise<TransitionResult> {
  return req(`/api/governance/events/${encodeURIComponent(event)}/stage`, {
    method: 'POST',
    body: JSON.stringify({ scope, stage, ...(note ? { note } : {}) }),
  });
}

export function deleteEvent(
  scope: string,
  event: string,
  docAction: 'wiki' | 'trash',
): Promise<{ ok: true; affected: { docs: number; failed: number } }> {
  return req(`/api/governance/events/${encodeURIComponent(event)}`, {
    method: 'DELETE',
    body: JSON.stringify({ scope, docAction }),
  });
}

export function reopenEvent(scope: string, event: string): Promise<{ ok: true; hint: string }> {
  return req(`/api/governance/events/${encodeURIComponent(event)}/reopen`, {
    method: 'POST',
    body: JSON.stringify({ scope }),
  });
}

// ─── 回收站 ───────────────────────────────────────────

export interface TrashItemView {
  scope: string;
  group: string;
  name: string;
  reason: TrashReason;
  deletedAt: number;
  expiresAt: number;
  ttlDays: number;
  ttlAssumed?: boolean;
  restoreCount: number;
  dirName: string;
  hasAssets: boolean;
  sizeBytes: number;
}

export interface TrashSettingsView {
  keepDays: 3 | 7 | 14 | 30;
  expireAction: 'purge' | 'notify';
}

/**
 * 视图（多库聚合）响应的公共元信息（REQ-20261120-001）。
 *
 * `view` 存在即代表「当前 scope 是视图」——页面据此切只读形态；
 * 单库响应**不出现**该字段，所以旧 daemon / 单库走的还是原来那条分支。
 */
export interface GovernanceViewMeta {
  view?: string;
  /** 本次实际参与合并的成员库（已去重、≤12） */
  members?: string[];
  /** 每库读取结果摘要：某个库失败只污染自己的桶，其余照常 */
  buckets?: Array<{ scope: string; total?: number; error?: string }>;
  /** 未参与本次读取的成员（strict 未注册 / 超出单次合并上限） */
  skipped?: Array<{ scope: string; reason: string }>;
  /** 成员数超上限被截断 */
  truncated?: boolean;
}

export interface GovernanceTrashResponse extends GovernanceViewMeta {
  ok: true;
  scope: string;
  total: number;
  items: TrashItemView[];
  /** 单库才有；视图下各库设置可能不同，故不下发单一值 */
  settings?: TrashSettingsView;
  settingsByScope?: Array<{ scope: string; settings: TrashSettingsView }>;
}

export function listTrash(
  scope: string,
  opts: { reason?: TrashReason; limit?: number; offset?: number } = {},
): Promise<GovernanceTrashResponse> {
  const params = new URLSearchParams({ scope });
  if (opts.reason) params.set('reason', opts.reason);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  return req(`/api/governance/trash?${params.toString()}`);
}

export function restoreTrash(
  scope: string,
  args: { group: string; dirName: string; targetLifecycle?: 'wiki' | 'temp' },
): Promise<{ ok: true; lifecycle: LifecycleKind; expiresAtChanged: boolean; rebuild: string; hint?: string }> {
  return req('/api/governance/trash/restore', {
    method: 'POST',
    body: JSON.stringify({ scope, ...args }),
  });
}

export function purgeTrash(scope: string, args: { group: string; dirName: string }): Promise<{ ok: true }> {
  return req('/api/governance/trash/purge', {
    method: 'POST',
    body: JSON.stringify({ scope, ...args }),
  });
}

export function getTrashSettings(scope: string): Promise<{ ok: true; settings: TrashSettingsView; options: number[] }> {
  return req(`/api/governance/trash/settings?${new URLSearchParams({ scope }).toString()}`);
}

export function putTrashSettings(scope: string, settings: TrashSettingsView): Promise<{ ok: true; settings: TrashSettingsView }> {
  return req('/api/governance/trash/settings', {
    method: 'PUT',
    body: JSON.stringify({ scope, ...settings }),
  });
}

// ─── 计数 / 诊断 ──────────────────────────────────────

export interface GovernanceCounts extends GovernanceViewMeta {
  ok: true;
  scope: string;
  docs: number;
  eventsOpen: number;
  eventsClosed: number;
  trash: number;
  pendingIndex: number;
}

/**
 * 正在跑分析的事件 id 清单（2026-11-19）。
 *
 * 后端只读进程内 `activeRuns`，无磁盘 I/O —— 列表页可以低频轮询用来打「分析中」标记。
 * 注意是**本进程视角**：daemon 重启后本就没有正在跑的任务，清单为空是如实的。
 */
export interface FinishedAnalysisView {
  eventId: string;
  status: 'running' | 'ready' | 'partial' | 'failed' | 'cancelled';
  runId: string;
  at: number;
}

/**
 * 正在跑 + **最近结束**的分析（2026-11-20）。
 *
 * `finished` 用于列表行的「分析完成 / 分析失败」徽标：与 `ids` 同源（进程内缓存，
 * 无磁盘 I/O）。daemon 重启后 `finished` 为空 —— 只是少一个提示，不会显示错状态。
 */
export function listRunningAnalyses(
  scope: string,
): Promise<{ ok: true; scope: string; ids: string[]; finished?: FinishedAnalysisView[] }> {
  return req(`/api/governance/events/running?${new URLSearchParams({ scope }).toString()}`);
}

export function getGovernanceCounts(scope: string): Promise<GovernanceCounts> {
  return req(`/api/governance/counts?${new URLSearchParams({ scope }).toString()}`);
}

export interface GovernanceDiagnostics {
  ok: true;
  scope: string;
  pending: { count: number; items: Array<{ group: string; relation: string; target: string; attempts: number }> };
  failures: { items: Array<{ group: string; relation: string; kind: string; code: string; message: string; attempts: number }> };
  trash: {
    total: number;
    /** 正文缺失（sizeBytes===0）的条目：恢复只会写回空串，UI 应禁止恢复 */
    emptyContent: Array<{ group: string; name: string; dirName: string; reason: string }>;
    /** emptyContent 只扫最近 200 条，这里给出实际扫描条数 */
    scanned: number;
  };
}

export function getGovernanceDiagnostics(scope: string): Promise<GovernanceDiagnostics> {
  return req(`/api/governance/diagnostics?${new URLSearchParams({ scope }).toString()}`);
}

// ─── 文档列表（带分类，供分类页）──────────────────────

export interface GovernanceDocItem {
  /**
   * 条目所属物理库（REQ-20261120-001）。
   *
   * 单库模式同样返回，前端键统一为 `scope\0group\0name` —— 一套渲染代码同时服务
   * 单库与视图，不必到处判断「是不是视图」。
   */
  scope: string;
  group: string;
  name: string;
  lifecycle: LifecycleKind;
  expiresAt?: number;
  ttlDays?: number;
  eventId?: string;
  lifecycleWarning?: string;
  visibility: Visibility;
  imported: boolean;
  /** 仅 temp：剩余天数（服务端算）；其他档位为 null */
  remainDays: number | null;
  /** 最后活跃（毫秒）；null = 从未被读取 */
  lastUsedTime: number | null;
  /** 事件文档才有：绑定的事件与当前阶段（列表要显示「#3 标题 · 阶段」） */
  event: { id: string; shortId: number | null; title: string; stageName: string | null; closed?: boolean } | null;
}

/** 各档全量计数（与 `total` 同一集合，已应用 group / 关键字过滤） */
export interface GovernanceLifecycleCounts {
  all: number;
  wiki: number;
  temp: number;
  event: number;
}

export interface GovernanceDocsResponse extends GovernanceViewMeta {
  ok: true;
  scope: string;
  total: number;
  items: GovernanceDocItem[];
  /** 旧 daemon 缺失 → 前端回退按已加载列表统计 */
  lifecycleCounts?: GovernanceLifecycleCounts;
}

export function listGovernanceDocs(
  scope: string,
  opts: { group?: string; q?: string; limit?: number; offset?: number } = {},
): Promise<GovernanceDocsResponse> {
  const params = new URLSearchParams({ scope });
  if (opts.group) params.set('group', opts.group);
  if (opts.q) params.set('q', opts.q);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  return req(`/api/governance/docs?${params.toString()}`);
}

export function applyLifecycleBatch(
  scope: string,
  items: Array<{ group: string; name: string; lifecycle: LifecycleKind; ttlDays?: number; eventId?: string }>,
): Promise<{ ok: true; scope: string; succeeded: number; failed: Array<{ group: string; name: string; code?: string; error: string }> }> {
  return req('/api/governance/lifecycle/batch-apply', {
    method: 'POST',
    body: JSON.stringify({ scope, items }),
  });
}

// ─── 事件详情（右栏）───────────────────────────────────

export interface EventDetail {
  ok: true;
  /** 事件**所属库**（视图下也不是视图名）：后续 refs / analysis / ask 直接复用它 */
  scope: string;
  /** 视图模式下：请求时的视图名（仅用于展示） */
  view?: string;
  viewMembers?: string[];
  event: EventView & { typeName?: string };
  members: Array<{ group: string; name: string }>;
  logs: Array<{ fromKey: string | null; toKey: string; at: number; by: string; note?: string }>;
  analysis?: EventAnalysisDto;
}

export type AnalysisDraft = AnalysisDraftDto;
export type ConfirmedCodeLocation = ConfirmedCodeLocationDto;
/** 结论因果链节点（2026-11-19）：`draft.chain` 的元素类型 */
export type ConclusionNode = ConclusionNodeDto;
export type EventAnalysis = EventAnalysisDto;
export type AnalysisAskTurn = AnalysisAskTurnDto;

export function getEventDetail(scope: string, eventId: string): Promise<EventDetail> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}?${new URLSearchParams({ scope }).toString()}`);
}

// ─── 事件源码分析（REQ-20261113-003 · S-03/S-04/S-05）─────

export function startEventAnalysis(
  scope: string,
  eventId: string,
  opts: { forceOverwrite?: boolean; resume?: boolean } = {},
): Promise<{ ok: true; scope: string; eventId: string; reused: boolean; analysis: EventAnalysis }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analyze`, {
    method: 'POST',
    body: JSON.stringify({
      scope,
      ...(opts.forceOverwrite ? { forceOverwrite: true } : {}),
      // 续跑：后端会用断点里的模型上下文接着跑；断点不存在时报 ANALYSIS_RESUME_UNAVAILABLE
      ...(opts.resume ? { resume: true } : {}),
    }),
  });
}

/**
 * 手动停止分析（幂等）。返回的 `draft` 可能仍是 `running` —— 后台收到 abort 才落终态，
 * 调用方继续轮询即可看到 `cancelled` / `partial`。
 */
export function cancelEventAnalysis(
  scope: string,
  eventId: string,
): Promise<{ ok: true; scope: string; eventId: string; canceled: boolean; analysis: EventAnalysis }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analysis/cancel`, {
    method: 'POST',
    body: JSON.stringify({ scope }),
  });
}

export function getEventAnalysis(
  scope: string,
  eventId: string,
): Promise<{ ok: true; scope: string; eventId: string; draft: AnalysisDraft | null; confirmed: ConfirmedCodeLocation[] }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analysis?${new URLSearchParams({ scope }).toString()}`);
}

export function confirmEventAnalysis(
  scope: string,
  eventId: string,
  args: { candidateIds: string[]; expectedRunId?: string; discardDraft?: boolean },
): Promise<{ ok: true; scope: string; eventId: string; added: number; draft: AnalysisDraft | null; confirmed: ConfirmedCodeLocation[] }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analysis/confirm`, {
    method: 'POST',
    body: JSON.stringify({ scope, ...args }),
  });
}

/**
 * 人工校正三块产物（2026-11-23 · REQ-20261123-001）：整块提交。
 *
 * 三个约定（详见后端 `saveDraftEdits`）：
 * · 未提供的块保持原值，但**前端始终三块都传**（避免"只改一处"时把其余块写丢）；
 * · `conclusion: null` / `chain: []` 是合法的"人工清空"，不是"没传"；
 * · `expectedRunId` 传 `draft?.runId ?? null`：无草稿时传 `null` 表示"我期望此刻没有草稿"。
 */
export function saveEventAnalysisEdits(
  scope: string,
  eventId: string,
  patch: {
    expectedRunId?: string | null;
    conclusion?: string | null;
    chain?: ConclusionNode[];
    unconfirmed?: string[];
    confirmed?: {
      add?: Array<{ file: string; line: number; endLine?: number; why: string }>;
      update?: Array<{ id: string; why: string }>;
    };
    /**
     * 采纳了哪一轮追问的补丁（S03 R-23）。
     *
     * 只在"用补丁覆盖结论"时传：服务端写完盘才回写 `.ask.json` 的
     * `proposalAccepted`，失败不标记（用户其实没采纳）。
     */
    acceptedProposalTurnId?: string;
  },
): Promise<{
  ok: true;
  scope: string;
  eventId: string;
  editedAt?: number;
  draft: AnalysisDraft | null;
  confirmed: ConfirmedCodeLocation[];
}> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analysis`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, ...patch }),
  });
}

export function discardEventAnalysisDraft(
  scope: string,
  eventId: string,
): Promise<{ ok: true; scope: string; eventId: string; draft: AnalysisDraft | null; confirmed: ConfirmedCodeLocation[] }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analysis/draft?${new URLSearchParams({ scope }).toString()}`, {
    method: 'DELETE',
  });
}

/**
 * 整份重置这次分析（2026-11-23）：清草稿 + 已确认的代码位置，后端同时清掉
 * 断点（`.analysis.resume.json`）与追问记录（`.ask.json`）。
 *
 * 与上面的 `discardEventAnalysisDraft` 的区别：那个只丢草稿、保留已确认位置。
 * 运行中会被后端拒（409 `ANALYSIS_ALREADY_RUNNING`），调用方应只在非运行态暴露入口。
 */
export function resetEventAnalysis(
  scope: string,
  eventId: string,
): Promise<{
  ok: true;
  scope: string;
  eventId: string;
  draft: AnalysisDraft | null;
  confirmed: ConfirmedCodeLocation[];
  resumeAvailable?: boolean;
}> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analysis?${new URLSearchParams({ scope }).toString()}`, {
    method: 'DELETE',
  });
}

/** 追问这次分析（B2）：提问一轮 */
export function askEventAnalysis(
  scope: string,
  eventId: string,
  args: { question: string; runId?: string },
): Promise<{ ok: true; scope: string; eventId: string; turn: AnalysisAskTurn }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analysis/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope,
      question: args.question,
      ...(args.runId ? { runId: args.runId } : {}),
    }),
    timeoutMs: 60_000,
  });
}

/**
 * 追问（流式）：边生成边回调文本增量。
 * 走 `POST /analysis/ask/stream`（SSE over fetch，不能用 EventSource —— 需要 POST body）。
 * 响应非 200 时按普通 JSON 错误解析；流内 `type:'error'` 转为抛错。
 */
export interface AskStep {
  id: string;
  kind: 'thinking' | 'tool' | 'answer';
  label: string;
  /** 累积全文（同 id 覆盖即可） */
  text: string;
  at: number;
}

/** 补丁差异块（S03）：块级展示，不做全文对照 */
export interface AskProposalDiffBlock {
  block: 'conclusion' | 'chain';
  kind: '改' | '增' | '删';
  before?: string;
  after?: string;
}

/**
 * 追问末端的结论补丁建议（S03）。
 *
 * `valid:false` 也会下发：前端要能说明"AI 想改但不合规、原因是什么"，
 * 而不是假装没有建议（N14）；此时**不给确认按钮**。
 */
export interface AskProposalEvent {
  type: 'proposal';
  turnId: string;
  valid: boolean;
  reason?: string;
  reasons?: string[];
  diff?: { changed: boolean; blocks: AskProposalDiffBlock[] };
  patch?: { conclusion: string; chain: ConclusionNode[]; reason: string };
}

export type AskProgressEvent =
  | { type: 'step'; step: AskStep }
  | { type: 'tool'; name: string; label: string }
  | { type: 'thinking'; text: string }
  | AskProposalEvent;

export async function askEventAnalysisStream(
  scope: string,
  eventId: string,
  args: { question: string; runId?: string },
  onDelta: (text: string) => void,
  onEvent?: (event: AskProgressEvent) => void,
): Promise<{ turn: AnalysisAskTurn }> {
  const res = await fetch(`/api/governance/events/${encodeURIComponent(eventId)}/analysis/ask/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope,
      question: args.question,
      ...(args.runId ? { runId: args.runId } : {}),
    }),
  });
  if (!res.ok) {
    let message = `追问失败（HTTP ${res.status}）`;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string; code?: string };
      if (j.error) message = j.error;
      code = j.code;
    } catch { /* 非 JSON 错误体，用默认文案 */ }
    throw new GovernanceApiError(message, res.status, code);
  }
  if (!res.body) throw new GovernanceApiError('当前环境不支持流式响应', 0);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let doneTurn: AnalysisAskTurn | null = null;
  let errMessage = '';
  let errCode: string | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) {
        try {
          const payload = JSON.parse(line.slice(6)) as {
            type: string; text?: string; name?: string; label?: string; step?: AskStep;
            turn?: AnalysisAskTurn; message?: string; code?: string;
            turnId?: string; valid?: boolean; reason?: string; reasons?: string[];
            diff?: { changed: boolean; blocks: AskProposalDiffBlock[] };
            patch?: { conclusion: string; chain: ConclusionNode[]; reason: string };
          };
          if (payload.type === 'delta') onDelta(payload.text ?? '');
          else if (payload.type === 'step' && payload.step && onEvent) onEvent({ type: 'step', step: payload.step });
          else if (payload.type === 'tool' && onEvent) onEvent({ type: 'tool', name: payload.name ?? '', label: payload.label ?? '' });
          else if (payload.type === 'thinking' && onEvent) onEvent({ type: 'thinking', text: payload.text ?? '' });
          else if (payload.type === 'proposal' && onEvent) {
            // 旧后端不会发这个事件；这里对缺省字段一律按"无建议"兜底
            onEvent({
              type: 'proposal',
              turnId: payload.turnId ?? '',
              valid: payload.valid === true,
              ...(payload.reason ? { reason: payload.reason } : {}),
              ...(payload.reasons ? { reasons: payload.reasons } : {}),
              ...(payload.diff ? { diff: payload.diff } : {}),
              ...(payload.patch ? { patch: payload.patch } : {}),
            });
          }
          else if (payload.type === 'done' && payload.turn) doneTurn = payload.turn;
          else if (payload.type === 'error') {
            errMessage = payload.message ?? '追问失败';
            errCode = payload.code;
          }
        } catch { /* 单条事件坏掉不影响后续 */ }
      }
      idx = buf.indexOf('\n\n');
    }
  }

  if (!doneTurn) throw new GovernanceApiError(errMessage || '连接中断，回答未完成', 0, errCode);
  return { turn: doneTurn };
}

/** 读追问记录（可按 runId 过滤） */
export function listEventAnalysisAsk(
  scope: string,
  eventId: string,
  runId?: string,
): Promise<{ ok: true; scope: string; eventId: string; turns: AnalysisAskTurn[]; total: number; truncated: boolean; activeRunId: string | null }> {
  const qs = new URLSearchParams({ scope, ...(runId ? { runId } : {}) });
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analysis/ask?${qs}`);
}

/** 清空追问记录（写权限） */
export function clearEventAnalysisAsk(
  scope: string,
  eventId: string,
): Promise<{ ok: true; scope: string; eventId: string; cleared: number }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analysis/ask?${new URLSearchParams({ scope })}`, {
    method: 'DELETE',
  });
}

export function removeConfirmedCodeLocation(
  scope: string,
  eventId: string,
  locId: string,
): Promise<{ ok: true; scope: string; eventId: string; draft: AnalysisDraft | null; confirmed: ConfirmedCodeLocation[] }> {
  return req(
    `/api/governance/events/${encodeURIComponent(eventId)}/analysis/confirmed/${encodeURIComponent(locId)}?${new URLSearchParams({ scope }).toString()}`,
    { method: 'DELETE' },
  );
}

// ─── 参考文档 ─────────────────────────────────────────

export interface RefItem {
  group: string;
  name: string;
  /** 文档实际所在库；缺省 = 事件所在库（老数据） */
  sourceScope?: string;
  addedBy: 'ai' | 'manual';
  addedAt: number;
  score?: number;
  stale: boolean;
  /** stale 的原因：doc-deleted = 文档被删；scope-missing = 源库已不存在或无权限 */
  staleReason?: 'doc-deleted' | 'scope-missing';
  visibility: Visibility;
}

export function listRefs(scope: string, eventId: string): Promise<{ ok: true; refs: RefItem[] }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/refs?${new URLSearchParams({ scope }).toString()}`);
}

/**
 * 候选与步骤类型**直接取契约 DTO**（`governanceContract.ts`），不再本地重写一份。
 *
 * 此前这里有一份手抄的同名 interface，与契约文件靠人工保持一致 ——
 * 而 parity 测试只比对「后端 contract ↔ 前端 contract」，**管不到这份手抄**，
 * 加字段时漏改就会静默漂移。改成别名后，contract 一改这里跟着变，tsc 立刻报错。
 */
export type RefCandidate = RefCandidateDto;
export type RefSearchCall = RefSearchCallDto;
export type RefSearchStep = RefSearchStepDto;
export type RefSearchReason = NonNullable<RefSearchResultDto['reason']>;

/** 响应外壳由 `req()` 校验后补上 `ok/scope`，其余字段全部来自契约 */
export type RefSearchResult = RefSearchResultDto & { ok: true; scope: string };

/**
 * AI 候选（S-05 §3.2 五步）。**只此一种语义** —— 按名搜索请用 `searchRefDocs`。
 *
 * 0 候选时看 `reason`：`no-keywords` / `empty-scope` / `no-hits` / `all-excluded`
 * 对应四句完全不同的空态文案（尤其 empty-scope = 事件与文档不在同一 scope）。
 */
export function findRefCandidates(
  scope: string,
  eventId: string,
  opts: {
    /** `fast`（缺省）= 确定性五步；`deep` = LLM 深度查找（服务端未上线时 400） */
    mode?: 'fast' | 'deep';
    topK?: number;
    limit?: number;
    threshold?: number;
    /** 可取消：关弹窗 / 点停止 / 切模式 */
    signal?: AbortSignal;
    /** 客户端超时。fast 缺省 15s；deep 应覆盖「排队 20s + 服务端 45s 硬超时」再留余量 */
    timeoutMs?: number;
  } = {},
): Promise<RefSearchResult> {
  const { signal, timeoutMs, ...body } = opts;
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/refs/search`, {
    method: 'POST',
    body: JSON.stringify({ scope, ...body }),
    ...(signal ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

/** 流式过程中的一次工具调用（与后端 `onProgress` 形状一致） */
export interface RefSearchStepEvent {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  ok: boolean;
  round: number;
  label?: string;
}

/**
 * `event: error` 帧的正文（2026-11-20）。
 *
 * 流式接口在查找开始前就回了 `200 + text/event-stream`，门禁失败 / 硬超时 / 上游异常
 * 都拿不到 HTTP 状态码，只能以该帧下发；不带它时面板只会说"连接可能被中断"。
 */
interface RefSearchStreamError {
  code?: string;
  error?: string;
  details?: unknown;
}

/**
 * **流式版** AI 候选：与服务端 `?stream=1` 配套（2026-11-19）。
 *
 * 为什么需要它：深度查找要 25~35 秒，非流式接口在这整段时间里不返回任何东西，
 * 面板只能干转圈（实测反馈"知道有结果了才显示"）。流式版把每次工具调用作为
 * `event: step` 推下来，面板即可边跑边显示「检索了什么 / 读了几篇」。
 *
 * 返回值与 `findRefCandidates` **完全一致**（最终 `event: result` 的 payload），
 * 所以调用方只需把结果照旧丢给渲染层。
 */
export async function findRefCandidatesStream(
  scope: string,
  eventId: string,
  opts: {
    signal?: AbortSignal;
    /**
     * 客户端超时（毫秒）。**流式也必须保留**：服务端 45s 硬顶 + 排队 20s，
     * 客户端不设上限时，一旦网关半开或服务端卡死，面板会永远转圈。
     */
    timeoutMs?: number;
    /** 每收到一次工具调用回调一次（用于实时更新过程区） */
    onStep?: (step: RefSearchStepEvent) => void;
  } = {},
): Promise<RefSearchResult> {
  // 调用方取消 + 客户端超时，两者任一触发都中止（AbortSignal.any 已在目标浏览器基线内）
  const signals: AbortSignal[] = [];
  if (opts.signal) signals.push(opts.signal);
  if (opts.timeoutMs !== undefined) signals.push(AbortSignal.timeout(opts.timeoutMs));
  const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  const res = await fetch(
    `/api/governance/events/${encodeURIComponent(eventId)}/refs/search?stream=1`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok || !res.body) {
    throw new Error(`查找失败（HTTP ${res.status}）`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result: RefSearchResult | null = null;
  /** `event: error` 的正文（门禁失败 / 超时 / 上游异常都以它下发，见服务端注释） */
  let failure: RefSearchStreamError | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      idx = buf.indexOf('\n\n');
      const evName = /^event: (\w+)$/m.exec(chunk)?.[1];
      const dataLine = /^data: (.*)$/m.exec(chunk)?.[1];
      if (!dataLine) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(dataLine);
      } catch {
        continue;
      }
      if (evName === 'step') {
        opts.onStep?.(payload as RefSearchStepEvent);
      } else if (evName === 'result') {
        result = payload as RefSearchResult;
      } else if (evName === 'error') {
        failure = payload as RefSearchStreamError;
      }
    }
  }

  /*
   * 失败必须以 `event: error` 优先判定：HTTP 已经是 200（头在查找开始前就发出去了），
   * 不带这层就会把「模型不可用 / 查找超时 / 并发排队超时」统一报成"连接被中断"，
   * 用户只能点重试而不知道真因（2026-11-20 实测）。
   */
  if (failure) {
    throw new GovernanceApiError(failure.error ?? 'AI 查找失败', 200, failure.code, failure.details);
  }
  if (!result) throw new Error('流式响应未返回结果（连接可能被中断）');
  return result;
}

/** 最近一次「AI 查找」的结论（落盘在事件 refs 文件里，刷新后仍在） */
export interface FindSummaryRecord {
  summary: string;
  uncertainties?: string[];
  at: number;
}

export function getFindSummary(
  scope: string,
  eventId: string,
): Promise<{ ok: true; scope: string; lastFind: FindSummaryRecord | null }> {
  const params = new URLSearchParams({ scope });
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/refs/find-summary?${params}`);
}

/** 确认加入参考文档时调用：把这次的结论固定下来（不随刷新消失） */
export function saveFindSummary(
  scope: string,
  eventId: string,
  summary: string,
  uncertainties?: string[],
): Promise<{ ok: true }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/refs/find-summary`, {
    method: 'POST',
    body: JSON.stringify({
      scope,
      summary,
      ...(uncertainties && uncertainties.length > 0 ? { uncertainties } : {}),
    }),
  });
}

/** 手动按名 / 路径搜文档；传 eventId 时后端排除「已关联 / 已加入」（R31 服务端兜底） */
export function searchRefDocs(
  scope: string,
  q: string,
  eventId?: string,
  limit = 20,
): Promise<{
  ok: true;
  hits: Array<{
    group: string;
    name: string;
    visibility: Visibility;
    /** 已绑在另一个未收口事件上：选择器禁用并标注 */
    event?: { id: string; shortId: number; title: string };
  }>;
}> {
  const params = new URLSearchParams({ scope, q, limit: String(limit) });
  if (eventId) params.set('eventId', eventId);
  return req(`/api/governance/docs/search?${params.toString()}`);
}

export function addRefs(
  scope: string,
  eventId: string,
  docs: Array<{ sourceScope?: string; group: string; name: string; score?: number }>,
  addedBy: 'ai' | 'manual' = 'manual',
): Promise<{ ok: true; added: number; skipped: string[] }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/refs`, {
    method: 'POST',
    body: JSON.stringify({ scope, docs, addedBy }),
  });
}

/** 上传文件并挂为参考文档（REQ-20261118-001）的 202 回执 */
export interface EventRefUploadResponse {
  ok: true;
  scope: string;
  eventId: string;
  shortId: number;
  /** 本次落点 Group（缺省由服务端算：`事件参考/{短号}-{标题}`） */
  group: string;
  jobId: string;
  uploadId: string;
  refs: { limit: number; current: number };
  /** 已通过校验、正在导入的文件（relation = 文件名去扩展名，与导入同源） */
  accepted: Array<{ name: string; group: string; relation: string }>;
  /** 未通过校验的文件（格式 / 大小 / 带路径 / 重名 / 图片附件） */
  rejected: Array<{ name: string; error: string }>;
  hint?: string;
}

/**
 * 上传文件并挂为该事件的参考文档。
 *
 * 服务端顺序是「先校验 → 再导入 → 再建引用」（REQ-20261118-001 D1），
 * 名额/数量/格式被拒时不产生任何文档 —— 前端不要自己先传再补救。
 *
 * `timeoutMs`：10 × 1MB 的 base64 请求体可能十几 MB，给一个宽松上限；
 * 导入本身是异步 job，由调用方轮询 `/api/import/status`。
 */
export function uploadEventRefDocs(
  scope: string,
  eventId: string,
  files: Array<{ name: string; content: string }>,
  opts: { group?: string } = {},
): Promise<EventRefUploadResponse> {
  return req<EventRefUploadResponse>(`/api/governance/events/${encodeURIComponent(eventId)}/refs/upload`, {
    method: 'POST',
    body: JSON.stringify({ scope, files, ...(opts.group ? { group: opts.group } : {}) }),
    timeoutMs: 120_000,
  });
}

/**
 * 删除一条引用。
 *
 * `sourceScope` 缺省 = 事件库（老后端 / 老数据兼容）；跨库引用必须带上，
 * 否则同 group 同名的另一库文档会被误删。
 */
export function removeRef(
  scope: string,
  eventId: string,
  group: string,
  name: string,
  sourceScope?: string,
): Promise<{ ok: true }> {
  const params = new URLSearchParams({ scope, group, name });
  if (sourceScope) params.set('sourceScope', sourceScope);
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/refs?${params.toString()}`, { method: 'DELETE' });
}
