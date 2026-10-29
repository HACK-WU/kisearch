/**
 * 数据源定时计划纯函数（REQ-20261029-001 / S-01）。
 *
 * 只依赖 epoch ms 与本地时间字符串，不读写磁盘，便于单测。
 * `at` 按 daemon 本地时区解释；页面与 daemon 默认同机同时区。
 */
import type {
  DataSourceLastSync,
  DataSourceSchedule,
  DataSourceScheduleInput,
  DataSourceScheduleRepeat,
  DataSourceScheduleUnit,
  DataSourceScheduleView,
} from './datasource-types.js';

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 365 * 24 * 60;
const AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const UNITS: readonly DataSourceScheduleUnit[] = ['minute', 'hour', 'day'];
const MODES = ['interval', 'at'] as const;
const REPEATS: readonly DataSourceScheduleRepeat[] = ['once', 'daily'];

export function defaultDataSourceSchedule(): DataSourceSchedule {
  return {
    enabled: false,
    mode: 'interval',
    intervalValue: 24,
    intervalUnit: 'hour',
    at: null,
    repeat: 'once',
    revision: 0,
    consecutiveFailures: 0,
    lastAutoAt: null,
    lastAutoFor: null,
    lastAutoState: null,
    lastSkipReason: null,
    lastSkipAt: null,
  };
}

function toInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function toUnit(value: unknown): DataSourceScheduleUnit | null {
  return typeof value === 'string' && (UNITS as readonly string[]).includes(value)
    ? value as DataSourceScheduleUnit
    : null;
}

function toRepeat(value: unknown): DataSourceScheduleRepeat | null {
  return typeof value === 'string' && (REPEATS as readonly string[]).includes(value)
    ? value as DataSourceScheduleRepeat
    : null;
}

/** 解析本地时间 'YYYY-MM-DDTHH:mm'；非法/不存在（含 DST 跳变）返回 null */
export function parseAtLocal(value: string | null): number | null {
  if (!value) return null;
  const match = AT_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  // 回写校验：2026-02-30 / DST 不存在的本地时刻会被 Date 归一化，这里判为非法
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
  ) return null;
  return date.getTime();
}

export function intervalMinutes(value: number | null, unit: DataSourceScheduleUnit | null): number | null {
  if (value === null || unit === null) return null;
  const factor = unit === 'minute' ? 1 : unit === 'hour' ? 60 : 24 * 60;
  return value * factor;
}

function isValidInterval(schedule: Pick<DataSourceScheduleInput, 'intervalValue' | 'intervalUnit'>): boolean {
  const minutes = intervalMinutes(schedule.intervalValue, schedule.intervalUnit);
  return minutes !== null && minutes >= MIN_INTERVAL_MINUTES && minutes <= MAX_INTERVAL_MINUTES;
}

/** 读取文件时的归一化；非法但 enabled 的计划降级为关闭（fail-safe），不静默启用 */
export function normalizeDataSourceSchedule(raw: unknown): DataSourceSchedule {
  const base = defaultDataSourceSchedule();
  if (!raw || typeof raw !== 'object') return base;
  const v = raw as Record<string, unknown>;
  const mode = typeof v.mode === 'string' && (MODES as readonly string[]).includes(v.mode)
    ? v.mode as DataSourceSchedule['mode']
    : 'interval';
  const schedule: DataSourceSchedule = {
    enabled: v.enabled === true,
    mode,
    intervalValue: toInteger(v.intervalValue, 1, 100_000),
    intervalUnit: toUnit(v.intervalUnit),
    at: typeof v.at === 'string' && AT_RE.test(v.at) && parseAtLocal(v.at) !== null ? v.at : null,
    repeat: toRepeat(v.repeat),
    revision: toInteger(v.revision, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    consecutiveFailures: toInteger(v.consecutiveFailures, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    lastAutoAt: typeof v.lastAutoAt === 'number' && Number.isFinite(v.lastAutoAt) ? v.lastAutoAt : null,
    lastAutoFor: typeof v.lastAutoFor === 'number' && Number.isFinite(v.lastAutoFor) ? v.lastAutoFor : null,
    lastAutoState: typeof v.lastAutoState === 'string'
      && ['ok', 'partial', 'failed', 'cancelled'].includes(v.lastAutoState)
      ? v.lastAutoState as DataSourceSchedule['lastAutoState']
      : null,
    lastSkipReason: typeof v.lastSkipReason === 'string' ? v.lastSkipReason : null,
    lastSkipAt: typeof v.lastSkipAt === 'number' && Number.isFinite(v.lastSkipAt) ? v.lastSkipAt : null,
  };
  if (!schedule.enabled) return schedule;

  const usable = schedule.mode === 'interval'
    ? isValidInterval(schedule)
    : schedule.at !== null && schedule.repeat !== null;
  if (usable) return schedule;
  return {
    ...schedule,
    enabled: false,
    lastSkipReason: 'invalid-schedule',
  };
}

export type ScheduleValidation =
  | { ok: true; value: DataSourceScheduleInput }
  | { ok: false; code: string; field: string; message: string };

function fail(code: string, field: string, message: string): ScheduleValidation {
  return { ok: false, code, field, message };
}

/** 页面保存的输入校验；关闭态只要求 mode 合法 */
export function validateScheduleInput(raw: unknown): ScheduleValidation {
  if (!raw || typeof raw !== 'object') return fail('SCHEDULE_INVALID', 'schedule', '定时设置必须是对象');
  const v = raw as Record<string, unknown>;
  const mode = v.mode;
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
    return fail('SCHEDULE_INVALID_MODE', 'mode', 'mode 只能是 interval 或 at');
  }
  const value: DataSourceScheduleInput = {
    enabled: v.enabled === true,
    mode: mode as DataSourceScheduleInput['mode'],
    intervalValue: toInteger(v.intervalValue, 1, 100_000),
    intervalUnit: toUnit(v.intervalUnit),
    at: typeof v.at === 'string' && v.at ? v.at : null,
    repeat: toRepeat(v.repeat),
    ...(typeof v.baseRevision === 'number' && Number.isInteger(v.baseRevision) && v.baseRevision >= 0
      ? { baseRevision: v.baseRevision }
      : {}),
  };
  if (!value.enabled) return { ok: true, value };

  if (value.mode === 'interval') {
    if (value.intervalValue === null || value.intervalUnit === null) {
      return fail('SCHEDULE_INVALID_INTERVAL', 'interval', '请填写间隔数值和单位');
    }
    const minutes = intervalMinutes(value.intervalValue, value.intervalUnit);
    if (minutes === null || minutes < MIN_INTERVAL_MINUTES) {
      return fail('SCHEDULE_INTERVAL_TOO_SMALL', 'interval', `间隔不能小于 ${MIN_INTERVAL_MINUTES} 分钟`);
    }
    if (minutes > MAX_INTERVAL_MINUTES) {
      return fail('SCHEDULE_INTERVAL_TOO_LARGE', 'interval', '间隔不能超过 365 天');
    }
    return { ok: true, value };
  }

  if (!value.at) return fail('SCHEDULE_AT_INVALID', 'at', '请选择执行时间');
  if (parseAtLocal(value.at) === null) {
    return fail('SCHEDULE_AT_INVALID', 'at', '执行时间不是合法的本地时间（或落在夏令时跳变时刻）');
  }
  if (value.repeat === null) return fail('SCHEDULE_INVALID_REPEAT', 'repeat', '请选择仅一次或每天重复');
  return { ok: true, value };
}

export interface NextRunResult {
  /** 理论下次运行时间；null = 无下次（关闭 / 仅一次已完成） */
  nextRunAt: number | null;
  /** 当前是否已到期（含停机补跑） */
  due: boolean;
  /** 本次计划槽位（指定时间模式用于 lastAutoFor 去重） */
  occurrence: number | null;
}

const NEVER: NextRunResult = { nextRunAt: null, due: false, occurrence: null };

/**
 * 计算下次运行。
 * 周期模式从「上次同步完成」起算（`lastSync.at`，无则 `lastAutoAt`）；首次开启等满一个周期。
 * 指定时间模式以 `lastAutoFor` 判断某个槽位是否已执行。
 */
export function computeNextRun(input: {
  schedule: DataSourceSchedule;
  lastSyncAt?: number | null;
  now: number;
}): NextRunResult {
  const { schedule, now } = input;
  if (!schedule.enabled) return NEVER;

  if (schedule.mode === 'interval') {
    const minutes = intervalMinutes(schedule.intervalValue, schedule.intervalUnit);
    if (minutes === null || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) return NEVER;
    const intervalMs = minutes * 60_000;
    const base = Math.max(input.lastSyncAt ?? 0, schedule.lastAutoAt ?? 0);
    if (base === 0) return { nextRunAt: now + intervalMs, due: false, occurrence: null };
    const nextRunAt = base + intervalMs;
    return { nextRunAt, due: nextRunAt <= now, occurrence: null };
  }

  const atMs = parseAtLocal(schedule.at);
  if (atMs === null || schedule.repeat === null) return NEVER;

  if (schedule.repeat === 'once') {
    if (schedule.lastAutoFor === atMs) return NEVER;
    return { nextRunAt: atMs, due: atMs <= now, occurrence: atMs };
  }

  // daily：从 at 指定日期起，每天 HH:mm
  if (now < atMs) return { nextRunAt: atMs, due: false, occurrence: atMs };
  const at = new Date(atMs);
  const today = new Date(now);
  const todaySlot = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    at.getHours(),
    at.getMinutes(),
    0,
    0,
  ).getTime();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfAt = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  // at 的日期晚于今天（理论上 now>=atMs 已排除），保底
  if (startOfAt > startOfToday) return { nextRunAt: atMs, due: false, occurrence: atMs };

  if (todaySlot <= now && (schedule.lastAutoFor === null || schedule.lastAutoFor < todaySlot)) {
    return { nextRunAt: todaySlot, due: true, occurrence: todaySlot };
  }
  const tomorrowSlot = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + 1,
    at.getHours(),
    at.getMinutes(),
    0,
    0,
  ).getTime();
  const nextRunAt = todaySlot > now ? todaySlot : tomorrowSlot;
  return { nextRunAt, due: false, occurrence: nextRunAt };
}

export function toScheduleView(
  schedule: DataSourceSchedule,
  lastSync: Pick<DataSourceLastSync, 'at'> | null,
  now = Date.now(),
): DataSourceScheduleView {
  return {
    ...schedule,
    nextRunAt: computeNextRun({ schedule, lastSyncAt: lastSync?.at ?? null, now }).nextRunAt,
  };
}

/** 供页面/CLI 展示的简短描述（服务端日志也用它，避免多处口径） */
export function describeSchedule(schedule: DataSourceSchedule): string {
  if (!schedule.enabled) return '关闭';
  if (schedule.mode === 'interval') {
    const unit = schedule.intervalUnit === 'minute' ? '分钟' : schedule.intervalUnit === 'hour' ? '小时' : '天';
    return `每 ${schedule.intervalValue ?? '?'} ${unit}`;
  }
  const repeat = schedule.repeat === 'daily' ? '每天' : '仅一次';
  return `${schedule.at ?? '未设置'} · ${repeat}`;
}
