/**
 * AppShell.tsx —— 应用布局（对齐 v2 demo：品牌区 + 分组导航（SVG 图标）+ 共用标题操作区 + 服务徽标）
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { summarizeHealth, useHealth, type HealthLevel } from '@/lib/hooks';
import { ScopeSelect } from '@/components/ScopeSelect';
import { DocumentEditor } from '@/components/DocumentEditor';
import { DocumentEditorProvider, type DocumentEditorRequest } from '@/lib/documentEditorContext';
import { ImportPage } from '@/pages/ImportPage';
import { useScopeValue } from '@/lib/scopeContext';
import { getTasks, getVectorDimensionStatus, refreshVectorDimensionStatus } from '@/api/tasksApi';
import { Icon } from '@/components/icons';
import { ChatPanel } from '@/chat/ChatPanel';
import { createChatStore } from '@/chat/chatStore';
import { ChatStoreContext } from '@/chat/chatStoreContext';
import webPackage from '../../package.json';

const THEME_KEY = 'ki-theme';

const NAV_MAIN = [
  { to: '/', label: '总览', icon: 'grid', end: true },
  { to: '/browse', label: '知识库浏览', icon: 'book' },
  { to: '/search', label: '语义搜索', icon: 'search' },
  // REQ-20261008-001：独立对话页入口（用户拍板 Q1：位于「语义搜索」之下）
  { to: '/chat', label: 'AI 对话', icon: 'chat' },
  { to: '/import', label: '上传导入', icon: 'upload' },
  { to: '/write', label: '知识写入', icon: 'edit' },
  { to: '/tasks', label: '后台任务', icon: 'clock' },
];

function useTheme(): { theme: string; toggle: () => void } {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) ?? 'light';
    } catch {
      return 'light';
    }
  });
  useEffect(() => {
    document.body.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return { theme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') };
}

const DOT_CLASS: Record<HealthLevel, string> = {
  checking: 'ki-dot--muted',
  unreachable: 'ki-dot--err',
  slow: 'ki-dot--warn',
  fail: 'ki-dot--err',
  warn: 'ki-dot--warn',
  ok: 'ki-dot--ok',
};

function ServiceBadge(): JSX.Element {
  const { data, error, isPending } = useHealth();
  const s = summarizeHealth(data, error, isPending);
  return (
    <span className="ki-service-badge" title={s.detail || s.label}>
      <span className={`ki-dot ${DOT_CLASS[s.level]}`} />
      <span className="ki-service-badge__text">{s.label}</span>
    </span>
  );
}

export function AppShell(): JSX.Element {
  // ★ D15 硬约束：对话状态与流式累积态必须驻留【AppShell 级】（面板关闭 = 隐藏不卸载），
  //   因此 store 在此创建一次；ChatPanel 只是视图，不持有业务状态（否则关面板会丢内容并连带 abort）
  const chatStoreRef = useRef<ReturnType<typeof createChatStore> | null>(null);
  if (chatStoreRef.current === null) chatStoreRef.current = createChatStore();
  const chatStore = chatStoreRef.current;
  /**
   * 面板开合态：REQ-20261009-002 起收敛到 store（`chatStore.open` 此前是无人消费的死状态），
   * 使全屏阅读器内的「AI 对话」开关与顶栏开关共享同一份状态 —— 两者分处不同组件树分支，
   * props 够不着。
   *
   * 只订阅 `open` 一个字段：流式推进时 getSnapshot 恒等，AppShell 不随每个 chunk 重渲染。
   * ⚠️ AppShell 是 `ChatStoreContext.Provider` 本身，不能消费该 context，故直接读 store。
   */
  const chatOpen = useSyncExternalStore(chatStore.subscribe, () => chatStore.getState().open);
  const setChatOpen = useCallback(
    (next: boolean) => {
      chatStore.dispatch({ type: 'setOpen', open: next });
    },
    [chatStore],
  );
  const chatToggleRef = useRef<HTMLButtonElement>(null);

  const location = useLocation();
  const importVisible = location.pathname === '/import';
  const isChatRoute = location.pathname.startsWith('/chat');
  /**
   * Q4/Q5（REQ-20261008-001 用户拍板）：处于独立对话页时右侧面板**自动收起**，
   * 离开时**恢复进入前的开/关先态**。先态只在进入 /chat 那一刻记录一次；
   * 用户在 /chat 手动再开面板不打扰（离开仍恢复进入前状态）。
   */
  const chatOpenBeforeRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (isChatRoute) {
      if (chatOpenBeforeRef.current === null) {
        // 用 getState 读先态：闭包里的 chatOpen 可能滞后，且避免把它列入依赖
        // （先态只记一次，不被面板自身的开/关覆盖）
        const wasOpen = chatStore.getState().open;
        chatOpenBeforeRef.current = wasOpen;
        if (wasOpen) setChatOpen(false);
      }
    } else if (chatOpenBeforeRef.current !== null) {
      if (chatOpenBeforeRef.current) setChatOpen(true);
      chatOpenBeforeRef.current = null;
    }
  }, [isChatRoute, chatStore, setChatOpen]);
  const currentLabel = NAV_MAIN.find((item) =>
    item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)
  )?.label ?? '总览';
  const { theme, toggle } = useTheme();
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [editorRequest, setEditorRequest] = useState<DocumentEditorRequest | null>(null);
  const queryClient = useQueryClient();
  const scope = useScopeValue();
  const lastDimensionTaskFinish = useRef(Date.now());
  const taskQuery = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getTasks(200),
    refetchInterval: (query) => query.state.data?.tasks.some((task) => task.state === 'queued' || task.state === 'running') ? 3_000 : 15_000,
    staleTime: 0,
    retry: false,
  });
  const dimensionQuery = useQuery({
    queryKey: ['vectorDimensionStatus', scope],
    queryFn: async () => {
      const current = await getVectorDimensionStatus(scope);
      const { checkedAt, staleAfterMs, state } = current.status;
      // 快照缺失或过期时检查一次；真正检查失败的近期快照留给用户手动重试。
      if (state === 'unknown' && (checkedAt === undefined || Date.now() - checkedAt >= staleAfterMs)) {
        return refreshVectorDimensionStatus(scope);
      }
      return current;
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  useEffect(() => {
    const latestFinish = Math.max(0, ...(taskQuery.data?.tasks ?? [])
      .filter((task) => task.scope === scope && ['import', 'rebuild-vector', 'restore-snapshot'].includes(task.operation))
      .map((task) => task.finishedAt ?? 0));
    if (latestFinish <= lastDimensionTaskFinish.current) return;
    lastDimensionTaskFinish.current = latestFinish;
    void queryClient.invalidateQueries({ queryKey: ['vectorDimensionStatus', scope] });
  }, [taskQuery.data, scope, queryClient]);
  const activeTasks = taskQuery.data?.tasks.filter((task) => task.state === 'queued' || task.state === 'running') ?? [];
  const partialTasks = taskQuery.data?.tasks.filter((task) => task.state === 'partial') ?? [];
  /** `${scope}\u0000${operation}` → 最近一次 succeeded 的完成时间（用于自动消除被覆盖的旧失败） */
  const latestSuccessByScopeOp = useMemo(() => {
    const map = new Map<string, number>();
    for (const task of taskQuery.data?.tasks ?? []) {
      if (task.state !== 'succeeded') continue;
      const key = `${task.scope}\u0000${task.operation}`;
      map.set(key, Math.max(map.get(key) ?? 0, task.finishedAt ?? 0));
    }
    return map;
  }, [taskQuery.data?.tasks]);
  /** 手动忽略：按 scope 记住忽略时间戳（localStorage）；该时间戳之前的失败不再进入徽章 */
  const [dismissTick, setDismissTick] = useState(0);
  const dismissKey = `ki.taskFailedDismissedAt.${scope}`;
  const dismissedFailedAt = useMemo(() => {
    try { return Number(localStorage.getItem(dismissKey)) || 0; } catch { return 0; }
  }, [dismissKey, dismissTick]);
  const dismissFailedNotice = (): void => {
    try { localStorage.setItem(dismissKey, String(Date.now())); } catch { /* 存储不可用时不影响本次会话内的重新计算 */ }
    setDismissTick((n) => n + 1);
  };
  /**
   * 失败任务（进入顶栏徽章的口径，用户 2026-10-02 要求两条消解规则）：
   * ① 自动消除：同 scope + 同 operation 已有更新的 succeeded 记录 → 旧失败不再提示；
   * ② 手动忽略：忽略时间戳之前的失败不再提示（其后的新失败仍会重新亮起）。
   * 仅从顶栏徽章消解；任务页保留完整历史用于追溯。
   */
  const failedTasks = (taskQuery.data?.tasks ?? []).filter((task) => {
    if (task.state !== 'failed' && task.state !== 'unknown') return false;
    const latestSuccess = latestSuccessByScopeOp.get(`${task.scope}\u0000${task.operation}`) ?? 0;
    if (latestSuccess > (task.finishedAt ?? 0)) return false;
    if ((task.finishedAt ?? 0) <= dismissedFailedAt) return false;
    return true;
  });
  const taskStatus = activeTasks.length > 0
    ? `${activeTasks.length} 个任务运行中${failedTasks.length ? ` · ${failedTasks.length} 个失败/未知` : ''}${partialTasks.length ? ` · ${partialTasks.length} 个部分完成` : ''}`
    : failedTasks.length > 0
      ? `${failedTasks.length} 个任务失败或状态未知`
      : partialTasks.length > 0
        ? `${partialTasks.length} 个任务部分完成`
      : taskQuery.error
        ? '任务状态暂不可用'
        : '后台任务';
  const taskTone = activeTasks.length > 0 ? 'running' : failedTasks.length > 0 || taskQuery.error ? 'failed' : partialTasks.length > 0 ? 'partial' : 'idle';

  const refreshDimension = async (): Promise<void> => {
    await refreshVectorDimensionStatus(scope);
    await queryClient.invalidateQueries({ queryKey: ['vectorDimensionStatus', scope] });
  };

  // 全局 Ctrl+F / Cmd+F → 聚焦当前页的搜索框（data-ki-search-input 标记）
  // 阻止浏览器默认的"查找页面 DOM"行为，让用户用应用内搜索框（在 Browse/Search 页有意义）
  // 抽屉打开时不拦截：用户可能想在文档原文内用浏览器查找文本
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const isFind = (e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F');
      if (!isFind) return;
      // 覆盖层抽屉打开：保留浏览器默认查找；常驻阅读区（inline）不算，Ctrl+F 仍聚焦应用内搜索框
      if (document.querySelector('.ki-drawer:not(.ki-drawer--inline)')) return;
      const target = document.querySelector<HTMLInputElement>('[data-ki-search-input]');
      if (!target) return; // 当前页无应用内搜索框，保留浏览器默认
      e.preventDefault();
      target.focus();
      target.select();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <ChatStoreContext.Provider value={chatStore}>
    <DocumentEditorProvider value={{ isOpen: editorRequest !== null, open: setEditorRequest }}>
    <>
    {/* data-chat-open：全屏阅读器让位的唯一依据（REQ-20261009-002 需求 A，
        规则见 ki.css「E. 全屏阅读器与 AI 面板共存」段）——纯 CSS 派生，不做跨组件通信 */}
    <div className="ki-shell" data-chat-open={chatOpen ? 'true' : 'false'}>
      {/* ════════ 侧边栏 ════════ */}
      <aside className={`ki-sidebar${sidebarHidden ? ' ki-sidebar--hidden' : ''}`}>
        <div className="ki-sidebar__header">
          <div className="ki-logo" aria-hidden="true">ki</div>
          <span className="ki-sidebar__brand">
            <span className="ki-sidebar__title">ki 知识库</span>
            <span className="ki-sidebar__subtitle">KNOWLEDGE INDEXER</span>
          </span>
        </div>

        <nav className="ki-sidebar__section">
          <div className="ki-sidebar__section-head">
            <span className="ki-sidebar__section-label">工作空间</span>
          </div>
          {NAV_MAIN.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `ki-nav-item${isActive ? ' ki-nav-item--active' : ''}`
              }
            >
              <span className="ki-nav-item__icon"><Icon name={item.icon} /></span>
              <span className="ki-nav-item__name">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="ki-sidebar__spacer" />

        <div className="ki-sidebar__footer">
          <strong className="ki-sidebar__footer-title">本地工作区</strong>
          <span className="ki-sidebar__footer-meta">ki v{webPackage.version} · MCP 7423</span>
          <div className="ki-sidebar__footer-row">
            <button className="ki-icon-link" onClick={toggle} title="切换主题" aria-label="切换主题">
              <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
            </button>
            <a
              className="ki-icon-link"
              href="https://github.com/HACK-WU/kisearch"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub"
              aria-label="GitHub"
            >
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
              </svg>
            </a>
          </div>
        </div>
      </aside>

      {/* ════════ 主区域 ════════ */}
      <div className="ki-main">
        <main className="ki-content">
          <div className="ki-content-inner">
            <header className="ki-topbar ki-workspace-header">
              <div className="ki-workspace-header__heading">
                <button
                  className="ki-icon-button"
                  onClick={() => setSidebarHidden((v) => !v)}
                  title="收起/展开侧边栏"
                  aria-label="收起或展开侧边栏"
                  aria-expanded={!sidebarHidden}
                >
                  <Icon name={sidebarHidden ? 'menu' : 'chevron-left'} />
                </button>
                <h1 className="ki-workspace-title">{currentLabel}</h1>
              </div>
              <div className="ki-workspace-header__actions">
                {/* D15：顶部开关控制对话面板显隐（关闭 = 隐藏不卸载，不中止生成） */}
                <button
                  type="button"
                  className="ki-topbar__chat-toggle"
                  ref={chatToggleRef}
                  onClick={() => setChatOpen(!chatOpen)}
                  title={chatOpen ? '收起 AI 对话' : '打开 AI 对话'}
                  aria-label="AI 对话"
                  aria-pressed={chatOpen}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 3V11.5a9 9 0 0 1 18 0Z" />
                    <path d="M7 11h.01M11 11h.01M15 11h.01" strokeWidth="3" />
                  </svg>
                  <span className="ki-topbar__chat-label">AI 对话</span>
                </button>
                <Link to="/tasks" className={`ki-global-task-link ki-global-task-link--${taskTone}`} aria-live="polite" title={failedTasks[0]?.error ?? partialTasks[0]?.error ?? taskStatus}>
                  {taskTone === 'running' ? <span className="ki-task-spinner" aria-hidden="true" /> : <span aria-hidden="true">{taskTone === 'failed' ? '!' : <Icon name="clock" className="ki-icon ki-icon--sm" />}</span>}
                  <span>{taskStatus}</span>
                </Link>
                {/* 手动忽略失败提示：独立按钮（徽章本体是 Link，button 不能嵌进去） */}
                {failedTasks.length > 0 && (
                  <button
                    className="ki-global-task-dismiss"
                    type="button"
                    onClick={dismissFailedNotice}
                    title="忽略失败提示；之后出现的新失败会再次提醒，任务页仍可查历史"
                    aria-label="忽略失败提示"
                  >
                    ×
                  </button>
                )}
                <ScopeSelect />
                <ServiceBadge />
              </div>
            </header>
            {dimensionQuery.data?.status.state === 'mismatch' && dimensionQuery.data.status.persisted !== undefined ? (
              <div className="ki-vector-dimension-banner" role="alert">
                <span className="ki-vector-dimension-banner__icon" aria-hidden="true">!</span>
                <div className="ki-vector-dimension-banner__copy">
                  <b>当前知识库的语义向量不可用</b>
                  <span>{scope}：当前 embedding 为 {dimensionQuery.data.status.configured} 维，旧向量集合为 {dimensionQuery.data.status.persisted} 维。</span>
                  <code>ki restore {scope} --rebuild-vector --yes</code>
                </div>
                <button className="ki-btn ki-btn--secondary" onClick={() => void refreshDimension()}>重新检查</button>
              </div>
            ) : dimensionQuery.data?.status.state === 'unknown' || dimensionQuery.error ? (
              <div className="ki-vector-dimension-banner ki-vector-dimension-banner--unknown" role="status">
                <span className="ki-vector-dimension-banner__icon" aria-hidden="true">?</span>
                <div className="ki-vector-dimension-banner__copy">
                  <b>暂无法确认向量维度</b>
                  <span>{scope} · {dimensionQuery.data?.status.error ?? '维度快照缺失或已过期'}</span>
                </div>
                <button className="ki-btn ki-btn--secondary" onClick={() => void refreshDimension()} disabled={dimensionQuery.isFetching}>重新检查</button>
              </div>
            ) : null}
            <div style={{ display: importVisible ? 'contents' : 'none' }}>
              <ImportPage />
            </div>
            <Outlet />
          </div>
        </main>
      </div>

      {/* ════════ 右侧对话面板（常驻所有页面；关闭 = 隐藏不卸载，见 D15）════════ */}
      <ChatPanel store={chatStore} open={chatOpen} onClose={() => {
        setChatOpen(false);
        chatToggleRef.current?.focus();
      }} />
    </div>
    {editorRequest && (
      <DocumentEditor
        key={`${editorRequest.scope}/${editorRequest.group}/${editorRequest.relation}`}
        scope={editorRequest.scope}
        group={editorRequest.group}
        relation={editorRequest.relation}
        readerSelection={editorRequest.readerSelection}
        onSaved={(content, result) => {
          editorRequest.onSaved?.(content, result);
          void queryClient.invalidateQueries({ queryKey: ['docList', editorRequest.scope] });
        }}
        onClose={() => setEditorRequest(null)}
      />
    )}
    </>
    </DocumentEditorProvider>
    </ChatStoreContext.Provider>
  );
}
