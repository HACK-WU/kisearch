/**
 * UsersPage.tsx —— 用户管理 v2（REQ-20261104-001）
 * 仅 users.manage 可进入；成员列表只对管理员可见，编辑/删除收在两枚按钮里。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  AuthApiError,
  deleteUser,
  listUsers,
  type UserView,
} from '@/api/authApi';
import { useAuth } from '@/lib/authContext';
import { Notice } from '@/components/Notice';
import { ChangePasswordDialog } from '@/components/ChangePasswordDialog';
import { UserAccountCard } from '@/components/UserAccountCard';
import { CreateUserDialog } from '@/components/CreateUserDialog';
import { UserEditDialog } from '@/components/UserEditDialog';
import { UserDrawer } from '@/components/UserDrawer';
import { UserConfirmDialog } from '@/components/UserConfirmDialog';
import {
  PermissionBadge,
  TokenCountCell,
  UserStatusBadge,
  ValidityText,
} from '@/components/UserBadges';
import {
  accountStatus,
  describeUserError,
  formatTime,
} from '@/lib/usersPageModel';

function GuardIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="10" height="6.5" rx="1.5" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}

export function UsersPage(): JSX.Element {
  const { can, user: currentUser, refresh } = useAuth();
  const [users, setUsers] = useState<UserView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserView | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<UserView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const drawerReturnFocus = useRef<HTMLTableRowElement | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setUsers(await listUsers());
      setError(null);
    } catch (err) {
      setError(err instanceof AuthApiError ? describeUserError(err.code, err.message) : '账号列表读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (can('users.manage')) void reload();
    else setLoading(false);
  }, [can, reload]);

  const closeDrawer = useCallback((): void => {
    setDrawerTarget(null);
    window.setTimeout(() => drawerReturnFocus.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!drawerTarget) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerTarget, closeDrawer]);

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

  const members = users.filter((user) => user.role !== 'admin');
  const counts = {
    total: users.length,
    admins: users.filter((user) => user.role === 'admin').length,
    editors: members.filter((user) => user.role === 'editor').length,
    viewers: members.filter((user) => user.role === 'viewer').length,
    expired: members.filter((user) => accountStatus(user) !== 'active').length,
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await deleteUser(deleteTarget.id);
      setDeleteTarget(null);
      if (drawerTarget?.id === deleteTarget.id) setDrawerTarget(null);
      setNotice(result.tokenCleanupWarning
        ? `账号已删除；Token 清理未完成：${result.tokenCleanupWarning}`
        : '账号已删除；会话与名下 Token 已失效');
      await reload();
    } catch (err) {
      setError(err instanceof AuthApiError ? describeUserError(err.code, err.message) : '删除失败，请稍后重试');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="ki-users-page">
      <div className="u2-page-head">
        <div>
          <p>
            账号用于登录本页面；MCP Token 用于 MCP 客户端连接本知识库，受账号权限约束。
          </p>
          <p className="u2-summary">
            共 <b>{counts.total}</b> 个账号 ·
            <b> 全部权限 {counts.admins}</b> ·
            读写 <b>{counts.editors}</b> ·
            只读 <b>{counts.viewers}</b> ·
            <span className="u2-expired-count"> 已过期/禁用 {counts.expired}</span>
          </p>
        </div>
        <button type="button" className="ki-btn ki-btn--primary" onClick={() => setCreateOpen(true)}>+ 新建账号</button>
      </div>

      {error ? <Notice tone="warn" title="操作失败" onClose={() => setError(null)}>{error}</Notice> : null}
      {notice ? <Notice tone="success" title={notice} onClose={() => setNotice(null)}><span /></Notice> : null}
      {counts.admins > 1 ? (
        <Notice tone="warn" title="检测到多个管理员账号">
          当前规则只允许一个管理员；请用 CLI 处理多余管理员，避免出现权限歧义。
        </Notice>
      ) : null}

      <UserAccountCard
        user={{
          id: currentUser?.id ?? null,
          username: currentUser?.username ?? '—',
          role: currentUser?.role ?? 'admin',
          disabled: currentUser?.disabled === true,
          expiresAt: currentUser?.expiresAt ?? null,
          createdAt: currentUser?.createdAt ?? null,
          lastLoginAt: currentUser?.lastLoginAt ?? null,
        }}
        title="当前登录账号"
        localAdmin={currentUser?.id === null}
        action={currentUser?.id ? (
          <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={() => setPasswordOpen(true)}>
            修改密码
          </button>
        ) : <span className="u2-hint">本机免登录</span>}
      />

      <section className="ki-card" aria-label="成员账号">
        <div className="ki-card__head u2-members-head">
          <div className="u2-members-title">
            <h3 className="ki-card__title">成员账号 · {members.length}</h3>
            <span className="u2-guard"><GuardIcon />仅管理员可见</span>
          </div>
          <span className="u2-card-hint">权限 / 状态 / 有效期 / Token 通过「编辑」管理</span>
        </div>
        {loading ? (
          <p className="ki-form-hint" style={{ padding: '20px' }}>正在读取…</p>
        ) : members.length === 0 ? (
          <div className="u2-empty">
            <strong>尚无成员账号</strong>
            点击右上角「新建账号」添加读写或只读账号。
          </div>
        ) : (
          <table className="u2-table">
            <thead>
              <tr>
                <th>账号</th><th>权限</th><th>状态</th><th>有效期</th><th>MCP Token</th><th>最近登录</th><th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {members.map((user) => (
                <tr
                  key={user.id}
                  className={`u2-row--clickable${user.disabled ? ' u2-row--disabled' : ''}`}
                  tabIndex={0}
                  title="点击查看账号详情"
                  aria-label={`查看 ${user.username} 的账号详情`}
                  onClick={(event) => {
                    drawerReturnFocus.current = event.currentTarget;
                    setDrawerTarget(user);
                  }}
                  onKeyDown={(event) => {
                    if ((event.target as HTMLElement).closest('button')) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      drawerReturnFocus.current = event.currentTarget;
                      setDrawerTarget(user);
                    }
                  }}
                >
                  <td data-label="账号" className="u2-td-user">
                    <span className="u2-user-cell">
                      <span className="u2-user-name" title={user.username}>{user.username}</span>
                      <span className="u2-row-chevron" aria-hidden="true">›</span>
                    </span>
                  </td>
                  <td data-label="权限"><PermissionBadge role={user.role} /></td>
                  <td data-label="状态"><UserStatusBadge user={user} /></td>
                  <td data-label="有效期"><ValidityText user={user} /></td>
                  <td data-label="MCP Token"><TokenCountCell count={user.tokenCount ?? 0} user={user} /></td>
                  <td data-label="最近登录"><span className="u2-time">{formatTime(user.lastLoginAt, true)}</span></td>
                  <td data-label="操作" className="u2-td-actions">
                    <div className="u2-actions">
                      <button
                        type="button"
                        className="ki-btn ki-btn--secondary ki-btn--small u2-btn"
                        onClick={(event) => { event.stopPropagation(); setEditTarget(user); }}
                      >编辑</button>
                      <button
                        type="button"
                        className="ki-btn ki-btn--secondary ki-btn--small u2-btn u2-btn--danger"
                        onClick={(event) => { event.stopPropagation(); setDeleteTarget(user); }}
                      >删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {createOpen ? (
        <CreateUserDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            setNotice('账号已创建');
            void reload();
          }}
        />
      ) : null}

      {editTarget ? (
        <UserEditDialog
          user={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={(message) => {
            setEditTarget(null);
            setNotice(message);
            void reload();
          }}
          onTokensChanged={() => void reload()}
        />
      ) : null}

      {drawerTarget ? (
        <UserDrawer user={drawerTarget} onClose={closeDrawer} />
      ) : null}

      {deleteTarget ? (
        <UserConfirmDialog
          title={`删除账号 · ${deleteTarget.username}`}
          confirmLabel="删除账号"
          busy={deleting}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
          body={(
            <>
              <ul className="u2-danger-list">
                <li><span className="ok">✓</span><span>该账号立即无法登录本页面</span></li>
                <li><span className="ok">✓</span><span>已登录的会话立即失效</span></li>
                <li><span className="ok">✓</span><span>该账号的 MCP Token 立即失效并被删除</span></li>
                <li><span className="ok">✓</span><span>该账号的对话记录仍保留，仅管理员可访问</span></li>
              </ul>
              <p className="u2-danger-note">此操作不可撤销。</p>
            </>
          )}
        />
      ) : null}

      {passwordOpen ? (
        <ChangePasswordDialog
          onClose={() => setPasswordOpen(false)}
          onSaved={() => {
            setNotice('密码已修改');
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
