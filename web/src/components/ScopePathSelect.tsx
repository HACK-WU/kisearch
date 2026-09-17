/**
 * ScopePathSelect.tsx —— Scope 下拉选择与新建输入
 *
 * 与 GroupPathSelect 保持相同的 combobox 交互：已有 scope 可选，
 * 不存在的合法 scope 输入后回车确认，提交时由后端按现有 scope 语义自动创建。
 */

import { useEffect, useRef, useState } from 'react';
import { useScopeList } from '@/lib/hooks';
import { scopeError } from '@/lib/validators';

interface ScopePathSelectProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
}

const ICON_SCOPE = (
  <svg className="ki-gtree-icon" viewBox="0 0 16 16" fill="none">
    <path
      d="M2.2 3.1c0-.55.45-1 1-1h3.1l1.25 1.45h5.25c.55 0 1 .45 1 1v7.3c0 .55-.45 1-1 1H3.2c-.55 0-1-.45-1-1V3.1z"
      fill="#7db3ef"
      stroke="#5f97d6"
      strokeWidth="0.6"
    />
  </svg>
);

export function ScopePathSelect({ value, onChange, placeholder, hint, error }: ScopePathSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { data, isLoading } = useScopeList();
  const scopes = data?.scopes ?? [];
  const known = scopes.some((item) => item.scope === value.trim());
  const inputError = error ?? (value.trim() ? scopeError(value) : null);
  const isNew = !isLoading && !!value.trim() && !known && !inputError;

  useEffect(() => {
    if (!value) setConfirmed(false);
  }, [value]);

  useEffect(() => {
    const onDocClick = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const pick = (scope: string): void => {
    onChange(scope);
    setConfirmed(true);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (value.trim() && !inputError) {
      setConfirmed(true);
      setOpen(false);
    }
  };

  return (
    <div className="ki-combobox" ref={rootRef}>
      <div className="ki-combobox__input-wrap">
        <input
          className={`ki-form-input${isNew ? ' ki-form-input--new' : ''}${confirmed ? ' ki-form-input--confirmed' : ''}${inputError ? ' ki-form-input--error' : ''}`}
          placeholder={placeholder ?? '选择或输入 Scope 名称'}
          value={value}
          onChange={(event) => { setConfirmed(false); onChange(event.target.value); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          aria-invalid={inputError ? true : undefined}
        />
        {confirmed && <span className="ki-combobox__confirm">✓</span>}
        <button
          type="button"
          className={`ki-combobox__toggle${open ? ' ki-combobox__toggle--open' : ''}`}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      <div className={`ki-combobox__panel${open ? ' ki-combobox__panel--open' : ''}`}>
        <div className="ki-combobox__tree">
          {scopes.length === 0 ? (
            <div className="ki-cell-sub" style={{ padding: 6 }}>
              {isLoading ? '正在加载 Scope…' : '暂无已有 Scope，可直接输入新建'}
            </div>
          ) : (
            scopes.map((item) => (
              <div
                key={item.scope}
                className="ki-gtree-dir"
                onClick={(event) => {
                  event.stopPropagation();
                  pick(item.scope);
                }}
              >
                <span className="ki-gtree-arrow" />
                {ICON_SCOPE}
                <span className="ki-gtree-label">{item.scope}</span>
              </div>
            ))
          )}
        </div>
        <div className="ki-combobox__footer">
          <span className="ki-cell-sub">
            {inputError ? (
              <span style={{ color: 'var(--ki-color-danger)' }}>{inputError}</span>
            ) : confirmed ? (
              <span style={{ color: 'var(--ki-color-success)' }}>✓ 已确认：{value}</span>
            ) : isNew ? (
              <span style={{ color: 'var(--ki-color-success)' }}>✚ 将新建 Scope：{value}（回车确认）</span>
            ) : value ? (
              <span style={{ color: 'var(--ki-color-primary)' }}>✓ 已有 Scope</span>
            ) : (
              '输入新名称可新建 Scope'
            )}
          </span>
        </div>
      </div>
      {hint && !inputError && <div className="ki-form-hint">{hint}</div>}
      {inputError && <div className="ki-form-error">{inputError}</div>}
    </div>
  );
}
