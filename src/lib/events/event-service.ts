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
  readAllEvents, findEventIn, isEventClosed, writeEvent, removeEventFile,
  allocateShortId, newEventId,
} from './store.js';
import { appendStageLog, removeStageLog } from './stage-log.js';
import { getType, listTypes, resolveStageVisibility } from './type-service.js';
import type { EventRecord, EventTypeRecord, Visibility } from './types.js';
import type { Relation } from '../scoring.js';

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────
// 成员聚合（Relation.eventId 反向索引）
// ─────────────────────────────────────────────────────────────

export interface MemberDoc {
  group: string;
  name: string;
  relation: Relation;
}

/** 只读聚合：扫全部分片收集某事件的成员（单机低频，全量扫可接受） */
export function collectMembers(scope: string, eventId: string): MemberDoc[] {
  const out: MemberDoc[] = [];
  for (const [group, doc] of readAllGroupCaches(scope)) {
    for (const rel of doc.hot_relations) {
      if (rel.eventId === eventId) out.push({ group, name: rel.text, relation: rel });
    }
  }
  return out;
}

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
      if (status === 'open' && isEventClosed(e)) return false;
      if (status === 'closed' && !isEventClosed(e)) return false;
      if (opts.typeId && e.typeId !== opts.typeId) return false;
      if (q && !`${e.title} #${e.shortId}`.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

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
  typeId: string;
  /** 初始成员（可选） */
  docs?: Array<{ group: string; name: string }>;
  by?: 'user' | 'ai';
}

export async function createEvent(scope: string, input: CreateEventInput): Promise<EventRecord> {
  return withScopeWriteLock(scope, 'event-create', async () => {
    const title = input.title?.trim();
    if (!title) throw new GovernanceError('EVENT_NOT_FOUND', '事件标题不能为空');
    const type = getType(scope, input.typeId);
    if (!type) {
      throw new GovernanceError('TYPE_NOT_FOUND', `事件类型「${input.typeId}」不存在`, {
        available: listTypes(scope).map((t) => ({ id: t.id, name: t.name })),
      });
    }

    const now = Date.now();
    const event: EventRecord = {
      id: newEventId(now),
      shortId: allocateShortId(scope),
      scope,
      title,
      typeId: type.id,
      stageKey: type.stages[0].key,
      stageIndex: 0,
      closedAt: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    writeEvent(scope, event);
    appendStageLog(scope, { eventId: event.id, fromKey: null, toKey: event.stageKey, at: now, by: input.by ?? 'user' });

    if (input.docs?.length) bindDocs(scope, event, type, input.docs, now);

    return event;
  });
}

/** 把文档绑到事件：写 lifecycle=event + eventId，并清掉可能残留的期限字段 */
function bindDocs(
  scope: string,
  event: EventRecord,
  type: EventTypeRecord,
  docs: Array<{ group: string; name: string }>,
  now: number,
): void {
  const wanted = new Map<string, Set<string>>();
  for (const d of docs) {
    const set = wanted.get(d.group) ?? new Set<string>();
    set.add(d.name);
    wanted.set(d.group, set);
  }

  const touched = loadFullDocs(scope, [...wanted.keys()]);
  for (const [group, doc] of touched) {
    const names = wanted.get(group);
    if (!names) continue;
    for (const rel of doc.hot_relations) {
      if (!names.has(rel.text)) continue;
      rel.lifecycle = 'event';
      rel.eventId = event.id;
      delete rel.expiresAt;
      delete rel.ttlDays;
    }
  }
  if (touched.size > 0) writeGroupCacheBatch(scope, touched);

  const { visibility } = resolveStageVisibility(type, event.stageKey);
  enqueueVisibility(
    scope,
    [...wanted].flatMap(([group, names]) => [...names].map((relation) => ({ group, relation }))),
    visibility,
    now,
  );
}

export async function updateEventTitle(scope: string, eventRef: string, title: string, revision: number): Promise<EventRecord> {
  return withScopeWriteLock(scope, 'event-update', async () => {
    const event = mustFindEvent(scope, eventRef);
    if (event.revision !== revision) {
      throw new GovernanceError('REVISION_CONFLICT', `事件已被他人修改（当前版本 ${event.revision}）`, { currentRevision: event.revision });
    }
    const next: EventRecord = { ...event, title: title.trim() || event.title, revision: event.revision + 1, updatedAt: Date.now() };
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
      for (const m of groupMembers) {
        const moved = moveToTrash({
          scope, group, relation: m.name, reason: 'event-closed', now, relationSnapshot: m.relation,
        });
        if (moved.ok) done += 1;
        else failed += 1;
      }
      doc.hot_relations = doc.hot_relations.filter((r) => !(names.has(r.text) && r.eventId === event.id));
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
}

export interface DeleteEventOutcome {
  event: EventRecord;
  docAction: 'wiki' | 'trash';
  affected: { docs: number; failed: number };
  shortIdReleased: false;
}

export async function deleteEvent(scope: string, input: DeleteEventInput): Promise<DeleteEventOutcome> {
  return withScopeWriteLock(scope, 'event-delete', async () => {
    const event = mustFindEvent(scope, input.event);
    if (!isEventClosed(event)) {
      throw new GovernanceError(
        'EVENT_NOT_CLOSED',
        `事件「#${event.shortId} ${event.title}」尚未收口，不能删除；请先流转到终态阶段`,
        { stageKey: event.stageKey },
      );
    }
    if (!input.docAction) {
      throw new GovernanceError('DOC_ACTION_REQUIRED', '删除事件必须指定成员文档去向：wiki（改长期保留）或 trash（移入回收站）');
    }

    const now = Date.now();
    const members = collectMembers(scope, event.id);
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
        for (const m of groupMembers) {
          const moved = moveToTrash({ scope, group, relation: m.name, reason: 'event-closed', now, relationSnapshot: m.relation });
          if (moved.ok) done += 1;
          else failed += 1;
        }
        doc.hot_relations = doc.hot_relations.filter((r) => !(names.has(r.text) && r.eventId === event.id));
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

    return { event, docAction: input.docAction, affected: { docs: done, failed }, shortIdReleased: false };
  });
}

function removeRefsFile(scope: string, eventId: string): void {
  const p = path.join(getKbDir(scope), '.events', `${eventId}.refs.json`);
  try {
    fs.rmSync(p, { force: true });
  } catch { /* refs 由 S-05 维护，缺失不影响删除 */ }
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

function mustFindEvent(scope: string, ref: string): EventRecord {
  const event = findEventIn(readAllEvents(scope), ref);
  if (!event) {
    const available = readAllEvents(scope)
      .filter((e) => !isEventClosed(e))
      .slice(0, 5)
      .map((e) => ({ id: e.id, shortId: e.shortId, title: e.title }));
    throw new GovernanceError('EVENT_NOT_FOUND', `事件「${ref}」不存在`, { available });
  }
  return event;
}

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
