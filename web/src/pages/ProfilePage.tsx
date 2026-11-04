/**
 * ProfilePage.tsx —— 个人中心（REQ-20261104-001）
 * 普通用户只看到账号 + 自己的 MCP Token；管理员也可从这里管理自己的 Token。
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  AuthApiError,
  createMyToken,
  listMyTokens,
  revokeMyToken,
  type UserTokenView,
} from '@/api/authApi';
import { useAuth } from '@/lib/authContext';
import { Notice } from '@/components/Notice';
import { ChangePasswordDialog } from '@/components/ChangePasswordDialog';
import { UserAccountCard } from '@/components/UserAccountCard';
import { UserDialog } from '@/components/UserDialog';
import { UserConfirmDialog } from '@/components/UserConfirmDialog';
import { TokenCreateForm, TokenNote, TokenSecretPanel, UserTokenTable, type TokenCreateInput } from '@/components/UserTokenSection';
import {
  TOKEN_LIMIT_USER,
  accountActive,
  describeUserError,
  tokenCountLabel,
  tokenLimitHint,
} from '@/lib/usersPageModel';

export function ProfilePage(): JSX.Element {
  const { user, source, refresh } = useAuth();
  const [tokens, setTokens] = useState<UserTokenView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [secret, setSecret] = useState<{ token: string; item: UserTokenView } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<UserTokenView | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await listMyTokens();
      setTokens(result.tokens);
      setError(null);
    } catch (err) {
      setError(err instanceof AuthApiError ? describeUserError(err.code, err.message) : 'Token 读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void reload();
    else setLoading(false);
  }, [reload, user]);

  if (!user) {
    return (
      <section className="ki-card">
        <div className="ki-card__body">
          <h2 className="ki-card__title">个人中心</h2>
          <p className="ki-form-hint">Token 身份没有个人中心；请使用账号登录。</p>
        </div>
      </section>
    );
  }

  const active = accountActive({
    role: user.role,
    disabled: user.disabled === true,
    expiresAt: user.expiresAt ?? null,
  });
  const capReached = user.role !== 'admin' && tokens.length >= TOKEN_LIMIT_USER;
  const createDisabled = !active || capReached;
  const createTitle = !active ? '账号已禁用或已过期，无法创建 Token' : capReached ? `已达 ${TOKEN_LIMIT_USER} 个 Token 上限，请先撤销一个` : '';
  const capHint = tokenLimitHint(user.role, tokens.length);

  const submitCreate = async (input: TokenCreateInput): Promise<void> => {
    setCreateBusy(true);
    try {
      const result = await createMyToken(input);
      setCreateOpen(false);
      setSecret({ token: result.token, item: result.item });
      setNotice('Token 已创建');
      await reload();
    } catch (err) {
      throw new Error(err instanceof AuthApiError ? describeUserError(err.code, err.message) : 'Token 创建失败');
    } finally {
      setCreateBusy(false);
    }
  };

  const confirmRevoke = async (): Promise<void> => {
    if (!revokeTarget) return;
    setRevokeBusy(true);
    try {
      await revokeMyToken(revokeTarget.id);
      setRevokeTarget(null);
      setNotice('Token 已撤销');
      await reload();
    } catch (err) {
      setError(err instanceof AuthApiError ? describeUserError(err.code, err.message) : '撤销失败');
    } finally {
      setRevokeBusy(false);
    }
  };

  return (
    <div className="u2-personal">
      <div className="u2-page-head">
        <div>
          <p>查看你的账号信息与 MCP Token；账号与权限由管理员管理。</p>
        </div>
      </div>

      {error ? <Notice tone="warn" title="操作失败" onClose={() => setError(null)}>{error}</Notice> : null}
      {notice ? <Notice tone="success" title={notice} onClose={() => setNotice(null)}><span /></Notice> : null}

      <UserAccountCard
        user={{
          id: user.id,
          username: user.username,
          role: user.role,
          disabled: user.disabled === true,
          expiresAt: user.expiresAt ?? null,
          createdAt: user.createdAt ?? null,
          lastLoginAt: user.lastLoginAt ?? null,
        }}
        title="我的账号"
        localAdmin={source === 'local'}
        action={source === 'session' ? (
          <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={() => setPasswordOpen(true)}>修改密码</button>
        ) : undefined}
      />

      <TokenNote />

      <section className="ki-card" aria-label="MCP Token">
        <div className="ki-card__head u2-token-head">
          <h3 className="ki-card__title">MCP Token</h3>
          <div className="u2-token-head__right">
            <span className="u2-token-count">{loading ? '读取中…' : tokenCountLabel(user.role, tokens.length)}</span>
            <button
              type="button"
              className="ki-btn ki-btn--primary ki-btn--small"
              disabled={createDisabled}
              title={createTitle || undefined}
              onClick={() => { if (!createDisabled) setCreateOpen(true); }}
            >创建 Token</button>
          </div>
        </div>
        <div className="u2-token-card__body">
          {capHint ? <p className="u2-hint u2-hint--warn u2-token-card__hint">{capHint}</p> : null}
          {loading ? <p className="ki-form-hint" style={{ padding: '20px' }}>正在读取 Token…</p> : (
            <UserTokenTable
              tokens={tokens}
              ownerRole={user.role}
              busyTokenId={revokeBusy ? revokeTarget?.id ?? null : null}
              emptyHint="点击「创建 Token」生成一个给 MCP 客户端使用。"
              onRevoke={(token) => setRevokeTarget(token)}
            />
          )}
        </div>
      </section>

      {createOpen ? (
        <UserDialog title="创建 MCP Token" onClose={() => setCreateOpen(false)} busy={createBusy}>
          <TokenCreateForm
            ownerRole={user.role}
            busy={createBusy}
            onSubmit={submitCreate}
            onCancel={() => setCreateOpen(false)}
          />
        </UserDialog>
      ) : null}

      {secret ? (
        <UserDialog title="Token 已创建" onClose={() => setSecret(null)}>
          <TokenSecretPanel
            token={secret.token}
            label={secret.item.label}
            readOnly={secret.item.readOnly}
            scopes={secret.item.scopes}
            createdBy={secret.item.createdBy}
            onDismiss={() => setSecret(null)}
          />
        </UserDialog>
      ) : null}

      {revokeTarget ? (
        <UserConfirmDialog
          title={`撤销 Token · ${revokeTarget.label}`}
          confirmLabel="撤销 Token"
          busy={revokeBusy}
          onClose={() => setRevokeTarget(null)}
          onConfirm={() => void confirmRevoke()}
          body={(
            <>
              <ul className="u2-danger-list">
                <li><span className="ok">✓</span><span>该 Token 立即失效</span></li>
                <li><span className="ok">✓</span><span>使用该 Token 的 MCP 客户端将无法连接</span></li>
                <li><span className="ok">✓</span><span>不会影响账号本身与其它 Token</span></li>
              </ul>
              <p className="u2-danger-note">此操作不可撤销。</p>
            </>
          )}
        />
      ) : null}

      {passwordOpen ? (
        <ChangePasswordDialog
          onClose={() => setPasswordOpen(false)}
          onSaved={() => { setNotice('密码已修改'); void refresh(); }}
        />
      ) : null}
    </div>
  );
}
