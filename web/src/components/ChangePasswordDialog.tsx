/**
 * ChangePasswordDialog.tsx —— 修改自己的密码（REQ-20261103-001 · S-04）
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { changePassword, AuthApiError } from '@/api/authApi';

export interface ChangePasswordDialogProps {
  onClose: () => void;
  onSaved: () => void;
}

export function ChangePasswordDialog({ onClose, onSaved }: ChangePasswordDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 0);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [busy, onClose]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (newPassword !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword(oldPassword, newPassword);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof AuthApiError) {
        if (err.code === 'AUTH_INVALID') setError('旧密码不正确');
        else if (err.code === 'USER_PASSWORD_TOO_WEAK') setError('新密码长度需为 8-128 个字符');
        else setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : '修改失败，请稍后重试');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="ki-overlay ki-overlay--show ki-overlay--front"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="ki-dialog ki-dialog--form ki-auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ki-change-password-title"
        tabIndex={-1}
      >
        <header className="ki-dialog__head">
          <div>
            <h3 className="ki-dialog__title" id="ki-change-password-title">修改密码</h3>
            <p className="ki-dialog__sub">修改成功后其他设备的登录会失效。</p>
          </div>
          <button type="button" className="ki-dialog__close" aria-label="关闭修改密码" onClick={onClose} disabled={busy}>✕</button>
        </header>
        <form onSubmit={(e) => void submit(e)}>
          <div className="ki-dialog__body">
            <label className="ki-form-label" htmlFor="ki-old-password">旧密码</label>
            <input
              id="ki-old-password"
              className="ki-form-input"
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              disabled={busy}
              required
            />
            <label className="ki-form-label" htmlFor="ki-new-password">新密码</label>
            <input
              id="ki-new-password"
              className="ki-form-input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={busy}
              minLength={8}
              required
            />
            <p className="ki-form-hint">8-128 个字符。</p>
            <label className="ki-form-label" htmlFor="ki-confirm-password">再次输入新密码</label>
            <input
              id="ki-confirm-password"
              className="ki-form-input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              minLength={8}
              required
            />
            {error ? <p className="ki-form-error" role="alert">{error}</p> : null}
          </div>
          <footer className="ki-dialog__foot">
            <button type="button" className="ki-btn ki-btn--secondary" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className="ki-btn ki-btn--primary" disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
