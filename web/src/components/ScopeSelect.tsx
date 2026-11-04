/** ScopeSelect.tsx —— 全局 scope 选择器（支持键盘输入与模糊过滤，不支持新建） */

import { useEffect, useRef, useState } from 'react';
import { useScope } from '@/lib/scopeContext';
import { useScopeList, type ScopeEntry } from '@/lib/hooks';
import { getLastView } from '@/lib/lastView';

export function ScopeSelect(): JSX.Element {
  const { scope, setScope } = useScope();
  const { data, isLoading } = useScopeList();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const scopes = data?.scopes ?? [];
  const views = data?.views ?? [];
  const degraded = data != null && data.vectorAvailable === false;

  /**
   * 两级：视图（只读聚合）在上，单个知识库在下。
   *
   * 无视图时（旧版 daemon / 尚未创建）退化成**改造前的平面列表**，一个像素都不变。
   * 当前值不在任何一组里时补一条占位到「单个知识库」，避免选择器显示空白。
   */
  const isView = views.some((v) => v.view === scope);
  const options: ScopeEntry[] = scopes.some((item) => item.scope === scope) || isView
    ? scopes
    : [{ scope, kb: false, vector: false, registered: false, wikiCount: 0, ftsOnlyDocCount: 0 }, ...scopes];

  const normalizedFilter = filter.trim().toLowerCase();
  const match = (name: string): boolean => !normalizedFilter || name.toLowerCase().includes(normalizedFilter);
  const filteredViews = views.filter((v) => match(v.view));
  const filteredScopes = options.filter((item) => match(item.scope));
  /** 键盘 Enter 用：两组拉平后的顺序（视图在前，与视觉顺序一致） */
  const flatNames = [...filteredViews.map((v) => v.view), ...filteredScopes.map((s) => s.scope)];

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
    } else if (event.key === 'Enter' && flatNames.length === 1) {
      event.preventDefault();
      pick(flatNames[0]);
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
            {flatNames.length === 0 && (
              <div className="ki-scope-picker__empty">没有匹配的 Scope 或视图</div>
            )}

            {filteredViews.length > 0 && (
              <>
                {views.length > 0 && scopes.length > 0 && (
                  <div className="ki-scope-picker__group">视图（只读聚合）</div>
                )}
                {filteredViews.map((v) => {
                  const hasReadonly = v.memberMeta.some((m) => m.readonly);
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={v.view === scope}
                      className={`ki-scope-picker__option${v.view === scope ? ' ki-scope-picker__option--active' : ''}`}
                      key={`view:${v.view}`}
                      onClick={() => pick(v.view)}
                    >
                      {/*
                        名称与元信息**纵向堆叠**：下拉面板很窄（约 200px），
                        横向并排会把 "demo-view" 挤成两行、"2 个库 · 含只读" 挤成碎片。
                        也刻意不加图标：emoji 在不同字体下渲染不一致（会变成彩色方块）。
                      */}
                      <span className="ki-scope-picker__label">
                        <span className="ki-scope-picker__name">{v.view}</span>
                        <span className="ki-scope-picker__meta">
                          {v.members.length} 个库{hasReadonly ? ' · 含只读' : ''}
                          {v.missing.length > 0 ? ` · ${v.missing.length} 缺失` : ''}
                        </span>
                      </span>
                      {v.view === scope && <span className="ki-scope-picker__check">✓</span>}
                    </button>
                  );
                })}
              </>
            )}

            {filteredScopes.length > 0 && (
              <>
                {views.length > 0 && scopes.length > 0 && (
                  <div className="ki-scope-picker__group">单个知识库</div>
                )}
                {filteredScopes.map((item) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={item.scope === scope}
                    className={`ki-scope-picker__option${item.scope === scope ? ' ki-scope-picker__option--active' : ''}`}
                    key={`scope:${item.scope}`}
                    onClick={() => pick(item.scope)}
                  >
                    <span>{item.scope}</span>
                    {item.readonly === true && <span className="ki-scope-picker__ro">只读</span>}
                    {item.scope === scope && <span className="ki-scope-picker__check">✓</span>}
                  </button>
                ))}
              </>
            )}
          </div>
          {/*
            「回到视图」软入口（REQ-20261104-003 / S-05）：
            库节点的「进入 ↗」会把顶栏持久化到单库，用户下次打开就找不到原视图。
            这里用 sessionStorage 记住的最近视图给一条回程票；视图已被删除时不显示。
          */}
          {(() => {
            const last = getLastView();
            if (!last || last === scope) return null;
            if (views.length > 0 && !isView && !views.some((v) => v.view === last)) return null;
            return (
              <button type="button" className="ki-scope-picker__back" onClick={() => pick(last)}>
                ↩ 回到视图 {last}
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
}
