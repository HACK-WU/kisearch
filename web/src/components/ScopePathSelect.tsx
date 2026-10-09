/**
 * ScopePathSelect.tsx —— 显式选择本次操作的目标 Scope（单输入框 + 模式切换）。
 * 「选择已有 Scope」：输入即筛选列表，点选即设为本次目标；
 * 「新建 Scope」：输入名称后**回车 / 输入框失焦 / 点「创建」按钮**三者等价（R4，
 * REQ-20261009-001——此前只有回车一条路径，用户感知为"必须强制回车"）。
 * 父组件只在点选已有项或确认合法新名称后收到 (value, true)。
 */

import { useEffect, useRef, useState } from 'react';
import { useScopeList } from '@/lib/hooks';
import { scopeError } from '@/lib/validators';

interface ScopePathSelectProps {
  value: string;
  confirmed: boolean;
  currentScope: string;
  onChange: (value: string, confirmed: boolean) => void;
  /**
   * 「新建 Scope」模式下输入框的草稿（尚未回车确认）。
   * 父组件据此拦截「输入了 consu 却没回车、结果按旧 scope 静默导入」这类串号。
   */
  onDraftChange?: (draft: string) => void;
  /** 字段标签；与模式按钮同行渲染，保证与相邻字段（如 Group 路径）左右对齐 */
  label?: string;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
}

const ICON_SCOPE = (
  <svg
    className="ki-gtree-icon"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.2 3.1c0-.55.45-1 1-1h3.1l1.25 1.45h5.25c.55 0 1 .45 1 1v7.3c0 .55-.45 1-1 1H3.2c-.55 0-1-.45-1-1V3.1z" />
  </svg>
);

export function ScopePathSelect({
  value,
  confirmed,
  currentScope,
  onChange,
  onDraftChange,
  label,
  placeholder,
  hint,
  error,
  disabled = false,
}: ScopePathSelectProps): JSX.Element {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [scopeFilter, setScopeFilter] = useState('');
  const [newScope, setNewScope] = useState('');
  // 列表默认收起：聚焦输入框或点「选择已有 Scope」时才展开（避免一进页面像已被选中）
  const [listOpen, setListOpen] = useState(false);
  const [newScopeListRefreshPending, setNewScopeListRefreshPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 输入框当前展示值与其是否等于已确认目标（决定主色实心态，避免切换模式后绿态残留） */
  const inputValue = mode === 'new' ? newScope : scopeFilter;
  const inputVerified = Boolean(value && confirmed && inputValue === value);

  // 点击组件外部关闭下拉（此前只有「选完」才关，点页面别处会一直挂着）
  useEffect(() => {
    if (!listOpen) return () => undefined;
    const onDocMouseDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setListOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [listOpen]);
  const { data, isLoading, isFetching, isError, refetch } = useScopeList();
  const scopeListFailed = isError || !data || data.ok === false || !Array.isArray(data.scopes);
  const scopes = scopeListFailed ? [] : (data?.scopes ?? []);
  const trimmedNewScope = newScope.trim();
  const newScopeError = trimmedNewScope ? scopeError(trimmedNewScope) : null;
  const alreadyExists = scopes.some((item) => item.scope === trimmedNewScope);
  const filteredScopes = scopes.filter((item) => item.scope.toLocaleLowerCase().includes(scopeFilter.trim().toLocaleLowerCase()));
  const confirmBlocked = disabled || newScopeListRefreshPending || scopeListFailed || isLoading || isFetching || !trimmedNewScope || !!newScopeError || alreadyExists;
  /**
   * 显式动作（点「创建」/输入框失焦）的阻塞条件（R4）：只拦「名字本身不可用」与
   * 「列表读不到」，**不拦列表刷新中**——切到「新建」会触发一次 refetch，若把
   * isFetching/newScopeListRefreshPending 也算阻塞，用户输入后立刻失焦会被静默忽略
   * （正是本次要修掉的"看不到反应"体验）。
   */
  const explicitConfirmBlocked = disabled || scopeListFailed || !trimmedNewScope || !!newScopeError || alreadyExists;
  /** 已确认过的名称：让「失焦 + 点按钮」连击成为幂等空操作 */
  const confirmedNameRef = useRef('');

  const chooseMode = (next: 'existing' | 'new'): void => {
    setMode(next);
    // 切换模式一律重置该模式的输入（未确认的草稿即丢弃），列表按目标模式开合
    confirmedNameRef.current = '';
    onDraftChange?.('');
    setScopeFilter(value && confirmed ? value : '');
    setListOpen(next === 'existing');
    if (next === 'new') {
      setNewScope('');
      setNewScopeListRefreshPending(true);
      void refetch().then(
        () => setNewScopeListRefreshPending(false),
        () => setNewScopeListRefreshPending(false),
      );
    } else {
      setNewScope('');
    }
  };

  /**
   * 确认新建 Scope。
   * @param explicit 显式动作（点「创建」按钮 / 输入框失焦）——用较宽松的阻塞条件，
   *   且与回车路径共用同一幂等守卫（失焦后紧跟点击按钮会连击两次）。
   */
  const confirmNewScope = (explicit = false): void => {
    if (disabled || !trimmedNewScope) return;
    if (confirmedNameRef.current === trimmedNewScope) return;
    if (explicit ? explicitConfirmBlocked : confirmBlocked) return;
    confirmedNameRef.current = trimmedNewScope;
    onChange(trimmedNewScope, true);
    onDraftChange?.('');
    setListOpen(false);
  };

  const pickExisting = (scope: string): void => {
    if (disabled) return;
    onChange(scope, true);
    onDraftChange?.('');
    setScopeFilter(scope);
    setListOpen(false);
  };

  return (
    <div className="ki-scope-target" ref={rootRef}>
      <div className="ki-scope-target__head">
        <label className="ki-form-label">{label ?? 'Scope（目标知识库）'}</label>
      <div className="ki-scope-target__modes" role="group" aria-label="选择目标 Scope 类型">
        <button
          type="button"
          className={`ki-btn ki-btn--small${mode === 'existing' ? ' ki-btn--primary' : ' ki-btn--secondary'}`}
          aria-pressed={mode === 'existing'}
          onClick={() => chooseMode('existing')}
          title="从已有 Scope 中选择（输入即筛选）"
          disabled={disabled}
        >选择已有 Scope</button>
        <button
          type="button"
          className={`ki-btn ki-btn--small${mode === 'new' ? ' ki-btn--primary' : ' ki-btn--secondary'}`}
          aria-pressed={mode === 'new'}
          onClick={() => chooseMode('new')}
          title="新建 Scope（输入名称后回车 / 失焦 / 点「创建」均可）"
          disabled={disabled}
        >新建 Scope</button>
      </div>
      </div>

      <div className="ki-scope-target__row">
      <div className="ki-combobox__input-wrap">
        <input
          className={`ki-form-input${inputVerified ? ' ki-form-input--verified' : ''}`}
          placeholder={
            mode === 'new'
              ? '输入新 Scope 名称（回车 / 失焦 / 点右侧「创建」）'
              : placeholder ?? '按名称筛选已有 Scope，如：kafka'
          }
          value={inputValue}
          disabled={disabled}
          onFocus={() => { if (mode === 'existing' && !listOpen) setListOpen(true); }}
          onChange={(e) => {
            if (mode === 'new') {
              // 名称一改，上一次的"已确认"即作废（否则改名后无法再创建）
              confirmedNameRef.current = '';
              setNewScope(e.target.value);
              onDraftChange?.(e.target.value);
              return;
            }
            setScopeFilter(e.target.value);
            setListOpen(true);
          }}
          onKeyDown={(e) => {
            if (mode !== 'new' || e.key !== 'Enter') return;
            e.preventDefault();
            confirmNewScope();
          }}
          onBlur={() => {
            // R4：失焦即确认（仅「新建」模式、名称可用时）。点「创建」按钮会先触发
            // 本回调再触发 onClick——confirmNewScope 内部的同名幂等守卫负责去重。
            if (mode !== 'new') return;
            confirmNewScope(true);
          }}
        />
        </div>

        {mode === 'new' && (
          <button
            type="button"
            className="ki-btn ki-btn--small ki-btn--primary"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => confirmNewScope(true)}
            disabled={explicitConfirmBlocked}
            title={
              explicitConfirmBlocked && trimmedNewScope
                ? (newScopeError ?? (alreadyExists ? `Scope ${trimmedNewScope} 已存在` : 'Scope 列表未就绪'))
                : `以「${trimmedNewScope || '新名称'}」为目标 Scope`
            }
          >创建</button>
        )}

      {mode === 'existing' && listOpen && (
        <div className="ki-scope-target__panel">
          {scopeListFailed ? (
            <div className="ki-scope-target__load-error" role="alert">
              Scope 列表加载失败
              <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={() => void refetch()}>重试</button>
            </div>
          ) : isLoading || isFetching || newScopeListRefreshPending ? (
            <div className="ki-cell-sub">正在加载 Scope…</div>
          ) : filteredScopes.length === 0 ? (
            <div className="ki-cell-sub">{scopes.length ? '没有匹配的 Scope' : '暂无已有 Scope'}</div>
          ) : (
            <div className="ki-scope-target__list" role="listbox" aria-label="已有 Scope">
              {filteredScopes.map((item) => (
                <div
                  key={item.scope}
                  className={`ki-gtree-dir${value === item.scope ? ' ki-gtree-dir--active' : ''}`}
                  role="option"
                  aria-selected={value === item.scope}
                  tabIndex={disabled ? -1 : 0}
                  onClick={() => pickExisting(item.scope)}
                  onKeyDown={(event) => {
                    if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault();
                      pickExisting(item.scope);
                    }
                  }}
                >
                  {ICON_SCOPE}
                  <span className="ki-gtree-label">{item.scope}</span>
                  {item.scope === currentScope && value !== item.scope && (
                    <span className="ki-badge ki-badge--off">当前</span>
                  )}
                  {value === item.scope && confirmed && <span className="ki-badge ki-badge--primary">本次目标 ✓</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>

      {mode === 'new' && (newScopeError || alreadyExists) && (
        <div className="ki-form-error">
          {alreadyExists ? `Scope ${trimmedNewScope} 已存在，请切到「选择已有 Scope」直接点选` : newScopeError}
        </div>
      )}
      {error ? <div className="ki-form-error">{error}</div> : null}

      <div className="ki-form-hint">
        {hint ?? '「已有」点选即设目标；「新建」输入名称后回车、失焦或点「创建」均可。'}
      </div>
    </div>
  );
}
