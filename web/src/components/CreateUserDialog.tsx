/**
 * 新建账号弹窗（REQ-20261104-001）：仅 editor / viewer；管理员只能 CLI 创建。
 */
import { useState, type FormEvent, type JSX } from 'react';
import { AuthApiError, createUser, type Role, type UserView } from '@/api/authApi';
import { DateTimePicker } from './DateTimePicker';
import { UserDialog } from './UserDialog';
import {
  describeUserError,
  validateExpiry,
  validatePassword,
  validateUsername,
} from '@/lib/usersPageModel';
import { defaultFromNow, formatLocalDateTime } from '@/lib/datetimePicker';

export interface CreateUserDialogProps {
  onClose: () => void;
  onCreated: (user: UserView) => void;
}

export function CreateUserDialog({ onClose, onCreated }: CreateUserDialogProps): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [validity, setValidity] = useState<'never' | 'date'>('never');
  const [expiry, setExpiry] = useState(() => formatLocalDateTime(defaultFromNow(30 * 24 * 60)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const usernameError = validateUsername(username);
    if (usernameError) { setError(usernameError); return; }
    const passwordError = validatePassword(password);
    if (passwordError) { setError(passwordError); return; }
    if (validity === 'date') {
      const expiryError = validateExpiry(expiry);
      if (expiryError) { setError(expiryError); return; }
    }
    setBusy(true);
    setError(null);
    try {
      const user = await createUser({
        username: username.trim(),
        password,
        role,
        ...(validity === 'date' ? { expiresAt: new Date(expiry).toISOString() } : {}),
      });
      onCreated(user);
    } catch (err) {
      setError(err instanceof AuthApiError ? describeUserError(err.code, err.message) : '创建失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <UserDialog
      title="新建账号"
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <button type="button" className="ki-btn ki-btn--secondary" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" form="ki-create-user-form" className="ki-btn ki-btn--primary" disabled={busy}>
            {busy ? '创建中…' : '创建账号'}
          </button>
        </>
      )}
    >
      <form id="ki-create-user-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="u2-form-grid">
          <div className="u2-field">
            <span className="u2-field__label">用户名</span>
            <div className="u2-field__control">
              <input
                className="ki-form-input"
                value={username}
                autoComplete="off"
                placeholder="字母、数字、点、连字符、下划线"
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
          </div>
          <div className="u2-field">
            <span className="u2-field__label">初始密码</span>
            <div className="u2-field__control">
              <input
                className="ki-form-input"
                type="password"
                autoComplete="new-password"
                placeholder="8-128 个字符"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </div>
          <div className="u2-field">
            <span className="u2-field__label">权限</span>
            <div className="u2-field__control">
              <div className="ki-segmented u2-seg" role="group" aria-label="权限">
                <button type="button" aria-pressed={role === 'editor'} onClick={() => setRole('editor')}>读写</button>
                <button type="button" aria-pressed={role === 'viewer'} onClick={() => setRole('viewer')}>只读</button>
              </div>
              <p className="u2-hint">
                {role === 'editor'
                  ? '读写：写知识、导入文档、AI 对话可写；数据源只读。'
                  : '只读：可浏览、检索与只读 AI 对话；所有写入禁止。'}
              </p>
            </div>
          </div>
          <div className="u2-field">
            <span className="u2-field__label">有效期</span>
            <div className="u2-field__control">
              <div className="ki-segmented u2-seg" role="group" aria-label="有效期">
                <button type="button" aria-pressed={validity === 'never'} onClick={() => setValidity('never')}>永久</button>
                <button type="button" aria-pressed={validity === 'date'} onClick={() => setValidity('date')}>指定时间</button>
              </div>
              {validity === 'date' ? (
                <div className="u2-date-row">
                  <DateTimePicker value={expiry} onChange={setExpiry} ariaLabel="账号有效期" />
                </div>
              ) : null}
              <p className="u2-hint">到期后该账号无法登录，现有会话与 Token 立即失效。</p>
            </div>
          </div>
        </div>
        <p className="u2-hint">
          管理员账号只能通过命令行创建：<code>ki user create &lt;用户名&gt; --role admin</code>
        </p>
        {error ? <p className="u2-inline-error" role="alert">{error}</p> : null}
      </form>
    </UserDialog>
  );
}
