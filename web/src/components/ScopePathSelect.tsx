/**
 * ScopePathSelect.tsx —— 显式选择本次操作的目标 Scope。
 *
 * 已有 Scope 与新建 Scope 使用分开的选择流程；父组件只在用户点击已有项
 * 或确认合法的新名称后收到已确认的目标，避免把全局 Scope 当成默认写入目标。
 */

import { useState } from 'react';
import { useScopeList } from '@/lib/hooks';
import { scopeError } from '@/lib/validators';

interface ScopePathSelectProps {
  value: string;
  confirmed: boolean;
  currentScope: string;
  onChange: (value: string, confirmed: boolean) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
}

const ICON_SCOPE = (
  <svg className="ki-gtree-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M2.2 3.1c0-.55.45-1 1-1h3.1l1.25 1.45h5.25c.55 0 1 .45 1 1v7.3c0 .55-.45 1-1 1H3.2c-.55 0-1-.45-1-1V3.1z"
      fill="#7db3ef"
      stroke="#5f97d6"
      strokeWidth="0.6"
    />
  </svg>
);

export function ScopePathSelect({
  value,
  confirmed,
  currentScope,
  onChange,
  placeholder,
  hint,
  error,
  disabled = false,
}: ScopePathSelectProps): JSX.Element {
  const [mode, setMode] = useState<'existing' | 'new' | null>(null);
  const [scopeFilter, setScopeFilter] = useState('');
  const [newScope, setNewScope] = useState('');
  const [newScopeListRefreshPending, setNewScopeListRefreshPending] = useState(false);
  const { data, isLoading, isFetching, isError, refetch } = useScopeList();
  const scopeListFailed = isError || !data || data.ok === false || !Array.isArray(data.scopes);
  const scopes = scopeListFailed ? [] : (data?.scopes ?? []);
  const trimmedNewScope = newScope.trim();
  const newScopeError = trimmedNewScope ? scopeError(trimmedNewScope) : null;
  const alreadyExists = scopes.some((item) => item.scope === trimmedNewScope);
  const filteredScopes = scopes.filter((item) => item.scope.toLocaleLowerCase().includes(scopeFilter.trim().toLocaleLowerCase()));

  const chooseMode = (next: 'existing' | 'new'): void => {
    setMode(next);
    setScopeFilter('');
    if (next === 'new') {
      setNewScope('');
      setNewScopeListRefreshPending(true);
      void refetch().then(
        () => setNewScopeListRefreshPending(false),
        () => setNewScopeListRefreshPending(false),
      );
    }
    onChange('', false);
  };

  const confirmNewScope = (): void => {
    if (disabled || newScopeListRefreshPending || scopeListFailed || isLoading || isFetching || !trimmedNewScope || newScopeError || alreadyExists) return;
    onChange(trimmedNewScope, true);
  };

  return (
    <div className="ki-scope-target">
      <div className="ki-scope-target__modes" role="group" aria-label="选择目标 Scope 类型">
        <button
          type="button"
          className={`ki-btn ki-btn--small${mode === 'existing' ? ' ki-btn--primary' : ' ki-btn--secondary'}`}
          aria-pressed={mode === 'existing'}
          onClick={() => chooseMode('existing')}
          disabled={disabled}
        >选择已有 Scope</button>
        <button
          type="button"
          className={`ki-btn ki-btn--small${mode === 'new' ? ' ki-btn--primary' : ' ki-btn--secondary'}`}
          aria-pressed={mode === 'new'}
          onClick={() => chooseMode('new')}
          disabled={disabled}
        >新建 Scope</button>
      </div>

      {mode === null && (
        <div className="ki-form-hint">
          当前全局 Scope：{currentScope || '未设置'}。它仅作参考，不会自动成为本次目标；请先选择已有 Scope 或新建 Scope。
        </div>
      )}

      {mode === 'existing' && (
        <div className="ki-scope-target__panel">
          <input
            className="ki-form-input"
            value={scopeFilter}
            onChange={(event) => setScopeFilter(event.target.value)}
            placeholder={placeholder ?? '按名称筛选已有 Scope'}
            autoComplete="off"
            disabled={disabled || isLoading || scopeListFailed}
            aria-label="筛选已有 Scope"
          />
          <div className="ki-scope-target__list" role="listbox" aria-label="已有 Scope">
            {isLoading ? (
              <div className="ki-cell-sub">正在加载 Scope…</div>
            ) : scopeListFailed ? (
              <div className="ki-scope-target__load-error" role="alert">
                <span>Scope 列表加载失败。为避免把已有 Scope 误判为新建目标，请重试后再选择。</span>
                <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={() => void refetch()}>重试</button>
              </div>
            ) : filteredScopes.length === 0 ? (
              <div className="ki-cell-sub">{scopes.length ? '没有匹配的 Scope' : '暂无已有 Scope'}</div>
            ) : filteredScopes.map((item) => (
              <div
                key={item.scope}
                className={`ki-gtree-dir${value === item.scope ? ' ki-gtree-dir--active' : ''}`}
                role="option"
                aria-selected={value === item.scope}
                tabIndex={disabled ? -1 : 0}
                onClick={() => { if (!disabled) onChange(item.scope, true); }}
                onKeyDown={(event) => {
                  if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onChange(item.scope, true);
                  }
                }}
              >
                <span className="ki-gtree-arrow" />
                {ICON_SCOPE}
                <span className="ki-gtree-label">{item.scope}</span>
                {value === item.scope && confirmed && <span className="ki-cell-sub">本次目标 ✓</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === 'new' && (
        <div className="ki-scope-target__panel">
          <div className="ki-scope-target__new-row">
            <input
              className={`ki-form-input${newScope && !newScopeError && !alreadyExists ? ' ki-form-input--new' : ''}${error || newScopeError || alreadyExists ? ' ki-form-input--error' : ''}`}
              value={newScope}
              onChange={(event) => { setNewScope(event.target.value); onChange('', false); }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); confirmNewScope(); } }}
              placeholder="输入新的 Scope 名称"
              autoComplete="off"
              aria-invalid={Boolean(error || newScopeError || alreadyExists) || undefined}
              disabled={disabled}
            />
            <button
              type="button"
              className="ki-btn ki-btn--secondary ki-btn--small"
              onClick={confirmNewScope}
              disabled={disabled || newScopeListRefreshPending || isLoading || isFetching || scopeListFailed || !trimmedNewScope || Boolean(newScopeError) || alreadyExists}
            >确认新建目标</button>
          </div>
          {newScopeListRefreshPending || isLoading || isFetching ? (
            <div className="ki-form-hint">正在确认 Scope 列表…</div>
          ) : scopeListFailed ? (
            <div className="ki-scope-target__load-error" role="alert">
              <span>Scope 列表加载失败，无法确认名称是否已存在。</span>
              <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={() => void refetch()}>重试 Scope 列表</button>
            </div>
          ) : newScopeError ? (
            <div className="ki-form-error">{newScopeError}</div>
          ) : alreadyExists ? (
            <div className="ki-form-error">此 Scope 已存在，请切换到“选择已有 Scope”。</div>
          ) : confirmed && value === trimmedNewScope ? (
            <div className="ki-form-hint" style={{ color: 'var(--ki-color-success)' }}>✓ 本次目标：新建 Scope「{value}」</div>
          ) : (
            <div className="ki-form-hint">确认后，提交导入/写入时会自动创建此 Scope。</div>
          )}
        </div>
      )}

      {mode === 'existing' && value && !confirmed && (
        <div className="ki-form-hint">已选「{value}」；每次操作前请重新点击列表中的 Scope 确认目标。</div>
      )}
      {mode === 'new' && value && !confirmed && !alreadyExists && (
        <div className="ki-form-hint">上次目标为「{value}」；请再次确认本次是否新建到此 Scope。</div>
      )}
      {error && <div className="ki-form-error">{error}</div>}
      {hint && !error && <div className="ki-form-hint">{hint}</div>}
    </div>
  );
}
