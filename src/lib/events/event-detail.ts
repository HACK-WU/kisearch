/**
 * `getEventDetail` —— 单事件详情的只读聚合（MCP `ki_event_get` 的服务层）
 *
 * **为什么不复用 HTTP 的详情接口**：`GET /governance/events/:id` 是另一套内联组装
 * （`governance-http.ts`），且不含参考文档；本期不动它，避免改既有接口引入前端回归面。
 *
 * **两条体积纪律**（本工具的主要失败模式是一次返回几十 KB，把 AI 上下文吃掉）：
 *   1. 每块都带 `total`，被截断时给 `note`——让调用方知道"还有多少没显示"；
 *   2. 分析过程（`steps`）与候选正文（`candidates`）**不进返回体**——它们与
 *      `unconfirmed` / `confirmed` 信息重叠，而单个工具响应就可能几 KB；只留
 *      `candidateTotal` 一个计数，用来区分"有候选但一个都没确认"与"压根没找到"。
 *
 * **文档引用必须带三元组**：`members` / `refs` 每条都给 `scope` + 完整 `group` + `name`，
 * 否则调用方只有文档名、调 `ki_get_module_info` 取不到正文（跨库引用走 `sourceScope`）。
 * 代码位置同理，`file` 是相对 `analysis.targetDir` 的路径，两者一起才定位得到。
 */

import { findEvent, isEventClosed } from './store.js';
import { getType } from './type-service.js';
import { collectMembers } from './members.js';
import { listRefs } from './refs-service.js';
import { readRefs } from './refs-store.js';
import { readStageLogs } from './stage-log.js';
import { readAnalysisDocRaw, normalizeAnalysisDocForRead } from './analysis-store.js';
import { GovernanceError } from '../governance-errors.js';

/** 单块上限：超过就截断并给 note（默认值见工具层 zod，服务层只做兜底夹取） */
const HARD_CAP = 100;

export interface EventDetailOptions {
  /** 事件 id（`evt_…`）、`#3` 或 `3` */
  ref: string;
  /** 0 = 不返回该块（仍给 total） */
  membersLimit?: number;
  refsLimit?: number;
  logsLimit?: number;
  locationsLimit?: number;
  /** 已确认位置的代码快照截断长度；0 = 不返回 snippet */
  snippetLimit?: number;
  now?: number;
}

export interface DocRefItem {
  /** 实际所在库（跨库引用为 sourceScope），取正文时的 scope 参数 */
  scope: string;
  /** 完整 Group 路径 */
  group: string;
  /** Relation 名，取正文时作 relation 参数 */
  name: string;
}

export interface MemberItemView extends DocRefItem {
  isImported: boolean;
}

export interface RefItemView extends DocRefItem {
  addedBy: 'ai' | 'manual';
  addedAt: number;
  stale: boolean;
  staleReason?: 'doc-deleted' | 'scope-missing';
  visibility: string;
}

export interface ConfirmedLocationView {
  file: string;
  line: number;
  endLine?: number;
  why: string;
  confidence: number;
  /** 分析时的 commit；历史位置可能没有（null） */
  commit: string | null;
  confirmedAt: number;
  snippet?: string;
}

export interface EventLogView {
  at: number;
  fromKey: string | null;
  toKey: string;
  by: 'user' | 'ai';
  note?: string;
  status?: 'committed' | 'aborted';
}

export interface EventDetailView {
  event: {
    id: string;
    shortId: string;
    title: string;
    description: string | null;
    closed: boolean;
    closedAt: number | null;
    revision: number;
    createdAt: number;
    updatedAt: number;
  };
  type: {
    id: string;
    name: string;
    terminalAction: 'keep' | 'trash';
    fallbackDays: number | null;
    stages: Array<{ key: string; name: string; visibility: string; disabled: boolean; current: boolean }>;
  } | null;
  stage: {
    key: string;
    name: string;
    index: number;
    visibility: string;
    legend: string;
  };
  members: { total: number; items: MemberItemView[]; note?: string };
  refs: { total: number; items: RefItemView[]; note?: string };
  analysis: {
    /** 分析目标目录；`confirmed[].file` 是相对它的路径 */
    targetDir: string | null;
    draft: {
      status: string;
      conclusion: string | null;
      unconfirmed: string[];
      commit: string | null;
      startedAt: number;
      updatedAt: number;
      errorCode?: string;
      errorMessage?: string;
    } | null;
    /** 候选**正文**不返回，只给计数（0 与 null 含义不同：null = 从未分析过） */
    candidateTotal: number;
    /**
     * 仅在「候选数 ≠ 已确认数」时出现：说明还有几个候选没确认。
     *
     * 为什么需要：两个数相等时（真实事件 #37 就是 12 = 12）光看 `candidateTotal`
     * 容易被读成「还有 12 个候选待处理」，而实际是全部已确认。
     */
    candidateNote?: string;
    confirmed: { total: number; items: ConfirmedLocationView[]; note?: string };
  };
  logs: { total: number; items: EventLogView[]; note?: string };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clip(text: string, limit: number): string | undefined {
  if (limit <= 0) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 截断说明：limit=0 与"正好够"是两种语义，文案必须分开 */
function blockNote(shown: number, total: number, limit: number, param: string): string | undefined {
  if (limit === 0 && total > 0) return `本块未返回（${param}=0），共 ${total} 条；需要时传 ${param}`;
  if (total > shown) return `仅显示前 ${shown} 条，共 ${total} 条；需要时传 ${param}`;
  return undefined;
}

function visibilityLegend(mode: string): string {
  if (mode === 'hidden') {
    return '当前阶段不可检索：语义与全文都搜不到，这是阶段设计的预期行为，不是数据丢失；按名读取用 ki_get_module_info';
  }
  if (mode === 'fts-only') {
    return '当前阶段仅全文可命中：语义检索不会召回，关键词检索用 ki_search(mode=fulltext)，按名读取用 ki_get_module_info';
  }
  return '当前阶段语义与全文都可检索';
}

export function getEventDetail(scope: string, options: EventDetailOptions): EventDetailView {
  const now = options.now ?? Date.now();
  const memberLimit = clamp(options.membersLimit ?? 20, 0, HARD_CAP);
  const refLimit = clamp(options.refsLimit ?? 20, 0, HARD_CAP);
  const logLimit = clamp(options.logsLimit ?? 20, 0, HARD_CAP);
  const locLimit = clamp(options.locationsLimit ?? 20, 0, HARD_CAP);
  const snippetLimit = clamp(options.snippetLimit ?? 200, 0, 2000);

  const event = findEvent(scope, options.ref);
  if (!event) {
    throw new GovernanceError(
      'EVENT_NOT_FOUND',
      `事件「${options.ref}」不存在；先用 ki_event_list 定位（支持 evt_… / #3 / 3 三种写法）`,
      { event: options.ref },
    );
  }

  const type = getType(scope, event.typeId);
  const currentStage = type?.stages.find((s) => s.key === event.stageKey) ?? null;
  const visibility = currentStage?.visibility ?? 'full';

  // 关联文档：只暴露三元组 + 数据源标记，relation 全量对象留给服务层内部
  const membersAll = collectMembers(scope, event.id);
  const memberItems: MemberItemView[] = membersAll.slice(0, memberLimit).map((m) => ({
    scope,
    group: m.group,
    name: m.name,
    isImported: m.relation.isImported === true,
  }));

  // 参考文档：跨库引用必须给 sourceScope 解析后的实际库，否则取不到正文。
  // `refs_limit=0` 时跳过 `listRefs`：它要为**每一条**引用解析可见性（跨库读 group cache），
  // 只想拿 total 时没必要付这个成本 —— 直接读 refs 文件取条数即可。
  const refsAll = refLimit === 0 ? null : listRefs(scope, event.id).refs;
  const refsTotal = refsAll?.length ?? readRefs(scope, event.id).length;
  const refItems: RefItemView[] = (refsAll ?? []).slice(0, refLimit).map((r) => ({
    scope: r.sourceScope ?? scope,
    group: r.group,
    name: r.name,
    addedBy: r.addedBy,
    addedAt: r.addedAt,
    stale: r.stale,
    ...(r.staleReason ? { staleReason: r.staleReason } : {}),
    visibility: r.visibility,
  }));

  // 阶段日志：文件是写入顺序（时间正序），取末尾 N 条即为"最近 N 条"
  const logsAll = readStageLogs(scope, event.id);
  const logItems: EventLogView[] = (logLimit === 0 ? [] : logsAll.slice(-logLimit)).map((l) => ({
    at: l.at,
    fromKey: l.fromKey,
    toKey: l.toKey,
    by: l.by,
    ...(l.note ? { note: l.note } : {}),
    ...(l.status ? { status: l.status } : {}),
  }));

  // 分析：只取"结论 / 未确认点 / 已确认位置"，过程与候选正文不返回
  const normalized = normalizeAnalysisDocForRead(readAnalysisDocRaw(scope, event.id), false, now);
  const draft = normalized.draft;
  const confirmedAll = normalized.confirmed;
  const confirmedItems: ConfirmedLocationView[] = confirmedAll.slice(0, locLimit).map((c) => {
    const snippet = clip(c.snippet ?? '', snippetLimit);
    return {
      file: c.file,
      line: c.line,
      ...(c.endLine !== undefined ? { endLine: c.endLine } : {}),
      why: c.why,
      confidence: c.confidence,
      commit: c.commit,
      confirmedAt: c.confirmedAt,
      ...(snippet ? { snippet } : {}),
    };
  });
  const targetDir = draft?.targetDir ?? confirmedAll[0]?.targetDir ?? null;

  const candidateTotal = draft?.candidates?.length ?? 0;
  const pendingCandidates = Math.max(0, candidateTotal - confirmedAll.length);
  const candidateNote = draft && pendingCandidates > 0
    ? `${candidateTotal} 个分析候选中 ${pendingCandidates} 个尚未确认（confirmed 为已确认位置），候选正文不返回`
    : undefined;

  const membersNote = blockNote(memberItems.length, membersAll.length, memberLimit, 'members_limit');
  const refsNote = blockNote(refItems.length, refsTotal, refLimit, 'refs_limit');
  const confirmedNote = blockNote(confirmedItems.length, confirmedAll.length, locLimit, 'locations_limit');
  const logsNote = logLimit === 0 && logsAll.length > 0
    ? `本块未返回（logs_limit=0），共 ${logsAll.length} 条`
    : logLimit > 0 && logsAll.length > logItems.length
      ? `仅显示最近 ${logItems.length} 条，共 ${logsAll.length} 条；需要时传 logs_limit`
      : undefined;

  return {
    event: {
      id: event.id,
      shortId: `#${event.shortId}`,
      title: event.title,
      description: event.description ?? null,
      closed: isEventClosed(event),
      closedAt: event.closedAt,
      revision: event.revision,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    },
    type: type
      ? {
        id: type.id,
        name: type.name,
        terminalAction: type.terminalAction,
        fallbackDays: type.fallbackDays,
        stages: type.stages.map((s) => ({
          key: s.key,
          name: s.name,
          visibility: s.visibility,
          disabled: s.disabled === true,
          current: s.key === event.stageKey,
        })),
      }
      : null,
    stage: {
      key: event.stageKey,
      name: currentStage?.name ?? event.stageKey,
      index: event.stageIndex,
      visibility,
      legend: visibilityLegend(visibility),
    },
    members: { total: membersAll.length, items: memberItems, ...(membersNote ? { note: membersNote } : {}) },
    refs: { total: refsTotal, items: refItems, ...(refsNote ? { note: refsNote } : {}) },
    analysis: {
      targetDir,
      draft: draft
        ? {
          status: draft.status,
          conclusion: draft.conclusion ?? null,
          unconfirmed: Array.isArray(draft.unconfirmed) ? draft.unconfirmed : [],
          commit: draft.commit ?? null,
          startedAt: draft.startedAt,
          updatedAt: draft.updatedAt,
          ...(draft.errorCode ? { errorCode: draft.errorCode } : {}),
          ...(draft.errorMessage ? { errorMessage: draft.errorMessage } : {}),
        }
        : null,
      candidateTotal,
      ...(candidateNote ? { candidateNote } : {}),
      confirmed: {
        total: confirmedAll.length,
        items: confirmedItems,
        ...(confirmedNote ? { note: confirmedNote } : {}),
      },
    },
    logs: { total: logsAll.length, items: logItems, ...(logsNote ? { note: logsNote } : {}) },
  };
}
