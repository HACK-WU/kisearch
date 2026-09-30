/**
 * AppShell.tsx —— 应用布局（对齐 demo：ki-sidebar 分组导航 + ki-topbar 服务徽标）
 */

import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { summarizeHealth, useHealth, type HealthLevel } from '@/lib/hooks';
import { ScopeSelect } from '@/components/ScopeSelect';
import { DocumentEditor } from '@/components/DocumentEditor';
import { DocumentEditorProvider, type DocumentEditorRequest } from '@/lib/documentEditorContext';
import { ImportPage } from '@/pages/ImportPage';
import { useScopeValue } from '@/lib/scopeContext';
import { getTasks, getVectorDimensionStatus, refreshVectorDimensionStatus } from '@/api/tasksApi';
import webPackage from '../../package.json';

const THEME_KEY = 'ki-theme';

const NAV_MAIN = [
  { to: '/', label: '总览', icon: '◧', end: true },
  { to: '/browse', label: '知识库浏览', icon: '☰' },
  { to: '/search', label: '语义搜索', icon: '⌕' },
  { to: '/import', label: '上传导入', icon: '⇪' },
  { to: '/write', label: '知识写入', icon: '✎' },
  { to: '/tasks', label: '后台任务', icon: '◷' },
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
  const location = useLocation();
  const importVisible = location.pathname === '/import';
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
  const failedTasks = taskQuery.data?.tasks.filter((task) => task.state === 'failed' || task.state === 'unknown') ?? [];
  const partialTasks = taskQuery.data?.tasks.filter((task) => task.state === 'partial') ?? [];
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
      if (document.querySelector('.ki-drawer')) return; // 抽屉打开：保留浏览器默认查找
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
    <DocumentEditorProvider value={{ isOpen: editorRequest !== null, open: setEditorRequest }}>
    <>
    <div className="ki-shell">
      {/* ════════ 侧边栏 ════════ */}
      <aside className={`ki-sidebar${sidebarHidden ? ' ki-sidebar--hidden' : ''}`}>
        <div className="ki-sidebar__header">
          <div className="ki-logo">ki</div>
          <span className="ki-sidebar__title">ki 知识库</span>
        </div>

        <nav className="ki-sidebar__section">
          <div className="ki-sidebar__section-head">
            <span className="ki-sidebar__section-label">导航</span>
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
              <span className="ki-nav-item__icon">{item.icon}</span>
              <span className="ki-nav-item__name">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="ki-sidebar__spacer" />

        <div className="ki-sidebar__footer">
          <div className="ki-sidebar__footer-version">ki v{webPackage.version} · MCP 7423</div>
          <div className="ki-sidebar__footer-row">
            <button className="ki-icon-link" onClick={toggle} title="切换主题" aria-label="切换主题">
              <svg viewBox="0 0 16 16" fill="currentColor" style={{ display: theme === 'dark' ? 'none' : '' }}>
                <path d="M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm.5-9.5a.5.5 0 1 1-1 0v-1a.5.5 0 0 1 1 0v1zm0 11a.5.5 0 1 1-1 0v-1a.5.5 0 0 1 1 0v1zM4.146 4.146a.5.5 0 0 1 .708 0l.707.708a.5.5 0 1 1-.708.707l-.707-.707a.5.5 0 0 1 0-.708zm6.292 6.293a.5.5 0 0 1 .708 0l.707.707a.5.5 0 0 1-.707.708l-.708-.708a.5.5 0 0 1 0-.707zM2.5 8.5a.5.5 0 0 1 0-1h1a.5.5 0 0 1 0 1h-1zm11 0a.5.5 0 0 1 0-1h1a.5.5 0 0 1 0 1h-1zM4.146 11.854a.5.5 0 0 1 0-.708l.708-.707a.5.5 0 0 1 .707.707l-.707.708a.5.5 0 0 1-.708 0zm6.293-6.293a.5.5 0 0 1 0-.707l.707-.708a.5.5 0 0 1 .708.708l-.708.707a.5.5 0 0 1-.707 0z" />
              </svg>
              <svg viewBox="0 0 16 16" fill="currentColor" style={{ display: theme === 'dark' ? '' : 'none' }}>
                <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z" />
              </svg>
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
        <header className="ki-topbar">
          <button
            className="ki-topbar__toggle"
            onClick={() => setSidebarHidden((v) => !v)}
            title="收起/展开侧边栏"
          >
            {sidebarHidden ? '☰' : '◁'}
          </button>
          <span className="ki-topbar__title">ki 知识库</span>
          <div className="ki-topbar__spacer" />
          <Link to="/tasks" className={`ki-global-task-link ki-global-task-link--${taskTone}`} aria-live="polite" title={failedTasks[0]?.error ?? partialTasks[0]?.error ?? taskStatus}>
            {taskTone === 'running' ? <span className="ki-task-spinner" aria-hidden="true" /> : <span aria-hidden="true">{taskTone === 'failed' ? '!' : '◷'}</span>}
            <span>{taskStatus}</span>
          </Link>
          <ScopeSelect />
          <ServiceBadge />
        </header>

        <main className="ki-content">
          <div className="ki-content-inner">
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
  );
}
