/**
 * 数据源定时计划的展示/校验辅助（S-04）。
 *
 * 不重复实现 nextRunAt 计算：下次运行时间以服务端返回为准，
 * 这里只负责文案、表单转换与客户端基础校验。
 */
import type {
  DataSourceListResponse,
  DataSourceScheduleInput,
  DataSourceScheduleUnit,
  DataSourceScheduleView,
} from '@/api/httpApi';

/** 连续失败告警阈值：与数据源页「定时⚠」同一条口径 */
export const SCHEDULE_FAILURE_WARN = 3;

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

export function formatShortTime(ms: number, nowMs = Date.now()): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const now = new Date(nowMs);
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
  return schedule.consecutiveFailures >= SCHEDULE_FAILURE_WARN ? '定时⚠' : '定时';
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

/**
 * 总览「定时同步」卡口径：已开启定时的**数据源数**（与数据源页徽标、CLI 脚注同源）。
 * `missing` / `corrupt` 不计入（只进 tooltip 说明）；旧 daemon 不下发 `schedule` ⇒ known=false，显示「—」而不是 0。
 */
export interface ScheduleSummary {
  /** 数据源列表是否已返回（首屏加载中为 false） */
  ready: boolean;
  /** 服务端是否上报了定时计划字段（旧 daemon 不下发） */
  known: boolean;
  enabled: number;
  failed: number;
  /** 是否有待执行的下次运行（用于区分「已执行完的仅一次」） */
  pending: boolean;
  total: number;
  excluded: number;
  schedulerDisabled: boolean;
  /** 首屏读取失败的错误信息（有缓存数据时不置位，仍按缓存口径显示） */
  error: string | null;
}

export function summarizeSchedules(
  list: DataSourceListResponse | undefined,
  opts: { error?: string } = {},
): ScheduleSummary {
  if (!list) {
    return {
      ready: false,
      known: false,
      enabled: 0,
      failed: 0,
      pending: false,
      total: 0,
      excluded: 0,
      schedulerDisabled: false,
      error: opts.error ?? null,
    };
  }
  const sources = list.sources ?? [];
  // 空列表没有可判字段，此时 0 是准确值，不当作「未知」
  const known = sources.length === 0 || sources.some((s) => s.schedule !== undefined);
  const enabledRows = sources.filter((s) => s.schedule?.enabled === true);
  return {
    ready: true,
    known,
    enabled: enabledRows.length,
    failed: enabledRows.filter(
      (s) => (s.schedule?.consecutiveFailures ?? 0) >= SCHEDULE_FAILURE_WARN,
    ).length,
    pending: enabledRows.some((s) => s.schedule?.nextRunAt !== null && s.schedule?.nextRunAt !== undefined),
    total: sources.length,
    excluded: (list.missing?.length ?? 0) + (list.corrupt?.length ?? 0),
    schedulerDisabled: list.schedulerDisabled === true,
    error: null,
  };
}

export interface ScheduleSummaryView {
  value: string;
  sub: string;
  tone: 'muted' | 'warn';
  title: string;
}

/** 副行只显示一条，优先级：调度器停用 > 连续失败 > 无待执行 > 未开启；正常态不显示副行 */
export function scheduleSummaryView(summary: ScheduleSummary): ScheduleSummaryView {
  if (!summary.ready) {
    if (summary.error !== null) {
      return {
        value: '—',
        sub: '数据源读取失败',
        tone: 'warn',
        title: `数据源列表读取失败，无法统计定时同步：${summary.error}`,
      };
    }
    return { value: '—', sub: '', tone: 'muted', title: '数据源列表读取中' };
  }
  if (!summary.known) {
    return {
      value: '—',
      // 五列时单卡内宽仅 108px，文案须 ≤8 字（10 字会折行）
      sub: '未上报定时计划',
      tone: 'muted',
      title: '当前服务端（daemon）不返回定时计划（旧版本），升级后可显示',
    };
  }
  const titleParts = [`已开启定时同步的数据源 ${summary.enabled} 个，共 ${summary.total} 个`];
  if (summary.excluded > 0) titleParts.push(`不含缺失/损坏数据源 ${summary.excluded} 个`);
  if (summary.schedulerDisabled) {
    titleParts.push('定时调度器已被服务端停用（KI_DISABLE_DATASOURCE_SCHEDULER）');
  }
  const title = titleParts.join('；');
  if (summary.schedulerDisabled && summary.enabled > 0) {
    return { value: String(summary.enabled), sub: '调度器已停用', tone: 'warn', title };
  }
  if (summary.failed > 0) {
    return { value: String(summary.enabled), sub: `${summary.failed} 个连续失败`, tone: 'warn', title };
  }
  if (summary.enabled > 0) {
    // 正常态不显示副行（下次运行时间按用户要求不展示）；仅「仅一次已执行完」提示无待执行
    return { value: String(summary.enabled), sub: summary.pending ? '' : '无待执行计划', tone: 'muted', title };
  }
  return { value: '0', sub: '未开启定时同步', tone: 'muted', title };
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
