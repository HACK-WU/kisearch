/**
 * 文档生命周期（分类）· 唯一口径（B0 冻结）
 *
 * 为什么需要这个文件：
 *   1. 缺省值只能有一个来源。散落的 `rel.lifecycle ?? 'wiki'` 会在半年内漂移成
 *      `'wiki' | undefined | null` 三套语义，且没有任何测试能发现；
 *   2. **读路径不写回**：缺省在内存里补，不回写分片。否则 91 篇存量会被无意义改写，
 *      还会污染 WAL 与并发语义（S-01 决策 3）；
 *   3. 入参校验与存储不变量分开：入参校验回答"能不能写"，resolveLifecycle 回答"现在是什么"。
 *
 * 设计来源：design/S01 §3.1-§3.4、§3.9。
 */

import type { GovernanceErrorCode } from './governance-errors.js';

export type LifecycleKind = 'wiki' | 'temp' | 'event';

export const MIN_TTL_DAYS = 1;
export const MAX_TTL_DAYS = 365;
/** 恢复时 ttlDays 缺失的兜底（S-04 §3.4）；写入侧**不**用它替代用户输入 */
export const FALLBACK_TTL_DAYS = 7;

const DAY_MS = 86_400_000;

export function ttlDaysToExpiresAt(ttlDays: number, now: number): number {
  return now + ttlDays * DAY_MS;
}

export function expiresAtToTtlDays(expiresAt: number, now: number): number {
  return Math.round((expiresAt - now) / DAY_MS);
}

/** 解析所需的字段子集；用结构类型而非 `Relation`，避免 B0 依赖 B1 的字段新增 */
export interface LifecycleFields {
  lifecycle?: string;
  expiresAt?: number;
  eventId?: string;
  ttlDays?: number;
}

export interface ResolvedLifecycle {
  kind: LifecycleKind;
  expiresAt?: number;
  eventId?: string;
  ttlDays?: number;
  /**
   * 存储态与 kind 不一致（temp 无 expiresAt / event 无 eventId / wiki 带残留）。
   * 只用于诊断，**不自动修**——静默修数据会让问题在别处以更难看的方式暴露。
   */
  inconsistent: boolean;
  /** 不一致时的可读原因，供诊断接口原样输出 */
  reason?: string;
}

const VALID_KINDS: ReadonlySet<string> = new Set(['wiki', 'temp', 'event']);

/**
 * 读侧唯一缺省口径。
 *
 * 不做 I/O、不改入参、不抛异常：任何历史数据（含手改坏的）都要能读出来，
 * 由 `inconsistent` 把问题交给诊断，而不是让整个列表 500。
 */
export function resolveLifecycle(fields: LifecycleFields): ResolvedLifecycle {
  const raw = fields.lifecycle;
  if (raw === undefined || raw === null || raw === '') {
    return { kind: 'wiki', inconsistent: false };
  }
  if (!VALID_KINDS.has(raw)) {
    return {
      kind: 'wiki',
      inconsistent: true,
      reason: `未知的 lifecycle 值「${String(raw)}」，已按 wiki 处理`,
    };
  }

  const kind = raw as LifecycleKind;
  if (kind === 'temp') {
    if (typeof fields.expiresAt !== 'number' || !Number.isFinite(fields.expiresAt)) {
      return { kind, ttlDays: fields.ttlDays, inconsistent: true, reason: 'temp 文档缺少 expiresAt' };
    }
    return { kind, expiresAt: fields.expiresAt, ttlDays: fields.ttlDays, inconsistent: false };
  }

  if (kind === 'event') {
    if (!fields.eventId) {
      return { kind, inconsistent: true, reason: 'event 文档缺少 eventId' };
    }
    return { kind, eventId: fields.eventId, inconsistent: false };
  }

  // wiki：带残留字段说明写入侧没清干净
  const residual: string[] = [];
  if (fields.expiresAt !== undefined) residual.push('expiresAt');
  if (fields.eventId !== undefined) residual.push('eventId');
  if (fields.ttlDays !== undefined) residual.push('ttlDays');
  if (residual.length > 0) {
    return { kind, inconsistent: true, reason: `wiki 文档残留字段：${residual.join('/')}` };
  }
  return { kind, inconsistent: false };
}

export interface LifecycleInput {
  lifecycle?: string;
  ttlDays?: number;
  eventId?: string;
}

export type LifecycleValidation =
  | {
      ok: true;
      /** false = 调用方什么都没传：新建落 wiki、覆盖保持原值（S-01 §3.4） */
      specified: boolean;
      kind?: LifecycleKind;
      expiresAt?: number;
      ttlDays?: number;
      eventId?: string;
    }
  | { ok: false; code: GovernanceErrorCode; message: string };

/**
 * 写入侧入参校验。
 *
 * 只做形状与互斥判断；`eventId` 是否真实存在、事件是否已收口由 S-02 的查询回答
 * （本文件不引 events 包，避免循环依赖）。
 *
 * `now` 参与计算是为了让返回值可直接落库，同时便于单测注入。
 */
export function validateLifecycleInput(input: LifecycleInput, now: number): LifecycleValidation {
  const { lifecycle, ttlDays, eventId } = input;

  if (lifecycle === undefined && ttlDays === undefined && eventId === undefined) {
    return { ok: true, specified: false };
  }

  if (lifecycle !== undefined && !VALID_KINDS.has(lifecycle)) {
    return {
      ok: false,
      code: 'LIFECYCLE_INVALID',
      message: `lifecycle 必须是 wiki / temp / event 之一，收到「${String(lifecycle)}」`,
    };
  }

  const kind = lifecycle as LifecycleKind | undefined;

  // 未显式给 lifecycle 但给了伴随字段：按伴随字段推断，避免"给了期限却没生效"
  if (kind === undefined) {
    if (eventId !== undefined) return validateLifecycleInput({ lifecycle: 'event', eventId }, now);
    if (ttlDays !== undefined) return validateLifecycleInput({ lifecycle: 'temp', ttlDays }, now);
    return { ok: true, specified: false };
  }

  if (kind === 'wiki') {
    if (ttlDays !== undefined || eventId !== undefined) {
      return {
        ok: false,
        code: 'LIFECYCLE_ARG_CONFLICT',
        message: 'lifecycle=wiki 时不应传 ttl_days / event；要保留期限请用 temp，要绑定事件请用 event',
      };
    }
    return { ok: true, specified: true, kind: 'wiki' };
  }

  if (kind === 'temp') {
    if (eventId !== undefined) {
      return {
        ok: false,
        code: 'LIFECYCLE_ARG_CONFLICT',
        message: 'lifecycle=temp 时不应传 event',
      };
    }
    if (ttlDays === undefined) {
      return {
        ok: false,
        code: 'TTL_REQUIRED',
        message: 'lifecycle=temp 必须同时给 ttl_days（1~365），不猜测期限',
      };
    }
    if (!Number.isInteger(ttlDays) || ttlDays < MIN_TTL_DAYS || ttlDays > MAX_TTL_DAYS) {
      return {
        ok: false,
        code: 'TTL_INVALID',
        message: `ttl_days 必须是 ${MIN_TTL_DAYS}~${MAX_TTL_DAYS} 之间的整数，收到「${String(ttlDays)}」`,
      };
    }
    return {
      ok: true,
      specified: true,
      kind: 'temp',
      ttlDays,
      expiresAt: ttlDaysToExpiresAt(ttlDays, now),
    };
  }

  // event
  if (ttlDays !== undefined) {
    return {
      ok: false,
      code: 'LIFECYCLE_ARG_CONFLICT',
      message: 'lifecycle=event 时不应传 ttl_days；事件文档的去留由事件终态动作决定',
    };
  }
  if (!eventId) {
    return {
      ok: false,
      code: 'EVENT_REQUIRED',
      message: 'lifecycle=event 必须给 event（事件 id 或 #编号）；可用 ki_event_list 查未收口事件，或用 ki_event_create 新建',
    };
  }
  return { ok: true, specified: true, kind: 'event', eventId };
}

/** 已过期 temp 文档（S-04 的惰性扫描入口之一；本函数不做 I/O） */
export function findExpiredTemp<T extends LifecycleFields>(relations: readonly T[], now: number): T[] {
  return relations.filter((rel) => {
    if (rel.lifecycle !== 'temp') return false;
    return typeof rel.expiresAt === 'number' && Number.isFinite(rel.expiresAt) && rel.expiresAt <= now;
  });
}

/** 剩余天数（向下取整，最小 0）；仅 temp 有意义 */
export function remainDays(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
}
