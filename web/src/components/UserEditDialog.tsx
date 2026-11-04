/**
 * 编辑成员弹窗（REQ-20261104-001）：权限/状态/有效期 + 即时密码重置 + 内联 MCP Token。
 * 成员行只保留「编辑 / 删除」，所有编辑都收在这里。
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import {
  AuthApiError,
  createUserToken,
  listUserTokens,
  revokeUserToken,
  updateUser,
  type Role,
  type UserTokenView,
  type UserView,
} from '@/api/authApi';
import { DateTimePicker } from './DateTimePicker';
import { UserDialog } from './UserDialog';
import { UserConfirmDialog } from './UserConfirmDialog';
import { TokenCreateForm, TokenSecretPanel, TokenNote, UserTokenTable, type TokenCreateInput } from './UserTokenSection';
import {
  accountActive,
  describeUserError,
  formatTime,
  hasPendingAccountSecurityChanges,
  tokenAddState,
  tokenCountLabel,
  validateExpiry,
  validatePassword,
} from '@/lib/usersPageModel';
import { defaultFromNow, formatLocalDateTime, toLocalDateTime } from '@/lib/datetimePicker';

function isoToLocalInput(iso?: string | null): string {
  if (!iso) return formatLocalDateTime(defaultFromNow(30 * 24 * 60));
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return formatLocalDateTime(defaultFromNow(30 * 24 * 60));
  return formatLocalDateTime(toLocalDateTime(date));
}

function draftExpiryIso(validity: 'never' | 'date', expiry: string): string | null {
  if (validity !== 'date' || !expiry) return null;
  const date = new Date(expiry);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface UserEditDialogProps {
  user: UserView;
  onClose: () => void;
  onSaved: (message: string) => void;
  onTokensChanged?: () => void;
}

export function UserEditDialog({ user, onClose, onSaved, onTokensChanged }: UserEditDialogProps): JSX.Element {
  const [role, setRole] = useState<Role>(user.role === 'viewer' ? 'viewer' : 'editor');
  const [disabled, setDisabled] = useState(user.disabled);
  const [validity, setValidity] = useState<'never' | 'date'>(user.expiresAt ? 'date' : 'never');
  const [expiry, setExpiry] = useState(() => isoToLocalInput(user.expiresAt));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const passwordOpenRef = useRef<HTMLButtonElement>(null);

  const [tokens, setTokens] = useState<UserTokenView[]>([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [inlineTokenOpen, setInlineTokenOpen] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ token: string; item: UserTokenView } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<UserTokenView | null>(null);

  const pending = hasPendingAccountSecurityChanges(
    user,
    {
      role,
      disabled,
      expiresAt: draftExpiryIso(validity, expiry),
    },
  );
  const originalExpiryInput = isoToLocalInput(user.expiresAt);
  const expiredUnchanged = Boolean(user.expiresAt)
    && Date.parse(user.expiresAt ?? '') <= Date.now()
    && validity === 'date'
    && expiry.slice(0, 16) === originalExpiryInput.slice(0, 16);
  const addState = tokenAddState({
    role: user.role,
    active: accountActive(user),
    tokenCount: tokens.length,
    pendingAccountChanges: pending,
    passwordPanelOpen: passwordOpen,
  });

  useEffect(() => {
    let alive = true;
    setTokensLoading(true);
    listUserTokens(user.id)
      .then((result) => {
        if (!alive) return;
        setTokens(result.tokens);
        setTokensError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setTokensError(err instanceof AuthApiError ? describeUserError(err.code, err.message) : 'Token 读取失败');
      })
      .finally(() => {
        if (alive) setTokensLoading(false);
      });
    return () => { alive = false; };
  }, [user.id]);

  const reloadTokens = async (): Promise<void> => {
    const result = await listUserTokens(user.id);
    setTokens(result.tokens);
  };

  const submitPassword = async (): Promise<void> => {
    const passwordValidation = validatePassword(password);
    if (passwordValidation) {
      setPasswordError(passwordValidation);
      return;
    }
    setPasswordBusy(true);
    setPasswordError(null);
    try {
      await updateUser(user.id, { password });
      setPasswordOpen(false);
      setPassword('');
      setNotice('密码已重置；该账号现有会话已失效');
      window.setTimeout(() => passwordOpenRef.current?.focus(), 0);
    } catch (err) {
      setPasswordError(err instanceof AuthApiError ? describeUserError(err.code, err.message) : '密码重置失败');
    } finally {
      setPasswordBusy(false);
    }
  };

  const submitToken = async (input: TokenCreateInput): Promise<void> => {
    setTokenBusy(true);
    setTokenError(null);
    try {
      const result = await createUserToken(user.id, input);
      setSecret({ token: result.token, item: result.item });
      setInlineTokenOpen(false);
      await reloadTokens();
      onTokensChanged?.();
    } catch (err) {
      const message = err instanceof AuthApiError ? describeUserError(err.code, err.message) : 'Token 创建失败';
      setTokenError(message);
      throw new Error(message);
    } finally {
      setTokenBusy(false);
    }
  };

  const confirmRevoke = async (): Promise<void> => {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setTokenBusy(true);
    try {
      await revokeUserToken(user.id, target.id);
      setRevokeTarget(null);
      await reloadTokens();
      onTokensChanged?.();
    } catch (err) {
      setTokenError(err instanceof AuthApiError ? describeUserError(err.code, err.message) : '撤销失败');
    } finally {
      setTokenBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (inlineTokenOpen) {
      setError('请先完成或取消「新增 Token」，再保存账号');
      return;
    }
    if (secret) {
      setError('请先点击「我已保存」确认已保存 Token 明文，再保存账号');
      return;
    }
    if (passwordOpen) {
      setError('请先完成或取消「重置密码」，再保存账号');
      return;
    }
    if (validity === 'date') {
      const original = isoToLocalInput(user.expiresAt);
      const expiryChanged = user.expiresAt ? expiry.slice(0, 16) !== original.slice(0, 16) : true;
      if (expiryChanged) {
        const expiryError = validateExpiry(expiry);
        if (expiryError) {
          setError(expiryError);
          return;
        }
      } else if (!expiry) {
        setError('请选择有效期时间');
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await updateUser(user.id, {
        role: role === 'viewer' ? 'viewer' : 'editor',
        disabled,
        expiresAt: draftExpiryIso(validity, expiry),
      });
      onSaved('已保存');
    } catch (err) {
      setError(err instanceof AuthApiError ? describeUserError(err.code, err.message) : '保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <UserDialog
      title={`编辑账号 · ${user.username}`}
      onClose={onClose}
      busy={saving || passwordBusy || tokenBusy || Boolean(revokeTarget)}
      wide
      footer={(
        <>
          <button type="button" className="ki-btn ki-btn--secondary" onClick={onClose} disabled={saving}>取消</button>
          <button type="button" className="ki-btn ki-btn--primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      )}
    >
      <div className="u2-dialog__meta">
        {user.username} · 创建于 {formatTime(user.createdAt)} · 最近登录 {formatTime(user.lastLoginAt, true)}
      </div>

      <div className="u2-edit-tools" hidden={passwordOpen}>
        <button
          ref={passwordOpenRef}
          type="button"
          className="ki-btn ki-btn--secondary ki-btn--small"
          disabled={inlineTokenOpen || passwordBusy}
          title={inlineTokenOpen ? '请先完成或取消「新增 Token」' : undefined}
          onClick={() => {
            if (inlineTokenOpen) return;
            setPasswordOpen(true);
            setPassword('');
            setPasswordError(null);
            setNotice(null);
            window.setTimeout(() => document.getElementById('ki-user-new-password')?.focus(), 30);
          }}
        >重置密码</button>
        <span className="u2-edit-tools__hint">
          {inlineTokenOpen ? '请先完成或取消「新增 Token」，再重置密码。' : '重置后该账号现有会话立即失效。'}
        </span>
      </div>

      {passwordOpen ? (
        <div className="u2-inline-panel">
          <div className="u2-inline-panel__head">
            <span className="u2-inline-panel__title">重置密码</span>
            <span className="u2-hint">重置后现有会话立即失效</span>
          </div>
          <div className="u2-inline-panel__body">
            <label className="u2-inline-panel__field">
              <span>新密码</span>
              <input
                id="ki-user-new-password"
                className="ki-form-input"
                type="password"
                autoComplete="new-password"
                placeholder="8-128 个字符"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submitPassword();
                  }
                }}
              />
            </label>
            <p className="u2-hint">新密码点「重置密码」后立即生效，与「保存」无关。</p>
            {passwordError ? <p className="u2-inline-error">{passwordError}</p> : null}
          </div>
          <div className="u2-inline-panel__actions">
            <button
              type="button"
              className="ki-btn ki-btn--secondary ki-btn--small"
              disabled={passwordBusy}
              onClick={() => {
                setPasswordOpen(false);
                setPassword('');
                setPasswordError(null);
                window.setTimeout(() => passwordOpenRef.current?.focus(), 0);
              }}
            >取消</button>
            <button type="button" className="ki-btn ki-btn--primary ki-btn--small" disabled={passwordBusy} onClick={() => void submitPassword()}>
              {passwordBusy ? '重置中…' : '重置密码'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="u2-form-grid">
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
          <span className="u2-field__label">状态</span>
          <div className="u2-field__control">
            <div className="ki-segmented u2-seg" role="group" aria-label="状态">
              <button type="button" aria-pressed={!disabled} onClick={() => setDisabled(false)}>启用</button>
              <button type="button" aria-pressed={disabled} onClick={() => setDisabled(true)}>禁用</button>
            </div>
            <p className="u2-hint">禁用后该账号立即无法登录，现有会话与 Token 失效。</p>
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
            {expiredUnchanged ? (
              <p className="u2-hint u2-hint--warn">
                该账号已过期：只保存其它字段后仍无法登录，需把有效期改到未来或选择永久。
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="u2-token-section">
        <div className="u2-token-section__head">
          <span className="u2-token-section__title">MCP Token</span>
          <span className="u2-token-count">{tokensLoading ? '读取中…' : tokenCountLabel(user.role, tokens.length)}</span>
          {!inlineTokenOpen ? (
            <button
              type="button"
              className="ki-btn ki-btn--secondary ki-btn--small"
              disabled={addState.disabled}
              title={addState.title || undefined}
              onClick={() => {
                if (addState.disabled) return;
                setInlineTokenOpen(true);
                setTokenError(null);
                setSecret(null);
              }}
            >新增 Token</button>
          ) : null}
        </div>
        <TokenNote />
        {addState.hint ? <p className="u2-hint u2-hint--warn">{addState.hint}</p> : null}
        {tokensError ? <p className="u2-inline-error">{tokensError}</p> : null}
        {inlineTokenOpen ? (
          <TokenCreateForm
            ownerRole={user.role}
            busy={tokenBusy}
            onSubmit={submitToken}
            onCancel={() => {
              setInlineTokenOpen(false);
              setTokenError(null);
            }}
          />
        ) : null}
        {tokenError && !inlineTokenOpen ? <p className="u2-inline-error">{tokenError}</p> : null}
        {secret ? (
          <TokenSecretPanel
            token={secret.token}
            label={secret.item.label}
            readOnly={secret.item.readOnly}
            scopes={secret.item.scopes}
            createdBy={secret.item.createdBy}
            onDismiss={() => setSecret(null)}
          />
        ) : null}
        {tokensLoading ? <p className="u2-hint">正在读取 Token…</p> : (
          <UserTokenTable
            tokens={tokens}
            ownerRole={user.role}
            busyTokenId={tokenBusy ? revokeTarget?.id ?? null : null}
            onRevoke={(token) => setRevokeTarget(token)}
          />
        )}
        <p className="u2-hint">Token 创建后立即生效，与「保存」无关；修改权限、禁用或删除账号会立即影响现有 Token。</p>
      </div>

      {notice ? <p className="u2-hint" style={{ color: 'var(--ki-color-success)' }}>{notice}</p> : null}
      {error ? <p className="u2-inline-error" role="alert">{error}</p> : null}
    </UserDialog>
    {revokeTarget ? (
      <UserConfirmDialog
        title={`撤销 Token · ${revokeTarget.label}`}
        confirmLabel="撤销 Token"
        busy={tokenBusy}
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
    </>
  );
}
