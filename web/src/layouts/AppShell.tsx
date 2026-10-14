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
import { dimensionStatusDetail, DEGRADED_TITLE, UNKNOWN_TITLE } from '@/lib/vectorDimensionCopy';
import { visibleTaskNotices } from '@/lib/taskNotice';
import {
  dimensionNoticeFingerprint,
  dimensionNoticeKind,
  readDimensionDismissedFingerprint,
  shouldShowDimensionNotice,
  writeDimensionDismissedFingerprint,
} from '@/lib/vectorDimensionNotice';
import { Icon } from '@/components/icons';
import { ChatPanel } from '@/chat/ChatPanel';
import { createChatStore } from '@/chat/chatStore';
import { ChatStoreContext } from '@/chat/chatStoreContext';
import { readChatOpen, writeChatOpen } from '@/lib/chatPanelPrefs';
import { DOC_FIND_OPEN_EVENT } from '@/lib/docFind';
import webPackage from '../../package.json';

const THEME_KEY = 'ki-theme';

/** 「手动忽略任务提示」的时间戳 key（失败 / 部分完成各一；全局，不按 scope 分桶） */
const FAILED_DISMISS_KEY = 'ki.taskFailedDismissedAt';
const PARTIAL_DISMISS_KEY = 'ki.taskPartialDismissedAt';

/** 左侧主导航「收起」偏好（2026-10-13：与对话面板同批补持久化，此前刷新即复位） */
const SIDEBAR_HIDDEN_KEY = 'ki.sidebarHidden';

/** 读取左侧主导航收起态（存储不可用 → 展开；顶栏始终有切换按钮，不会找不到入口） */
function readSidebarHidden(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** 读取忽略时间戳：多个 key 取最新（0 = 未忽略；localStorage 不可用时按未忽略处理） */
function readDismissedAt(keys: string[]): number {
  let latest = 0;
  for (const key of keys) {
    try { latest = Math.max(latest, Number(localStorage.getItem(key)) || 0); } catch { /* 单个 key 读失败不影响其余 */ }
  }
  return latest;
}

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
  // 初始开合按「用户上次意图」恢复（localStorage，见 lib/chatPanelPrefs）：
  // 修复「全屏开 AI 对话后刷新，面板被关掉」——原先每次挂载都回落到「关闭」。
  if (chatStoreRef.current === null) chatStoreRef.current = createChatStore(readChatOpen());
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
  /**
   * 对话是否正在生成（2026-10-14 用户需求：「AI 对话」tab 要有进行中提示）。
   *
   * ★ 为何订阅而不是从 `chatOpen` 派生：面板**关闭时生成照旧进行**（D15：关闭=隐藏不卸载），
   *   用户切到别的页面（甚至面板收着）时全站只有这里能提示"回答还在生成"。
   * ★ 只订阅布尔：流式推进（content 逐字累积）不改变 `active`，getSnapshot 恒等 ⇒
   *   AppShell 不会随 chunk 重渲染（与上面 `open` 同款写法）。
   */
  const chatStreaming = useSyncExternalStore(chatStore.subscribe, () => chatStore.getState().streaming.active);
  /**
   * 设置面板开合；`persist: false` 用于**路由派生**的开合（2026-10-13）。
   *
   * · 用户意图（顶栏开关 / 全屏阅读器内的开关 / 面板关闭按钮）→ 默认写 localStorage，刷新后恢复；
   * · 路由派生（进入 `/chat` 自动收起、离开时恢复先态，见下方 Q4/Q5 段）→ 不写：
   *   否则一次刷新就会把「派生状态」写成用户意图 —— 用户在 /chat 转一圈回来会发现
   *   面板状态被路由逻辑改写。
   */
  const setChatOpen = useCallback(
    (next: boolean, opts?: { persist?: boolean }) => {
      chatStore.dispatch({ type: 'setOpen', open: next });
      if (opts?.persist !== false) writeChatOpen(next);
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
        if (wasOpen) setChatOpen(false, { persist: false });
      }
    } else if (chatOpenBeforeRef.current !== null) {
      // 此处同样是**路由派生**（恢复进入 /chat 前的先态），不得写持久化：
      // 持久化只认用户在开关上的显式选择（见 setChatOpen 注释）。
      if (chatOpenBeforeRef.current) setChatOpen(true, { persist: false });
      chatOpenBeforeRef.current = null;
    }
  }, [isChatRoute, chatStore, setChatOpen]);
  const currentLabel = NAV_MAIN.find((item) =>
    item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)
  )?.label ?? '总览';
  const { theme, toggle } = useTheme();
  /** 左侧主导航收起态：本地持久化（2026-10-13，此前只存 state、刷新即复位） */
  const [sidebarHidden, setSidebarHidden] = useState(readSidebarHidden);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_HIDDEN_KEY, sidebarHidden ? '1' : '0');
    } catch {
      /* 存储不可用：本次会话内仍生效 */
    }
  }, [sidebarHidden]);
  const [editorRequest, setEditorRequest] = useState<DocumentEditorRequest | null>(null);
  const queryClient = useQueryClient();
  const scope = useScopeValue();
  const lastDimensionTaskFinish = useRef(Date.now());
  const taskQuery = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getTasks(200),
    // S-02/R5（REQ-20261009-003）：索引整理期间同样按 3s 刷新 —— 否则顶栏「索引整理中」
    // 会一直挂到 15s 才切到「已优化/可用」，用户以为卡住了。
    refetchInterval: (query) => query.state.data?.tasks.some(
      (task) => task.state === 'queued' || task.state === 'running' || task.phase === 'indexing',
    ) ? 3_000 : 15_000,
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
  /**
   * S-02/R5（REQ-20261009-003）**索引整理中**的任务：`state` 已是终态（导入结果可用），
   * 但 `phase === 'indexing'` ⇒ 引擎仍在后台整理索引。此处单独成列（不混入 `activeTasks`
   * 的"运行中"计数）：文档已可用，只是检索可能略慢，必须让用户看得见**在等什么**。
   */
  const indexingTasks = (taskQuery.data?.tasks ?? []).filter((task) => task.phase === 'indexing');
  /**
   * 手动忽略：记住忽略时间戳（localStorage），该时间戳之前的记录不再进入徽章。
   *
   * 时间戳**不按 scope 分桶**——徽章展示的是全部 scope 的任务，若按 scope 存，
   * 「在 A 忽略过的提示，切到 B 又原样冒出来」会让用户以为删不掉（旧 key 仍读取以兼容历史）。
   */
  const [dismissTick, setDismissTick] = useState(0);
  const dismissal = useMemo(() => ({
    failedAt: readDismissedAt([FAILED_DISMISS_KEY, `ki.taskFailedDismissedAt.${scope}`]),
    partialAt: readDismissedAt([PARTIAL_DISMISS_KEY, `ki.taskPartialDismissedAt.${scope}`]),
    // 依赖 dataUpdatedAt：多标签页场景下，另一页点过忽略后本页在下次轮询（3s/15s）同步消失，
    // 否则本页会一直挂着已被忽略的旧提示直到手动刷新。
  }), [scope, dismissTick, taskQuery.dataUpdatedAt]);
  const dismissTaskNotices = (): void => {
    const now = String(Date.now());
    try {
      localStorage.setItem(FAILED_DISMISS_KEY, now);
      localStorage.setItem(PARTIAL_DISMISS_KEY, now);
    } catch { /* 存储不可用时不影响本次会话内的重新计算 */ }
    setDismissTick((n) => n + 1);
  };
  /**
   * 进入顶栏徽章的「需关注任务」：失败/未知 + 部分完成，两条消解规则（自动消除 / 手动忽略）
   * 见 lib/taskNotice.ts —— 部分完成此前没有手动消除入口，会一直挂到 1 小时 TTL 到期。
   */
  const { failed: failedTasks, partial: partialTasks } = useMemo(
    () => visibleTaskNotices(taskQuery.data?.tasks ?? [], dismissal),
    [taskQuery.data?.tasks, dismissal],
  );
  const taskStatus = activeTasks.length > 0
    ? `${activeTasks.length} 个任务运行中${failedTasks.length ? ` · ${failedTasks.length} 个失败/未知` : ''}${partialTasks.length ? ` · ${partialTasks.length} 个部分完成` : ''}`
    : failedTasks.length > 0
      ? `${failedTasks.length} 个任务失败或状态未知`
      // R5：整理期提示 —— 明确"文档已可用、只是在整理索引"，避免被误读为导入未完成
      : indexingTasks.length > 0
        ? `索引整理中 · 文档已可用（${indexingTasks[0].scope}）`
        : partialTasks.length > 0
          ? `${partialTasks.length} 个任务部分完成`
      : taskQuery.error
        ? '任务状态暂不可用'
        : '后台任务';
  const taskTone = activeTasks.length > 0 || indexingTasks.length > 0 ? 'running' : failedTasks.length > 0 || taskQuery.error ? 'failed' : partialTasks.length > 0 ? 'partial' : 'idle';

  const refreshDimension = async (): Promise<void> => {
    try {
      // R8：把**本次响应**写回 cache（含 degraded）—— 若只 invalidate，queryFn 会重新 GET，
      // 命中的可能仍是旧快照（如 compatible）：「用户主动刷新失败」会被显示成"一切正常"。
      // POST refresh 的响应本身就是最新状态，无需再触发一次 GET。
      const res = await refreshVectorDimensionStatus(scope);
      queryClient.setQueryData(['vectorDimensionStatus', scope], res);
    } catch {
      // 请求本身失败：让 query 走 error 态（banner 显示"暂无法确认"），而不是停在旧数据上
      await queryClient.invalidateQueries({ queryKey: ['vectorDimensionStatus', scope] });
    }
  };

  /**
   * R8（REQ-20261009-003，二期）：refresh 超时时后端返回 `degraded` +「上次快照 + state:'unknown'」
   * —— 这是"**本次未能确认**"，不是"快照缺失/引擎故障"（N9）：文案必须区分，否则用户会以为
   * 维度信息丢了。降级时把上次已知维度与检查时刻一并给出（快照文件未被改动，仍是有效数据）。
   * 文案生成见 `web/src/lib/vectorDimensionCopy.ts`（纯函数，有单测）。
   * 守 #4：只保留手动「重新检查」，不引入自动轮询/重试。
   *
   * ⚠️ query 处于 error 态时忽略缓存里的 `degraded`：react-query 在 refetch 失败时会保留上次
   * 成功的 data，若沿用它会把**本次请求失败**显示成"刷新未完成 + 上次结果"（把故障说成未知）。
   */
  const dimensionDegraded = dimensionQuery.error ? undefined : dimensionQuery.data?.degraded;
  const dimensionUnknownDetail = dimensionStatusDetail({
    degraded: dimensionDegraded,
    status: dimensionQuery.data?.status,
  });
  /**
   * 维度告警 banner 的展示判定（用户 2026-10-12：异常提示都要能手动消掉）。
   * 忽略按「状态指纹」记（见 lib/vectorDimensionNotice.ts）：状态不变则保持隐藏，
   * 状态一变（重建完成 / 维度值改变 / unknown↔mismatch / 请求恢复或再次失败）立即重新提示。
   */
  const dimensionNotice = useMemo(() => {
    const input = {
      scope,
      state: dimensionQuery.data?.status.state,
      persisted: dimensionQuery.data?.status.persisted,
      configured: dimensionQuery.data?.status.configured,
      degradedReason: dimensionDegraded?.reason,
      hasError: Boolean(dimensionQuery.error),
    };
    if (!shouldShowDimensionNotice(input, readDimensionDismissedFingerprint())) return null;
    return { kind: dimensionNoticeKind(input), fingerprint: dimensionNoticeFingerprint(input) } as const;
    // dismissTick：点忽略后立即重算并隐藏
  }, [scope, dimensionQuery.data, dimensionQuery.error, dimensionDegraded, dismissTick]);
  const dismissDimensionNotice = (fingerprint: string): void => {
    writeDimensionDismissedFingerprint(fingerprint);
    setDismissTick((n) => n + 1);
  };

  /**
   * 全局 Ctrl+F / Cmd+F 判定链（REQ-20261014-002 §2.1）：
   *
   * ① 文档查看器可见（内联 / 全屏 / 抽屉任一形态）→ **文档内查找**；
   * ② 无查看器但有应用内搜索框（`data-ki-search-input`）→ 聚焦它（浏览页 / 检索页的全库与语义搜索）；
   * ③ 两者都无 → 不拦截，保留浏览器原生查找（跨节点命中的兜底路径）。
   *
   * 原判据 `'.ki-drawer:not(.ki-drawer--inline)'` 的缺陷：内联阅读进入全屏后元素**同时**带
   * `--inline --fullscreen` 两个 class，选择器匹配不到 ⇒ 全屏阅读时 Ctrl+F 被抢到「搜索全库文档」框，
   * 与本段原本声明的意图相悖（2026-10-14 实测 + git 历史确认同属 ab1e3ec）。
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const isFind = (e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F');
      if (!isFind) return;
      // ① 文档查看器：查找栏已展开则直接聚焦；未展开则请查看器自行展开（组件内部状态不外露）
      if (document.querySelector('.ki-drawer')) {
        e.preventDefault();
        const findInput = document.querySelector<HTMLInputElement>('[data-ki-drawer-find]');
        if (findInput) {
          findInput.focus();
          findInput.select();
        } else {
          window.dispatchEvent(new CustomEvent(DOC_FIND_OPEN_EVENT));
        }
        return;
      }
      // ② 应用内搜索框
      const target = document.querySelector<HTMLInputElement>('[data-ki-search-input]');
      if (!target) return; // ③ 保留浏览器原生查找
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
          {NAV_MAIN.map((item) => {
            /** 「AI 对话」进行中标记（用户需求 2026-10-14）：挂在图标上，侧栏收起态同样可见 */
            const busy = item.to === '/chat' && chatStreaming;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `ki-nav-item${isActive ? ' ki-nav-item--active' : ''}`
                }
                title={busy ? 'AI 正在生成回答' : undefined}
              >
                <span className="ki-nav-item__icon">
                  <Icon name={item.icon} />
                  {busy ? <span className="ki-nav-item__busy" aria-hidden="true" /> : null}
                </span>
                <span className="ki-nav-item__name">{item.label}</span>
              </NavLink>
            );
          })}
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
                {/* 手动忽略失败 / 部分完成提示：独立按钮（徽章本体是 Link，button 不能嵌进去） */}
                {(failedTasks.length > 0 || partialTasks.length > 0) && (
                  <button
                    className="ki-global-task-dismiss"
                    type="button"
                    onClick={dismissTaskNotices}
                    title="忽略失败 / 部分完成提示；之后出现的新提示会再次提醒，任务页仍可查历史"
                    aria-label="忽略任务提示"
                  >
                    ×
                  </button>
                )}
                <ScopeSelect />
                <ServiceBadge />
              </div>
            </header>
            {dimensionNotice?.kind === 'mismatch' ? (
              <div className="ki-vector-dimension-banner" role="alert">
                <span className="ki-vector-dimension-banner__icon" aria-hidden="true">!</span>
                <div className="ki-vector-dimension-banner__copy">
                  <b>当前知识库的语义向量不可用</b>
                  <span>{scope}：当前 embedding 为 {dimensionQuery.data?.status.configured} 维，旧向量集合为 {dimensionQuery.data?.status.persisted} 维。</span>
                  <code>ki restore {scope} --rebuild-vector --yes</code>
                </div>
                <button className="ki-btn ki-btn--secondary" onClick={() => void refreshDimension()}>重新检查</button>
                <button
                  className="ki-global-task-dismiss ki-vector-dimension-banner__dismiss"
                  type="button"
                  onClick={() => dismissDimensionNotice(dimensionNotice.fingerprint)}
                  title="忽略该提示；维度状态发生变化后会再次提醒"
                  aria-label="忽略向量维度提示"
                >
                  ×
                </button>
              </div>
            ) : dimensionNotice?.kind === 'unknown' ? (
              <div className="ki-vector-dimension-banner ki-vector-dimension-banner--unknown" role="status">
                <span className="ki-vector-dimension-banner__icon" aria-hidden="true">?</span>
                <div className="ki-vector-dimension-banner__copy">
                  <b>{dimensionDegraded ? DEGRADED_TITLE : UNKNOWN_TITLE}</b>
                  <span>{scope} · {dimensionUnknownDetail}</span>
                </div>
                <button className="ki-btn ki-btn--secondary" onClick={() => void refreshDimension()} disabled={dimensionQuery.isFetching}>重新检查</button>
                <button
                  className="ki-global-task-dismiss ki-vector-dimension-banner__dismiss"
                  type="button"
                  onClick={() => dismissDimensionNotice(dimensionNotice.fingerprint)}
                  title="忽略该提示；维度状态发生变化后会再次提醒"
                  aria-label="忽略向量维度提示"
                >
                  ×
                </button>
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
