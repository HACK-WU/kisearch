/**
 * 用户 MCP Token 列表 / 内联创建表单 / 明文展示（REQ-20261104-001）。
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { Role, UserTokenView } from '@/api/authApi';
import { ScopeMultiPicker } from '@/components/ScopeMultiPicker';
import { useScopeList } from '@/lib/hooks';
import {
  tokenCreatorLabel,
  tokenModeLabel,
  tokenScopeLabel,
  tokenTightened,
  formatTime,
  validateTokenLabel,
} from '@/lib/usersPageModel';

function KeyIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5.5" cy="5.5" r="3" />
      <path d="M7.8 7.8 13 13M11 11l1.8-1.8M12.6 12.6l1.6-1.6" />
    </svg>
  );
}

export function InfoIcon({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v4M8 4.8h.01" />
    </svg>
  );
}

const TOKEN_NOTE = '用于 MCP 客户端连接本知识库；Token 明文只在创建时显示一次。';

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* 非安全上下文或权限被拒，走 textarea 兜底 */
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('复制失败');
}

export function TokenNote(): JSX.Element {
  return (
    <p className="u2-token-note">
      <InfoIcon />
      <span>{TOKEN_NOTE}</span>
    </p>
  );
}

export interface UserTokenTableProps {
  tokens: UserTokenView[];
  ownerRole: Role;
  showActions?: boolean;
  busyTokenId?: string | null;
  emptyHint?: string;
  onRevoke?: (token: UserTokenView) => void;
}

export function UserTokenTable({
  tokens,
  ownerRole,
  showActions = true,
  busyTokenId,
  emptyHint,
  onRevoke,
}: UserTokenTableProps): JSX.Element {
  if (tokens.length === 0) {
    return (
      <div className="u2-token-empty">
        <strong>尚未创建 Token</strong>
        {emptyHint ?? '点击「新增 Token」为账号创建 MCP Token。'}
      </div>
    );
  }
  return (
    <table className={`u2-token-table ${showActions ? 'u2-token-table--actions' : 'u2-token-table--readonly'}`}>
      <thead>
        <tr>
          <th>名称</th><th>权限</th><th>访问范围</th><th>创建者</th><th>创建时间</th>
          {showActions ? <th style={{ textAlign: 'right' }}>操作</th> : null}
        </tr>
      </thead>
      <tbody>
        {tokens.map((token) => {
          const tightened = tokenTightened(token, ownerRole);
          return (
            <tr key={token.id}>
              <td data-label="名称" className="u2-td-token-name">
                <span className="u2-token-name" title={token.label}>
                  <KeyIcon />
                  <span>{token.label}</span>
                </span>
              </td>
              <td data-label="权限">
                <span
                  className={`u2-perm ${token.readOnly ? 'u2-perm--viewer' : 'u2-perm--editor'}`}
                  title={tightened ? '账号为只读，该 Token 的实际权限已收紧为只读' : undefined}
                >
                  {tokenModeLabel(token.readOnly)}
                </span>
              </td>
              <td data-label="访问范围">
                <span className="u2-token-scope" title={tokenScopeLabel(token.scopes)}>{tokenScopeLabel(token.scopes)}</span>
              </td>
              <td data-label="创建者"><span className="u2-token-creator">{tokenCreatorLabel(token.createdBy)}</span></td>
              <td data-label="创建时间"><span className="u2-time">{formatTime(token.createdAt, true)}</span></td>
              {showActions ? (
                <td data-label="操作" className="u2-td-token-actions">
                  <div className="u2-token-actions">
                    <button
                      type="button"
                      className="ki-btn ki-btn--secondary ki-btn--small u2-btn u2-btn--quiet-danger"
                      disabled={busyTokenId === token.id}
                      onClick={() => onRevoke?.(token)}
                    >撤销</button>
                  </div>
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface TokenCreateInput {
  label: string;
  readOnly: boolean;
  scopes: string[];
}

export interface TokenCreateFormProps {
  ownerRole: Role;
  busy?: boolean;
  submitLabel?: string;
  onSubmit: (input: TokenCreateInput) => Promise<void> | void;
  onCancel: () => void;
}

export function TokenCreateForm({ ownerRole, busy, submitLabel = '创建 Token', onSubmit, onCancel }: TokenCreateFormProps): JSX.Element {
  const viewer = ownerRole === 'viewer';
  const [label, setLabel] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [scopeMode, setScopeMode] = useState<'all' | 'specific'>('all');
  const [scopes, setScopes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const { data } = useScopeList();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      rootRef.current?.scrollIntoView({ block: 'nearest' });
      labelRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const submit = async (): Promise<void> => {
    const labelError = validateTokenLabel(label);
    if (labelError) {
      setError(labelError);
      return;
    }
    if (scopeMode === 'specific' && scopes.length === 0) {
      setError('请至少选择一个知识库');
      return;
    }
    setError(null);
    try {
      await onSubmit({
        label: label.trim(),
        readOnly: viewer ? true : readOnly,
        scopes: scopeMode === 'all' ? ['all'] : scopes,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Token 创建失败');
    }
  };

  return (
    <div className="u2-inline-panel" ref={rootRef}>
      <div className="u2-inline-panel__head">
        <span className="u2-inline-panel__title">新增 Token</span>
        <span className="u2-hint">明文只显示一次</span>
      </div>
      <div className="u2-inline-panel__body">
        <label className="u2-inline-panel__field">
          <span>名称</span>
          <input
            ref={labelRef}
            className="ki-form-input"
            value={label}
            maxLength={64}
            placeholder="例如：Claude Desktop"
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <div className="u2-inline-panel__row">
          <div className="u2-inline-panel__field">
            <span>权限</span>
            <div className="ki-segmented u2-seg u2-inline-panel__seg" role="group" aria-label="Token 权限">
              <button type="button" aria-pressed={readOnly} onClick={() => setReadOnly(true)}>只读</button>
              <button
                type="button"
                aria-pressed={!readOnly}
                disabled={viewer}
                title={viewer ? '只读账号只能创建只读 Token' : undefined}
                onClick={() => setReadOnly(false)}
              >读写</button>
            </div>
          </div>
          <div className="u2-inline-panel__field">
            <span>访问范围</span>
            <div className="ki-segmented u2-seg u2-inline-panel__seg" role="group" aria-label="访问范围">
              <button type="button" aria-pressed={scopeMode === 'all'} onClick={() => setScopeMode('all')}>全部</button>
              <button type="button" aria-pressed={scopeMode === 'specific'} onClick={() => setScopeMode('specific')}>指定</button>
            </div>
          </div>
        </div>
        {scopeMode === 'specific' ? (
          /*
           * 与「新建视图 → 包含哪些知识库」共用同一个选择器：库多时（几十个）
           * 平铺 chips 只能滚动找，也没有"已选 / 未选"的分层。
           * 这里不显示「维度不一致」—— 那份数据来自 /api/views 的 memberMeta，
           * 不属于 Token 表单的口径；「只读 / 仅全文」对"授权后能做什么"有影响，保留。
           */
          <ScopeMultiPicker
            scopes={data?.scopes ?? []}
            value={scopes}
            onChange={setScopes}
            emptyHint="还没有选择知识库"
            maxWidth="100%"
            /* 弹窗内没有多余高度：面板浮层展开，避免把提示行与「创建」按钮推出可视区 */
            floating
            optionMeta={(info) => (
              <>
                {!info.vector && <span className="sp-tag">仅全文</span>}
                {info.readonly && <span className="sp-tag sp-tag--ro">只读</span>}
              </>
            )}
            optionTitle={(info) => (info.readonly
              ? '只读库：Token 授权后也只能检索，不能写入'
              : undefined)}
          />
        ) : null}
        <p className="u2-hint">
          {viewer ? '只读账号只能创建只读 Token。' : 'Token 权限不会超过账号权限。'}
          {readOnly ? '只读 Token 仅能检索与读取知识库。' : '读写 Token 可写知识、使用 AI 写工具；数据源写、用户管理与删除任务仍不可用。'}
        </p>
        {error ? <p className="u2-inline-error">{error}</p> : null}
      </div>
      <div className="u2-inline-panel__actions">
        <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={onCancel} disabled={busy}>取消</button>
        <button type="button" className="ki-btn ki-btn--primary ki-btn--small" onClick={() => void submit()} disabled={busy}>
          {busy ? '创建中…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

export interface TokenSecretPanelProps {
  token: string;
  label: string;
  readOnly: boolean;
  scopes: string[];
  createdBy: UserTokenView['createdBy'];
  onDismiss: () => void;
}

export function TokenSecretPanel({ token, label, readOnly, scopes, createdBy, onDismiss }: TokenSecretPanelProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => copyRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const copy = async (): Promise<void> => {
    try {
      await writeClipboard(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="u2-token-created-inline">
      <p className="u2-hint u2-hint--warn">Token 已创建；请立即复制保存，关闭弹窗后无法再次查看。</p>
      <div className="u2-token-secret">
        <code>{token}</code>
        <button ref={copyRef} type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <p className="u2-hint">
        {label} · {tokenModeLabel(readOnly)} · {tokenScopeLabel(scopes)} · 创建者 {tokenCreatorLabel(createdBy)}
      </p>
      <div className="u2-inline-panel__actions">
        <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={onDismiss}>我已保存</button>
      </div>
    </div>
  );
}

