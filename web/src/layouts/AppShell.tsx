/**
 * AppShell.tsx —— 应用布局（对齐 v2 demo：品牌区 + 分组导航（SVG 图标）+ 共用标题操作区 + 服务徽标）
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, formatRole } from '@/lib/authContext';
import { ChangePasswordDialog } from '@/components/ChangePasswordDialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  summarizeHealth, useHealth, useServerInfo, useVectorAvailability, useVectorDimensionStatus,
  vectorBadgeLabel, type HealthLevel,
} from '@/lib/hooks';
import { ScopeSelect } from '@/components/ScopeSelect';
import { HealthDetailPanel } from '@/components/HealthDetailPanel';
import { DocumentEditor } from '@/components/DocumentEditor';
import { DocumentEditorProvider, type DocumentEditorRequest } from '@/lib/documentEditorContext';
import { ImportPage } from '@/pages/ImportPage';
import { WritePage } from '@/pages/WritePage';
import { useScopeValue } from '@/lib/scopeContext';
import { govFailedMembers } from '@/lib/governanceView';
import { MERGED_WRITE_LABEL, navItemActive, writeTabFromPath } from '@/lib/writeTabs';
import { getTasks, refreshVectorDimensionStatus } from '@/api/tasksApi';
import { dimensionStatusDetail, DEGRADED_TITLE, UNKNOWN_TITLE } from '@/lib/vectorDimensionCopy';
import { visibleTaskNotices } from '@/lib/taskNotice';
import {
  dimensionNoticeFingerprint,
  dimensionNoticeKind,
  readDimensionDismissedFingerprint,
  shouldShowDimensionNotice,
  writeDimensionDismissedFingerprint,
} from '@/lib/vectorDimensionNotice';
import { CodeLangSelect } from '@/components/CodeLangSelect';
import { Icon } from '@/components/icons';
import { ChatPanel } from '@/chat/ChatPanel';
import { createChatStore } from '@/chat/chatStore';
import { ChatStoreContext } from '@/chat/chatStoreContext';
import { chatOpenFromSearch, withChatOpenParam } from '@/lib/chatOpenUrl';
import { aiSettingsHref, isAiSettingsPath, resolveAiSettingsBack } from '@/lib/aiSettingsUrl';
import { DOC_FIND_OPEN_EVENT, pickFindSeed, type DocFindOpenDetail } from '@/lib/docFind';
import { THEME_STORAGE_KEY } from '@/lib/theme';
import webPackage from '../../package.json';

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

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** 精确匹配（只有根路径 `/` 需要） */
  end?: boolean;
  /** 额外算作激活的路径（合并页：一个入口承载 `/import` 与 `/write`） */
  also?: readonly string[];
}

/**
 * 侧栏第一组「工作台」：日常使用知识的五个入口（看 → 读 → 搜 → 问 → 写）。
 * 组名原为「工作空间」，2026-11-16 用户反馈后改掉：本产品里"工作空间/知识库"已被顶栏的
 * scope 选择器占用，同名不同义；且这一组当时还混装了数据源/后台任务/知识视图/资源四项配置类入口，
 * 分组没能降低查找成本。
 */
const NAV_WORKSPACE: NavItem[] = [
  { to: '/', label: '总览', icon: 'grid', end: true },
  { to: '/browse', label: '知识库浏览', icon: 'book' },
  { to: '/search', label: '语义搜索', icon: 'search' },
  // REQ-20261008-001：独立对话页入口（用户拍板 Q1：位于「语义搜索」之下）
  { to: '/chat', label: 'AI 对话', icon: 'chat' },
  /**
   * REQ-20261116-002：原「上传导入」+「知识写入」两项合并为一个入口。
   * 图标取 `edit`（与页面名「知识写入」一致；`upload` 保留给导入 tab 里的拖拽区，
   * 侧栏与页内同义重复会让"哪个是导入"更难认）。`also` 让 `/write` 上侧栏仍然高亮。
   */
  { to: '/import', label: MERGED_WRITE_LABEL, icon: 'edit', also: ['/write'] },
];

/** 侧栏第二组「接入与运维」：知识从哪来、在跑什么、怎么共享与接入 */
const NAV_OPS: NavItem[] = [
  { to: '/datasource', label: '数据源', icon: 'database' },
  { to: '/tasks', label: '后台任务', icon: 'clock' },
  // 知识视图（REQ-20261104-004）：多库聚合视图的团队共享管理页
  { to: '/views', label: '知识视图', icon: 'layers' },
  // 资源（MCP 接入 / Agent Skill 安装）
  { to: '/resources', label: '资源', icon: 'compass' },
];

/**
 * 扁平全量表：顶栏 H1 查表（`currentLabel`）与权限过滤都按它走。
 * 侧栏**渲染不走这里**，而是按上面两组分别渲染（分组标题需要独立节点）。
 */
const NAV_MAIN: NavItem[] = [...NAV_WORKSPACE, ...NAV_OPS];

/**
 * 知识治理三页的顶栏标题（与侧栏「知识治理」分组的 label 保持一致）。
 * 它们挂在 `NAV_MAIN` 之外，`currentLabel` 的常规查表命中不到，故单列一张表。
 */
const GOVERNANCE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['/governance/lifecycle', '分类'],
  ['/governance/events', '事件'],
  ['/governance/trash', '回收站'],
];

function useTheme(): { theme: string; toggle: () => void } {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY) ?? 'light';
    } catch {
      return 'light';
    }
  });
  useEffect(() => {
    document.body.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
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

/**
 * 服务健康徽标（REQ-20261016-003）
 *
 * ★ 由 `<span title>` 升级为 `<button>` + 明细面板：原先完整原因只躺在原生 title 里 ——
 *   触屏没有 hover、键盘用户拿不到 title、长项名还会被固定宽度截断，且多异常项时
 *   只显示第一条。同款问题项目已在 `.ki-code-warn`（MarkdownPreview）解决过，此处沿用
 *   同一口径：点击 / 回车展开，桌面端仍保留 title 速览入口提示。
 * ★ 判据仍是唯一来源 `summarizeHealth`（lib/healthSummary.ts），本组件只负责呈现。
 * ★ 面板为**非模态**浮层：绝对定位、不参与顶栏布局（宽度链 170px 保持不变），
 *   点外部 / ESC 关闭且焦点归还徽标。
 */
function ServiceBadge(): JSX.Element {
  const { data, error, isPending, isFetching, refetch, dataUpdatedAt } = useHealth();
  const s = summarizeHealth(data, error, isPending);
  /**
   * 向量降级：仅"只是向量不可用"时替换文案与点色（判据见 lib/vectorAvailability.ts
   * `vectorBadgeLabel`）。明细面板仍收 `s`（真实 fail 项不隐藏）。
   */
  const vectorAvailability = useVectorAvailability();
  const vectorLabel = vectorBadgeLabel(s, vectorAvailability);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus(); // 键盘用户关掉浮层后不应丢失焦点
    };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const closeAndReturnFocus = useCallback((): void => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  return (
    <div className="ki-service-badge-wrap" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`ki-service-badge${open ? ' ki-service-badge--open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={vectorLabel
          ? `向量不可用${vectorAvailability.reason ?? (s.detail ? `：${s.detail}` : '')}（点击查看服务健康明细）`
          : '点击查看服务健康明细（含每项原因与修复指引）'}
      >
        <span className={`ki-dot ${vectorLabel ? DOT_CLASS.warn : DOT_CLASS[s.level]}`} aria-hidden="true" />
        <span className="ki-service-badge__text">{vectorLabel ?? s.label}</span>
      </button>
      {open && (
        <HealthDetailPanel
          summary={s}
          updatedAt={dataUpdatedAt || undefined}
          checking={isFetching}
          onRetry={() => void refetch()}
          onClose={closeAndReturnFocus}
        />
      )}
    </div>
  );
}

export function AppShell(): JSX.Element {
  const { user, source, can, signOut } = useAuth();
  const navigate = useNavigate();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  // 顶栏 scope 必须在计数 effect 之前声明（deps 里要引用它）
  const scope = useScopeValue();
  // 知识治理三项的计数（REQ-20261113-004 · S-07）：与页面同源，避免侧栏与表格口径漂移
  const [govCounts, setGovCounts] = useState<{ docs: number; eventsOpen: number; trash: number } | null>(null);
  /**
   * 计数请求里**读取失败**的成员库（视图下才有）：三个数字都只统计成功库，
   * 失败库会让数字静默偏小 —— 加 `*` + tooltip，别让用户拿它当准确值（#57 复审补漏）。
   */
  const [govCountsFailed, setGovCountsFailed] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    /*
     * 切 scope 先清空：否则会短暂显示**上一个库**的数字（比显示 0 更误导 ——
     * 用户会以为「这个视图就等于那个库」）。清空期间 badge 不渲染。
     */
    setGovCounts(null);
    setGovCountsFailed([]);
    // scope 必须跟着顶栏选择器走：写死 'default' 会让侧栏显示别的库的数字
    fetch(`/api/governance/counts?scope=${encodeURIComponent(scope)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        if (!alive || !payload || payload.ok !== true) return;
        setGovCounts({ docs: payload.docs, eventsOpen: payload.eventsOpen, trash: payload.trash });
        setGovCountsFailed(govFailedMembers(payload).map((f) => f.scope));
      })
      .catch(() => { /* 计数失败不影响导航 */ });
    return () => { alive = false; };
  }, [scope]);
  const displayName = user?.username ?? (source === 'token' ? 'Token' : '未登录');
  const roleLabel = formatRole(user?.role);
  const initial = displayName.trim().slice(0, 1).toUpperCase() || 'U';

  useEffect(() => {
    if (!userMenuOpen) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [userMenuOpen]);

  const handleLogout = async (): Promise<void> => {
    setUserMenuOpen(false);
    await signOut();
    navigate('/login', { replace: true });
  };

  /**
   * 侧栏可见性过滤：合并项（REQ-20261116-002）一个入口同时承载导入与手动写入，能力要求不变。
   * 抽成函数是因为既要算出扁平表（H1 查表用），也要按分组各算一次。
   */
  const canSeeNavItem = (item: NavItem): boolean => {
    if (!can('knowledge.write') && item.to === '/import') return false;
    if (!can('datasource.read') && item.to === '/datasource') return false;
    return true;
  };
  const navItems = NAV_MAIN.filter(canSeeNavItem);
  /**
   * 侧栏渲染分组（2026-11-16 用户确认方案 A）：工作台 / 接入与运维 + 下方硬编码的「知识治理」。
   * 顺序刻意让「知识治理」留在最底部 —— 分类/事件/回收站三项位置不变，只有四个配置类项下落三行。
   * 空组不渲染（某角色无任何可见项时不该留一个孤零零的组标题）。
   */
  const navGroups: ReadonlyArray<{ label: string; items: NavItem[] }> = [
    { label: '工作台', items: NAV_WORKSPACE.filter(canSeeNavItem) },
    { label: '接入与运维', items: NAV_OPS.filter(canSeeNavItem) },
  ];
  /** 单个侧栏项：两个分组共用同一渲染（图标 + 名称 + AI 对话进行中标记） */
  const renderNavItem = (item: NavItem): JSX.Element => {
    /** 「AI 对话」进行中标记（用户需求 2026-10-14）：挂在图标上，侧栏收起态同样可见 */
    const busy = item.to === '/chat' && chatStreaming;
    /**
     * 高亮改用 `navItemActive`（含 `also`）而不是 NavLink 自带的 isActive：
     * 合并项只声明 `to: '/import'`，NavLink 在 `/write` 上会判为未激活 —— 侧栏不亮、
     * 而顶栏 H1 却显示「知识写入」，两处打架。改用 Link 保留同一视觉与 aria-current。
     */
    const active = navItemActive(item, location.pathname);
    return (
      <Link
        key={item.to}
        to={item.to}
        className={`ki-nav-item${active ? ' ki-nav-item--active' : ''}`}
        aria-current={active ? 'page' : undefined}
        title={busy ? 'AI 正在生成回答' : undefined}
      >
        <span className="ki-nav-item__icon">
          <Icon name={item.icon} />
          {busy ? <span className="ki-nav-item__busy" aria-hidden="true" /> : null}
        </span>
        <span className="ki-nav-item__name">{item.label}</span>
      </Link>
    );
  };

  const [searchParams, setSearchParams] = useSearchParams();
  // ★ D15 硬约束：对话状态与流式累积态必须驻留【AppShell 级】（面板关闭 = 隐藏不卸载），
  //   因此 store 在此创建一次；ChatPanel 只是视图，不持有业务状态（否则关面板会丢内容并连带 abort）
  const chatStoreRef = useRef<ReturnType<typeof createChatStore> | null>(null);
  // 初始开合以**本标签页的 URL** 为准（`chat=1`，见 lib/chatOpenUrl）：
  // 修复「全屏开 AI 对话后刷新，面板被关掉」，且不再用 localStorage —— 那是同源跨标签页共享的，
  // 一个标签页关面板会让另一个标签页刷新后也被关掉（2026-10-14 用户报的 Bug）。
  if (chatStoreRef.current === null) chatStoreRef.current = createChatStore(chatOpenFromSearch(searchParams.toString()));
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
   * 设置面板开合（顶栏开关 / 全屏阅读器内的开关 / 面板关闭按钮 / 路由派生，全走这里）。
   *
   * 只改 store：面板状态本身常驻 store（D15 关闭不卸载），URL 上的 `chat=1` 由下方
   * 「镜像同步」effect 统一维护 —— 于是这里不必再区分「用户意图」与「路由派生」。
   */
  const setChatOpen = useCallback(
    (next: boolean) => {
      chatStore.dispatch({ type: 'setOpen', open: next });
    },
    [chatStore],
  );
  const chatToggleRef = useRef<HTMLButtonElement>(null);
  /**
   * 页脚「MCP 端口」：**动态**取自 daemon（`/healthz`），不写死。
   * 2026-10-27 用户反馈：端口换成 7433 后页脚仍显示 `MCP 7423`，等于指向不存在的地址。
   * 口径（dev 走 proxy 目标端口 / 生产走地址栏 / 逐级回落）见 `lib/daemonPort.ts`。
   */
  const serverInfo = useServerInfo();

  const location = useLocation();
  /**
   * 合并页（REQ-20261116-002）：`/import` 与 `/write` 是同一个页面的两个 tab，页面本体都在
   * AppShell 里常驻渲染、用 `display` 切换 —— **不能**改由 `<Outlet />` 渲染，否则路由一离开
   * 组件就卸载，在途导入的轮询会随之停掉（见 plan 护栏 1）。
   */
  const mergedTab = writeTabFromPath(location.pathname);
  const importTabVisible = mergedTab === 'import';
  const writeTabVisible = mergedTab === 'write';
  /**
   * 写入页改为**首次进入后常驻**（懒挂载）：此前它只在 `/write` 时挂载，合并后若仍按需挂载，
   * 切回导入 tab 会卸载正在写的正文草稿（拍板②要求切 tab 不丢）。
   * 懒挂载而非无条件挂载：未进过写入 tab 的用户不必为它付 `useVectorAvailability` 等查询开销。
   */
  const [writeMounted, setWriteMounted] = useState(writeTabVisible);
  useEffect(() => {
    if (writeTabVisible) setWriteMounted(true);
  }, [writeTabVisible]);
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
      // 此处同样是**路由派生**（恢复进入 /chat 前的先态）：只改 store，URL 标记由见下方
      // 镜像 effect 处理（它在 /chat 上不写，URL 记的是「进入 /chat 前的意图」）。
      if (chatOpenBeforeRef.current) setChatOpen(true);
      chatOpenBeforeRef.current = null;
    }
  }, [isChatRoute, chatStore, setChatOpen]);

  /**
   * 面板开合 ⇄ URL 标记（`chat=1`）镜像同步（2026-10-14 用户裁决：开合态由 URL 承载）。
   *
   * 分工：store 是**渲染来源**（D15 关闭不卸载、不丢对话态），URL 是**跨刷新载体**，两者由本
   * effect 拉平 —— 于是站内跳转（导航链接 / 深链接只带自己的参数）不会把面板关掉，而刷新按本
   * 标签页自己的地址恢复；两个标签页各持一份 URL，互不影响。
   *
   * · 镜像的是**意图**：`/chat` 上 dock 被路由派生收起（Q4/Q5），此时写的是「进入前的开合」，
   *   于是 `/chat` 页刷新后离开仍能恢复先态 —— 与既有「路由派生不写意图」的约定等价。
   * · 合并写（lib/chatOpenUrl.withChatOpenParam）：只增删 `chat`，不动页面自己的参数。
   * · 读 `chatStore.getState()` 而非闭包里的 `chatOpen`：离开 `/chat` 的恢复 dispatch 与本次
   *   effect 同处一轮提交（dispatch 是同步的），闭包值还是收起后的旧值，照它写会先删标记再
   *   加回来（多一次无谓导航，浏览页的深链接 effect 会被顺带重跑）。
   */
  useEffect(() => {
    const intent = isChatRoute && chatOpenBeforeRef.current !== null
      ? chatOpenBeforeRef.current
      : chatStore.getState().open;
    if (chatOpenFromSearch(searchParams.toString()) === intent) return;
    setSearchParams((prev) => withChatOpenParam(prev, intent), { replace: true });
  }, [isChatRoute, chatOpen, chatStore, searchParams, setSearchParams]);
  /**
   * 顶栏 H1 是**页面身份的唯一出口**（与「数据源」等页同口径）。
   * 知识治理三页不在 `NAV_MAIN` 里，故单独查表；此前对 /governance/* 返回空串把它藏起来，
   * 页面身份只剩页内小字面包屑，看起来像"没有标题"（2026-11-15 用户反馈）。
   */
  const govLabel = GOVERNANCE_LABELS.find(([path]) => location.pathname.startsWith(path))?.[1];
  /**
   * AI 设置（2026-11-15）：它不在 `NAV_MAIN` 里（不是一级导航项，只从顶栏入口进），
   * 因此 H1 必须单独查表 —— 否则访问 `/settings/ai` 时标题会显示成「总览」。
   */
  const aiSettingsActive = isAiSettingsPath(location.pathname);
  /**
   * 顶栏「AI 设置」= **toggle**：已在设置页时再点一次 = 关闭并回到进入前的页面。
   * 与「AI 对话」按钮同一种手感（用户 2026-11-15 反馈："再点一下应该能关闭"）。
   * 关闭目标取 URL 上的 `from`（经白名单校验），因此从事件页 / 对话面板进来都能原路返回。
   */
  const toggleAiSettings = useCallback((): void => {
    if (aiSettingsActive) {
      navigate(resolveAiSettingsBack(new URLSearchParams(location.search).get('from')));
      return;
    }
    navigate(aiSettingsHref({ from: `${location.pathname}${location.search}` }));
  }, [aiSettingsActive, location.pathname, location.search, navigate]);

  const currentLabel = aiSettingsActive
    ? 'AI 设置'
    // 用 navItemActive 而不是裸 startsWith：合并项的 `also` 也要命中，
    // 否则在 `/write` 上 H1 会查不到 label 而变空（REQ-20261116-002）
    : govLabel ?? navItems.find((item) => navItemActive(item, location.pathname))?.label ?? (location.pathname.startsWith('/users')
      ? '用户管理'
      : location.pathname.startsWith('/profile')
        ? '个人中心'
        : '总览');
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
  // REQ-20261016-002：查询逻辑抽到 lib/hooks（总览页「嵌入模型 / 向量维度」面板共用同一缓存），
  // 此处行为与抽前逐项等价（见 hooks.useVectorDimensionStatus 注释）。
  const dimensionQuery = useVectorDimensionStatus(scope);
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
   * 见 lib/taskNotice.ts —— 部分完成此前没有手动消除入口，会一直挂到任务台账 TTL 到期。
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
   * ⓿ 文档编辑器打开（`.ki-editor-overlay`）→ **不拦截**，交给浏览器原生查找（编辑器是 textarea）；
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
      /**
       * ⓿ 文档编辑器打开 → **不拦截**，让浏览器原生查找接手（2026-11-12 用户报障修复）。
       *
       * 编辑器主体是 `<textarea>`，Chrome / Safari / Firefox 的原生查找都能直接在其中
       * 定位（这层内容本身就在 DOM 里被渲染）。若让 ①/② 先命中：编辑器是从阅读抽屉里
       * 打开的，`.ki-drawer` 仍在 ⇒ 查找栏会展开在**被编辑器盖住**的抽屉里，用户看到的
       * 就是「按 Ctrl+F 没反应」。
       */
      if (document.querySelector('.ki-editor-overlay')) return;
      // ① 文档查看器：查找栏已展开则直接聚焦；未展开则请查看器自行展开（组件内部状态不外露）
      if (document.querySelector('.ki-drawer')) {
        e.preventDefault();
        // 选中的正文文本 → 查找种子（2026-10-15）：有选中就把所选带入查找栏（编辑器式行为），
        // 无选中则保持原行为（聚焦已展开的输入框并全选 / 展开空查找栏）。
        // ⚠️ 查找栏是受控 input：**已展开时也无法从外部赋值** ⇒ 有种子一律走事件通道，
        // 由查看器自己写入并聚焦（隐藏实例会被查看器侧的可见性判定挡掉）。
        const seed = pickFindSeed(window.getSelection()?.toString() ?? '');
        if (seed) {
          window.dispatchEvent(
            new CustomEvent<DocFindOpenDetail>(DOC_FIND_OPEN_EVENT, { detail: { query: seed } }),
          );
          return;
        }
        // 只认可见的那个输入框：同时挂载多个查看器时（引用预览 + 阅读区），隐藏实例不应偷走焦点
        const findInput = Array.from(document.querySelectorAll<HTMLInputElement>('[data-ki-drawer-find]'))
          .find((el) => el.offsetWidth > 0 || el.offsetHeight > 0);
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

        {/* aria-label：侧栏现在有三个 `<nav>` 地标，无名地标在屏幕阅读器里只会读成
            "导航、导航、导航"，用户分不清哪组是哪组 */}
        {navGroups.map((group) => (
          group.items.length > 0 ? (
            <nav className="ki-sidebar__section" key={group.label} aria-label={group.label}>
              <div className="ki-sidebar__section-head">
                <span className="ki-sidebar__section-label">{group.label}</span>
              </div>
              {group.items.map(renderNavItem)}
            </nav>
          ) : null
        ))}

        {/* 知识治理（REQ-20261113-004 · S-07）：独立分组，三项都是只读即可进入 */}
        <nav className="ki-sidebar__section" aria-label="知识治理">
          <div className="ki-sidebar__section-head">
            <span className="ki-sidebar__section-label">知识治理</span>
          </div>
          {[
            { to: '/governance/lifecycle', label: '分类', icon: 'layers', count: govCounts?.docs },
            { to: '/governance/events', label: '事件', icon: 'clock', count: govCounts?.eventsOpen },
            { to: '/governance/trash', label: '回收站', icon: 'database', count: govCounts?.trash },
          ].map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `ki-nav-item${isActive ? ' ki-nav-item--active' : ''}`}
              title={govCountsFailed.length > 0
                ? `有成员库读取失败：${govCountsFailed.join('、')} —— 数字只统计成功库，可能偏小，请切到具体知识库核对`
                : undefined}
            >
              <span className="ki-nav-item__icon"><Icon name={item.icon} /></span>
              <span className="ki-nav-item__name">{item.label}</span>
              {typeof item.count === 'number' ? (
                <span className="ki-nav-item__count">
                  {item.count}
                  {govCountsFailed.length > 0 ? <span aria-label="计数可能偏小">*</span> : null}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>

        <div className="ki-sidebar__spacer" />

        <div className="ki-sidebar__footer">
          <strong className="ki-sidebar__footer-title">本地工作区</strong>
          {/* 端口动态取自 daemon（/healthz），见 useServerInfo —— 不写死 7423 */}
          <span className="ki-sidebar__footer-meta">ki v{webPackage.version} · MCP {serverInfo.port}</span>
          {/* 顺序固定为：GitHub（最左）→ 首选代码语言（中）→ 主题切换（最右），见 ki.css 的 .ki-sidebar__footer-row */}
          <div className="ki-sidebar__footer-row">
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
            <CodeLangSelect />
            <button className="ki-icon-link" onClick={toggle} title="切换主题" aria-label="切换主题">
              <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
            </button>
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
                {/*
                  AI 设置入口（2026-11-15）：与「AI 对话」并列，任意页可达。
                  此前 AI 配置只能从对话面板头部的「配置」进入 —— 在事件页想调提示词
                  必须"开面板 → 点配置 → 再关掉"，属于纯粹的绕路。
                  `from` 带上当前地址，设置页的返回按钮据此回到来源页（白名单校验）。
                */}
                <button
                  type="button"
                  className="ki-topbar__chat-toggle"
                  onClick={toggleAiSettings}
                  title={aiSettingsActive ? '关闭 AI 设置（返回上一页）' : 'AI 设置：提示词 / Skill / 工具 / 预算'}
                  aria-label={aiSettingsActive ? '关闭 AI 设置' : 'AI 设置'}
                  aria-pressed={aiSettingsActive}
                >
                  <Icon name="sliders" />
                  <span className="ki-topbar__chat-label">AI 设置</span>
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
                <div className="ki-user-menu" ref={userMenuRef}>
                  <button
                    type="button"
                    className="ki-user-menu__trigger"
                    aria-haspopup="menu"
                    aria-expanded={userMenuOpen}
                    onClick={() => setUserMenuOpen((open) => !open)}
                    title={`${displayName} · ${roleLabel}`}
                  >
                    <span className="ki-user-menu__avatar" aria-hidden="true">{initial}</span>
                    <span className="ki-user-menu__name">{displayName}</span>
                    <span className="ki-user-menu__caret" aria-hidden="true">▾</span>
                  </button>
                  {userMenuOpen ? (
                    <div className="ki-user-menu__pop" role="menu">
                      <div className="ki-user-menu__meta">
                        <strong>{displayName}</strong>
                        <span>{roleLabel}{source === 'local' ? ' · 本机' : ''}</span>
                      </div>
                      <button type="button" role="menuitem" onClick={() => { setUserMenuOpen(false); navigate('/profile'); }}>
                        个人中心
                      </button>
                      {can('users.manage') ? (
                        <button type="button" role="menuitem" onClick={() => { setUserMenuOpen(false); navigate('/users'); }}>
                          用户管理
                        </button>
                      ) : null}
                      {source === 'session' ? (
                        <button type="button" role="menuitem" onClick={() => { setUserMenuOpen(false); setPasswordOpen(true); }}>
                          修改密码
                        </button>
                      ) : null}
                      {source === 'session' ? (
                        <button type="button" role="menuitem" onClick={() => void handleLogout()}>
                          退出登录
                        </button>
                      ) : null}
                      {source === 'local' ? (
                        <p className="ki-user-menu__note">本机管理员 · 无需登录</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </header>
            {!can('knowledge.write') ? (
              <div className="ki-readonly-banner" role="status">
                <strong>当前账号为只读</strong>
                <span>导入、编辑、写入等操作已禁用；如需写入请联系管理员调整权限。</span>
              </div>
            ) : null}
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
            {/* 合并页（REQ-20261116-002）：两个 tab 的面板都在这里常驻，用 display 切换。
                导入页**始终挂载**（含离开 `/import` 时）—— 在途导入的轮询靠它延续；
                写入页首次进入后常驻 —— 切 tab 不丢正文草稿。 */}
            <div style={{ display: importTabVisible ? 'contents' : 'none' }}>
              <ImportPage />
            </div>
            {/* 能力门禁仍是知识的写权限：`routes.tsx` 的 RequireCapability 会把人重定向走，
                但重定向前 AppShell 已经渲染了一帧 —— 这里先拦住，别让只读账号短暂挂载写入页
                （改造前该页在路由里渲染，只读账号根本不挂载）。导入页是改造前就无条件挂载的，
                不在本次调整范围。 */}
            {writeMounted && can('knowledge.write') ? (
              <div style={{ display: writeTabVisible ? 'contents' : 'none' }}>
                <WritePage />
              </div>
            ) : null}
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
    {passwordOpen ? (
      <ChangePasswordDialog
        onClose={() => setPasswordOpen(false)}
        onSaved={() => setPasswordOpen(false)}
      />
    ) : null}
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
