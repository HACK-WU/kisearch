/**
 * 用户管理页 v2 共享徽标 / 状态（REQ-20261104-001）。
 */
import type { JSX } from 'react';
import type { Role } from '@/api/authApi';
import {
  PERMISSION_LABEL,
  ROLE_LABEL,
  STATUS_LABEL,
  accountStatus,
  type AccountLike,
} from '@/lib/usersPageModel';

export function PermissionBadge({ role }: { role: Role }): JSX.Element {
  const cls = role === 'admin' ? 'u2-perm--admin' : role === 'editor' ? 'u2-perm--editor' : 'u2-perm--viewer';
  return <span className={`u2-perm ${cls}`}>{PERMISSION_LABEL[role]}</span>;
}

export function RoleChip({ role }: { role: Role }): JSX.Element {
  return (
    <span className={`u2-chip ${role === 'viewer' ? 'u2-chip--viewer' : 'u2-chip--role'}`}>
      {role === 'admin' ? '管理员 · 唯一' : ROLE_LABEL[role]}
    </span>
  );
}

export function UserStatusBadge({ user }: { user: AccountLike }): JSX.Element {
  const status = accountStatus(user);
  return <span className={`u2-status u2-status--${status === 'active' ? 'on' : status === 'expired' ? 'expired' : 'off'}`}>{STATUS_LABEL[status]}</span>;
}

export function ValidityText({ user, now }: { user: Pick<AccountLike, 'expiresAt'>; now?: number }): JSX.Element {
  if (!user.expiresAt) return <span className="u2-validity u2-validity--never">永久</span>;
  const at = Date.parse(user.expiresAt);
  const expired = Number.isFinite(at) && at <= (now ?? Date.now());
  const text = user.expiresAt.replace('T', ' ').slice(0, 16);
  return <span className={`u2-validity${expired ? ' u2-validity--expired' : ''}`}>{text}</span>;
}

export function TokenCountCell({ count, user }: { count: number; user: AccountLike }): JSX.Element {
  if (count === 0) return <span className="u2-token-count-cell u2-token-count-cell--zero">0</span>;
  if (accountStatus(user) !== 'active') {
    return (
      <span className="u2-token-count-cell u2-token-count-cell--invalid" title="账号已禁用或过期，Token 已失效">
        {count}<em>已失效</em>
      </span>
    );
  }
  return <span className="u2-token-count-cell">{count}</span>;
}
