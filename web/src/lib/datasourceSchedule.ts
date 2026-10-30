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

/**
 * 同步状态中文化（`lastSync.state` 与 `lastAutoState` 同源同一套枚举）。
 * 放在这里而不是各弹窗里，避免「上次同步 · 成功」与「上次自动 · ok」两种口径并存。
 */
export const SYNC_STATE_LABEL: Record<string, string> = {
  ok: '成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
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

/** 默认执行时间：现在 + 30 分钟，秒归零（`datetime-local` 只认到分钟） */
export function defaultScheduleAt(nowMs: number = Date.now()): string {
  const base = new Date(nowMs + 30 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`
    + `T${pad(base.getHours())}:${pad(base.getMinutes())}`;
}

export interface ScheduleModeSwitch {
  patch: Partial<ScheduleFormState>;
  /** 传回给下一次调用：记录「哪个值是自动填的」，切回周期时据此撤回 */
  autoAt: string | null;
}

/**
 * 切换「周期 / 指定时间」时该怎么处理 `at`。
 *
 * - 切到指定时间且 `at` 为空 → 填 `now + 30min`，并记住它是自动填的
 * - 切回周期且 `at` 仍是那个自动值 → 一并清空
 *   否则「点一下指定时间再点回周期」就会变成待保存（`toScheduleInput` 在周期模式下
 *   把 at 置 null，这次保存写不回任何东西，白发一次请求、revision 还会 +1）
 * - 已有计划自带 `at`（编辑已有计划）时一律不动它
 */
export function switchScheduleMode(
  form: ScheduleFormState,
  nextMode: ScheduleFormState['mode'],
  opts: { nowMs?: number; autoAt?: string | null } = {},
): ScheduleModeSwitch {
  const autoAt = opts.autoAt ?? null;
  if (nextMode === 'interval') {
    if (autoAt !== null && form.at === autoAt) {
      return { patch: { mode: 'interval', at: '' }, autoAt: null };
    }
    return { patch: { mode: 'interval' }, autoAt };
  }
  if (form.at !== '') return { patch: { mode: 'at' }, autoAt };
  const at = defaultScheduleAt(opts.nowMs);
  return { patch: { mode: 'at', at }, autoAt: at };
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

/**
 * 「下次同步」列的两行视图（2026-10-30 用户定稿：从「上次同步」副行升为独立列）。
 *
 * ★ 主值（`value`）只放「什么时候会再跑」这一个事实，用正文字号 + 600 承重；
 *   周期 / 模式 / 未开启等限定信息全部下沉副行（`sub`），别在主值里拼长句
 *   —— 主值一旦变成「下次 20:35 · 每 3 分钟」，独立成列就又退化成一行字。
 * ★ 列宽内放不下的（完整时刻、连续失败原因）一律进 `title`，不靠折行。
 */
export interface ScheduleNextView {
  /** 主值：下次执行时刻；无待执行时为「—」 */
  value: string;
  /** 副行：周期或模式（未开启 / 未上报 / 仅一次 / 每天 …） */
  sub: string;
  /** warn = 即将补跑或连续失败，整列转告警色 */
  tone: 'muted' | 'warn';
  /**
   * 无待执行（主值是「—」）：渲染层据此把主值降回弱色。
   * ★ 必须由数据层给出，别在 JSX 里比 `value === '—'` —— 主值的「—」是「没有下次」的
   *   业务结论，不是排版占位；用字符串比对会让以后新增的空值文案悄悄漏掉弱化。
   */
  empty: boolean;
  /** 悬浮说明（title） */
  title: string;
}

export function scheduleNextLine(
  schedule: DataSourceScheduleView | undefined | null,
  now = Date.now(),
): ScheduleNextView {
  // 旧 daemon 不下发 schedule ≠「未开启」：口径与总览页 summarizeSchedules 的 known 一致
  if (schedule === undefined || schedule === null) {
    return {
      value: '—',
      sub: '未上报',
      tone: 'muted',
      empty: true,
      title: '当前服务端（daemon）不返回定时计划（旧版本），升级后可显示',
    };
  }
  if (!schedule.enabled) {
    return {
      value: '—',
      sub: '未开启定时',
      tone: 'muted',
      empty: true,
      title: '定时同步未开启；点行内「编辑」可设置',
    };
  }
  const fails = schedule.consecutiveFailures;
  const warn = fails >= SCHEDULE_FAILURE_WARN;
  const failNote = warn ? `连续失败 ${fails} 次，仍会尝试` : '';
  /**
   * 告警必须落在**副行看得见**的位置，不能只塞进 title（hover 才有 = 等于没说）。
   * 有下次运行时副行改报失败次数、周期退到 title —— 「要处理的事」优先于「配置值」。
   */
  const warnSub = `连续失败 ${fails} 次`;
  const intervalLabel = `每 ${schedule.intervalValue ?? '?'} ${UNIT_LABEL[schedule.intervalUnit ?? 'hour']}`;
  const modeLabel = schedule.mode === 'interval'
    ? intervalLabel
    : `${schedule.repeat === 'daily' ? '每天' : '仅一次'}`;
  const planLabel = schedule.mode === 'interval'
    ? intervalLabel
    : `${formatDateTime(schedule.at)} · ${modeLabel}`;
  const title = (lead: string): string => [lead, `计划 ${planLabel}`, failNote].filter((part) => part !== '').join('；');
  // 「仅一次」已执行过就不要再画过去的下次时间（判断必须早于 overdue）
  const doneOnce = schedule.mode === 'at'
    && schedule.repeat === 'once'
    && schedule.lastAutoFor !== null
    && schedule.lastAutoState !== null;
  if (doneOnce) {
    return {
      value: '—',
      sub: '已执行 · 仅一次',
      // 已结束的计划没有「待处理事项」：不再转 warn 色，也不再暗示「仍会尝试」
      tone: 'muted',
      empty: true,
      title: `仅此一次的计划已执行，无下次运行；计划 ${planLabel}${warn ? `；连续失败 ${fails} 次` : ''}`,
    };
  }
  if (schedule.nextRunAt !== null && schedule.nextRunAt <= now) {
    return {
      value: '即将补跑',
      sub: warn ? warnSub : modeLabel,
      tone: 'warn',
      empty: false,
      title: title(`已到计划时间（${formatDateTime(schedule.nextRunAt)}），等待调度器执行`),
    };
  }
  const emptyTitle = '暂无待执行的下次运行';
  // 先落到局部变量再判空：对 `schedule.nextRunAt` 这种属性访问，TS 无法把收窄结果
  // 带进三元分支（中间有函数调用），只能靠 `as number` 硬断言；用局部 const 就不必断言。
  const nextRunAt = schedule.nextRunAt;
  const noNext = nextRunAt === null;
  return {
    // 当天只给时分（跨天才带日期）：与「上次同步」列的完整时刻并排时不抢宽度
    value: noNext
      ? '—'
      : schedule.mode === 'interval'
        ? formatShortTime(nextRunAt, now)
        : formatDateTime(nextRunAt),
    sub: warn ? warnSub : modeLabel,
    tone: warn ? 'warn' : 'muted',
    empty: noNext,
    title: title(noNext ? emptyTitle : `下次运行 ${formatDateTime(nextRunAt)}`),
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
