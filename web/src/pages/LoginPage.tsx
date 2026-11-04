/**
 * LoginPage.tsx —— 远程访问登录页（REQ-20261103-001 · S-04）
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { login, AuthApiError } from '@/api/authApi';
import { useAuth } from '@/lib/authContext';

function loginErrorMessage(err: unknown): string {
  if (err instanceof AuthApiError) {
    if (err.code === 'AUTH_RATE_LIMITED') return '尝试过于频繁，请 5 分钟后再试';
    if (err.code === 'USER_STORE_CORRUPT') {
      return '账号数据不可读，请在本机运行 ki user list 检查';
    }
    if (err.code === 'AUTH_INVALID') return '用户名或密码不正确';
    return err.message;
  }
  return err instanceof Error ? err.message : '登录失败，请稍后重试';
}

export function LoginPage(): JSX.Element | null {
  const { status, localAdminEnabled, refresh, error: authError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: unknown } | null)?.from;
  const target = typeof from === 'string' && from.startsWith('/') && from !== '/login' ? from : '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') navigate(target, { replace: true });
  }, [status, target, navigate]);

  if (status === 'loading') {
    return <div className="ki-auth-loading">正在加载…</div>;
  }
  if (status === 'authenticated') return null;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      await refresh();
      navigate(target, { replace: true });
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ki-login-page">
      <main className="ki-login-card" aria-labelledby="ki-login-title">
        <div className="ki-login-brand">
          <span className="ki-login-logo" aria-hidden="true">ki</span>
          <span className="ki-login-brand-text">
            <strong>ki 知识库</strong>
            <span>KNOWLEDGE INDEXER</span>
          </span>
        </div>
        <h1 className="ki-login-title" id="ki-login-title">登录以继续</h1>
        <p className="ki-login-sub">使用管理员或团队账号访问当前知识库。</p>

        <form className="ki-login-form" onSubmit={(e) => void submit(e)}>
          <label className="ki-login-field">
            <span>用户名</span>
            <input
              className="ki-form-input"
              name="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
              required
            />
          </label>
          <label className="ki-login-field">
            <span>密码</span>
            <input
              className="ki-form-input"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
            />
          </label>

          {error ? <p className="ki-login-error" role="alert">{error}</p> : null}
          {!error && authError ? <p className="ki-login-error" role="alert">{authError}</p> : null}

          <button className="ki-btn ki-btn--primary ki-login-submit" type="submit" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>

        {localAdminEnabled ? (
          <p className="ki-login-hint">本机访问（127.0.0.1 / localhost）无需登录。</p>
        ) : null}
      </main>
    </div>
  );
}
