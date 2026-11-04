/**
 * 账号详情抽屉（REQ-20261104-001）：只读，宽度与数据源详情一致。
 */
import { useEffect, useState, type JSX } from 'react';
import { AuthApiError, listUserTokens, type UserTokenView, type UserView } from '@/api/authApi';
import { DetailDrawer, DetailSection } from './DetailDrawer';
import { PermissionBadge, RoleChip, ValidityText } from './UserBadges';
import { TokenNote, UserTokenTable } from './UserTokenSection';
import { TOKEN_LIMIT_USER, accountStatus, formatTime } from '@/lib/usersPageModel';

export interface UserDrawerProps {
  user: UserView;
  onClose: () => void;
}

export function UserDrawer({ user, onClose }: UserDrawerProps): JSX.Element {
  const [tokens, setTokens] = useState<UserTokenView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const status = accountStatus(user);
  const invalid = status !== 'active';

  useEffect(() => {
    let alive = true;
    setLoading(true);
    listUserTokens(user.id)
      .then((result) => {
        if (!alive) return;
        setTokens(result.tokens);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof AuthApiError ? err.message : 'Token 读取失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [user.id]);

  const statusView = status === 'active'
    ? { tone: 'succeeded' as const, label: '启用' }
    : status === 'expired'
      ? { tone: 'partial' as const, label: '已过期' }
      : { tone: 'cancelled' as const, label: '已禁用' };

  return (
    <DetailDrawer
      ariaLabel={`账号详情：${user.username}`}
      title={`账号详情 · ${user.username}`}
      status={statusView}
      meta={<>{user.role === 'admin' ? '管理员' : user.role === 'editor' ? '读写账号' : '只读账号'} · 最近登录 {formatTime(user.lastLoginAt, true)}</>}
      onClose={onClose}
    >
      <DetailSection title="账号信息" material="meta">
        <div className="u2-drawer-profile">
          <div className="u2-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</div>
          <div>
            <div className="u2-drawer-profile__name">{user.username}</div>
            <div className="u2-drawer-profile__sub">
              <RoleChip role={user.role} />
              <PermissionBadge role={user.role} />
            </div>
          </div>
        </div>
        <dl className="u2-drawer-facts">
          <div><dt>账号有效期</dt><dd><ValidityText user={user} /></dd></div>
          <div><dt>创建时间</dt><dd>{formatTime(user.createdAt)}</dd></div>
          <div><dt>账号 ID</dt><dd><code>{user.id}</code></dd></div>
        </dl>
      </DetailSection>

      <DetailSection
        title="MCP Token"
        material="data"
        actions={<span className="u2-token-count">{tokens.length} / {user.role === 'admin' ? '不限' : TOKEN_LIMIT_USER}</span>}
      >
        <TokenNote />
        {invalid && tokens.length > 0 ? (
          <p className="u2-hint u2-hint--warn">
            该账号{status === 'disabled' ? '已禁用' : '已过期'}，以下 Token 已全部失效；
            {status === 'disabled' ? '启用' : '延长有效期'}后恢复。
          </p>
        ) : null}
        {error ? <p className="u2-inline-error">{error}</p> : null}
        {loading ? <p className="u2-hint">正在读取 Token…</p> : (
          <UserTokenTable tokens={tokens} ownerRole={user.role} showActions={false} emptyHint="该账号尚未创建 Token。" />
        )}
      </DetailSection>
    </DetailDrawer>
  );
}
