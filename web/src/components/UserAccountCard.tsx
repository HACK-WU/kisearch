/**
 * 账号卡片（用户管理当前管理员 / 个人中心我的账号，REQ-20261104-001）。
 */
import type { JSX, ReactNode } from 'react';
import type { Role } from '@/api/authApi';
import {
  PERMISSION_LABEL,
  accountStatus,
  formatTime,
  permissionDescription,
} from '@/lib/usersPageModel';
import { RoleChip, UserStatusBadge, ValidityText } from './UserBadges';

function LockIcon({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="10" height="6.5" rx="1.5" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}

function InfoIcon({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v4M8 4.8h.01" />
    </svg>
  );
}

export interface AccountCardUser {
  id: string | null;
  username: string;
  role: Role;
  disabled?: boolean;
  expiresAt?: string | null;
  createdAt?: string | null;
  lastLoginAt?: string | null;
}

export interface UserAccountCardProps {
  user: AccountCardUser;
  title: string;
  action?: ReactNode;
  localAdmin?: boolean;
}

export function UserAccountCard({ user, title, action, localAdmin }: UserAccountCardProps): JSX.Element {
  const isAdmin = user.role === 'admin';
  const status = accountStatus({
    role: user.role,
    disabled: user.disabled === true,
    expiresAt: user.expiresAt ?? null,
  });
  const initial = user.username.slice(0, 1).toUpperCase();
  return (
    <section className="ki-card u2-admin-card" aria-label={title}>
      <div className="ki-card__head u2-admin-head">
        <h3 className="ki-card__title">{title}</h3>
        {action}
      </div>
      <div className="u2-admin">
        <div className="u2-admin__identity">
          <div className="u2-avatar" aria-hidden="true">{initial}</div>
          <div className="u2-admin__main">
            <div className="u2-title-row">
              <strong className="u2-admin__name">{user.username}</strong>
              <RoleChip role={user.role} />
            </div>
            <div className="u2-admin__perm">
              {isAdmin ? <LockIcon size={13} /> : null}
              <span>{isAdmin ? PERMISSION_LABEL.admin : permissionDescription(user.role)}</span>
              {isAdmin ? <span className="u2-admin__perm-fixed">固定，不可修改</span> : null}
            </div>
            <div className="u2-admin__lock-inline">
              {isAdmin ? <LockIcon /> : <InfoIcon />}
              <span>
                {localAdmin
                  ? '本机免登录 · 管理员身份'
                  : isAdmin
                    ? '唯一管理员：不可降级、禁用、删除'
                    : '如需调整，请联系管理员'}
              </span>
            </div>
          </div>
        </div>
        <div className="u2-admin__facts">
          <div className="u2-fact"><span className="u2-fact__label">状态</span><span className="u2-fact__value"><UserStatusBadge user={{ role: user.role, disabled: user.disabled === true, expiresAt: user.expiresAt ?? null }} /></span></div>
          <div className="u2-fact"><span className="u2-fact__label">最近登录</span><span className="u2-fact__value">{formatTime(user.lastLoginAt, true)}</span></div>
          <div className="u2-fact"><span className="u2-fact__label">创建时间</span><span className="u2-fact__value">{formatTime(user.createdAt)}</span></div>
          <div className="u2-fact"><span className="u2-fact__label">账号有效期</span><span className="u2-fact__value"><ValidityText user={{ expiresAt: user.expiresAt ?? null }} /></span></div>
        </div>
      </div>
      {status === 'expired' ? (
        <p className="u2-hint u2-hint--warn" style={{ padding: '0 20px 16px' }}>账号已过期：无法登录，名下 Token 已失效；延长有效期后恢复。</p>
      ) : null}
    </section>
  );
}
