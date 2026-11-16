/**
 * 事件成员（关联文档）的绑定 / 解绑（REQ-20261116-004 · S-01）
 *
 * 为什么单独成文件：`event-service.ts` 承担事件状态机（创建 / 流转 / 收口 / 删除），
 * 已近 700 行；成员语义（校验 + 档位切换）与状态机没有共用状态，混在一起会让两者都难测。
 *
 * 三条硬约束都在本层兜住（页面 / HTTP / MCP / CLI 四个入口共用）：
 *   1. **归属冲突、数据源锁、上限**必须拦在服务层 —— 只在 HTTP 层拦等于给 MCP 留后门；
 *   2. **绑定/解绑必须走 `applyVisibility*`**（唯一出口）：摘除是语义正确性要求，
 *      只入队不摘除会让 hidden 阶段的文档继续被 `ki_search` 召回；
 *   3. **`createEvent` 已持 scope 写锁，只能调 `bindMembersLocked`** ——
 *      抢锁版在同 scope 内重入会排队到 `lock_timeout` 后失败。
 */

import { withScopeWriteLock } from '../scope-write-lock.js';
import { GovernanceError } from '../governance-errors.js';
import {
  loadGroupCache, writeGroupCache, writeGroupCacheBatch,
  readAllGroupCaches, type GroupCacheDoc,
} from '../group-cache.js';
import { findEventIn, isEventClosed, readAllEvents, writeEvent } from './store.js';
import { getType, resolveStageVisibility } from './type-service.js';
import { precheckLifecycle } from '../relation-lifecycle.js';
import {
  applyVisibility, applyVisibilityBatch, resolveVisibilityBatch, resolveVisibilityOfRelation,
  type IndexKind,
} from '../visibility-index.js';
import type { Relation } from '../scoring.js';
import type { EventRecord, Visibility } from './types.js';

/** 单事件关联文档上限（与 `REF_LIMIT` 对齐，避免返回体无界） */
export const MEMBER_LIMIT = 50;

export interface MemberRef {
  group: string;
  name: string;
}

export interface MemberDoc {
  group: string;
  name: string;
  relation: Relation;
}

export type MemberSkipReason = 'already-bound' | 'duplicate-in-request';

export interface MemberSkip extends MemberRef {
  reason: MemberSkipReason;
}

export interface MemberFailure extends MemberRef {
  code: string;
  error: string;
}

export interface MemberVisibilityFailure extends MemberRef {
  kind: IndexKind;
  error: string;
}

export interface BindMembersInput {
  docs: MemberRef[];
  by?: 'user' | 'ai';
}

export interface BindMembersOutcome {
  event: EventRecord;
  visibility: { mode: Visibility; dense: boolean; fts: boolean };
  bound: MemberRef[];
  skipped: MemberSkip[];
  failed: MemberFailure[];
  /** 已绑定成功但索引摘除失败（文档仍可能被检索到）——调用方必须透出 */
  visibilityFailed: MemberVisibilityFailure[];
  pending: IndexKind[];
}

export interface UnbindMemberOutcome {
  event: EventRecord;
  removed: MemberRef;
  lifecycle: 'wiki';
  visibility: { mode: 'full'; dense: true; fts: true };
  pending: IndexKind[];
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

function visibilityFlags(mode: Visibility): { mode: Visibility; dense: boolean; fts: boolean } {
  return { mode, dense: mode === 'full', fts: mode !== 'hidden' };
}

function mustFindEvent(scope: string, ref: string): EventRecord {
  const events = readAllEvents(scope);
  const event = findEventIn(events, ref);
  if (!event) {
    const available = events
      .filter((e) => !isEventClosed(e))
      .slice(0, 5)
      .map((e) => ({ id: e.id, shortId: e.shortId, title: e.title }));
    throw new GovernanceError('EVENT_NOT_FOUND', `事件「${ref}」不存在`, { available });
  }
  return event;
}

/** `docs` 入参归一化：缺失 / 非数组 / 元素不合法 → `EVENT_DOCS_INVALID`；空数组合法 */
function normalizeDocs(raw: unknown): MemberRef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new GovernanceError('EVENT_DOCS_INVALID', 'docs 必须是数组（[{ group, name }]）');
  }
  const out: MemberRef[] = [];
  for (const item of raw) {
    const group = typeof item?.group === 'string' ? item.group.trim() : '';
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!group || !name) {
      throw new GovernanceError('EVENT_DOCS_INVALID', 'docs 的每一项都必须包含非空的 group 与 name', {
        item: { group: item?.group ?? null, name: item?.name ?? null },
      });
    }
    out.push({ group, name });
  }
  return out;
}

/** 抢锁版：页面 / HTTP / MCP 入口用 */
export async function bindMembers(
  scope: string,
  eventRef: string,
  input: BindMembersInput,
): Promise<BindMembersOutcome> {
  return withScopeWriteLock(scope, 'event-update', async () => {
    const event = mustFindEvent(scope, eventRef);
    return bindMembersLocked(scope, event, input);
  });
}

/**
 * 不加锁版：调用方必须已持 scope 写锁（`createEvent`、`bindMembers`）。
 *
 * 所有校验先跑完再落盘，保证"一批里 3 篇成功 1 篇冲突"能给出完整报告。
 */
export async function bindMembersLocked(
  scope: string,
  event: EventRecord,
  input: BindMembersInput,
): Promise<BindMembersOutcome> {
  if (isEventClosed(event)) {
    throw new GovernanceError(
      'EVENT_CLOSED',
      `事件「#${event.shortId} ${event.title}」已收口，不能新增关联文档；如需继续请先「重新打开」`,
      { closedAt: event.closedAt },
    );
  }
  const type = getType(scope, event.typeId);
  if (!type) {
    throw new GovernanceError('TYPE_NOT_FOUND', `事件所属类型「${event.typeId}」已不存在，无法绑定文档`, {
      hint: '类型被删除后事件无法绑定文档，请先在页面恢复类型或改绑其他事件',
    });
  }

  const docs = normalizeDocs(input.docs);
  const now = Date.now();
  const to = resolveStageVisibility(type, event.stageKey).visibility;

  const members = collectMembers(scope, event.id);
  const memberKeys = new Set(members.map((m) => `${m.group}\u0000${m.name}`));

  // ── 去重 + 幂等（skipped）──────────────────────────────
  const skipped: MemberSkip[] = [];
  const wanted: MemberRef[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const key = `${doc.group}\u0000${doc.name}`;
    if (seen.has(key)) {
      skipped.push({ ...doc, reason: 'duplicate-in-request' });
      continue;
    }
    seen.add(key);
    if (memberKeys.has(key)) {
      skipped.push({ ...doc, reason: 'already-bound' });
      continue;
    }
    wanted.push(doc);
  }

  // ── 批次前置 A3：上限（整批拒绝，不截断）────────────────
  if (members.length + wanted.length > MEMBER_LIMIT) {
    throw new GovernanceError(
      'EVENT_MEMBER_LIMIT_EXCEEDED',
      `单个事件最多 ${MEMBER_LIMIT} 篇关联文档（当前 ${members.length} 篇，本次 ${wanted.length} 篇），本次未执行`,
      { limit: MEMBER_LIMIT, current: members.length, requested: wanted.length },
    );
  }

  if (wanted.length === 0) {
    return {
      event,
      visibility: visibilityFlags(to),
      bound: [],
      skipped,
      failed: [],
      visibilityFailed: [],
      pending: [],
    };
  }

  // ── 逐条校验 B1~B5 ────────────────────────────────────
  const events = readAllEvents(scope);
  const byGroup = new Map<string, GroupCacheDoc>();
  for (const doc of wanted) {
    if (byGroup.has(doc.group)) continue;
    const cache = loadGroupCache(scope, doc.group);
    if (cache) byGroup.set(doc.group, cache);
  }

  // `from` 必须在改字段前算：改完再算会把自己算成新档位
  const fromMap = resolveVisibilityBatch(
    scope,
    wanted.map((d) => ({ group: d.group, relation: d.name })),
  );

  const failed: MemberFailure[] = [];
  const accepted: Array<{ ref: MemberRef; rel: Relation; from: Visibility }> = [];
  const touchedGroups = new Set<string>();

  for (const doc of wanted) {
    const cache = byGroup.get(doc.group);
    const rel = cache?.hot_relations.find((r) => r.text === doc.name);
    if (!cache || !rel) {
      failed.push({ ...doc, code: 'DOC_NOT_FOUND', error: `文档不存在：${doc.group}/${doc.name}` });
      continue;
    }
    const check = precheckLifecycle({
      scope,
      group: doc.group,
      relation: doc.name,
      existing: rel,
      locked: rel.isImported === true,
      lifecycle: 'event',
      eventId: event.id,
      now,
      events,
    });
    if (!check.ok) {
      failed.push({ ...doc, code: check.code, error: check.message });
      continue;
    }
    accepted.push({
      ref: doc,
      rel,
      from: fromMap.get(`${doc.group}\u0000${doc.name}`) ?? 'full',
    });
    touchedGroups.add(doc.group);
  }

  // ── 落字段 ────────────────────────────────────────────
  for (const item of accepted) {
    item.rel.lifecycle = 'event';
    item.rel.eventId = event.id;
    delete item.rel.expiresAt;
    delete item.rel.ttlDays;
  }
  if (touchedGroups.size > 0) {
    const batch = new Map<string, GroupCacheDoc>();
    for (const group of touchedGroups) {
      const cache = byGroup.get(group);
      if (cache) batch.set(group, cache);
    }
    writeGroupCacheBatch(scope, batch);
  }

  // ── 档位切换（批量：一次快照 / 一次 lookups）────────────
  const applied = await applyVisibilityBatch(
    scope,
    accepted.map((item) => ({ group: item.ref.group, relation: item.ref.name, from: item.from })),
    to,
  );

  // ── 事件 updatedAt（**不动 revision**：那是描述编辑的乐观锁）──
  let event2 = event;
  if (accepted.length > 0) {
    event2 = { ...event, updatedAt: now };
    writeEvent(scope, event2);
  }

  return {
    event: event2,
    visibility: visibilityFlags(to),
    bound: accepted.map((item) => item.ref),
    skipped,
    failed,
    visibilityFailed: applied.failed.map((f) => ({
      group: f.group,
      name: f.relation,
      kind: f.kind,
      error: f.error,
    })),
    pending: applied.pending,
  };
}

/** 解绑：文档回 `wiki`（长期保留、可检索），**不删除文档、不进回收站** */
export async function unbindMember(
  scope: string,
  eventRef: string,
  group: string,
  name: string,
): Promise<UnbindMemberOutcome> {
  return withScopeWriteLock(scope, 'event-update', async () => {
    const event = mustFindEvent(scope, eventRef);
    const doc = loadGroupCache(scope, group);
    const rel = doc?.hot_relations.find((r) => r.text === name);
    if (!doc || !rel) {
      throw new GovernanceError('DOC_NOT_FOUND', `文档不存在：${group}/${name}`, { memberOf: null });
    }
    if (rel.eventId !== event.id) {
      throw new GovernanceError(
        'DOC_NOT_FOUND',
        `「${name}」不是事件 #${event.shortId} 的关联文档`,
        { memberOf: rel.eventId ?? null },
      );
    }

    const now = Date.now();
    // from 必须在改字段前算
    const from = resolveVisibilityOfRelation(scope, rel).mode;

    delete rel.lifecycle;
    delete rel.eventId;
    delete rel.expiresAt;
    delete rel.ttlDays;
    writeGroupCache(scope, group, doc);

    const applied = from === 'full'
      ? { pending: [] as IndexKind[] }
      : await applyVisibility({ scope, group, relation: name, from, to: 'full', now });

    const next: EventRecord = { ...event, updatedAt: now };
    writeEvent(scope, next);

    return {
      event: next,
      removed: { group, name },
      lifecycle: 'wiki',
      visibility: { mode: 'full' as const, dense: true as const, fts: true as const },
      pending: applied.pending,
    };
  });
}
