/**
 * 写入链路的生命周期落库（S-01 §3.4）
 *
 * 拆成两步，因为**校验必须发生在任何写入之前**：
 *   1. `precheckLifecycle()` —— 纯决策，不碰 Relation：校验入参、查 group 默认、查事件绑定；
 *   2. `applyLifecyclePlan()` —— 拿决策就地改字段（在 local KB 已写、关系已 upsert 之后）。
 *
 * 若把两步合成一步（先写 KB 再校验），校验失败会留下"KB 已写、分类没落"的半成品，
 * 而这正是历史上 `--no-vector` 半成品状态的同类问题。
 *
 * 语义（四选一，与 S-01 §3.4 一致）：
 *   显式传                → 以入参为准，未传的伴随字段清空
 *   新建且未传            → group 默认（有则用）→ 否则 wiki
 *   覆盖且未传            → **保持原值**（不得重置为 wiki）
 *   数据源文档（locked）   → 拒绝改分类（R4）
 */

import { resolveLifecycle, validateLifecycleInput, type LifecycleKind } from './lifecycle.js';
import { withScopeWriteLock } from './scope-write-lock.js';
import { readGovernance, getGroupDefault, type GovernanceConfig } from './governance-store.js';
import { readAllEvents, findEventIn, isEventClosed } from './events/store.js';
import type { EventRecord, Visibility } from './events/types.js';
import type { GovernanceErrorCode } from './governance-errors.js';
import type { Relation } from './scoring.js';
import { applyVisibility, resolveVisibilityOfRelation, type IndexKind } from './visibility-index.js';

export type LifecycleSource = 'explicit' | 'group-default' | 'preserved' | 'fallback-wiki';

export interface AppliedEventRef {
  id: string;
  shortId: number;
  title: string;
}

export type LifecyclePlan =
  | { action: 'clear' }
  | { action: 'temp'; ttlDays: number; expiresAt: number }
  | { action: 'event'; eventId: string; event: AppliedEventRef }
  | { action: 'keep' };

/** 返回值回显用的最终状态（`keep` 时取自现有记录） */
export interface LifecycleSummary {
  lifecycle: LifecycleKind;
  expiresAt?: number;
  ttlDays?: number;
  eventId?: string;
  event?: AppliedEventRef;
  source: LifecycleSource;
  /** 改分类后实际生效的检索档位（event 文档按阶段算；wiki / temp 恒 full） */
  visibility?: Visibility;
  /** 需异步补写的索引类别；非空时页面提示"索引补齐中" */
  pending?: IndexKind[];
}

export interface PrecheckArgs {
  scope: string;
  group: string;
  relation: string;
  /** 同 group 同名此前已存在（覆盖）时为该记录；不存在（新建）为 undefined */
  existing?: Relation;
  /** 数据源文档（`isImported`）→ 改分类一律拒绝 */
  locked: boolean;
  lifecycle?: string;
  ttlDays?: number;
  eventId?: string;
  now: number;
  /** 注入用：批量场景预读一次，避免逐条读盘（50 条 × N 个事件文件） */
  events?: readonly EventRecord[];
  /** 注入用：缺省 readGovernance(scope) */
  governance?: GovernanceConfig;
}

export type PrecheckOutput =
  | { ok: true; plan: LifecyclePlan; summary: LifecycleSummary }
  | { ok: false; code: GovernanceErrorCode; message: string; details?: Record<string, unknown> };

export function precheckLifecycle(args: PrecheckArgs): PrecheckOutput {
  const { scope, group, relation, existing, locked, now } = args;

  const validation = validateLifecycleInput(
    { lifecycle: args.lifecycle, ttlDays: args.ttlDays, eventId: args.eventId },
    now,
  );
  if (!validation.ok) {
    return { ok: false, code: validation.code, message: validation.message };
  }

  if (locked && validation.specified) {
    return {
      ok: false,
      code: 'DATASOURCE_LIFECYCLE_LOCKED',
      message: '该文档由数据源同步（isImported），分类固定为 wiki，不能修改；如需自定义分类请另建文档写入',
      details: { group, relation },
    };
  }

  // ── 未传 ──
  if (!validation.specified) {
    if (existing) {
      const current = resolveLifecycle(existing);
      return {
        ok: true,
        plan: { action: 'keep' },
        summary: {
          lifecycle: current.kind,
          expiresAt: current.expiresAt,
          ttlDays: current.ttlDays,
          eventId: current.eventId,
          source: 'preserved',
        },
      };
    }

    const config = args.governance ?? readGovernance(scope);
    const groupDefault = getGroupDefault(config, group);
    if (groupDefault?.kind === 'temp' && groupDefault.ttlDays !== undefined) {
      const ttlDays = groupDefault.ttlDays;
      const expiresAt = now + ttlDays * 86_400_000;
      return {
        ok: true,
        plan: { action: 'temp', ttlDays, expiresAt },
        summary: { lifecycle: 'temp', expiresAt, ttlDays, source: 'group-default' },
      };
    }
    return {
      ok: true,
      plan: { action: 'clear' },
      summary: { lifecycle: 'wiki', source: groupDefault?.kind === 'wiki' ? 'group-default' : 'fallback-wiki' },
    };
  }

  // ── 显式 ──
  if (validation.kind === 'wiki') {
    return { ok: true, plan: { action: 'clear' }, summary: { lifecycle: 'wiki', source: 'explicit' } };
  }

  if (validation.kind === 'temp') {
    return {
      ok: true,
      plan: { action: 'temp', ttlDays: validation.ttlDays!, expiresAt: validation.expiresAt! },
      summary: {
        lifecycle: 'temp',
        expiresAt: validation.expiresAt,
        ttlDays: validation.ttlDays,
        source: 'explicit',
      },
    };
  }

  // event：必须指向存在且未收口的事件
  const eventRef = validation.eventId!;
  const allEvents = args.events ?? readAllEvents(scope);
  const event = findEventIn(allEvents, eventRef);
  if (!event) {
    const available = allEvents
      .filter((e) => !isEventClosed(e))
      .slice(0, 5)
      .map((e) => ({ id: e.id, shortId: e.shortId, title: e.title }));
    return {
      ok: false,
      code: 'EVENT_NOT_FOUND',
      message: `事件「${eventRef}」不存在。可用 ki_event_list 查未收口事件，或用 ki_event_create 新建；`
        + (available.length > 0 ? '可绑定以下未收口事件' : '当前 scope 还没有未收口事件'),
      details: { available },
    };
  }
  if (isEventClosed(event)) {
    return {
      ok: false,
      code: 'EVENT_CLOSED',
      message: `事件「#${event.shortId} ${event.title}」已收口，不能绑定新文档；请改绑未收口事件或新建事件`,
      details: { event: { id: event.id, shortId: event.shortId, title: event.title, closedAt: event.closedAt } },
    };
  }

  /**
   * 归属冲突：文档已绑在**另一个未收口**事件上时必须拒绝。
   *
   * 否则一次绑定就把它从原事件静默摘走，而原事件页面上少一篇证据、没有任何提示。
   * 已收口事件的残留 `eventId` 不拦（收口时本应清掉，历史数据按 wiki 兜底）。
   */
  const currentEventId = existing?.eventId;
  if (currentEventId && currentEventId !== event.id) {
    const owner = allEvents.find((e) => e.id === currentEventId) ?? null;
    if (owner && !isEventClosed(owner)) {
      return {
        ok: false,
        code: 'DOC_BOUND_TO_OTHER_EVENT',
        message: `「${relation}」已属于事件 #${owner.shortId}「${owner.title}」（未收口），请先解绑或改选其他文档`,
        details: { event: { id: owner.id, shortId: owner.shortId, title: owner.title } },
      };
    }
  }

  const applied: AppliedEventRef = { id: event.id, shortId: event.shortId, title: event.title };
  return {
    ok: true,
    plan: { action: 'event', eventId: event.id, event: applied },
    summary: { lifecycle: 'event', eventId: event.id, event: applied, source: 'explicit' },
  };
}

/** 把决策落到 Relation 上（调用时机：local KB 已写、关系已 upsert） */
export function applyLifecyclePlan(rel: Relation, plan: LifecyclePlan): void {
  switch (plan.action) {
    case 'keep':
      return;
    case 'clear':
      delete rel.lifecycle;
      delete rel.expiresAt;
      delete rel.eventId;
      delete rel.ttlDays;
      return;
    case 'temp':
      rel.lifecycle = 'temp';
      rel.ttlDays = plan.ttlDays;
      rel.expiresAt = plan.expiresAt;
      delete rel.eventId;
      return;
    case 'event':
      rel.lifecycle = 'event';
      rel.eventId = plan.eventId;
      delete rel.expiresAt;
      delete rel.ttlDays;
      return;
  }
}

/**
 * 给**已存在**的文档改分类（页面行内「改」/ 批量条 / HTTP 路由用）。
 *
 * 与写入链路的区别：这里没有 `module_info`，不动内容与索引，只改分类字段。
 * 但共用同一套 `precheckLifecycle` 语义 —— 否则「页面能改、AI 不能改」会出现两套规则。
 *
 * 返回 `visibilityHint`：改成 `event` 后文档受阶段控制，页面要提示「可能立刻搜不到」。
 */
export async function changeLifecycle(
  args: {
    scope: string;
    group: string;
    name: string;
    lifecycle?: string;
    ttlDays?: number;
    eventId?: string;
    now?: number;
  },
): Promise<{ ok: true; summary: LifecycleSummary } | { ok: false; code: string; message: string; details?: Record<string, unknown> }> {
  const { loadGroupCache, writeGroupCache } = await import('./group-cache.js');
  const now = args.now ?? Date.now();

  return withScopeWriteLock(args.scope, 'event-update', async () => {
    const doc = loadGroupCache(args.scope, args.group);
    const rel = doc?.hot_relations.find((r) => r.text === args.name);
    if (!doc || !rel) {
      return { ok: false as const, code: 'DOC_NOT_FOUND', message: `文档不存在：${args.group}/${args.name}` };
    }

    const check = precheckLifecycle({
      scope: args.scope,
      group: args.group,
      relation: args.name,
      existing: rel,
      locked: rel.isImported === true,
      lifecycle: args.lifecycle,
      ttlDays: args.ttlDays,
      eventId: args.eventId,
      now,
    });
    if (!check.ok) {
      return { ok: false as const, code: check.code, message: check.message, ...(check.details ? { details: check.details } : {}) };
    }

    /**
     * 档位切换：`from` 必须在**改字段前**算（改完再算会把自己算成新档位）。
     *
     * 不接这一步的话，页面/HTTP 把文档改成 event 并落到 hidden 阶段后，旧 dense/FTS
     * 索引仍留在库里 —— `ki_search` 照样召回，"声明不可检索"变成一句空话。
     */
    const from = resolveVisibilityOfRelation(args.scope, rel).mode;
    applyLifecyclePlan(rel, check.plan);
    const to = resolveVisibilityOfRelation(args.scope, rel).mode;
    writeGroupCache(args.scope, args.group, doc);

    let pending: IndexKind[] = [];
    if (from !== to) {
      const applied = await applyVisibility({
        scope: args.scope,
        group: args.group,
        relation: args.name,
        from,
        to,
        now,
      });
      pending = applied.pending;
    }

    return {
      ok: true as const,
      summary: {
        ...check.summary,
        visibility: to,
        ...(pending.length > 0 ? { pending } : {}),
      },
    };
  });
}
