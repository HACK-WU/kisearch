/**
 * 自建日期时间选择器（2026-10-30）。
 *
 * 为什么不用 `<input type="datetime-local">` 自带的弹层：那个面板由浏览器绘制，
 * 不在 DOM 里也没有可用伪元素（`::picker()` 只对 `<select>` 生效），**边框无法样式化** ——
 * 白面板贴在白弹窗上完全看不出边界。要可控只能自己画。
 *
 * 交互取舍：
 *  - input 仍保留 `type="datetime-local"`（value 格式与后端 `toScheduleInput` 一致），
 *    但**隐藏原生日历图标**并盖一层热区：点框内任意位置打开的是本组件面板，不是原生弹层。
 *  - 键盘 Tab 进 input 仍可逐段键入（热区 tabIndex=-1，不进无障碍树）。
 *  - 面板里方向键 ←→ 移一天、↑↓ 移一周，Esc 关闭。
 */
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  WEEKDAY_LABELS,
  buildMonthGrid,
  clampInt,
  defaultFromNow,
  formatLocalDateTime,
  isSameDay,
  parseLocalDateTime,
  shiftMonth,
  toLocalDateTime,
  withDay,
  withTime,
  type LocalDateTime,
} from '@/lib/datetimePicker';

const PANEL_WIDTH = 296;
/** 面板高度估个上限就够：定位只为防溢出屏幕，多算比少算安全 */
const PANEL_HEIGHT_EST = 386;

export interface DateTimePickerProps {
  value: string;
  onChange: (next: string) => void;
  ariaLabel?: string;
}

function CalendarIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.2" y="3.2" width="11.6" height="10.6" rx="1.8" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.6 6.4h10.8M5.4 1.8v2.4M10.6 1.8v2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function DateTimePicker({ value, onChange, ariaLabel = '执行时间' }: DateTimePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  // 初始值只解析一次：四处各自 parse + defaultFromNow 会各取一次 Date.now()，
  // 秒级边界上 draft / view / 时分可能对不上
  const [draft, setDraft] = useState<LocalDateTime>(() => parseLocalDateTime(value) ?? defaultFromNow());
  const [view, setView] = useState(() => ({ year: draft.year, month: draft.month }));
  /**
   * 「时 / 分」用文本态：受控数字框若在 onChange 就 clamp，用户把 18 删空会立刻被写回 18，
   * 想改成 9 却删不干净。这里允许中间态为空，失焦时才归一化。
   */
  const [hourText, setHourText] = useState(() => String(draft.hour).padStart(2, '0'));
  const [minuteText, setMinuteText] = useState(() => String(draft.minute).padStart(2, '0'));

  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    // 用真实高度（首次定位时面板已挂载，只是 visibility:hidden，offsetHeight 有效）；
    // 拿不到才退回估算值 —— 否则向上翻时会多让出一大段空白、离输入框很远
    const height = panelRef.current?.offsetHeight || PANEL_HEIGHT_EST;
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8
      ? Math.max(8, rect.top - height - 6)
      : below;
    setPos({ left, top, width });
  }, []);

  const openPanel = (): void => {
    const base = parseLocalDateTime(value) ?? defaultFromNow();
    setDraft(base);
    setHourText(String(base.hour).padStart(2, '0'));
    setMinuteText(String(base.minute).padStart(2, '0'));
    setView({ year: base.year, month: base.month });
    setOpen(true);
  };

  const closePanel = useCallback((refocus = true) => {
    // 点外部关闭时，如果焦点正落在面板里（时/分输入框），直接关会把它丢到 body，
    // 键盘用户就丢失位置了 —— 这种情况交还给输入框
    const active = document.activeElement;
    const insidePanel = active instanceof Node && panelRef.current?.contains(active) === true;
    setOpen(false);
    setPos(null);
    if (refocus || insidePanel) inputRef.current?.focus();
  }, []);

  const apply = (next: LocalDateTime): void => {
    setDraft(next);
    onChange(formatLocalDateTime(next));
  };

  // 面板挂载 / 切月后重新定位（place 内部先读真实高度，拿不到才退回估算值；
  // 这里不判 panelRef 是否存在 —— 就算读不到高度也得先把 pos 落下来，否则面板一直藏着）
  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place, view]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (fieldRef.current?.contains(target)) return;
      closePanel(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // 必须掐断冒泡：弹窗自己也监听 Esc（会弹「放弃未保存的修改？」），
        // 不拦住的话一次 Esc 既关面板又关弹窗
        event.stopPropagation();
        closePanel();
      }
    };
    const onScroll = (): void => place();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place, closePanel]);

  const focusDay = (target: LocalDateTime): void => {
    requestAnimationFrame(() => {
      const key = `${target.year}-${target.month}-${target.day}`;
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${key}"]`)?.focus();
    });
  };

  const moveByDays = (delta: number): void => {
    const next = new Date(draft.year, draft.month - 1, draft.day + delta);
    const nextDt = { ...toLocalDateTime(next), hour: draft.hour, minute: draft.minute };
    apply(nextDt);
    setView({ year: nextDt.year, month: nextDt.month });
    focusDay(nextDt);
  };

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const delta = map[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    moveByDays(delta);
  };

  const cells = buildMonthGrid(view.year, view.month);
  const today = toLocalDateTime(new Date());

  return (
    <div className="ki-dtp-field" ref={fieldRef}>
      <input
        ref={inputRef}
        type="datetime-local"
        className="ki-form-input ki-dtp-input"
        value={value}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'ArrowDown') {
            event.preventDefault();
            if (!open) openPanel();
          }
        }}
      />
      <button
        type="button"
        className="ki-dtp-hit"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => (open ? closePanel(false) : openPanel())}
      />
      <span className="ki-dtp-icon"><CalendarIcon /></span>

      {open && (
        <div
          ref={panelRef}
          className="ki-dtp-panel"
          // 非模态浮层：不锁焦点、Tab 可离开，所以用 group 而不是 dialog
          // （role=dialog 会让读屏播报「对话框」并期待焦点陷阱，与实际行为不符）
          role="group"
          aria-label="选择执行时间"
          style={pos ? { left: pos.left, top: pos.top, width: pos.width } : { visibility: 'hidden' }}
        >
          <div className="ki-dtp-head">
            <button
              type="button"
              className="ki-dtp-nav"
              aria-label="上个月"
              onClick={() => setView((v) => shiftMonth(v.year, v.month, -1))}
            >‹</button>
            <span className="ki-dtp-month">{view.year} 年 {view.month} 月</span>
            <button
              type="button"
              className="ki-dtp-nav"
              aria-label="下个月"
              onClick={() => setView((v) => shiftMonth(v.year, v.month, 1))}
            >›</button>
            <span className="ki-dtp-head-gap" />
            <button type="button" className="ki-dtp-nav" aria-label="关闭" onClick={() => closePanel()}>✕</button>
          </div>

          <div className="ki-dtp-week">
            {WEEKDAY_LABELS.map((label) => <span key={label}>{label}</span>)}
          </div>

          <div className="ki-dtp-grid" ref={gridRef} onKeyDown={onGridKeyDown}>
            {cells.map((cell) => {
              const selected = isSameDay(cell, draft);
              const isToday = isSameDay(cell, today);
              return (
                <button
                  key={`${cell.year}-${cell.month}-${cell.day}`}
                  type="button"
                  data-day={`${cell.year}-${cell.month}-${cell.day}`}
                  tabIndex={selected ? 0 : -1}
                  aria-pressed={selected}
                  className={`ki-dtp-day${cell.inMonth ? '' : ' ki-dtp-day--outside'}${selected ? ' ki-dtp-day--selected' : ''}${isToday ? ' ki-dtp-day--today' : ''}`}
                  onClick={() => apply(withDay(draft, cell.year, cell.month, cell.day))}
                >{cell.day}</button>
              );
            })}
          </div>

          <div className="ki-dtp-time">
            <span className="ki-dtp-time__label">时间</span>
            <input
              type="number"
              min={0}
              max={23}
              step={1}
              className="ki-form-input ki-dtp-time__input"
              aria-label="小时"
              value={hourText}
              onChange={(event) => {
                const raw = event.target.value;
                setHourText(raw);
                if (raw.trim() === '') return;
                apply(withTime(draft, clampInt(raw, 0, 23, draft.hour), draft.minute));
              }}
              onBlur={() => {
                const hour = clampInt(hourText, 0, 23, draft.hour);
                setHourText(String(hour).padStart(2, '0'));
                apply(withTime(draft, hour, draft.minute));
              }}
            />
            <span className="ki-dtp-time__sep" aria-hidden="true">:</span>
            <input
              type="number"
              min={0}
              max={59}
              step={1}
              className="ki-form-input ki-dtp-time__input"
              aria-label="分钟"
              value={minuteText}
              onChange={(event) => {
                const raw = event.target.value;
                setMinuteText(raw);
                if (raw.trim() === '') return;
                apply(withTime(draft, draft.hour, clampInt(raw, 0, 59, draft.minute)));
              }}
              onBlur={() => {
                const minute = clampInt(minuteText, 0, 59, draft.minute);
                setMinuteText(String(minute).padStart(2, '0'));
                apply(withTime(draft, draft.hour, minute));
              }}
            />
          </div>

          <div className="ki-dtp-foot">
            <button
              type="button"
              className="ki-dtp-link"
              onClick={() => { onChange(''); closePanel(); }}
            >清除</button>
            <button
              type="button"
              className="ki-dtp-link"
              onClick={() => {
                const now = new Date();
                const next = withDay(draft, now.getFullYear(), now.getMonth() + 1, now.getDate());
                apply(next);
                setView({ year: next.year, month: next.month });
              }}
            >今天</button>
            <button
              type="button"
              className="ki-dtp-done"
              onClick={() => {
                // 从没选过任何值（点开又直接点完成）：把面板里的默认值落下去，别让它空着
                if (!value) onChange(formatLocalDateTime(draft));
                closePanel();
              }}
            >完成</button>
          </div>
        </div>
      )}
    </div>
  );
}
