/**
 * 定时同步表单体（2026-10-30 从 DatasourceScheduleDialog 抽出）：
 * 「启用开关 + 周期/指定时间 + 元信息」。弹窗与编辑弹窗共用，避免两套 UI 漂移。
 * 开关是启用状态的唯一入口（关闭时隐藏设置区并给出说明）。
 */
import type { Ref } from 'react';
import type { DataSourceScheduleView } from '@/api/httpApi';
import {
  formatDateTime,
  UNIT_LABEL,
  validateScheduleForm,
  type ScheduleFormState,
} from '@/lib/datasourceSchedule';

export interface DatasourceScheduleFieldsProps {
  form: ScheduleFormState;
  onChange: (next: Partial<ScheduleFormState>) => void;
  schedule?: DataSourceScheduleView | null;
  schedulerDisabled?: boolean;
  firstFieldRef?: Ref<HTMLButtonElement>;
}

export function DatasourceScheduleFields({
  form,
  onChange,
  schedule,
  schedulerDisabled,
  firstFieldRef,
}: DatasourceScheduleFieldsProps): JSX.Element {
  const validation = validateScheduleForm(form);
  // 字段下方说明：默认是引导语气（灰字）。只有「填了但不合法」才转告警色。
  const tipMessage = validation.ok
    ? (form.mode === 'interval' ? '间隔范围 1 分钟 ~ 365 天' : null)
    : (validation.message ?? null);
  const tipWarn = !validation.ok && !(form.mode === 'at' && form.at === '');
  const lastAuto = schedule?.lastAutoAt
    ? `${formatDateTime(schedule.lastAutoAt)}${schedule.lastAutoState ? ` · ${schedule.lastAutoState}` : ''}`
    : '—';

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
            ref={firstFieldRef}
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
                    onClick={() => onChange({ mode: 'interval' })}
                  >周期</button>
                  <button
                    type="button"
                    aria-pressed={form.mode === 'at'}
                    onClick={() => onChange({ mode: 'at' })}
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
                    <input
                      type="datetime-local"
                      className="ki-form-input ki-ds-sched-datetime"
                      value={form.at}
                      aria-label="执行时间"
                      onChange={(event) => onChange({ at: event.target.value })}
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
              <span className="ki-ds-sched-meta__label">下次运行（重算后）</span>
              <span className="ki-ds-sched-meta__value">{schedule?.nextRunAt ? formatDateTime(schedule.nextRunAt) : '—'}</span>
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
