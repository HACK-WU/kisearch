/**
 * 事件服务（REQ-20261113-004 · S-02）
 *
 * 三条最容易做错的语义，都在这里兜住：
 *   1. **收口以 `closedAt` 为唯一权威**，不用「是否停在末位」推导 —— 拖动排序会改末位；
 *   2. **已收口事件禁止流转**（400 `EVENT_CLOSED`）：收口时成员文档已按终态动作处理
 *      （可能已进回收站），再流转会让"文档已不在、事件又活过来"；
 *   3. **终态处理的事务边界**：事件文件先落盘，再回写文档；文档失败不回滚事件，
 *      用 `docsPending` 暴露出待补偿条数（反序会出现"文档已改、事件未收口"，无法自愈）。
 *
 * 索引可见性不在本层：B3 只改元数据并把目标档位写进 `.visibility-pending.json`，
 * 由 B4 的 `visibility-queue` 消费（阶段切换要摘/建四类索引，属 S-03）。
 *
 * 读写分离的一个细节：只读聚合用 `readAllGroupCaches`（快，但不含 version/scope），
 * **写回必须用 `loadGroupCache` 拿完整 doc** —— 直接把只读聚合结果写回会丢字段。
 */

import fs from 'fs';
import path from 'path';
import { withScopeWriteLock } from '../scope-write-lock.js';
import { GovernanceError } from '../governance-errors.js';
import { loadGroupCache, listGroupPaths, readAllGroupCaches, writeGroupCacheBatch, type GroupCacheDoc } from '../group-cache.js';
import { getKbDir } from '../scope.js';
import { readJson, writeJson } from '../store.js';
import { moveToTrash } from '../trash-service.js';
import {
  readAllEvents, isEventClosed, isEventPinned, writeEvent, removeEventFile, mustFindEvent,
  allocateShortId, newEventId,
} from './store.js';
import { appendStageLog, removeStageLog } from './stage-log.js';
import { addRefDocs, readRefs, removeRefsFile } from './refs-store.js';
import { REF_LIMIT } from './refs-service.js';
import { bindMembersLocked, collectMembers, MEMBER_LIMIT, type BindMembersOutcome, type MemberDoc } from './members.js';
import { removeAnalysisFile } from './analysis-store.js';
import { removeAskFile } from './analysis-ask-store.js';
import { getType, listTypes, resolveStageVisibility } from './type-service.js';
import {
  EVENT_DESCRIPTION_MAX_CHARS,
  type EventRecord,
  type EventTypeRecord,
  type Visibility,
} from './types.js';
import type { Relation } from '../scoring.js';

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────
// 成员聚合（Relation.eventId 反向索引）
// ─────────────────────────────────────────────────────────────

/**
 * 成员聚合搬到 `events/members.ts`（与绑定/解绑同文件，避免职责分散）。
 * 这里保留 re-export：`governance-http`、`analysis-runner` 与既有测试都从这里取。
 */
export { collectMembers } from './members.js';
export type { MemberDoc } from './members.js';

/** 写回用：按组拿完整 doc（readAllGroupCaches 不含 version/scope，不能直接写回） */
function loadFullDocs(scope: string, groups: Iterable<string>): Map<string, GroupCacheDoc> {
  const docs = new Map<string, GroupCacheDoc>();
  for (const group of groups) {
    const doc = loadGroupCache(scope, group);
    if (doc) docs.set(group, doc);
  }
  return docs;
}

// ─────────────────────────────────────────────────────────────
// 列表
// ─────────────────────────────────────────────────────────────

export interface ListEventsOptions {
  status?: 'open' | 'closed' | 'all';
  typeId?: string;
  q?: string;
  limit?: number;
  offset?: number;
  /** 每个事件附带的文档名条数（默认 3 / 上限 10，R42 防无界返回） */
  docsPreviewLimit?: number;
  /**
   * 返回置顶事件时**是否越过状态 / 类型筛选**（2026-11-19，默认 false）。
   *
   * 为什么要显式开关而不是默认免疫：本函数被 MCP `ki_event_list` 复用，
   * AI 要的是「按条件筛出来的精确集合」，混进不在条件内的事件会污染推理。
   * 所以"免疫"是 UI 的展示诉求，只能由 Web 端显式开启。
   *
   * **关键词 `q` 任何情况下都不免疫** —— 搜索是主动找特定事件，
   * 硬塞一条不匹配的置顶项等于骗人。
   */
  includePinned?: boolean;
}

export interface EventListItemView {
  event: EventRecord;
  type: EventTypeRecord | null;
  stage: { key: string; name: string; index: number; visibility: Visibility };
  members: MemberDoc[];
  memberTotal: number;
  visibilitySummary: { full: number; ftsOnly: number; hidden: number };
}

export function listEvents(scope: string, opts: ListEventsOptions = {}): {
  items: EventListItemView[];
  total: number;
  hasMore: boolean;
} {
  const status = opts.status ?? 'open';
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const previewLimit = Math.min(Math.max(opts.docsPreviewLimit ?? 3, 1), 10);
  const q = (opts.q ?? '').trim().toLowerCase();

  // 成员只扫一次，全量事件共用
  const membersByEvent = new Map<string, MemberDoc[]>();
  for (const [group, doc] of readAllGroupCaches(scope)) {
    for (const rel of doc.hot_relations) {
      if (!rel.eventId) continue;
      const list = membersByEvent.get(rel.eventId) ?? [];
      list.push({ group, name: rel.text, relation: rel });
      membersByEvent.set(rel.eventId, list);
    }
  }

  const types = new Map<string, EventTypeRecord | null>();
  const all = readAllEvents(scope)
    .filter((e) => {
      /*
       * 置顶免疫（2026-11-19）：`includePinned` 由 Web 端显式开启 —— 用户要的是
       * 「无论切到哪个筛选，置顶那条都在」。**只豁免状态与类型**：
       * 关键词搜索照旧严格匹配，否则搜 A 却冒出无关的 B 会让人以为搜索坏了。
       */
      const pinnedBypass = opts.includePinned === true && isEventPinned(e);
      if (!pinnedBypass) {
        if (status === 'open' && isEventClosed(e)) return false;
        if (status === 'closed' && !isEventClosed(e)) return false;
        if (opts.typeId && e.typeId !== opts.typeId) return false;
      }
      if (q && !`${e.title} #${e.shortId}`.toLowerCase().includes(q)) return false;
      return true;
    })
    /*
     * 置顶区恒在普通区之上（区内按「最近置顶在上」），普通区沿用 `updatedAt` 降序。
     * 分页截断发生在这之后，所以置顶项不会被 `offset` 挤掉。
     */
    .sort((a, b) => {
      const aPinned = isEventPinned(a);
      const bPinned = isEventPinned(b);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (aPinned && bPinned) {
        const diff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
        if (diff !== 0) return diff;
      }
      return b.updatedAt - a.updatedAt;
    });

  const page = all.slice(offset, offset + limit).map((event) => {
    if (!types.has(event.typeId)) types.set(event.typeId, getType(scope, event.typeId));
    const type = types.get(event.typeId) ?? null;
    const { visibility } = resolveStageVisibility(type, event.stageKey);
    const members = membersByEvent.get(event.id) ?? [];
    const stageIdx = type?.stages.findIndex((s) => s.key === event.stageKey) ?? -1;
    return {
      event,
      type,
      stage: {
        key: event.stageKey,
        name: type?.stages[stageIdx]?.name ?? '(未知阶段)',
        index: stageIdx,
        visibility,
      },
      members: members.slice(0, previewLimit),
      memberTotal: members.length,
      visibilitySummary: summarizeVisibility(members.length, visibility),
    };
  });

  /*
   * `total` / `hasMore` 按**合并后**的集合算：`includePinned=true` 时它们包含
   * 被筛选豁免的置顶项（页面只取 limit=100 的当前页，不受影响；
   * 若将来有消费方拿 total 当"符合筛选的条数"，需另给一个 `matchedTotal`）。
   */
  return { items: page, total: all.length, hasMore: offset + page.length < all.length };
}

/** 同一事件的全部成员共享该事件当前阶段的可见性，故按成员数直接归类 */
function summarizeVisibility(memberTotal: number, visibility: Visibility): { full: number; ftsOnly: number; hidden: number } {
  if (visibility === 'full') return { full: memberTotal, ftsOnly: 0, hidden: 0 };
  if (visibility === 'fts-only') return { full: 0, ftsOnly: memberTotal, hidden: 0 };
  return { full: 0, ftsOnly: 0, hidden: memberTotal };
}

// ─────────────────────────────────────────────────────────────
// 创建 / 改名
// ─────────────────────────────────────────────────────────────

export interface CreateEventInput {
  title: string;
  /** 可选事件描述（REQ-20261113-003 · S-03） */
  description?: string;
  typeId: string;
  /**
   * 起始阶段 key（可选，缺省 = 首阶段）。
   * 必须是该类型已定义且**未停用**的阶段——前端弹窗有「起始阶段」选择，
   * 若这里不认这个参数，UI 的选择会被静默丢弃（事件落在首阶段，可能是 hidden）。
   */
  stageKey?: string;
  /** 初始成员（可选） */
  docs?: Array<{ group: string; name: string }>;
  /** 初始参考文档（可选）：只建立引用，不改被引文档的分类与可见性 */
  refs?: Array<{ group: string; name: string }>;
  by?: 'user' | 'ai';
}

/** 创建事件的完整结果（HTTP / MCP 需要一次性拿到绑定报告） */
export interface CreateEventOutcome {
  event: EventRecord;
  binding: {
    docs: {
      bound: BindMembersOutcome['bound'];
      skipped: BindMembersOutcome['skipped'];
      failed: BindMembersOutcome['failed'];
      visibilityFailed: BindMembersOutcome['visibilityFailed'];
    };
    refs: {
      added: number;
      addedList: Array<{ group: string; name: string }>;
      skipped: Array<{ group: string; name: string; reason: 'duplicate' | 'already-associated' }>;
      failed: Array<{ group: string; name: string; code: string; error: string }>;
    };
  };
  visibility: { mode: Visibility; dense: boolean; fts: boolean };
  pending: BindMembersOutcome['pending'];
}

function normalizeEventDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length > EVENT_DESCRIPTION_MAX_CHARS) {
    throw new GovernanceError(
      'EVENT_DESCRIPTION_TOO_LONG',
      `事件描述不得超过 ${EVENT_DESCRIPTION_MAX_CHARS} 字，实际 ${trimmed.length} 字`,
    );
  }
  return trimmed || undefined;
}

/** 兼容入口：只要事件记录（既有测试与内部调用大量依赖这个形状） */
export async function createEvent(scope: string, input: CreateEventInput): Promise<EventRecord> {
  return (await createEventWithBinding(scope, input)).event;
}

/**
 * 创建事件并一次性完成文档绑定（HTTP / MCP 用）。
 *
 * 事务顺序固定为「事件落盘 → 绑关联文档（同一把锁，调用 locked 版）→ 参考文档」：
 * 文档侧失败不回滚事件，用 `binding.*.failed` 暴露待补偿项 —— 与 `transitionEvent` /
 * `deleteEvent` 的事务边界保持一致（反序会出现"文档已改、事件没建"的死局）。
 */
export async function createEventWithBinding(
  scope: string,
  input: CreateEventInput,
): Promise<CreateEventOutcome> {
  return withScopeWriteLock(scope, 'event-create', async () => {
    const title = input.title?.trim();
    if (!title) throw new GovernanceError('EVENT_NOT_FOUND', '事件标题不能为空');
    const description = normalizeEventDescription(input.description);
    const type = getType(scope, input.typeId);
    if (!type) {
      throw new GovernanceError('TYPE_NOT_FOUND', `事件类型「${input.typeId}」不存在`, {
        available: listTypes(scope).map((t) => ({ id: t.id, name: t.name })),
      });
    }

    /**
     * 起始阶段：缺省首阶段；指定时必须存在且未停用。
     * `stage` 既接受 key（st_3）也接受阶段名（已定位）—— MCP 工具让 AI 直接传名称，
     * 少一次 `ki_event_type_list` 往返，也避免它抄错 key。
     */
    const stageRef = input.stageKey?.trim();
    const startIndex = stageRef
      ? type.stages.findIndex((s) => s.key === stageRef || s.name === stageRef)
      : 0;
    if (startIndex < 0) {
      throw new GovernanceError('STAGE_NOT_FOUND', `阶段「${input.stageKey}」不在类型「${type.name}」中`, {
        available: type.stages.map((s) => ({ key: s.key, name: s.name, disabled: s.disabled === true })),
      });
    }
    const startStage = type.stages[startIndex];
    if (startStage.disabled) {
      throw new GovernanceError('STAGE_DISABLED', `阶段「${startStage.name}」已停用，不能作为新事件的起始阶段`, {
        available: type.stages.filter((s) => !s.disabled).map((s) => ({ key: s.key, name: s.name })),
      });
    }

    const refs = input.refs ?? [];
    const docsInput = input.docs ?? [];
    // 两类上限都在事件落盘前判：否则会留下"事件建成、文档全没加"的半成品
    // （bindMembersLocked 的超限是整批抛错，落盘后抛等于事件已建但接口报错）
    if (docsInput.length > MEMBER_LIMIT) {
      throw new GovernanceError(
        'EVENT_MEMBER_LIMIT_EXCEEDED',
        `单个事件最多 ${MEMBER_LIMIT} 篇关联文档（本次 ${docsInput.length} 篇），事件未创建`,
        { limit: MEMBER_LIMIT, requested: docsInput.length },
      );
    }
    if (refs.length > REF_LIMIT) {
      throw new GovernanceError(
        'REF_LIMIT_EXCEEDED',
        `单个事件最多 ${REF_LIMIT} 条参考文档（本次 ${refs.length} 条），事件未创建`,
        { limit: REF_LIMIT, requested: refs.length },
      );
    }

    const now = Date.now();
    const event: EventRecord = {
      id: newEventId(now),
      shortId: allocateShortId(scope),
      scope,
      title,
      ...(description !== undefined ? { description } : {}),
      typeId: type.id,
      stageKey: startStage.key,
      stageIndex: startIndex,
      closedAt: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    writeEvent(scope, event);
    appendStageLog(scope, { eventId: event.id, fromKey: null, toKey: event.stageKey, at: now, by: input.by ?? 'user' });

    // 关联文档：同一把锁内调 locked 版（抢锁版会重入）
    const docsResult = await bindMembersLocked(scope, event, { docs: input.docs ?? [], by: input.by });

    // 参考文档：交集记为 skipped（不改 addRefs 的抛错语义）
    const memberKeys = new Set(collectMembers(scope, event.id).map((m) => `${m.group}\u0000${m.name}`));
    const refSkip: Array<{ group: string; name: string; reason: 'duplicate' | 'already-associated' }> = [];
    const refFailed: Array<{ group: string; name: string; code: string; error: string }> = [];
    const refWanted: Array<{ group: string; name: string }> = [];
    const refSeen = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.group}\u0000${ref.name}`;
      if (memberKeys.has(key)) {
        refSkip.push({ ...ref, reason: 'already-associated' });
        continue;
      }
      if (refSeen.has(key)) {
        refSkip.push({ ...ref, reason: 'duplicate' });
        continue;
      }
      refSeen.add(key);
      refWanted.push(ref);
    }

    let refsAdded = 0;
    const refsAddedList: Array<{ group: string; name: string }> = [];
    if (refWanted.length > 0) {
      const existing = readRefs(scope, event.id).length;
      if (existing + refWanted.length > REF_LIMIT) {
        for (const ref of refWanted) {
          refFailed.push({
            ...ref,
            code: 'REF_LIMIT_EXCEEDED',
            error: `单个事件最多 ${REF_LIMIT} 条参考文档（已有 ${existing} 条）`,
          });
        }
      } else {
        const written = addRefDocs(
          scope,
          event.id,
          refWanted.map((ref) => ({
            scope,
            group: ref.group,
            name: ref.name,
            addedBy: input.by === 'ai' ? ('ai' as const) : ('manual' as const),
            addedAt: now,
          })),
          now,
        );
        refsAdded = written.added.length;
        for (const doc of written.added) refsAddedList.push({ group: doc.group, name: doc.name });
        for (const dup of written.skipped) {
          refSkip.push({ group: dup.group, name: dup.name, reason: 'duplicate' });
        }
      }
    }

    return {
      event: docsResult.event.updatedAt === now ? docsResult.event : { ...event, updatedAt: now },
      binding: {
        docs: {
          bound: docsResult.bound,
          skipped: docsResult.skipped,
          failed: docsResult.failed,
          visibilityFailed: docsResult.visibilityFailed,
        },
        refs: { added: refsAdded, addedList: refsAddedList, skipped: refSkip, failed: refFailed },
      },
      visibility: docsResult.visibility,
      pending: docsResult.pending,
    };
  });
}

export async function updateEvent(
  scope: string,
  eventRef: string,
  patch: { title?: string; description?: string; revision: number },
): Promise<EventRecord> {
  return withScopeWriteLock(scope, 'event-update', async () => {
    const event = mustFindEvent(scope, eventRef);
    if (event.revision !== patch.revision) {
      throw new GovernanceError('REVISION_CONFLICT', `事件已被他人修改（当前版本 ${event.revision}）`, { currentRevision: event.revision });
    }
    const nextTitle = patch.title !== undefined ? (patch.title.trim() || event.title) : event.title;
    const nextDesc = patch.description !== undefined
      ? normalizeEventDescription(patch.description)
      : event.description;
    const next: EventRecord = {
      ...event,
      title: nextTitle,
      revision: event.revision + 1,
      updatedAt: Date.now(),
    };
    if (nextDesc !== undefined) next.description = nextDesc;
    else delete next.description;
    writeEvent(scope, next);
    return next;
  });
}

export async function updateEventTitle(scope: string, eventRef: string, title: string, revision: number): Promise<EventRecord> {
  return updateEvent(scope, eventRef, { title, revision });
}

/**
 * 置顶 / 取消置顶（2026-11-19）。
 *
 * 三条刻意的取舍：
 *   1. **幂等**：已在目标态直接返回，不报错 —— 按钮连点两次不该出红条；
 *   2. **不动 `revision` / `updatedAt`**：置顶是列表偏好，不是内容变更。
 *      碰 `revision` 会让正在编辑描述的人莫名 409；碰 `updatedAt` 会改
 *      「最近更新」排序，让人以为事件被人动过；
 *   3. 取消置顶是**删字段**（不是写 0）：`pinnedAt === undefined` 才是唯一权威的"未置顶"。
 *
 * 与 `updateEvent` 分开而不是加进它的 patch：那条路径的错误码/乐观锁语义
 * （`REVISION_CONFLICT`）已被前端与 MCP 依赖，塞进一个不需要 revision 的开关会把它搅浑。
 */
export async function setEventPinned(scope: string, eventRef: string, pinned: boolean): Promise<EventRecord> {
  return withScopeWriteLock(scope, 'event-pin', async () => {
    const event = mustFindEvent(scope, eventRef);
    if (isEventPinned(event) === pinned) return event;
    const next: EventRecord = { ...event };
    if (pinned) next.pinnedAt = Date.now();
    else delete next.pinnedAt;
    writeEvent(scope, next);
    return next;
  });
}

// ─────────────────────────────────────────────────────────────
// 流转（唯一状态写入口）
// ─────────────────────────────────────────────────────────────

export interface TransitionInput {
  event: string;
  /** 目标阶段：key（st_3）或阶段名（已定位），二者都收 */
  stage: string;
  note?: string;
  by?: 'user' | 'ai';
}

export interface TransitionOutcome {
  event: EventRecord;
  from: { key: string; name: string; index: number };
  to: { key: string; name: string; index: number };
  closed: boolean;
  affected: { docs: number; failed: number };
  visibility: { mode: Visibility; dense: boolean; fts: boolean };
  pending: string[];
  logWarning: string | null;
  terminalAction?: 'keep' | 'trash';
}

export async function transitionEvent(scope: string, input: TransitionInput): Promise<TransitionOutcome> {
  return withScopeWriteLock(scope, 'event-transition', async () => {
    const event = mustFindEvent(scope, input.event);
    if (isEventClosed(event)) {
      throw new GovernanceError(
        'EVENT_CLOSED',
        `事件「#${event.shortId} ${event.title}」已收口，不能再流转；如需重新开始请用「重新打开」`,
        { closedAt: event.closedAt },
      );
    }

    const type = getType(scope, event.typeId);
    if (!type) {
      throw new GovernanceError('TYPE_NOT_FOUND', `事件所属类型「${event.typeId}」已不存在`, {
        hint: '类型被删除后事件无法流转，请先在页面恢复类型或把文档改绑其他事件',
      });
    }

    const targetIdx = type.stages.findIndex((s) => s.key === input.stage || s.name === input.stage);
    if (targetIdx < 0) {
      throw new GovernanceError('STAGE_NOT_FOUND', `阶段「${input.stage}」不在类型「${type.name}」中`, {
        available: type.stages.map((s, i) => ({ key: s.key, name: s.name, index: i })),
      });
    }
    const target = type.stages[targetIdx];
    if (target.disabled) {
      throw new GovernanceError('STAGE_DISABLED', `阶段「${target.name}」已停用，不能进入`);
    }
    if (target.key === event.stageKey) {
      throw new GovernanceError('STAGE_UNCHANGED', `事件已在阶段「${target.name}」`, { stageKey: target.key });
    }

    const now = Date.now();
    const isTerminal = targetIdx === type.stages.length - 1;
    const next: EventRecord = {
      ...event,
      stageKey: target.key,
      stageIndex: targetIdx,
      closedAt: isTerminal ? now : event.closedAt,
      revision: event.revision + 1,
      updatedAt: now,
    };

    // 事务边界：事件先落盘，再回写文档（文档失败不回滚事件）
    writeEvent(scope, next);

    const members = collectMembers(scope, next.id);
    const affected = isTerminal
      ? applyTerminalAction(scope, next, type, members, now)
      : { docs: members.length, failed: 0 };

    // 索引档位交给 B4：这里只登记目标
    enqueueVisibility(scope, members.map((m) => ({ group: m.group, relation: m.name })), target.visibility, now);

    const logged = appendStageLog(scope, {
      eventId: next.id,
      fromKey: event.stageKey,
      toKey: target.key,
      at: now,
      by: input.by ?? 'user',
      ...(input.note ? { note: input.note } : {}),
      status: 'committed',
    });

    const currentIdx = type.stages.findIndex((s) => s.key === event.stageKey);
    return {
      event: next,
      from: { key: event.stageKey, name: type.stages[currentIdx]?.name ?? '(未知)', index: currentIdx },
      to: { key: target.key, name: target.name, index: targetIdx },
      closed: isTerminal,
      affected,
      visibility: visibilityToFlags(target.visibility),
      pending: target.visibility === 'full' ? ['dense', 'fts', 'relation', 'path'] : [],
      logWarning: logged.warning ?? null,
      ...(isTerminal ? { terminalAction: type.terminalAction } : {}),
    };
  });
}

function visibilityToFlags(mode: Visibility): { mode: Visibility; dense: boolean; fts: boolean } {
  return { mode, dense: mode === 'full', fts: mode !== 'hidden' };
}

/**
 * 终态动作（`terminalAction` 是**类型级**，不挂阶段）。
 *   keep  → 文档改 wiki、清绑定（继续可检索）
 *   trash → 文档入回收站并从分片移除（回收站里的文档不该继续出现在知识库）
 */
function applyTerminalAction(
  scope: string,
  event: EventRecord,
  type: EventTypeRecord,
  members: MemberDoc[],
  now: number,
): { docs: number; failed: number } {
  if (members.length === 0) return { docs: 0, failed: 0 };

  const byGroup = new Map<string, MemberDoc[]>();
  for (const m of members) {
    const list = byGroup.get(m.group) ?? [];
    list.push(m);
    byGroup.set(m.group, list);
  }
  const docs = loadFullDocs(scope, byGroup.keys());
  let done = 0;
  let failed = 0;

  for (const [group, groupMembers] of byGroup) {
    const doc = docs.get(group);
    if (!doc) continue;
    const names = new Set(groupMembers.map((m) => m.name));

    if (type.terminalAction === 'trash') {
      /**
       * REQ-20261116-006（R8）：**数据源成员不搬回收站，改为 wiki**。
       * 它的正文由源侧文件托管：搬走后源文件还在，下次同步会重新导入，
       * 形成「回收站里有条目 + 检索又能命中」并存，比不清理更糟。
       * 与 `deleteEvent` 的同名分支必须保持同一口径（两处是终态动作仅有的出口）。
       */
      for (const m of groupMembers) {
        if (m.relation.isImported === true) continue;
        const moved = moveToTrash({
          scope, group, relation: m.name, reason: 'event-closed', now, relationSnapshot: m.relation,
        });
        if (moved.ok) done += 1;
        else failed += 1;
      }
      for (const rel of doc.hot_relations) {
        if (!names.has(rel.text) || rel.eventId !== event.id || rel.isImported !== true) continue;
        // 数据源成员：清掉分类即回 wiki，正文与索引都不动
        delete rel.lifecycle;
        delete rel.eventId;
        delete rel.expiresAt;
        delete rel.ttlDays;
        done += 1;
      }
      /**
       * 摘除口径**保持原样**（成员一律脱离该事件），只对 R8 的数据源成员开例外。
       * 刻意不改成「只摘真正进站的那些」：那会让 moveToTrash 失败（如读不到正文）的普通成员
       * 留在已收口事件上，挂着指向收口事件的悬空 `eventId`，还可能被终态阶段的档位判成
       * hidden —— 文档从"库里没有"变成"在库里但看不见"，更难排查。
       */
      doc.hot_relations = doc.hot_relations.filter(
        (r) => !(names.has(r.text) && r.eventId === event.id && r.isImported !== true),
      );
    } else {
      for (const rel of doc.hot_relations) {
        if (rel.eventId !== event.id) continue;
        delete rel.lifecycle;
        delete rel.eventId;
        delete rel.expiresAt;
        delete rel.ttlDays;
        done += 1;
      }
    }
  }

  if (docs.size > 0) writeGroupCacheBatch(scope, docs);
  return { docs: done, failed };
}

// ─────────────────────────────────────────────────────────────
// 删除 / 重新打开
// ─────────────────────────────────────────────────────────────

export interface DeleteEventInput {
  event: string;
  /** 成员文档去向：改长期保留 / 移入回收站（必选，无默认） */
  docAction?: 'wiki' | 'trash';
  /**
   * 强制删除**未收口**事件（默认 false）。定位是清理测试 / 废弃事件。
   *
   * 只对**无关联文档**的事件开放，原因是三个副作用都落在本项目出过事故的区域：
   *   · 未收口事件的成员多半处于 hidden / fts-only，删除后要恢复可见性 → 得改索引；
   *   · `trash` 去向要搬回收站，而 `moveToTrash` 只写回收站条目、不摘索引；
   *   · 可见性与索引一旦不同步，就是「hidden 仍可召回」那一类静默故障。
   * 有成员的场景有明确出路：先 `ki_event_docs remove` 解绑（文档回 wiki），再强制删；
   * 或走正常收口（`applyTerminalAction` 会把文档与索引一起处理）。
   */
  force?: boolean;
  /** `force` 时必填，且须与事件标题完全一致 —— 逼调用方先读出这条事件的标题 */
  confirmTitle?: string;
}

export interface DeleteEventOutcome {
  event: EventRecord;
  docAction: 'wiki' | 'trash';
  affected: { docs: number; failed: number };
  /** 本次是否为强制删除未收口事件 */
  forced: boolean;
  shortIdReleased: false;
}

export async function deleteEvent(scope: string, input: DeleteEventInput): Promise<DeleteEventOutcome> {
  return withScopeWriteLock(scope, 'event-delete', async () => {
    const event = mustFindEvent(scope, input.event);
    const closed = isEventClosed(event);
    const members = collectMembers(scope, event.id);

    if (!closed) {
      if (!input.force) {
        throw new GovernanceError(
          'EVENT_NOT_CLOSED',
          `事件「#${event.shortId} ${event.title}」尚未收口，不能删除；请先流转到终态阶段，或（仅清理测试/废弃事件）传 force 与 confirm_title`,
          { stageKey: event.stageKey, title: event.title, shortId: `#${event.shortId}` },
        );
      }
      if (!input.confirmTitle) {
        throw new GovernanceError(
          'EVENT_FORCE_CONFIRM_REQUIRED',
          `强制删除未收口事件必须传 confirm_title，且与事件标题完全一致：「#${event.shortId} ${event.title}」`,
          { title: event.title, shortId: `#${event.shortId}` },
        );
      }
      // 两边都 trim：标题若带首尾空格，只 trim 一侧会让它永远匹配不上（死锁，没有别的出路）
      if (input.confirmTitle.trim() !== event.title.trim()) {
        throw new GovernanceError(
          'EVENT_FORCE_CONFIRM_MISMATCH',
          `confirm_title 与事件标题不一致：该 #${event.shortId} 的实际标题是「${event.title}」；未删除任何数据`,
          { title: event.title, shortId: `#${event.shortId}` },
        );
      }
      if (members.length > 0) {
        throw new GovernanceError(
          'EVENT_FORCE_NOT_EMPTY',
          `事件「#${event.shortId} ${event.title}」还有 ${members.length} 篇关联文档，force 只用于清理空事件；`
            + '请先 ki_event_docs remove 解绑（文档回长期保留），或走正常收口后再删',
          { members: members.length },
        );
      }
    }
    if (!input.docAction) {
      throw new GovernanceError('DOC_ACTION_REQUIRED', '删除事件必须指定成员文档去向：wiki（改长期保留）或 trash（移入回收站）');
    }

    const now = Date.now();
    const byGroup = new Map<string, MemberDoc[]>();
    for (const m of members) {
      const list = byGroup.get(m.group) ?? [];
      list.push(m);
      byGroup.set(m.group, list);
    }
    const docs = loadFullDocs(scope, byGroup.keys());
    let done = 0;
    let failed = 0;

    for (const [group, groupMembers] of byGroup) {
      const doc = docs.get(group);
      if (!doc) continue;
      const names = new Set(groupMembers.map((m) => m.name));
      if (input.docAction === 'trash') {
        /**
         * REQ-20261116-006（R8）：与 `applyTerminalAction` 同一口径 ——
         * 数据源成员不搬回收站（源文件仍在，下次同步必复活），改为清空分类回 wiki。
         */
        for (const m of groupMembers) {
          if (m.relation.isImported === true) continue;
          const moved = moveToTrash({ scope, group, relation: m.name, reason: 'event-closed', now, relationSnapshot: m.relation });
          if (moved.ok) done += 1;
          else failed += 1;
        }
        for (const rel of doc.hot_relations) {
          if (!names.has(rel.text) || rel.eventId !== event.id || rel.isImported !== true) continue;
          delete rel.lifecycle;
          delete rel.eventId;
          delete rel.expiresAt;
          delete rel.ttlDays;
          done += 1;
        }
        // 摘除口径与 `applyTerminalAction` 同源：成员一律脱离该事件，只给数据源成员开例外
        doc.hot_relations = doc.hot_relations.filter(
          (r) => !(names.has(r.text) && r.eventId === event.id && r.isImported !== true),
        );
      } else {
        for (const rel of doc.hot_relations) {
          if (rel.eventId !== event.id) continue;
          delete rel.lifecycle;
          delete rel.eventId;
          delete rel.expiresAt;
          delete rel.ttlDays;
          done += 1;
        }
      }
    }
    if (docs.size > 0) writeGroupCacheBatch(scope, docs);

    removeEventFile(scope, event.id);
    removeStageLog(scope, event.id);
    removeRefsFile(scope, event.id);
    removeAnalysisFile(scope, event.id);

    return { event, docAction: input.docAction, affected: { docs: done, failed }, forced: !closed, shortIdReleased: false };
  });
}

export interface ReopenOutcome {
  event: EventRecord;
  membersRestored: 0;
  hint: string;
}

/**
 * 重新打开已收口事件。
 *
 * **不自动恢复文档绑定**：收口时成员已按终态动作处理（可能已进回收站甚至已清理），
 * 反向恢复要重建索引且可能捞不回原文。重开后事件是空壳，成员需重新绑定 —— UI 必须明示。
 */
export async function reopenEvent(scope: string, eventRef: string): Promise<ReopenOutcome> {
  return withScopeWriteLock(scope, 'event-reopen', async () => {
    const event = mustFindEvent(scope, eventRef);
    if (!isEventClosed(event)) {
      throw new GovernanceError('STAGE_UNCHANGED', `事件「#${event.shortId}」尚未收口，无需重新打开`);
    }
    const type = getType(scope, event.typeId);
    const first = type?.stages[0];
    if (!type || !first) {
      throw new GovernanceError('TYPE_NOT_FOUND', `事件所属类型「${event.typeId}」已不存在，无法重开`);
    }
    const now = Date.now();
    const next: EventRecord = {
      ...event,
      stageKey: first.key,
      stageIndex: 0,
      closedAt: null,
      revision: event.revision + 1,
      updatedAt: now,
    };
    writeEvent(scope, next);
    appendStageLog(scope, {
      eventId: next.id,
      fromKey: event.stageKey,
      toKey: first.key,
      at: now,
      by: 'user',
      note: '重新打开（成员需重新绑定）',
      status: 'committed',
    });
    return { event: next, membersRestored: 0, hint: '事件已重开，成员文档需重新绑定（收口时已按终态动作处理）' };
  });
}

// ─────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────

/** 查找 + 抛错收敛到 `store.ts::mustFindEvent`（三处业务模块共用，避免各写一份） */

/**
 * 把目标档位登记进 `.visibility-pending.json`（B4 的 visibility-queue 消费）。
 *
 * B3 不摘/建索引：那要按 3×3 矩阵处理四类索引（S-03），与档位切换是同一份代码。
 * 先登记后消费，B4 上线时不用改本文件。
 */
function enqueueVisibility(
  scope: string,
  items: Array<{ group: string; relation: string }>,
  visibility: Visibility,
  now: number,
): void {
  if (items.length === 0) return;
  const filePath = path.join(getKbDir(scope), '.visibility-pending.json');
  try {
    const current = readJson<{ version: 1; items: Array<Record<string, unknown>> }>(filePath);
    const next = Array.isArray(current?.items) ? current!.items : [];
    const kinds = visibility === 'hidden'
      ? ['dense', 'fts', 'relation']
      : visibility === 'fts-only'
        ? ['dense']
        : ['dense', 'fts', 'relation', 'path'];
    for (const item of items) {
      const idx = next.findIndex((i) => i.relation === item.relation && i.group === item.group);
      const entry = {
        relation: item.relation,
        group: item.group,
        target: visibility,
        kinds,
        createdAt: now,
        attempts: 0,
      };
      if (idx >= 0) next[idx] = entry;
      else next.push(entry);
    }
    writeJson(filePath, { version: 1, items: next } as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn(`[events] 登记索引档位失败：${(err as Error).message}`);
  }
}
