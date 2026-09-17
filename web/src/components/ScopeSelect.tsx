/** ScopeSelect.tsx —— 全局 scope 选择器（支持键盘输入与模糊过滤，不支持新建） */

import { useEffect, useRef, useState } from 'react';
import { useScope } from '@/lib/scopeContext';
import { useScopeList, type ScopeEntry } from '@/lib/hooks';

export function ScopeSelect(): JSX.Element {
  const { scope, setScope } = useScope();
  const { data, isLoading } = useScopeList();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const scopes = data?.scopes ?? [];
  const degraded = data != null && data.vectorAvailable === false;

  const options: ScopeEntry[] = scopes.some((item) => item.scope === scope)
    ? scopes
    : [{ scope, kb: false, vector: false, registered: false, wikiCount: 0 }, ...scopes];
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredScopes = normalizedFilter
    ? options.filter((item) => item.scope.toLowerCase().includes(normalizedFilter))
    : options;

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, []);

  const pick = (nextScope: string): void => {
    setScope(nextScope);
    setFilter('');
    setOpen(false);
  };

  const openPicker = (): void => {
    if (isLoading) return;
    setFilter('');
    setOpen(true);
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setFilter('');
      setOpen(false);
    } else if (event.key === 'Enter' && filteredScopes.length === 1) {
      event.preventDefault();
      pick(filteredScopes[0].scope);
    }
  };

  return (
    <div className="ki-scope-picker" ref={rootRef}>
      <div className="ki-scope-picker__input-wrap">
        <input
          className={`ki-scope-picker__input ki-form-input${open ? ' ki-scope-picker__input--open' : ''}`}
          value={open ? filter : scope}
          onFocus={() => { if (!open) openPicker(); }}
          onClick={() => { if (!open) openPicker(); }}
          onChange={(event) => {
            if (!open) setOpen(true);
            setFilter(event.target.value);
          }}
          onKeyDown={handleSearchKeyDown}
          placeholder={open ? '搜索 Scope…' : undefined}
          disabled={isLoading}
          autoComplete="off"
          aria-label="选择或搜索 Scope"
          aria-expanded={open}
          title={degraded
            ? `向量层暂不可用，仅显示 KB 层 scope${data?.vectorReason ? `：${data.vectorReason}` : ''}`
            : '当前知识库（scope）'}
        />
        <button
          type="button"
          className={`ki-scope-picker__toggle${open ? ' ki-scope-picker__toggle--open' : ''}`}
          onClick={() => (open ? setOpen(false) : openPicker())}
          disabled={isLoading}
          aria-label="展开 Scope 列表"
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      {open && (
        <div className="ki-scope-picker__panel" role="listbox" aria-label="选择 Scope">
          <div className="ki-scope-picker__options">
            {filteredScopes.length === 0 ? (
              <div className="ki-scope-picker__empty">没有匹配的 Scope</div>
            ) : (
              filteredScopes.map((item) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={item.scope === scope}
                  className={`ki-scope-picker__option${item.scope === scope ? ' ki-scope-picker__option--active' : ''}`}
                  key={item.scope}
                  onClick={() => pick(item.scope)}
                >
                  <span>{item.scope}</span>
                  {item.scope === scope && <span className="ki-scope-picker__check">✓</span>}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
