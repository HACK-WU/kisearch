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
  ConfirmedCodeLocationDto,
  EventAnalysisDto,
  RefCandidateDto,
  RefSearchCallDto,
  RefSearchResultDto,
  RefSearchStepDto,
} from './governanceContract';

export type LifecycleKind = 'wiki' | 'temp' | 'event';
export type Visibility = 'full' | 'fts-only' | 'hidden';
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
}

export function listEventTypes(scope: string): Promise<{ ok: true; scope: string; types: EventTypeView[] }> {
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
  stageKey: string;
  stageIndex: number;
  closedAt: number | null;
  revision: number;
  /** 创建时间（列表按创建时间排序时使用；后端 `...item.event` 一直有下发，此前前端未声明） */
  createdAt?: number;
  /** 最后更新时间（列表第二行显示「N 小时前」） */
  updatedAt?: number;
  stage?: { key: string; name: string; index: number; visibility: Visibility };
  memberTotal?: number;
  docsPreview?: Array<{ group: string; name: string }>;
}

export interface EventListResponse {
  ok: true;
  scope: string;
  total: number;
  hasMore: boolean;
  events: EventView[];
}

export function listEvents(
  scope: string,
  opts: { status?: 'open' | 'closed' | 'all'; type?: string; q?: string; limit?: number; offset?: number } = {},
): Promise<EventListResponse> {
  const params = new URLSearchParams({ scope, status: opts.status ?? 'open' });
  if (opts.type) params.set('type', opts.type);
  if (opts.q) params.set('q', opts.q);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
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

export function listTrash(
  scope: string,
  opts: { reason?: TrashReason; limit?: number; offset?: number } = {},
): Promise<{ ok: true; scope: string; total: number; items: TrashItemView[]; settings: TrashSettingsView }> {
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

export interface GovernanceCounts {
  ok: true;
  scope: string;
  docs: number;
  eventsOpen: number;
  eventsClosed: number;
  trash: number;
  pendingIndex: number;
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

export function listGovernanceDocs(
  scope: string,
  opts: { group?: string; q?: string; limit?: number; offset?: number } = {},
): Promise<{ ok: true; scope: string; total: number; items: GovernanceDocItem[] }> {
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
  scope: string;
  event: EventView & { typeName?: string };
  members: Array<{ group: string; name: string }>;
  logs: Array<{ fromKey: string | null; toKey: string; at: number; by: string; note?: string }>;
  analysis?: EventAnalysisDto;
}

export type AnalysisDraft = AnalysisDraftDto;
export type ConfirmedCodeLocation = ConfirmedCodeLocationDto;
export type EventAnalysis = EventAnalysisDto;
export type AnalysisAskTurn = AnalysisAskTurnDto;

export function getEventDetail(scope: string, eventId: string): Promise<EventDetail> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}?${new URLSearchParams({ scope }).toString()}`);
}

// ─── 事件源码分析（REQ-20261113-003 · S-03/S-04/S-05）─────

export function startEventAnalysis(
  scope: string,
  eventId: string,
  opts: { forceOverwrite?: boolean } = {},
): Promise<{ ok: true; scope: string; eventId: string; reused: boolean; analysis: EventAnalysis }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analyze`, {
    method: 'POST',
    body: JSON.stringify({ scope, ...(opts.forceOverwrite ? { forceOverwrite: true } : {}) }),
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

export function discardEventAnalysisDraft(
  scope: string,
  eventId: string,
): Promise<{ ok: true; scope: string; eventId: string; draft: AnalysisDraft | null; confirmed: ConfirmedCodeLocation[] }> {
  return req(`/api/governance/events/${encodeURIComponent(eventId)}/analysis/draft?${new URLSearchParams({ scope }).toString()}`, {
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
    /** 客户端超时。fast 缺省 15s；deep 应传服务端 `find.timeoutMs` + 10s 余量 */
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
