/**
 * UsersPage.tsx —— Web 账号管理（REQ-20261103-001 · S-04）
 * 仅 users.manage（管理员）可进入；与 MCP Token 相互独立。
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  createUser,
  deleteUser,
  listUsers,
  updateUser,
  AuthApiError,
  type Role,
  type UserView,
} from '@/api/authApi';
import { formatRole, useAuth } from '@/lib/authContext';
import { Notice } from '@/components/Notice';

function errorMessage(err: unknown): string {
  if (err instanceof AuthApiError) {
    if (err.code === 'USER_EXISTS') return '用户名已存在';
    if (err.code === 'USER_LAST_ADMIN') return '不能删除、降级或禁用最后一个管理员';
    if (err.code === 'USER_PASSWORD_TOO_WEAK') return '密码长度需为 8-128 个字符';
    if (err.code === 'USER_INVALID_USERNAME') return '用户名仅允许字母、数字、点、连字符、下划线';
    return err.message;
  }
  return err instanceof Error ? err.message : '操作失败，请稍后重试';
}

function formatTime(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN');
}

export function UsersPage(): JSX.Element {
  const { can, user: currentUser } = useAuth();
  const [users, setUsers] = useState<UserView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<UserView | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [createForm, setCreateForm] = useState<{ username: string; password: string; role: Role }>({
    username: '',
    password: '',
    role: 'editor',
  });
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setUsers(await listUsers());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (can('users.manage')) void reload();
    else setLoading(false);
  }, [can, reload]);

  if (!can('users.manage')) {
    return (
      <section className="ki-card">
        <div className="ki-card__body">
          <h2 className="ki-card__title">用户管理</h2>
          <p className="ki-form-hint">当前账号无权管理用户。</p>
        </div>
      </section>
    );
  }

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      await createUser({
        username: createForm.username.trim(),
        password: createForm.password,
        role: createForm.role,
      });
      setCreateForm({ username: '', password: '', role: 'editor' });
      setNotice('账号已创建');
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const changeRole = async (user: UserView, role: Role): Promise<void> => {
    setBusyId(user.id);
    setError(null);
    try {
      await updateUser(user.id, { role });
      await reload();
    } catch (err) {
      setError(errorMessage(err));
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  const toggleDisabled = async (user: UserView): Promise<void> => {
    setBusyId(user.id);
    setError(null);
    try {
      await updateUser(user.id, { disabled: !user.disabled });
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (user: UserView): Promise<void> => {
    if (!window.confirm(`删除账号 ${user.username}？该账号的会话会立即失效。`)) return;
    setBusyId(user.id);
    setError(null);
    try {
      await deleteUser(user.id);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const submitReset = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!resetTarget || busyId) return;
    setBusyId(resetTarget.id);
    setError(null);
    try {
      await updateUser(resetTarget.id, { password: resetPassword });
      setResetTarget(null);
      setResetPassword('');
      setNotice(`已重置 ${resetTarget.username} 的密码`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="ki-users-page">
      <div className="ki-page-head">
        <div>
          <h2 className="ki-card__title">用户管理</h2>
          <p className="ki-form-hint">账号只用于登录本页面，与 MCP Token 相互独立。</p>
        </div>
      </div>

      {error ? <Notice tone="warn" title="操作失败">{error}</Notice> : null}
      {notice ? <Notice tone="success" title={notice}><span /></Notice> : null}

      <section className="ki-card">
        <div className="ki-card__head">
          <h3 className="ki-card__title">新建账号</h3>
        </div>
        <form className="ki-users-create" onSubmit={(e) => void create(e)}>
          <label className="ki-login-field">
            <span>用户名</span>
            <input
              className="ki-form-input"
              value={createForm.username}
              onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))}
              disabled={creating}
              required
            />
          </label>
          <label className="ki-login-field">
            <span>初始密码</span>
            <input
              className="ki-form-input"
              type="password"
              autoComplete="new-password"
              value={createForm.password}
              onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
              minLength={8}
              disabled={creating}
              required
            />
          </label>
          <label className="ki-login-field">
            <span>权限</span>
            <select
              className="ki-form-select"
              value={createForm.role}
              onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value as Role }))}
              disabled={creating}
            >
              <option value="admin">管理员（全部权限）</option>
              <option value="editor">读写账号（写知识；数据源只读）</option>
              <option value="viewer">只读账号</option>
            </select>
          </label>
          <button className="ki-btn ki-btn--primary" type="submit" disabled={creating}>
            {creating ? '创建中…' : '创建账号'}
          </button>
        </form>
      </section>

      <section className="ki-card">
        <div className="ki-card__head">
          <h3 className="ki-card__title">账号列表</h3>
        </div>
        {loading ? (
          <p className="ki-form-hint">正在读取…</p>
        ) : users.length === 0 ? (
          <p className="ki-form-hint">尚无账号。</p>
        ) : (
          <div className="ki-users-table-wrap">
            <table className="ki-users-table">
              <thead>
                <tr>
                  <th>用户名</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>最近登录</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className={user.disabled ? 'ki-users-row--disabled' : undefined}>
                    <td>
                      <strong>{user.username}</strong>
                      {currentUser?.id === user.id ? <span className="ki-users-self">当前</span> : null}
                    </td>
                    <td>
                      <select
                        className="ki-form-select ki-users-role"
                        value={user.role}
                        disabled={busyId === user.id}
                        onChange={(e) => void changeRole(user, e.target.value as Role)}
                        aria-label={`修改 ${user.username} 的角色`}
                      >
                        <option value="admin">{formatRole('admin')}</option>
                        <option value="editor">{formatRole('editor')}</option>
                        <option value="viewer">{formatRole('viewer')}</option>
                      </select>
                    </td>
                    <td>
                      <span className={`ki-users-status ki-users-status--${user.disabled ? 'off' : 'on'}`}>
                        {user.disabled ? '已禁用' : '启用'}
                      </span>
                    </td>
                    <td>{formatTime(user.lastLoginAt)}</td>
                    <td>
                      <div className="ki-users-actions">
                        <button
                          type="button"
                          className="ki-btn ki-btn--secondary ki-btn--small"
                          disabled={busyId === user.id}
                          onClick={() => {
                            setResetTarget(user);
                            setResetPassword('');
                          }}
                        >重置密码</button>
                        <button
                          type="button"
                          className="ki-btn ki-btn--secondary ki-btn--small"
                          disabled={busyId === user.id}
                          onClick={() => void toggleDisabled(user)}
                        >{user.disabled ? '启用' : '禁用'}</button>
                        <button
                          type="button"
                          className="ki-btn ki-btn--danger ki-btn--small"
                          disabled={busyId === user.id}
                          onClick={() => void remove(user)}
                        >删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {resetTarget ? (
        <div
          className="ki-overlay ki-overlay--show ki-overlay--front"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && busyId === null) setResetTarget(null);
          }}
        >
          <section className="ki-dialog ki-dialog--form ki-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="ki-reset-title">
            <header className="ki-dialog__head">
              <h3 className="ki-dialog__title" id="ki-reset-title">重置密码 · {resetTarget.username}</h3>
              <button type="button" className="ki-dialog__close" aria-label="关闭重置密码" onClick={() => setResetTarget(null)}>✕</button>
            </header>
            <form onSubmit={(e) => void submitReset(e)}>
              <div className="ki-dialog__body">
                <label className="ki-form-label" htmlFor="ki-reset-password">新密码</label>
                <input
                  id="ki-reset-password"
                  className="ki-form-input"
                  type="password"
                  autoComplete="new-password"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  minLength={8}
                  required
                />
                <p className="ki-form-hint">重置后该账号现有会话会失效。</p>
              </div>
              <footer className="ki-dialog__foot">
                <button type="button" className="ki-btn ki-btn--secondary" onClick={() => setResetTarget(null)}>取消</button>
                <button type="submit" className="ki-btn ki-btn--primary" disabled={busyId !== null}>重置密码</button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
