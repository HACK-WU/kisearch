/**
 * 自建日期时间选择器的纯逻辑（2026-10-30）。
 *
 * 为什么要自建：`<input type="datetime-local">` 弹出的选择器面板由浏览器绘制，
 * 不在 DOM 里、没有可用伪元素（`::picker()` 只对 `<select>` 生效），**边框无法样式化**，
 * 白块糊在白弹窗上看不出边界。要可控只能自己画浮层。
 *
 * 这里只放能单测的部分：解析/格式化、月历网格、月份位移、数字钳制。
 * 渲染与定位在 `components/DateTimePicker.tsx`。
 */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 本地日期时间（与 `datetime-local` 的 value 同构，不带时区） */
export interface LocalDateTime {
  year: number;
  /** 1-12（不是 Date 的 0-11，避免两边来回换出错） */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** `YYYY-MM-DDTHH:mm`（input[type=datetime-local] 认这个格式） */
export function formatLocalDateTime(dt: LocalDateTime): string {
  return `${dt.year}-${pad2(dt.month)}-${pad2(dt.day)}T${pad2(dt.hour)}:${pad2(dt.minute)}`;
}

/** `YYYY-MM-DD HH:mm`（给人看，也给手输容错） */
export function formatLocalDateTimeText(dt: LocalDateTime): string {
  return `${dt.year}-${pad2(dt.month)}-${pad2(dt.day)} ${pad2(dt.hour)}:${pad2(dt.minute)}`;
}

/**
 * 解析 `YYYY-MM-DDTHH:mm`；也容忍空格分隔、秒、以及 `YYYY/MM/DD`。
 * 解析不出来返回 null（调用方回退到默认时间，不猜）。
 */
export function parseLocalDateTime(value: string | null | undefined): LocalDateTime | null {
  if (!value) return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const dt: LocalDateTime = {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]),
  };
  if (dt.month < 1 || dt.month > 12) return null;
  if (dt.hour > 23 || dt.minute > 59) return null;
  // 真实存在校验：2 月 30 日这类 Date 会自动进位，靠回读比对拦住
  const probe = new Date(dt.year, dt.month - 1, dt.day);
  if (probe.getFullYear() !== dt.year || probe.getMonth() !== dt.month - 1 || probe.getDate() !== dt.day) {
    return null;
  }
  return dt;
}

export function toLocalDateTime(date: Date): LocalDateTime {
  return {
    year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
    hour: date.getHours(), minute: date.getMinutes(),
  };
}

/** 月历格子：固定 6 行 × 7 列 = 42 格（行数恒定，切换月份时面板高度不跳） */
export interface MonthCell extends LocalDateTime {
  /** 是否属于当前展示的月（否则是补齐的上/下月日期，显示为浅灰） */
  inMonth: boolean;
}

/**
 * 生成某月的 42 格，**周一为一周起点**（与站内其它日期口径一致）。
 * @param year 年
 * @param month 1-12
 */
export function buildMonthGrid(year: number, month: number): MonthCell[] {
  const first = new Date(year, month - 1, 1);
  // getDay(): 周日=0 → 转成「周一=0」
  const leading = (first.getDay() + 6) % 7;
  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(year, month - 1, 1 - leading + i);
    const dMonth = d.getMonth() + 1;
    cells.push({
      year: d.getFullYear(), month: dMonth, day: d.getDate(),
      hour: 0, minute: 0,
      inMonth: dMonth === month && d.getFullYear() === year,
    });
  }
  return cells;
}

/** 月份位移（跨年正确，含负数） */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (((zero % 12) + 12) % 12) + 1 };
}

/** 只换日期部分，时分保留（点日历格时用） */
export function withDay(base: LocalDateTime, year: number, month: number, day: number): LocalDateTime {
  return { ...base, year, month, day };
}

/** 只换时分，日期保留 */
export function withTime(base: LocalDateTime, hour: number, minute: number): LocalDateTime {
  return { ...base, hour, minute };
}

export function isSameDay(a: LocalDateTime, b: LocalDateTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * 数字输入钳制：空串/非法 → fallback；超界 → 夹到边界。
 * 用于「时 / 分」两个输入框失焦与提交时的规范化。
 */
export function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 默认值：现在 + `minutes` 分钟，秒归零 */
export function defaultFromNow(minutes = 30, nowMs: number = Date.now()): LocalDateTime {
  return toLocalDateTime(new Date(nowMs + minutes * 60 * 1000));
}

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const;
