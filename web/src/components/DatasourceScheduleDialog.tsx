import { useEffect, useMemo, useRef, useState } from 'react';
import {
  saveDataSourceSchedule,
  type DataSourceScheduleResponse,
  type DataSourceScheduleView,
} from '@/api/httpApi';
import {
  formFromSchedule,
  isSameForm,
  toScheduleInput,
  validateScheduleForm,
  type ScheduleFormState,
} from '@/lib/datasourceSchedule';
import { DatasourceScheduleFields } from './DatasourceScheduleFields';

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
          <DatasourceScheduleFields
            form={form}
            onChange={patch}
            schedule={schedule}
            schedulerDisabled={schedulerDisabled}
            firstFieldRef={firstFieldRef}
          />
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
