import { useEffect, useMemo, useRef, useState } from 'react';
import {
  saveDataSourceSchedule,
  type DataSourceScheduleResponse,
  type DataSourceScheduleView,
} from '@/api/httpApi';
import {
  formatDateTime,
  formFromSchedule,
  isSameForm,
  toScheduleInput,
  UNIT_LABEL,
  validateScheduleForm,
  type ScheduleFormState,
} from '@/lib/datasourceSchedule';

export interface DatasourceScheduleDialogProps {
  scope: string;
  schedule?: DataSourceScheduleView | null;
  schedulerDisabled?: boolean;
  onClose: () => void;
  onSaved: (response: DataSourceScheduleResponse) => void;
}

function apiError(err: unknown): string {
  const e = err as Error & { status?: number; body?: { code?: string; error?: string } };
  if (e.status === 409 && e.body?.code === 'SCOPE_OPERATION_BUSY') {
    return e.body.error ?? '该知识库正在同步，完成后再修改定时设置';
  }
  if (e.status === 409 && e.body?.code === 'SCHEDULE_STALE') {
    return e.body.error ?? '定时设置已在别处修改，请关闭后重新打开';
  }
  if (e.status === 400) return e.body?.error ?? '定时设置不合法';
  if (e.status === 403) return '没有该知识库的修改权限';
  return e.body?.error ?? e.message ?? '保存失败，请重试';
}

export function DatasourceScheduleDialog({
  scope,
  schedule,
  schedulerDisabled,
  onClose,
  onSaved,
}: DatasourceScheduleDialogProps): JSX.Element {
  const baseline = useMemo(() => formFromSchedule(schedule), [schedule]);
  const [form, setForm] = useState<ScheduleFormState>(baseline);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const firstFieldRef = useRef<HTMLButtonElement>(null);

  const dirty = !isSameForm(form, baseline);
  const validation = validateScheduleForm(form);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (dirty) setDiscardOpen(true);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, onClose]);

  const requestClose = (): void => {
    if (saving) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  };

  const patch = (next: Partial<ScheduleFormState>): void => {
    setForm((prev) => ({ ...prev, ...next }));
    setError(null);
    setDiscardOpen(false);
  };

  const save = async (): Promise<void> => {
    if (!dirty || !validation.ok || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await saveDataSourceSchedule({
        scope,
        schedule: toScheduleInput(form, schedule?.revision),
      });
      onSaved(response);
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSaving(false);
    }
  };

  const lastAuto = schedule?.lastAutoAt
    ? `${formatDateTime(schedule.lastAutoAt)}${schedule.lastAutoState ? ` · ${schedule.lastAutoState}` : ''}`
    : '—';

  return (
    <div
      className="ki-overlay ki-overlay--show ki-overlay--front"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="ki-dialog ki-dialog--form ki-ds-sched-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ki-ds-sched-title"
        tabIndex={-1}
      >
        <header className="ki-dialog__head">
          <div>
            <h3 className="ki-dialog__title" id="ki-ds-sched-title">定时同步 · {scope}</h3>
            <p className="ki-ds-sched-sub">
              同步需要 daemon 常驻；时间按服务器本地时区
            </p>
          </div>
          <button type="button" className="ki-dialog__close" aria-label="关闭定时设置" onClick={requestClose}>✕</button>
        </header>

        <div className="ki-dialog__body">
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
                onClick={() => patch({ enabled: !form.enabled })}
              >
                <span className="ki-switch__knob" />
              </button>
              <span className="ki-ds-sched-hint">{form.enabled ? '已开启' : '默认关闭'}</span>
            </div>
          </div>

          {form.enabled ? (
            <>
              <div className="ki-ds-sched-row">
                <span className="ki-ds-sched-label">模式</span>
                <div className="ki-ds-sched-control ki-ds-sched-modes" role="radiogroup" aria-label="同步模式">
                  <label className="ki-ds-sched-radio">
                    <input
                      type="radio"
                      name="ki-ds-sched-mode"
                      checked={form.mode === 'interval'}
                      onChange={() => patch({ mode: 'interval' })}
                    />
                    周期
                  </label>
                  <label className="ki-ds-sched-radio">
                    <input
                      type="radio"
                      name="ki-ds-sched-mode"
                      checked={form.mode === 'at'}
                      onChange={() => patch({ mode: 'at' })}
                    />
                    指定时间
                  </label>
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
                      onChange={(event) => patch({ intervalValue: event.target.value })}
                    />
                    <select
                      className="ki-form-input ki-ds-sched-unit"
                      value={form.intervalUnit}
                      aria-label="间隔单位"
                      onChange={(event) => patch({ intervalUnit: event.target.value as ScheduleFormState['intervalUnit'] })}
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
                        onChange={(event) => patch({ at: event.target.value })}
                      />
                    </div>
                  </div>
                  <div className="ki-ds-sched-row">
                    <span className="ki-ds-sched-label">重复</span>
                    <div className="ki-ds-sched-control">
                      <label className="ki-ds-sched-radio">
                        <input
                          type="checkbox"
                          checked={form.repeat === 'daily'}
                          onChange={(event) => patch({ repeat: event.target.checked ? 'daily' : 'once' })}
                        />
                        每天重复
                      </label>
                    </div>
                  </div>
                </>
              )}

              {!validation.ok ? (
                <p className="ki-ds-sched-error" role="alert">{validation.message}</p>
              ) : null}

              <div className="ki-ds-sched-meta">
                <div><span>当前下次运行（保存后重算）</span><b>{schedule?.nextRunAt ? formatDateTime(schedule.nextRunAt) : '—'}</b></div>
                <div><span>上次自动</span><b>{lastAuto}</b></div>
                {schedule && schedule.consecutiveFailures >= 3 ? (
                  <div className="ki-ds-sched-warn-line">
                    连续失败 {schedule.consecutiveFailures} 次 · 下个周期仍会尝试
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <p className="ki-ds-sched-hint-block">开启后可设置「周期」或「指定日期时间」；默认关闭。</p>
          )}

          {error ? <p className="ki-ds-sched-error" role="alert">{error}</p> : null}
        </div>

        <footer className="ki-dialog__foot ki-ds-sched-footer">
          {discardOpen ? (
            <>
              <span className="ki-ds-sched-discard">放弃未保存的修改？</span>
              <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={() => setDiscardOpen(false)}>继续编辑</button>
              <button type="button" className="ki-btn ki-btn--danger ki-btn--small" onClick={onClose}>放弃</button>
            </>
          ) : (
            <>
              <button type="button" className="ki-btn ki-btn--secondary" disabled={saving} onClick={requestClose}>取消</button>
              <button
                type="button"
                className="ki-btn ki-btn--primary"
                disabled={saving || !dirty || !validation.ok}
                onClick={() => { void save(); }}
              >{saving ? '保存中…' : '保存'}</button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
