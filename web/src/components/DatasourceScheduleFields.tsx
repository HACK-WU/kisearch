/**
 * 定时同步表单体（2026-10-30 从 DatasourceScheduleDialog 抽出）：
 * 「启用开关 + 周期/指定时间 + 元信息」。开关是启用状态的唯一入口（关闭时隐藏设置区并给出说明）。
 *
 * ★ 使用者只有 `DatasourceEditDialog`：原独立定时弹窗（`DatasourceScheduleDialog`）已于同日删除
 *   —— 定时设置收敛为「行内编辑」一个入口（含目录不可读的 missing 行，它也只能从页面移除登记）。
 */
import { useRef } from 'react';
import type { DataSourceScheduleView } from '@/api/httpApi';
import {
  formatDateTime,
  switchScheduleMode,
  SYNC_STATE_LABEL,
  UNIT_LABEL,
  validateScheduleForm,
  type ScheduleFormState,
} from '@/lib/datasourceSchedule';
import { DateTimePicker } from './DateTimePicker';

export interface DatasourceScheduleFieldsProps {
  form: ScheduleFormState;
  onChange: (next: Partial<ScheduleFormState>) => void;
  schedule?: DataSourceScheduleView | null;
  schedulerDisabled?: boolean;
  /** 表单相对基准是否已改动：改动后「下次运行」就不准了，需要就地声明 */
  dirty?: boolean;
}

export function DatasourceScheduleFields({
  form,
  onChange,
  schedule,
  schedulerDisabled,
  dirty,
}: DatasourceScheduleFieldsProps): JSX.Element {
  const validation = validateScheduleForm(form);
  // 字段下方说明：默认是引导语气（灰字）。只有「填了但不合法」才转告警色。
  const tipMessage = validation.ok
    ? (form.mode === 'interval' ? '间隔范围 1 分钟 ~ 365 天' : null)
    : (validation.message ?? null);
  const tipWarn = !validation.ok && !(form.mode === 'at' && form.at === '');
  const lastAuto = schedule?.lastAutoAt
    ? `${formatDateTime(schedule.lastAutoAt)}${schedule.lastAutoState ? ` · ${SYNC_STATE_LABEL[schedule.lastAutoState] ?? schedule.lastAutoState}` : ''}`
    : '—';
  /**
   * 记录「哪个 at 值是切模式时自动填的」。切回周期时据此撤回，
   * 否则「点一下指定时间再点回来」会平白变成待保存。
   * 用 ref 不用 state：它不参与渲染，只是给下一次点击读的上下文。
   */
  const autoAtRef = useRef<string | null>(null);

  const changeMode = (nextMode: ScheduleFormState['mode']): void => {
    const { patch, autoAt } = switchScheduleMode(form, nextMode, { autoAt: autoAtRef.current });
    autoAtRef.current = autoAt;
    onChange(patch);
  };

  return (
    <>
      {schedulerDisabled ? (
        <div className="ki-ds-sched-warn" role="status">
          服务端已禁用调度（KI_DISABLE_DATASOURCE_SCHEDULER=1），保存后不会自动执行。
        </div>
      ) : null}

      <div className="ki-ds-sched-row">
        <span className="ki-ds-sched-label">自动同步</span>
        <div className="ki-ds-sched-control">
          <button
            type="button"
            className={`ki-switch${form.enabled ? ' ki-switch--on' : ''}`}
            role="switch"
            aria-checked={form.enabled}
            aria-label="自动同步"
            onClick={() => onChange({ enabled: !form.enabled })}
          >
            <span className="ki-switch__knob" />
          </button>
          <span className="ki-ds-sched-hint">{form.enabled ? '已开启' : '默认关闭'}</span>
        </div>
      </div>

      {form.enabled ? (
        <>
          <div className="ki-ds-sched-panel">
            <span className="ki-ds-sched-panel__title">同步设置</span>

            <div className="ki-ds-sched-row">
              <span className="ki-ds-sched-label">模式</span>
              <div className="ki-ds-sched-control">
                <div className="ki-ds-sched-seg" role="group" aria-label="同步模式">
                  <button
                    type="button"
                    aria-pressed={form.mode === 'interval'}
                    onClick={() => changeMode('interval')}
                  >周期</button>
                  <button
                    type="button"
                    aria-pressed={form.mode === 'at'}
                    onClick={() => changeMode('at')}
                  >指定时间</button>
                </div>
              </div>
            </div>

            {form.mode === 'interval' ? (
              <div className="ki-ds-sched-row">
                <span className="ki-ds-sched-label">每隔</span>
                <div className="ki-ds-sched-control ki-ds-sched-inline">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="ki-form-input ki-ds-sched-number"
                    value={form.intervalValue}
                    aria-label="间隔数值"
                    onChange={(event) => onChange({ intervalValue: event.target.value })}
                  />
                  <select
                    className="ki-form-select ki-ds-sched-unit"
                    value={form.intervalUnit}
                    aria-label="间隔单位"
                    onChange={(event) => onChange({ intervalUnit: event.target.value as ScheduleFormState['intervalUnit'] })}
                  >
                    <option value="minute">{UNIT_LABEL.minute}</option>
                    <option value="hour">{UNIT_LABEL.hour}</option>
                    <option value="day">{UNIT_LABEL.day}</option>
                  </select>
                </div>
              </div>
            ) : (
              <>
                <div className="ki-ds-sched-row">
                  <span className="ki-ds-sched-label">时间</span>
                  <div className="ki-ds-sched-control">
                    {/* 自建面板：原生日历弹层由浏览器绘制、边框无法样式化（白块糊在白弹窗上） */}
                    <DateTimePicker
                      value={form.at}
                      onChange={(next) => onChange({ at: next })}
                      ariaLabel="执行时间"
                    />
                  </div>
                </div>
                <div className="ki-ds-sched-row">
                  <span className="ki-ds-sched-label">重复</span>
                  <div className="ki-ds-sched-control">
                    <div className="ki-ds-sched-seg" role="group" aria-label="重复">
                      <button
                        type="button"
                        aria-pressed={form.repeat === 'once'}
                        onClick={() => onChange({ repeat: 'once' })}
                      >仅一次</button>
                      <button
                        type="button"
                        aria-pressed={form.repeat === 'daily'}
                        onClick={() => onChange({ repeat: 'daily' })}
                      >每天</button>
                    </div>
                  </div>
                </div>
              </>
            )}

            {tipMessage ? (
              <p
                className={`ki-ds-sched-tip${tipWarn ? ' ki-ds-sched-tip--warn' : ''}`}
                role={tipWarn ? 'alert' : undefined}
              >{tipMessage}</p>
            ) : null}
          </div>

          <div className="ki-ds-sched-meta">
            <div className="ki-ds-sched-meta__card">
              {/* 「重算后」是内部说法：这里显示的是**保存前**服务端下发的值，不会随表单实时重算 */}
              <span className="ki-ds-sched-meta__label">下次运行</span>
              <span className={`ki-ds-sched-meta__value${dirty && schedule?.nextRunAt ? ' ki-ds-sched-meta__value--muted' : ''}`}>
                {schedule?.nextRunAt ? formatDateTime(schedule.nextRunAt) : '—'}
              </span>
              {dirty ? <span className="ki-ds-sched-meta__flag">保存后更新</span> : null}
            </div>
            <div className="ki-ds-sched-meta__card">
              <span className="ki-ds-sched-meta__label">上次自动</span>
              <span className="ki-ds-sched-meta__value">{lastAuto}</span>
            </div>
            {schedule && schedule.consecutiveFailures >= 3 ? (
              <div className="ki-ds-sched-warn-line">
                连续失败 {schedule.consecutiveFailures} 次 · 下个周期仍会尝试
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <p className="ki-ds-sched-offnote">
          关闭后不再自动同步；手动同步仍受 30 分钟冷却限制，已有文档不受影响。
        </p>
      )}
    </>
  );
}
