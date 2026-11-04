/** ScopeSelect.tsx —— 全局 scope 选择器（支持键盘输入与模糊过滤，不支持新建） */

import { useEffect, useRef, useState } from 'react';
import { useScope } from '@/lib/scopeContext';
import { useScopeList, useIsViewName, type ScopeEntry } from '@/lib/hooks';
import { getLastView } from '@/lib/lastView';

export function ScopeSelect(): JSX.Element {
  const { scope, setScope } = useScope();
  const { data, isLoading } = useScopeList();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scopes = data?.scopes ?? [];
  const views = data?.views ?? [];
  const degraded = data != null && data.vectorAvailable === false;

  /**
   * 两级：视图（只读聚合）在上，单个知识库在下。
   *
   * 无视图时（旧版 daemon / 尚未创建）退化成**改造前的平面列表**，一个像素都不变。
   * 当前值不在任何一组里时补一条占位到「单个知识库」，避免选择器显示空白。
   */
  /** 当前顶栏值是不是视图（决定徽标与配色） */
  const currentIsView = useIsViewName(scope);
  const isView = currentIsView;
  const options: ScopeEntry[] = scopes.some((item) => item.scope === scope) || isView
    ? scopes
    : [{ scope, kb: false, vector: false, registered: false, wikiCount: 0, ftsOnlyDocCount: 0 }, ...scopes];

  const normalizedFilter = filter.trim().toLowerCase();
  const match = (name: string): boolean => !normalizedFilter || name.toLowerCase().includes(normalizedFilter);
  const filteredViews = views.filter((v) => match(v.view));
  const filteredScopes = options.filter((item) => match(item.scope));
  /** 键盘 Enter 用：两组拉平后的顺序（视图在前，与视觉顺序一致） */
  const flatNames = [...filteredViews.map((v) => v.view), ...filteredScopes.map((s) => s.scope)];

  /** 展开后把焦点交给搜索框：收起态是展示层，点它不会自动聚焦到 input */
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /**
   * 点击外部收起。
   *
   * ★ 必须用 `mousedown` 而不是 `click`：
   *   收起态是展示层 `<div>`，点它会 `setOpen(true)` → React 立刻把它换成 `<input>`，
   *   原节点脱离 DOM。同一个 click 事件随后冒泡到 document 时，
   *   `contains(已脱离的 target)` 返回 false → 误判为「点了外部」→ 刚打开就被关掉，
   *   表现为**根本选不了**。mousedown 早于任何重渲染，target 一定还在文档里。
   *   同时加 `isConnected` 兜底，防止其它重建场景复现同类问题。
   */
  useEffect(() => {
    const onDocumentPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target || !target.isConnected) return;
      if (rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentPointerDown);
    return () => document.removeEventListener('mousedown', onDocumentPointerDown);
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
    /*
     * 宽度固定，不随库名长短变化 —— 否则切 scope 时顶栏右侧（服务健康 / 本机管理员）
     * 会跟着左右跳动，比留白更难接受。收起/展开同宽，也避免打开时抖一下。
     */
    <div className={`ki-scope-picker${open ? ' ki-scope-picker--open' : ''}`} ref={rootRef}>
      <div className="ki-scope-picker__input-wrap">
        {/*
          收起态不再用 <input>：名字后面的「· 视图」要**紧贴名字**，
          而 input 里无法混排不同样式的文本，用绝对定位只能钉死在右边、
          与名字之间留出很大空白（用户明确要求"近一点"）。
          改成等高的只读展示层，名字与后缀自然排在一行、间距 4px。
          展开搜索时仍切回真正的 input，过滤与键盘操作一字未改。
        */}
        {open ? (
          <input
            ref={inputRef}
            className="ki-scope-picker__input ki-form-input ki-scope-picker__input--open"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索 Scope…"
            disabled={isLoading}
            autoComplete="off"
            aria-label="搜索 Scope"
            aria-expanded
          />
        ) : (
          <div
            className="ki-scope-picker__input ki-form-input ki-scope-picker__display"
            role="button"
            tabIndex={0}
            aria-label={`当前${currentIsView ? '视图' : '知识库'}：${scope}`}
            aria-expanded={false}
            onClick={openPicker}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openPicker();
              }
            }}
            title={degraded
              ? `向量层暂不可用，仅显示 KB 层 scope${data?.vectorReason ? `：${data.vectorReason}` : ''}`
              : `当前${currentIsView ? '视图（只读聚合）' : '知识库'}`}
          >
            <span className="ki-scope-picker__name">{scope}</span>
            {currentIsView && <span className="ki-scope-picker__kind">· 视图</span>}
          </div>
        )}
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
