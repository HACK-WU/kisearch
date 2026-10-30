/**
 * 数据源定时计划的展示/校验辅助（S-04）。
 *
 * 不重复实现 nextRunAt 计算：下次运行时间以服务端返回为准，
 * 这里只负责文案、表单转换与客户端基础校验。
 */
import type {
  DataSourceScheduleInput,
  DataSourceScheduleUnit,
  DataSourceScheduleView,
} from '@/api/httpApi';

export interface ScheduleFormState {
  enabled: boolean;
  mode: 'interval' | 'at';
  intervalValue: string;
  intervalUnit: DataSourceScheduleUnit;
  at: string;
  repeat: 'once' | 'daily';
}

export const UNIT_LABEL: Record<DataSourceScheduleUnit, string> = {
  minute: '分钟',
  hour: '小时',
  day: '天',
};

export function formFromSchedule(schedule?: DataSourceScheduleView | null): ScheduleFormState {
  if (!schedule) {
    return { enabled: false, mode: 'interval', intervalValue: '24', intervalUnit: 'hour', at: '', repeat: 'once' };
  }
  return {
    enabled: schedule.enabled,
    mode: schedule.mode,
    intervalValue: schedule.intervalValue === null ? '' : String(schedule.intervalValue),
    intervalUnit: schedule.intervalUnit ?? 'hour',
    at: schedule.at ?? '',
    repeat: schedule.repeat ?? 'once',
  };
}

export function describeSchedule(schedule: DataSourceScheduleView | undefined | null): string {
  if (!schedule || !schedule.enabled) return '关闭';
  if (schedule.mode === 'interval') {
    return `每 ${schedule.intervalValue ?? '?'} ${UNIT_LABEL[schedule.intervalUnit ?? 'hour']}`;
  }
  const repeat = schedule.repeat === 'daily' ? '每天' : '仅一次';
  return `${formatDateTime(schedule.at)} · ${repeat}`;
}

export function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatShortTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scheduleBadge(
  schedule: DataSourceScheduleView | undefined | null,
): '定时' | '定时⚠' | null {
  if (!schedule?.enabled) return null;
  return schedule.consecutiveFailures >= 3 ? '定时⚠' : '定时';
}

export function scheduleNextLine(
  schedule: DataSourceScheduleView | undefined | null,
  now = Date.now(),
): { text: string; tone: 'muted' | 'warn' } | null {
  if (!schedule?.enabled) return null;
  const warn = schedule.consecutiveFailures >= 3;
  const suffix = warn ? ` · 连续失败 ${schedule.consecutiveFailures} 次，仍会尝试` : '';
  if (schedule.mode === 'interval') {
    const label = `每 ${schedule.intervalValue ?? '?'} ${UNIT_LABEL[schedule.intervalUnit ?? 'hour']}`;
    if (schedule.nextRunAt !== null && schedule.nextRunAt <= now) {
      return { text: `即将补跑 · ${label}${suffix}`, tone: 'warn' };
    }
    return {
      text: `下次 ${schedule.nextRunAt === null ? '—' : formatShortTime(schedule.nextRunAt)} · ${label}${suffix}`,
      tone: warn ? 'warn' : 'muted',
    };
  }
  if (schedule.repeat === 'once') {
    if (schedule.lastAutoFor !== null && schedule.lastAutoState !== null) {
      return { text: `已执行 · 仅一次${suffix}`, tone: warn ? 'warn' : 'muted' };
    }
    if (schedule.nextRunAt !== null && schedule.nextRunAt <= now) {
      return { text: `即将补跑（${formatShortTime(schedule.nextRunAt)}）${suffix}`, tone: 'warn' };
    }
    return {
      text: `下次 ${formatDateTime(schedule.nextRunAt)} · 仅一次${suffix}`,
      tone: warn ? 'warn' : 'muted',
    };
  }
  return {
    text: `下次 ${schedule.nextRunAt === null ? '—' : formatDateTime(schedule.nextRunAt)} · 每天${suffix}`,
    tone: warn ? 'warn' : 'muted',
  };
}

export interface ScheduleFormValidation {
  ok: boolean;
  field?: 'interval' | 'at' | 'repeat';
  message?: string;
}

export function validateScheduleForm(form: ScheduleFormState): ScheduleFormValidation {
  if (!form.enabled) return { ok: true };
  if (form.mode === 'interval') {
    if (!/^\d+$/.test(form.intervalValue.trim())) {
      return { ok: false, field: 'interval', message: '请填写正整数间隔' };
    }
    const value = Number(form.intervalValue);
    if (value <= 0) return { ok: false, field: 'interval', message: '间隔必须大于 0' };
    const factor = form.intervalUnit === 'minute' ? 1 : form.intervalUnit === 'hour' ? 60 : 24 * 60;
    const minutes = value * factor;
    if (minutes > 365 * 24 * 60) return { ok: false, field: 'interval', message: '间隔不能超过 365 天' };
    return { ok: true };
  }
  if (!form.at) return { ok: false, field: 'at', message: '请选择执行时间' };
  if (Number.isNaN(new Date(form.at).getTime())) {
    return { ok: false, field: 'at', message: '执行时间不合法' };
  }
  return { ok: true };
}

export function toScheduleInput(
  form: ScheduleFormState,
  baseRevision?: number,
): DataSourceScheduleInput {
  return {
    enabled: form.enabled,
    mode: form.mode,
    intervalValue: form.mode === 'interval' && form.intervalValue.trim() !== ''
      ? Number(form.intervalValue)
      : null,
    intervalUnit: form.mode === 'interval' ? form.intervalUnit : null,
    at: form.mode === 'at' ? (form.at || null) : null,
    repeat: form.mode === 'at' ? form.repeat : null,
    ...(baseRevision !== undefined ? { baseRevision } : {}),
  };
}

export function isSameForm(a: ScheduleFormState, b: ScheduleFormState): boolean {
  return a.enabled === b.enabled
    && a.mode === b.mode
    && a.intervalValue.trim() === b.intervalValue.trim()
    && a.intervalUnit === b.intervalUnit
    && a.at === b.at
    && a.repeat === b.repeat;
}
