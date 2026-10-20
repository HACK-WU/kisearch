/**
 * BrowsePage.tsx —— 知识库浏览（对齐 demo 双栏：左 Group 递归树 + 右文档列表 + 原文抽屉）
 *
 * 数据源：/api/doc/list（返回 Group 路径 + 文档，支持 q **名称 / 路径**搜索）
 * 原文：ki_get_module_info
 */

import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  browseFullscreenFromSearch,
  browseLinkKey,
  browseSearch,
  isBrowseUrlSelfWritten,
  markBrowseUrlSelfWritten,
} from '@/lib/browseUrl';
import { chatOpenFromSearch, withChatOpenParam } from '@/lib/chatOpenUrl';
import { useScope } from '@/lib/scopeContext';
import { useDocList, useGroupDocs, getDocList, fetchGroupDocsAll, type DocListResponse } from '@/lib/hooks';
import { getTasks, scopeImportRunning, type TaskRecord } from '@/api/tasksApi';
import { getDocContent, type DocItem } from '@/api/httpApi';
import { kiSearch, type SearchHit, type SearchResult } from '@/api/mcpClient';
import { ModuleDrawer } from '@/components/ModuleDrawer';
import { ChatToggleButton } from '@/chat/ChatToggleButton';
import { TagSelect } from '@/components/TagSelect';
import { Icon } from '@/components/icons';
import {
  documentViewForScope,
  resolveDocumentLink,
  type DocumentView,
  type ScopedDocumentView,
} from '@/lib/documentLinks';
import { highlightMatch, makeSearchSnippet } from '@/lib/searchText';
// 路径检索：命中分区 / 结果头计数 / 展示路径（见各模块头部说明）
import {
  docDisplayPath,
  hasNameOrPathHit,
  hasSearchTerm,
  searchResultSummary,
  splitSearchDocs,
} from '@/lib/browseSearchGroups';
import { findPathHighlightRange } from '@/lib/pathHighlight';
import {
  browseViewReducer,
  deriveBrowseMode,
  initialBrowseView,
  type BrowseViewMode,
} from '@/lib/browseReadMode';
import { revealTreeRow } from '@/lib/treeReveal';
import {
  applyOpenPaths,
  buildGroupTree,
  countDocs,
  findGroupNode,
  firstGroupWithDocuments,
  isGroupSelectable,
  revealGroupPath,
  toggleNodeOpen,
  withAllOpen,
  withDefaultOpen,
  type GroupTreeNode as TreeNode,
} from '@/lib/groupTree';
import {
  readBrowseTreeState,
  treeStateFromTree,
  writeBrowseTreeState,
  type BrowseTreeState,
} from '@/lib/browseTreeState';

/** 树内所有 Group 是否都已展开（决定折叠按钮当前动作与图标；demo 为单按钮切换） */
function isAllOpen(nodes: TreeNode[]): boolean {
  return nodes.every((node) => node.open && isAllOpen(node.children));
}

const ICON_FOLDER = (
  <svg
    className="ki-tree-icon"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M1.6 3.7c0-.6.5-1.1 1.1-1.1h2.9l1.6 1.7h5.7c.6 0 1.1.5 1.1 1.1v6.9c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1V3.7z" />
  </svg>
);

/** 全屏阅读器导航图标（描边风格，与 Group 树文件夹图标统一） */
const ICON_NAV_TREE = (
  <svg className="ki-reader-nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="16" y="16" width="6" height="6" rx="1.5" />
    <rect x="2" y="16" width="6" height="6" rx="1.5" />
    <rect x="9" y="2" width="6" height="6" rx="1.5" />
    <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
    <path d="M12 12V8" />
  </svg>
);

const ICON_NAV_COLLAPSE = (
  <svg className="ki-reader-nav__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.5 6.5 9 12l5.5 5.5" />
  </svg>
);

const ICON_NAV_REFRESH = (
  <svg className="ki-reader-nav__action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
);



/** 树节点无障碍名称：显式给出，避免 treeitem 按内容取名时把箭头按钮文案与计数混进来 */
function treeNodeLabel(node: TreeNode, totalDocs: number): string {
  const parts = [node.name];
  if (node.children.length > 0 && node.count > 0) {
    parts.push(`本组 ${node.count} 条`, `含子组共 ${totalDocs} 条`);
  } else {
    parts.push(`${totalDocs} 条`);
  }
  return parts.join('，');
}

export function BrowsePage(): JSX.Element {
  const { scope, setScope } = useScope();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  /**
   * 本页相关查询的在途状态（scope 列表 / 文档列表 / 全文检索）——只驱动刷新按钮的「刷新中」反馈。
   * 不能用全局 useIsFetching()：任务、健康检查等常驻轮询会把它长期抬为 > 0，
   * 导致刷新按钮常年禁用、点了毫无反应。也不禁用按钮：请求期间允许重复点击（React Query 自动去重）。
   */
  const fetching =
    useIsFetching({
      predicate: (query) => ['scopeList', 'docList', 'fullTextSearch'].includes(String(query.queryKey[0])),
    }) > 0;
  /** 手动刷新窗口：本地请求 ~70ms，旋转一闪而过等于没反馈，故保证至少转 600ms */
  const [manualRefreshing, setManualRefreshing] = useState(false);

  /** 点击刷新：失效本页查询，并在最小反馈时长内保持旋转 */
  const refreshNow = (): void => {
    if (manualRefreshing) return;
    setManualRefreshing(true);
    void Promise.all([
      queryClient.invalidateQueries(),
      new Promise((resolve) => setTimeout(resolve, 600)),
    ]).finally(() => setManualRefreshing(false));
  };
  /** 旋转/「刷新中」的判定：本页查询在途 或 手动刷新窗口内 */
  const busy = fetching || manualRefreshing;
  const [q, setQ] = useState('');
  /**
   * 左树持久化状态（按 scope 分桶）：目录展开 / 选中 Group / 左列收起刷新后保持。
   * 只在挂载与切 scope 时读取一次（见下方 scope 变化 effect），运行期以组件 state 为准。
   */
  const initialTreeStateRef = useRef<BrowseTreeState | null>(null);
  if (initialTreeStateRef.current === null) initialTreeStateRef.current = readBrowseTreeState(scope);
  const savedOpenPathsRef = useRef<string[] | null>(initialTreeStateRef.current.openPaths);
  const savedActiveGroupRef = useRef(initialTreeStateRef.current.activeGroup);
  /** 最近一次「因选中项变化而展开目录」的 Group；刷新恢复时初始化为恢复值，避免把持久化的折叠态抢回展开 */
  const revealedActiveGroupRef = useRef<string | null>(initialTreeStateRef.current.activeGroup || null);
  const [activeGroup, setActiveGroup] = useState(initialTreeStateRef.current.activeGroup);
  const [viewing, setViewing] = useState<ScopedDocumentView | null>(null);
  // Scope 切换的清理在 effect 中执行，首帧仍可能持有旧 viewing；渲染守卫必须同步生效，
  // 以免 ModuleDrawer 用新 scope 请求旧 Group/Relation。
  const currentViewing = documentViewForScope(scope, viewing);
  const [history, setHistory] = useState<ScopedDocumentView[]>([]);
  const [forwardHistory, setForwardHistory] = useState<ScopedDocumentView[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [searchQ, setSearchQ] = useState('');
  /**
   * 主区视图状态（REQ-20261018-001）：
   * - `viewMode`：文档呈现形态 —— 内联阅读区 / 右侧抽屉；
   * - `resultsHidden`：用户用「在页内打开」显式隐藏了结果列表。
   *
   * 不用原 `viewingSource: 'tree' | 'search'`：它同时承担"从哪来"与"怎么显示"两个语义，
   * 加了"页内打开结果"这第三种入口后必然打架（从结果来、却要内联显示）。
   */
  const [browseView, dispatchBrowseView] = useReducer(browseViewReducer, initialBrowseView);
  // 阅读器全屏时把 Browse 导航（Group 树）带入工作区；默认折叠，可从收起态展开。
  // 文档列表卡已按用户决策移除——全屏阅读以树选文档即可，列表与正文重复。
  const [readerFullscreen, setReaderFullscreen] = useState(false);
  const [readerOutlineCollapsed, setReaderOutlineCollapsed] = useState(true);
  /** 全屏工作区的知识目录：默认展开（用户 2026-10-02 要求）；收起后只留一个展开按钮 */
  const [readerGroupCollapsed, setReaderGroupCollapsed] = useState(false);
  // tag 过滤：选中则仅显示带该 tag 的文档；空表示不过滤
  const [selectedTag, setSelectedTag] = useState('');
  // 树内文档叶子：按 Group 缓存已加载文档（全量列表优先，被 500 条截断的 Group 懒加载补齐）
  const [docsByGroup, setDocsByGroup] = useState<Record<string, DocItem[]>>({});
  const loadedGroupsRef = useRef<Set<string>>(new Set());
  // 正文宽度：默认铺满；≥1480px 提供「居中 / 铺满」切换（对齐浏览 demo）
  const [readerWide, setReaderWide] = useState(true);
  /** 知识目录折叠：收起后左列变成窄条，正文拿到全部宽度（用户 2026-10-02 要求） */
  const [treeCollapsed, setTreeCollapsed] = useState(initialTreeStateRef.current.collapsed);
  // 窄屏：点树内文档后阅读区以覆盖层展开（CSS 仅在 ≤959px 生效），「返回目录」关闭
  const [mobileReaderOpen, setMobileReaderOpen] = useState(false);
  const appliedDirectTarget = useRef('');
  /** 最近一次已知的 URL 查询串（页面写入或深链接应用后同步）；写入前比较，避免无谓导航 */
  const currentSearchRef = useRef(searchParams.toString());
  /**
   * 每个 scope 只自动打开一次第一篇（用户主动关闭后不再抢回焦点）。
   * 刷新 / 深链接恢复同样算「已自动展示」，由深链接 effect 置位。
   */
  const autoOpenRef = useRef(false);
  const previousScopeRef = useRef(scope);
  const directoryRef = useRef<HTMLDivElement>(null);
  const fullscreenDirectoryRef = useRef<HTMLDivElement>(null);
  const revealedDirectoryTarget = useRef('');

  const directTarget = searchParams.toString();
  /**
   * 深链接判定的比较键：剔除与阅读态无关的 AI 面板标记（`chat=1`）——面板开关会写当前地址
   * （AppShell 镜像），若不剔除，开关一次面板就会被当成「URL 目标变了」而重放一遍阅读态。
   */
  const directTargetKey = browseLinkKey(directTarget);
  const hasDirectDocumentTarget = searchParams.get('scope') === scope
    && Boolean(searchParams.get('group') && searchParams.get('relation'));
  const { data, isLoading, isError, error, refetch } = useDocList(scope);

  /**
   * 阅读态 → URL（replace）：URL 承担「刷新后恢复现场」与复制分享，
   * 不产生浏览器历史 —— 文档导航仍由阅读器自带的「上一级 / 下一级」承担。
   * 修复前只实现了反方向（URL → 页面），故刷新会退回默认第一篇。
   */
  const writeBrowseUrl = useCallback((view: ScopedDocumentView | null, fullscreen: boolean): void => {
    // AI 面板开合标记（`chat=1`）不属于阅读态，但与之同处一个查询串：重建参数时按当前地址原样带上。
    // 否则 AppShell 的镜像 effect 得再补写一次 —— 那次导航会让下面的深链接 effect 重跑
    // （directTarget 变了），把用户刚输入的列表过滤词清掉、并重放一次阅读态。
    const next = withChatOpenParam(
      browseSearch(view, fullscreen),
      chatOpenFromSearch(currentSearchRef.current),
    ).toString();
    if (next === currentSearchRef.current) return;
    currentSearchRef.current = next;
    // 这次参数变化来自页面自身，深链接 effect 不必把同一目标再应用一遍（比较键不含面板标记）。
    appliedDirectTarget.current = browseLinkKey(next);
    // 标记「URL 是页面自己写的」：刷新时据此保持目录布局，而不是按外部深链接重置（见深链接 effect）。
    markBrowseUrlSelfWritten(next);
    setSearchParams(new URLSearchParams(next), { replace: true });
  }, [setSearchParams]);

  // S0-6：列表加载中时查本 scope 是否有运行中的导入任务（同 scope 读请求会排在
  // import 之后）——有则骨架屏改为「等待导入队列」说明，而非无说明骨架条。
  // 仅 isLoading 时启用；动态轮询：无命中 2s（快速出现提示）/已命中 5s（刷进度），
  // 加载完成后停止（不为常驻轮询加负载）。
  const importTaskQuery = useQuery<TaskRecord | null, Error>({
    queryKey: ['scopeImportTask', scope],
    queryFn: async () => scopeImportRunning((await getTasks(100)).tasks, scope),
    enabled: isLoading,
    refetchInterval: (query) => (query.state.data ? 5000 : 2000),
    staleTime: 0,
    retry: 1,
  });
  const importTask = isLoading ? importTaskQuery.data ?? null : null;
  useEffect(() => {
    // URL 是权威的「当前地址」：无论本轮是否应用，都先把写回时的比较基准同步过来
    // （浏览器前进后退、地址栏手改都走这里）。
    currentSearchRef.current = directTarget;
    if (!directTarget) {
      appliedDirectTarget.current = '';
      return;
    }
    if (appliedDirectTarget.current === directTargetKey) return;
    const params = new URLSearchParams(directTarget);
    const targetScope = params.get('scope');
    const group = params.get('group');
    const relation = params.get('relation');
    if (!targetScope) {
      appliedDirectTarget.current = '';
      return;
    }
    if (scope !== targetScope) {
      setScope(targetScope);
      return;
    }
    if (!group && !relation && data?.scope !== targetScope) return;
    if (group && relation) {
      // URL 是本页自己写的（刷新恢复）→ 目录布局与选中项保持本地记忆；
      // 外部深链接 / 新标签页打开 → 展开左列并把目录定位到目标文档所在组。
      if (!isBrowseUrlSelfWritten(directTarget)) {
        setTreeCollapsed(false);
        setActiveGroup(group);
      }
      dispatchBrowseView({ type: 'open-inline' });
      setMobileReaderOpen(true);
      setQ('');
      setSearchQ('');
      setSelectedTag('');
      // 刷新恢复现场：全屏阅读态也随 URL 一起回来（reader=1）
      setReaderFullscreen(browseFullscreenFromSearch(directTarget));
      // 深链接 / 刷新恢复也算「该 scope 已自动展示过」：否则用户随后关闭文档时会被
      // autoOpen 抢回第一篇（与该标记「主动关闭后不再抢回焦点」的约定相悖）。
      autoOpenRef.current = true;
      setViewing({ scope, group, module: relation, anchor: params.get('anchor') ?? undefined });
    } else {
      // scope / scope+group 是浏览入口：前者显示默认 Group，后者显示指定 Group；都不打开命中文档。
      setViewing(null);
      setMobileReaderOpen(false);
      setHistory([]);
      setForwardHistory([]);
      setReaderFullscreen(false);
      if (group) {
        setTreeCollapsed(false);
        setActiveGroup(group);
      } else if (data?.scope === targetScope) {
        const base = withDefaultOpen(buildGroupTree(data.groups ?? []));
        setActiveGroup(firstGroupWithDocuments(base) || (base.length > 0 ? base[0].path : ''));
      }
      setQ('');
      setSearchQ('');
      setSelectedTag('');
    }
    appliedDirectTarget.current = directTargetKey;
  }, [directTarget, directTargetKey, scope, setScope, data?.scope, data?.groups]);

  // 可用 tag 列表由 TagSelect 自行从 /api/doc/list 的 tags 字段读取（KB 层 relation.tags 去重，
  // 而非 /api/tags 的向量库 tag）；react-query 同 key 缓存，不会产生额外请求

  // 选中 group 的完整文档（后端按 group 精确返回，不受 500 条全量分页截断影响）
  const groupQuery = useGroupDocs(scope, activeGroup || null, selectedTag || undefined);
  const groupDocs = groupQuery.data?.docs ?? [];

  // 切换 scope 后清理旧 scope 的页面状态。阅读器必须先卸载：它按传入 scope 拉取正文，
  // 若沿用旧 Group/Relation，会对新 scope 发出一次必然失败的请求。
  useEffect(() => {
    if (previousScopeRef.current === scope) return;
    previousScopeRef.current = scope;
    setQ('');
    setSearchQ('');
    setSelectedTag('');
    // 上一个 scope 的「页内打开」不应带到新 scope（q 被清空后结果态本就不存在，这里一并归零）
    dispatchBrowseView({ type: 'show-results' });
    // 左树状态按 scope 分桶：切换后重新读取该 scope 的目录状态，避免把上一个 scope 的布局写过去
    const savedTree = readBrowseTreeState(scope);
    savedOpenPathsRef.current = savedTree.openPaths;
    savedActiveGroupRef.current = savedTree.activeGroup;
    // 该 scope 的恢复值即「当前选中项」：不视为需要强制展开的变化
    revealedActiveGroupRef.current = savedTree.activeGroup || null;
    setTreeCollapsed(savedTree.collapsed);
    // URL 里写的是上一个 scope 的文档（用户手动切换 scope）→ 清掉参数，
    // 否则刷新会被旧 scope 的深链接拉回去；深链接切换时参数里的 scope 就是新 scope，保留给下面的效果处理。
    if (searchParams.get('scope') && searchParams.get('scope') !== scope) writeBrowseUrl(null, false);
    // 深链接的 effect 会在同一轮提交里设置目标文档；不要在这里把它清掉。
    if (hasDirectDocumentTarget) return;
    setViewing(null);
    setHistory([]);
    setForwardHistory([]);
    setReaderFullscreen(false);
    setReaderOutlineCollapsed(true);
    setMobileReaderOpen(false);
  }, [hasDirectDocumentTarget, scope, searchParams, writeBrowseUrl]);

  // 搜索防抖：保留现有“跨 Group 搜索”语义，只减少逐字请求与列表闪烁。
  useEffect(() => {
    if (!q.trim()) {
      setSearchQ('');
      return;
    }
    const timer = window.setTimeout(() => setSearchQ(q.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  /**
   * 检索条件一变即回到结果列表（REQ-20261018-001 R5）。
   *
   * 页内阅读没有显式「返回检索结果」入口（用户 D3 拍板），修改检索词 / 切换 tag 就是唯一回退路径：
   * 不自动复位的话，用户会陷入"输入了词却仍停在正文、看不到结果"的错觉。
   * 用输入值 `q` 而非防抖后的 `searchQ`：一敲字就复位，不等 300ms。
   */
  useEffect(() => {
    dispatchBrowseView({ type: 'show-results' });
  }, [q, selectedTag]);

  // 浏览页：禁止外层 .ki-content 滚动，让双栏内部各自滚动
  useEffect(() => {
    const el = document.querySelector('.ki-content');
    if (el) el.classList.add('ki-content--noscroll');
    return () => { el?.classList.remove('ki-content--noscroll'); };
  }, []);

  // ── Group 树构建（仅在 groups 数据变化时重建，activeGroup 变化不触发重建）──
  // 分离原因：activeGroup 变化时若重建树 + 默认展开，会导致非一级节点被折叠。
  useEffect(() => {
    const rawGroups = data?.groups;
    if (!rawGroups?.length) {
      setTree([]);
      return;
    }
    const base = withDefaultOpen(buildGroupTree(rawGroups));
    // 恢复上次的目录展开态（该 scope 无记录时沿用默认展开）
    const savedOpenPaths = savedOpenPathsRef.current;
    setTree(savedOpenPaths ? applyOpenPaths(base, savedOpenPaths) : base);
    // 默认选中第一个有自身文档的 Group，包括有子级的父 Group。
    setActiveGroup((prev) => {
      // 已有选中且仍在树中 → 保留（避免重复请求）
      if (prev && findGroupNode(base, prev)) return prev;
      // 其次沿用该 scope 上次的选中项（刷新 / 切回来时）
      const saved = savedActiveGroupRef.current;
      if (saved && findGroupNode(base, saved)) return saved;
      return firstGroupWithDocuments(base) || (base.length > 0 ? base[0].path : '');
    });
  }, [data?.groups]); // ← 仅依赖 groups，不依赖 activeGroup

  // 左树状态（展开 / 选中 / 左列收起）变化即写回 localStorage —— 刷新后目录保持原样。
  // 只在数据属于当前 scope 时写入：切 scope 的过渡渲染里 tree 仍挂着上一个 scope 的树，
  // 此时写入会把旧 scope 的布局记到新 scope 名下。
  useEffect(() => {
    if (data?.scope !== scope || tree.length === 0) return;
    writeBrowseTreeState(scope, treeStateFromTree(tree, treeCollapsed, activeGroup));
  }, [scope, data?.scope, tree, treeCollapsed, activeGroup]);

  // 选中项**变化**时（点选 / 链接跳转 / 首次默认选中）展开其祖先链并展开自身，保证目录可见。
  // 选中项未变则不动树：否则「用户手动折叠当前选中目录」会被数据刷新、布局变化等无关渲染抢回，
  // 刷新后的持久化展开态也无法保持（revealGroupPath 幂等，已可见时返回原引用）。
  useEffect(() => {
    if (!activeGroup) return;
    if (revealedActiveGroupRef.current === activeGroup) return;
    revealedActiveGroupRef.current = activeGroup;
    setTree((prev) => {
      const revealed = revealGroupPath(prev, activeGroup);
      const target = findGroupNode(revealed, activeGroup);
      return target && !target.open ? toggleNodeOpen(revealed, activeGroup) : revealed;
    });
  }, [activeGroup, currentViewing?.group, currentViewing?.module, data?.groups, readerFullscreen]);

  // Wait for ancestor expansion and document loading, then reveal once per navigation.
  useEffect(() => {
    const directoryCollapsed = readerFullscreen ? readerGroupCollapsed : treeCollapsed;
    if (!activeGroup || directoryCollapsed) return;
    const documentName = currentViewing?.group === activeGroup ? currentViewing.module : '';
    if (documentName && groupQuery.isFetching) return;
    const key = JSON.stringify([scope, activeGroup, documentName, readerFullscreen, directoryCollapsed]);
    if (revealedDirectoryTarget.current === key) return;
    const frame = requestAnimationFrame(() => {
      const container = readerFullscreen ? fullscreenDirectoryRef.current : directoryRef.current;
      if (!container) return;
      const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-ki-group]'));
      const row = rows.find((item) => item.dataset.kiGroup === activeGroup
        && (documentName ? item.dataset.kiDocument === documentName : !item.dataset.kiDocument));
      if (!row) return;
      revealTreeRow(container, row);
      revealedDirectoryTarget.current = key;
    });
    return () => cancelAnimationFrame(frame);
  }, [scope, activeGroup, currentViewing, readerFullscreen, treeCollapsed, readerGroupCollapsed, groupQuery.isFetching, tree, docsByGroup]);

  // ── 全局搜索：有搜索词时发起后端 q 参数请求（跨组「名称 / 路径」模糊匹配，limit=2000）──
  // 判空由 hasSearchTerm 负责（只由分隔符/空白组成 = 无检索词，N1）：否则输入 `/` 会发一次请求并
  // 命中全库（实测 161 条）——那既不是用户要的，也把"空输入"伪装成了"有结果"。
  const searchQuery = useQuery<DocListResponse>({
    queryKey: ['docList', scope, 'search', searchQ, selectedTag],
    queryFn: () => getDocList(scope, { q: searchQ, tag: selectedTag || undefined }),
    enabled: hasSearchTerm(searchQ),
    staleTime: 10_000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });
  const searchDocs = searchQuery.data?.docs ?? [];
  /** 名称命中 / 路径命中分区（后端 matchedBy 决定；旧 daemon 无该字段时全部归名称，不丢结果） */
  const searchSections = useMemo(() => splitSearchDocs(searchDocs), [searchDocs]);
  const isSearching = hasSearchTerm(q);
  /**
   * 主区形态（REQ-20261018-001）：结果列表可见 = 有检索词 **且** 未被「在页内打开」隐藏。
   *
   * 原实现是 `showingResults = isSearching`（检索态下主区恒为结果列表，2026-10-16 决策：
   * 防止"先开着文档再搜索，主区仍是旧文档"）。页内打开引入了第三种意图，故拆成派生状态；
   * 原决策由 R5 守住 —— 检索条件一变立即回到结果列表。
   */
  const readMode = deriveBrowseMode({
    isSearching,
    resultsHidden: browseView.resultsHidden,
    hasViewing: currentViewing !== null,
  });
  const showingResults = readMode === 'results';
  const readingInline = readMode === 'reading';

  /**
   * 全库搜索框在两种状态下**换宿主**渲染：
   * - 阅读态（`readingInline`）→ 查看器的一行头部（`ModuleDrawer` 的 `inlineSearch`）；
   * - 结果态 → 页级工具栏（本文件）。
   *
   * 宿主切换 = 输入框卸载重建。若不管，用户敲下第一个字符（300ms 防抖后进入结果态）
   * 就会把焦点丢到 body —— 表现为「打着字忽然不能打了」。这两个 ref 用于**焦点接力**：
   * `lastTypingAtRef` 记住最近一次真实输入的时刻，切换时只在「刚刚还在输入」时把焦点交给
   * 新宿主，避免无谓抢焦点（例如用户只是点了 Tag）。
   */
  const pageSearchRef = useRef<HTMLInputElement>(null);
  const lastTypingAtRef = useRef(0);
  const handleSearchInput = useCallback((value: string): void => {
    lastTypingAtRef.current = Date.now();
    setQ(value);
  }, []);

  // 文档列表搜索之外，按同一关键词查询正文；结果独立展示，避免把“名称 / 路径命中”
  // 与“正文命中”混成一个排序口径。仅使用 FTS-only/hybrid 的全文分支，不调用 embedding。
  const fullTextQuery = useQuery<SearchResult>({
    queryKey: ['fullTextSearch', scope, searchQ, selectedTag],
    queryFn: () => kiSearch(searchQ, {
      scope,
      tags: selectedTag ? [selectedTag] : ['ki-search'],
      limit: 20,
      mode: 'fulltext',
    }),
    // 与名称/路径检索同一判空口径：无有效检索词时不打 FTS（否则正文噪声会顶出"有结果"的假象）
    enabled: hasSearchTerm(searchQ),
    staleTime: 10_000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });
  const fullTextHits = fullTextQuery.data?.results ?? [];

  const clearFilters = useCallback((): void => {
    setQ('');
    setSelectedTag('');
  }, []);

  // 合并当前已知文档：全量列表 + 当前 Group 完整列表 + 当前搜索结果。
  // group 查询不受全量列表 500 条上限影响，因此当前 Group 的本地链接始终优先可解析。
  const knownDocs = useMemo(() => {
    const byKey = new Map<string, DocItem>();
    for (const doc of [...(data?.docs ?? []), ...groupDocs, ...searchDocs]) {
      byKey.set(`${doc.group}\u0000${doc.name}`, doc);
    }
    return [...byKey.values()];
  }, [data?.docs, groupDocs, searchDocs]);
  /**
   * 打开文档时把知识目录同步到它所在的 Group（REQ-20261018-001 D4：抽屉与页内两条路径共用）。
   *
   * 这里**直接**展开目标 Group 与祖先链，而不是只改 activeGroup 等 effect 去展开：
   * 重复打开同一篇文档时 activeGroup / currentViewing 的依赖值都没变，effect 不会重跑，
   * 用户手动折叠过的 Group 会保持折叠 —— 目录看起来"没切过去"。
   * 同时清掉滚动去重键，保证重新展开后仍会滚到该行。
   */
  const syncDirectoryTo = useCallback((group?: string): void => {
    if (!group) return;
    setTreeCollapsed(false);
    setActiveGroup(group);
    setTree((prev) => {
      const revealed = revealGroupPath(prev, group);
      const target = findGroupNode(revealed, group);
      return target && !target.open ? toggleNodeOpen(revealed, group) : revealed;
    });
    // 已由上面的 setTree 完成展开，effect 不必再跑一次；但仍保持"选中项已揭示"的语义。
    revealedActiveGroupRef.current = group;
    revealedDirectoryTarget.current = '';
  }, []);

  /**
   * 手动打开文档是新的导航起点，不沿用上一次文档链接产生的历史。
   *
   * `syncDirectory=false` 只给「默认打开第一篇」用：那是页面初始化，不是用户导航，
   * 不应把用户持久化的目录折叠态强行展开（否则刷新一次就把「收起知识目录」的偏好重置）。
   */
  const openDocument = useCallback((
    doc: DocumentView,
    mode: BrowseViewMode = 'inline',
    syncDirectory = true,
  ): void => {
    dispatchBrowseView({ type: mode === 'drawer' ? 'open-drawer' : 'open-inline' });
    setHistory([]);
    setForwardHistory([]);
    if (syncDirectory) syncDirectoryTo(doc.group);
    const target = { ...doc, scope };
    setViewing(target);
    writeBrowseUrl(target, readerFullscreen);
  }, [scope, readerFullscreen, writeBrowseUrl, syncDirectoryTo]);

  /**
   * 结果行「在页内打开」：隐藏结果列表，主区切正文，左侧目录同步定位。
   * 窄屏同时展开阅读覆盖层（与树点击同一口径）。
   *
   * 同时清空全库检索词：搜索框属于结果态，留在阅读态会让人误以为"还在检索"，
   * 且按 D3 没有返回入口 —— 清空后搜索框回到空态，输入新词即重新进入结果列表。
   * 正文高亮不受影响：它走 `viewing.highlightQuery`（打开瞬间的快照），不是这里的 `q`。
   */
  const openDocumentInline = useCallback((doc: DocumentView): void => {
    setMobileReaderOpen(true);
    dispatchBrowseView({ type: 'hide-results' });
    setQ('');
    setSearchQ('');
    openDocument(doc, 'inline');
  }, [openDocument]);

  /**
   * 默认打开第一篇：数据就绪、有文档、且用户尚未打开任何文档时，自动展示第一篇内容。
   * 只有文档数为 0 时才显示「从左侧目录选择文档开始阅读」的真实空白页（用户要求）。
   * autoOpenRef 保证每个 scope 只自动打开一次——用户主动关闭后不再抢回焦点。
   */
  useEffect(() => {
    // 切换到带文档深链接（含刷新恢复）的 scope 时重置：那一轮该 scope 已有目标文档被摆好。
    // 依赖只取 scope —— 加上 searchParams 会在关闭文档清空 URL 时误重置标记、抢回焦点。
    if (searchParams.get('scope') && searchParams.get('group') && searchParams.get('relation')) return;
    autoOpenRef.current = false;
  }, [scope]);
  useEffect(() => {
    if (autoOpenRef.current || isLoading || currentViewing || isSearching) return;
    // A document deep link is applied in another effect in this same render.
    // Do not let the default first-document selection overwrite it.
    if (searchParams.get('scope') && searchParams.get('group') && searchParams.get('relation')) return;
    const first = knownDocs[0];
    if (!first) return;
    autoOpenRef.current = true;
    // 默认打开不是用户导航：不强制展开目录（保留用户持久化的折叠偏好）
    openDocument({ module: first.name, group: first.group, path: first.path }, 'inline', false);
  }, [currentViewing, isLoading, isSearching, knownDocs, openDocument, scope, searchParams]);

  // ── 树内文档叶子 ──
  // 首层数据：/api/doc/list 的全量列表（≤500 条按 Group 分组）
  useEffect(() => {
    const map: Record<string, DocItem[]> = {};
    for (const doc of data?.docs ?? []) {
      (map[doc.group] ??= []).push(doc);
    }
    setDocsByGroup(map);
    loadedGroupsRef.current = new Set(Object.keys(map));
  }, [data?.docs]);

  // Deep links select a group without the manual expansion callback. Feed that
  // group's query into the tree too, including the known current document if capped.
  useEffect(() => {
    if (!activeGroup || groupQuery.data?.scope !== scope) return;
    const docs = groupQuery.data.docs;
    const current = currentViewing?.group === activeGroup ? currentViewing.module : '';
    const visibleDocs = current && !docs.some((doc) => doc.name === current)
      ? [...docs, { group: activeGroup, name: current }] : docs;
    setDocsByGroup((previous) => ({ ...previous, [activeGroup]: visibleDocs }));
  }, [scope, activeGroup, currentViewing?.group, currentViewing?.module, data?.docs, groupQuery.data]);

  /** 展开某 Group 时补齐其文档（全量列表被截断的 scope 用；失败则回退为仅目录）
   *  S0-2：改用 fetchGroupDocsAll 翻页取全，单 Group >500 篇不再被首页截断 */
  const ensureGroupDocs = useCallback((group: string): void => {
    if (!group || loadedGroupsRef.current.has(group)) return;
    loadedGroupsRef.current.add(group);
    void queryClient
      .fetchQuery({
        queryKey: ['docList', scope, 'group', group, ''],
        queryFn: () => fetchGroupDocsAll(scope, group),
        staleTime: 30_000,
      })
      .then((res) => {
        setDocsByGroup((prev) => ({ ...prev, [group]: res.docs ?? [] }));
      })
      .catch(() => {
        loadedGroupsRef.current.delete(group);
      });
  }, [scope, queryClient]);

  /** 关闭文档后再次打开时从头开始记录导航历史。 */
  const closeDocument = useCallback((): void => {
    setHistory([]);
    setForwardHistory([]);
    setReaderFullscreen(false);
    setReaderOutlineCollapsed(true);
    setViewing(null);
    // 结果列表复位：检索词非空时关闭文档应回落到结果（需求 N4），
    // 否则会停在"有检索词 + 无文档"的空态 —— 页内打开又没有返回入口，等于死路。
    dispatchBrowseView({ type: 'show-results' });
    // URL 里的文档参数一并清掉，否则刷新会把刚关掉的文档又打开。
    writeBrowseUrl(null, false);
  }, [writeBrowseUrl]);

  /**
   * 关闭「检索结果点开」的那个抽屉：**只把来源切回树，保留 currentViewing**。
   *
   * 为什么不与 `closeDocument` 共用：结果列表此刻还开着，而它的头部是**内联查看器**渲染的
   * （结果列表作为它的 bodySlot）。若在这里清空 currentViewing，页面会回落到「无文档」分支的
   * 页级工具栏 —— 用户看到的就是「退出抽屉后，搜索框样式又变回原来的样子」（2026-10-16 反馈）。
   * 保留后头部与阅读态是同一套 DOM；之后清空搜索会自然回到这篇文档的正文（符合"我确实看过它"）。
   */
  const closeSearchDrawer = useCallback((): void => {
    dispatchBrowseView({ type: 'close-drawer' });
  }, []);

  /** 返回最近一次本地链接跳转前的文档，并同步恢复其 Group（祖先展开由选中 effect 统一处理）。 */
  const goBack = useCallback((): void => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((prev) => prev.slice(0, -1));
    if (currentViewing) setForwardHistory((prev) => [...prev, currentViewing]);
    setActiveGroup(previous.group ?? '');
    setViewing(previous);
    writeBrowseUrl(previous, readerFullscreen);
  }, [currentViewing, history, readerFullscreen, writeBrowseUrl]);

  /** 前进到最近一次返回前的文档，并同步恢复其 Group（祖先展开由选中 effect 统一处理）。 */
  const goForward = useCallback((): void => {
    const next = forwardHistory[forwardHistory.length - 1];
    if (!next) return;
    setForwardHistory((prev) => prev.slice(0, -1));
    if (currentViewing) setHistory((prev) => [...prev, currentViewing]);
    setActiveGroup(next.group ?? '');
    setViewing(next);
    writeBrowseUrl(next, readerFullscreen);
  }, [currentViewing, forwardHistory, readerFullscreen, writeBrowseUrl]);

  /** 在当前 Browse 页面内切换到 Markdown 链接指向的文档。 */
  const handleLocalLink = useCallback((href: string): boolean => {
    const target = resolveDocumentLink(href, currentViewing?.path, currentViewing?.group, knownDocs);
    if (!target) return false;
    if (currentViewing) setHistory((prev) => [...prev, currentViewing]);
    setForwardHistory([]);
    setActiveGroup(target.group);
    const next = {
      scope,
      module: target.name,
      group: target.group,
      path: target.path,
      highlightQuery: currentViewing?.highlightQuery,
    };
    setViewing(next);
    writeBrowseUrl(next, readerFullscreen);
    return true;
  }, [currentViewing, knownDocs, readerFullscreen, scope, writeBrowseUrl]);

  /** 切换节点展开/折叠（纯函数：返回新树，不改写旧 state 内的节点） */
  const toggleOpen = (path: string): void => {
    setTree((prev) => toggleNodeOpen(prev, path));
    ensureGroupDocs(path);
  };

  /** 递归收集树中全部 Group 路径（展开全部时批量补文档叶子） */
  const collectGroupPaths = (nodes: TreeNode[]): string[] =>
    nodes.flatMap((n) => [n.path, ...collectGroupPaths(n.children)]);

  /** 展开/折叠全部（纯函数） */
  const setAllOpen = (open: boolean): void => {
    setTree((prev) => withAllOpen(prev, open));
    if (open) collectGroupPaths(tree).forEach((path) => ensureGroupDocs(path));
  };

  /** 树卡头计数：恒为树内文档总数（搜索不再改写目录，命中数以右侧结果面板为准） */
  const visibleDocCount =
    tree.reduce((sum, node) => sum + countDocs(node), 0);
  /** 全部 Group 已展开 → 折叠按钮呈现「折叠」动作（单按钮切换，对齐 demo） */
  const allExpanded = tree.length > 0 && isAllOpen(tree);

  /**
   * 目录点击（鼠标 / 触屏）：切换展开/折叠并选中本组（对齐 demo：点击文件夹即收起/展开其下内容）。
   * 叶子 Group（只有文档、无子组）同样可折叠——此前只对有子组的节点生效，导致「点了没反应」。
   */
  const handleDirClick = (node: TreeNode): void => {
    const willOpen = !node.open;
    toggleOpen(node.path);
    if (willOpen) ensureGroupDocs(node.path);
    if (isGroupSelectable(node)) setActiveGroup(node.path);
  };

  /**
   * 目录键盘激活（Enter / Space）：保留「展开/折叠 + 选中」的传统树语义，
   * 让键盘用户在节点上也能收起子组（箭头按钮已移出 Tab 序列）。
   */
  const handleDirKeyActivate = (node: TreeNode): void => {
    const willOpen = !node.open;
    toggleOpen(node.path);
    if (willOpen) ensureGroupDocs(node.path);
    if (!isGroupSelectable(node)) return;
    setActiveGroup(node.path);
  };

  // 搜索命中集（后端跨组检索结果）：仅用于过滤树内文档叶子，不隐藏目录本身。
  // 页内阅读时结果列表已让位 ⇒ 目录恢复完整（否则正文命中的文档在目录里根本不存在，
  // 「目录切过去」无从谈起 —— REQ-20261018-001 R3 / 护栏 #4）。
  const matchedDocKeys = useMemo(
    () => (showingResults ? new Set(searchDocs.map((d) => `${d.group}\u0000${d.name}`)) : null),
    [showingResults, searchDocs],
  );

  /** hideSelf=true 时跳过本行、只渲染其子内容（全屏展平单根目录用） */
  const renderNode = (node: TreeNode, hideSelf = false): JSX.Element => {
    const hasSub = node.children.length > 0;
    const isActive = node.path === activeGroup;
    const totalDocs = countDocs(node);
    const countLabel = hasSub ? `本组 ${node.count} 条；含子组共 ${totalDocs} 条` : `本组 ${node.count} 条`;
    const nodeDocs = node.open
      ? (docsByGroup[node.path] ?? []).filter((d) =>
          (!selectedTag || (d.tags ?? []).includes(selectedTag)) &&
          (!matchedDocKeys || matchedDocKeys.has(`${d.group}\u0000${d.name}`)))
      : [];
    return (
      <Fragment key={node.path}>
        {!hideSelf && (
        <div
          className={`ki-tree-dir${node.open ? ' ki-tree-dir--open' : ''}${isActive ? ' ki-tree-dir--active' : ''}`}
          role="treeitem"
          data-ki-group={node.path}
          tabIndex={0}
          aria-label={treeNodeLabel(node, totalDocs)}
          aria-expanded={node.open}
          aria-selected={isActive}
          onClick={() => handleDirClick(node)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            handleDirKeyActivate(node);
          }}
        >
          <button
            className="ki-tree-arrow"
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={(e) => { e.stopPropagation(); toggleOpen(node.path); }}
          >
            {node.open ? '▾' : '▸'}
          </button>
          {ICON_FOLDER}
          <span className="ki-tree-dir__label">{node.name}</span>
          <span className="ki-cell-sub" title={countLabel}>
            {hasSub && node.count > 0 ? `${node.count} / ${totalDocs}` : totalDocs}
          </span>
        </div>
        )}
        {node.open && (hasSub || nodeDocs.length > 0) && (
          <div className="ki-tree-group">
            {nodeDocs.map((doc) => (
              <button
                key={`${doc.group}\u0000${doc.name}`}
                type="button"
                className={`ki-tree-doc${currentViewing?.group === doc.group && currentViewing.module === doc.name ? ' ki-tree-doc--active' : ''}`}
                data-ki-group={doc.group}
                data-ki-document={doc.name}
                onClick={() => {
                  // 结果列表可见时从树打开也走抽屉，避免把结果列表顶掉；
                  // 页内阅读态则就地替换正文，不再叠一个抽屉（REQ-20261018-001 R6）。
                  openDocument(
                    { module: doc.name, group: doc.group, path: doc.path },
                    showingResults ? 'drawer' : 'inline',
                  );
                  setMobileReaderOpen(true);
                }}
                title={doc.path ?? `${doc.group} / ${doc.name}`}
              >
                <Icon name="file" className="ki-icon ki-icon--sm" />
                <span className="ki-tree-doc__name">{doc.name}</span>
              </button>
            ))}
            {node.children.map((child) => renderNode(child))}
          </div>
        )}
      </Fragment>
    );
  };

  /** flattenRoot=true 时展平唯一根目录（scope 已确定，根行只是冗余壳；用户要求） */
  const renderTreeBody = (flattenRoot = false): JSX.Element => (
    <>
      {isLoading ? (
        <>
          {importTask ? (
            <div className="ki-empty" style={{ padding: 16, marginBottom: 8 }} role="status">
              <h3>正在等待导入队列</h3>
              <p>
                当前 Scope 有导入任务进行中
                {importTask.progress && importTask.progress.total > 0
                  ? `（已处理 ${importTask.progress.done}/${importTask.progress.total}）`
                  : ''}
                ，文档列表将在导入批次间隙或完成后加载。
              </p>
              <p className="ki-cell-sub">可先访问其他 Scope，或到「任务」页查看导入进度。</p>
            </div>
          ) : null}
          <div className="ki-skeleton" style={{ width: '100%', height: 28, marginBottom: 8 }} />
          <div className="ki-skeleton" style={{ width: '80%', height: 28, marginBottom: 8 }} />
          <div className="ki-skeleton" style={{ width: '90%', height: 28 }} />
        </>
      ) : isError ? (
        <div className="ki-empty" style={{ padding: 24 }}>
          <div>
            <h3>Group 加载失败</h3>
            <p>{error instanceof Error ? error.message : '暂时无法读取当前 Scope 的 Group。'}</p>
            <div className="ki-empty__actions">
              <button className="ki-btn ki-btn--secondary ki-btn--small" type="button" onClick={() => void refetch()}>
                重试
              </button>
            </div>
          </div>
        </div>
      ) : tree.length === 0 ? (
        <div className="ki-empty" style={{ padding: 24 }}>
          <div>
            <h3>空知识库</h3>
            <p>该 scope 暂无 Group，可前往上传导入。</p>
            <div className="ki-empty__actions">
              <Link className="ki-btn ki-btn--primary ki-btn--small" to="/import">
                前往上传导入
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="ki-tree-root" role="tree" aria-label="Group 树">
          {flattenRoot && tree.length === 1
            ? renderNode({ ...tree[0], open: true }, true)
            : tree.map((node) => renderNode(node))}
        </div>
      )}
    </>
  );

  /** 结果行路径：优先后端合并的 logicalPath，命中片段画 mark（连续子串高亮，见 lib/pathHighlight.ts） */
  const renderResultPath = (doc: DocItem): ReactNode => {
    const text = docDisplayPath(doc);
    const range = findPathHighlightRange(text, searchQ);
    if (!range) return <>{text}</>;
    return (
      <>
        {text.slice(0, range.start)}
        <mark className="ki-search-hit-mark">{text.slice(range.start, range.end)}</mark>
        {text.slice(range.end)}
      </>
    );
  };

  /** 名称命中 / 路径命中共用的一行：主点击开右侧抽屉（REQ-20261018-001 护栏 #1），次按钮页内打开 */
  const renderDocResultRow = (doc: DocItem): JSX.Element => {
    // 带上 highlightQuery：正文若含该词，打开后自动高亮并出现「取消高亮 / 下一个命中」导航
    const target = {
      module: doc.name,
      group: doc.group,
      path: doc.path,
      highlightQuery: searchQ,
    };
    return (
      <div className="ki-browse-fulltext__row" key={`doc:${doc.group}\u0000${doc.name}`}>
        <button
          type="button"
          className="ki-browse-fulltext__item"
          onClick={() => openDocument(target, 'drawer')}
        >
          <span className="ki-browse-fulltext__title">{highlightMatch(doc.name, searchQ)}</span>
          {/* 路径常显（原先只显示 Group）：按路径检索时，用户要能一眼看出命中的是路径哪一段 */}
          <span className="ki-browse-fulltext__path">{renderResultPath(doc)}</span>
        </button>
        <button
          type="button"
          className="ki-browse-fulltext__open-inline"
          onClick={() => openDocumentInline(target)}
          title="在页内打开（替换当前结果列表）"
          aria-label={`在页内打开 ${doc.group} / ${doc.name}`}
        >
          <Icon name="open-inline" className="ki-icon ki-icon--sm" />
        </button>
      </div>
    );
  };

  /** 名称 / 路径 / 正文三条链路的命中条数：结果头**分别计数**，不相加成"总数" */
  const searchCounts = {
    name: searchSections.nameHits.length,
    path: searchSections.pathHits.length,
    fullText: fullTextHits.length,
  };

  /**
   * 全文检索结果面板——展示在右侧主区，与语义检索页同构（RESULTS kicker + 标题 + meta + 结果项点击打开）。
   * 交互约定：结果只在主区出现；左侧目录不换标题、不替换树，仅按「名称 / 路径命中」过滤文档叶子
   * （正文命中不参与目录过滤）。页内阅读时结果让位，过滤一并解除（见 matchedDocKeys）。
   *
   * 2026-10-20 路径检索：名称命中与路径命中**拆成两个分区**、结果头分开计数。此前两者合并在
   * 「文件名命中」里，并与正文条数相加成"总数" —— 路径 0 命中时用户只看到「正文命中 20 条」
   * 的无关片段，于是判定"不支持路径匹配"（详见 lib/browseSearchGroups.ts 的说明）。
   */
  const renderSearchResults = (): JSX.Element => {
    const total = searchCounts.name + searchCounts.path + searchCounts.fullText;
    const searching = searchQuery.isFetching || fullTextQuery.isFetching;
    const failed = searchQuery.isError && fullTextQuery.isError;
    const pathOrNameHit = hasNameOrPathHit(searchSections);
    return (
      <div className="ki-browse-results" aria-live="polite">
        <div className="ki-results__head">
          <span className="ki-panel-heading">
            <span className="ki-panel-kicker">RESULTS</span>
            <span className="ki-results__title">检索结果</span>
          </span>
          <span className="ki-results__meta">
            「{searchQ || q.trim()}」 · {searching ? '搜索中…' : searchResultSummary(searchCounts)}
          </span>
        </div>
        {failed ? (
          <div className="ki-empty" style={{ border: 'none', padding: 40 }}>
            <div>
              <h3>检索暂时失败</h3>
              <p>文档列表与正文检索是两条独立链路；可稍后重试，或直接用左侧目录浏览。</p>
            </div>
          </div>
        ) : total === 0 && !searching ? (
          <div className="ki-empty" style={{ border: 'none', padding: 40 }}>
            <div>
              <h3>未找到相关内容</h3>
              <p>
                建议：调整关键词 / 切换 tag 过滤；路径检索支持「组名/文件名」写法（如 <code>wiki/API接口文档</code>）；
                正文检索只覆盖已建立 FTS 索引的文档。
              </p>
            </div>
          </div>
        ) : (
          <div className="ki-browse-results__list">
            {searchCounts.name > 0 && (
              <section className="ki-browse-results__group">
                <div className="ki-browse-results__group-head">
                  名称命中
                  <span className="ki-card__sub">
                    {searchQuery.isFetching ? '搜索中…' : `${searchCounts.name} 条`}
                  </span>
                </div>
                {searchSections.nameHits.map(renderDocResultRow)}
              </section>
            )}
            {searchCounts.path > 0 && (
              <section className="ki-browse-results__group">
                <div className="ki-browse-results__group-head">
                  路径命中
                  <span className="ki-card__sub">
                    {searchQuery.isFetching ? '搜索中…' : `${searchCounts.path} 条`}
                  </span>
                </div>
                {searchSections.pathHits.map(renderDocResultRow)}
              </section>
            )}
            {/* 名称/路径 0 命中必须**明说**：否则下面那 20 条正文命中会被当成"搜到过路径"，
                用户既不知道路径没命中，也看不到该怎么改（实测反馈就出在这里）。
                本块**不再加** role="status"：外层 .ki-browse-results 已是 aria-live="polite"，
                内层再来一个 live region 会让读屏把同一段话播报两遍。 */}
            {!pathOrNameHit && !searchQuery.isFetching && (
              <div className="ki-browse-results__hint">
                <div className="ki-browse-results__hint-title">名称 / 路径没有命中</div>
                <p>
                  当前检索词没有匹配到任何文档名或路径。可只输组名或文件名片段（如 <code>wiki</code>、
                  <code>API认证</code>）；若要找正文内容，见下方「正文命中」{searchCounts.fullText} 条。
                </p>
              </div>
            )}
            <section className="ki-browse-results__group">
              <div className="ki-browse-results__group-head">
                正文命中
                <span className="ki-card__sub">
                  {fullTextQuery.isFetching ? '搜索中…' : `${fullTextHits.length} 条`}
                </span>
              </div>
              {fullTextQuery.isError ? (
                <div className="ki-browse-fulltext__empty">正文检索暂时失败，可继续查看名称 / 路径命中。</div>
              ) : fullTextHits.length === 0 && !fullTextQuery.isFetching ? (
                <div className="ki-browse-fulltext__empty">暂未找到正文命中。</div>
              ) : (
                fullTextHits.map((hit: SearchHit, index) => {
                  const known = knownDocs.find((doc) => doc.group === hit.group && doc.name === hit.relation);
                  const group = hit.group ?? known?.group ?? '';
                  const relation = hit.relation ?? known?.name ?? '';
                  // 脏数据（缺 Group / 文档名）无法在目录中定位：动作禁用并说明原因（需求 N1）
                  const canOpen = Boolean(relation && group);
                  const target = { module: relation, group, path: known?.path, highlightQuery: searchQ };
                  return (
                    <div
                      className="ki-browse-fulltext__row"
                      key={`${hit.memoryId ?? index}:${hit.group ?? ''}:${hit.relation ?? ''}`}
                    >
                      <button
                        type="button"
                        className="ki-browse-fulltext__item"
                        onClick={() => {
                          if (!canOpen) return;
                          openDocument(target, 'drawer');
                        }}
                      >
                        <span className="ki-browse-fulltext__title">{relation || '未命名文档'}</span>
                        <span className="ki-browse-fulltext__path">{group}</span>
                        <span className="ki-browse-fulltext__snippet">
                          {/* 与语义检索页全文模式同口径：命中 chunk（content）优先于文件级原文（original），
                              否则整篇原文的开头会把命中位置挤出片段，高亮看起来「消失」 */}
                          {highlightMatch(makeSearchSnippet(hit.content ?? hit.original ?? '', searchQ), searchQ)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ki-browse-fulltext__open-inline"
                        onClick={() => {
                          if (!canOpen) return;
                          openDocumentInline(target);
                        }}
                        disabled={!canOpen}
                        title={canOpen ? '在页内打开（替换当前结果列表）' : '缺少 Group 或文档名，无法在页内打开'}
                        aria-label={canOpen ? `在页内打开 ${group} / ${relation}` : '无法在页内打开：缺少文档定位信息'}
                      >
                        <Icon name="open-inline" className="ki-icon ki-icon--sm" />
                      </button>
                    </div>
                  );
                })
              )}
            </section>
          </div>
        )}
      </div>
    );
  };

  /** 全屏阅读工作区：导航面板在抽屉内部渲染，因此不会被 scrim 遮挡。 */
  /** 全屏导航面板；收起/展开入口由抽屉统一提供（ModuleDrawer 的 nav-collapse），此处只渲染内容 */
  const fullscreenNavigation = (
    <div
      className={`ki-reader-navigation${readerGroupCollapsed ? ' ki-reader-navigation--group-collapsed' : ' ki-reader-navigation--group-open'}`}
    >
      <aside className={`ki-reader-nav ki-reader-nav--group${readerGroupCollapsed ? ' ki-reader-nav--collapsed' : ''}`}>
        {readerGroupCollapsed ? (
          <button
            className="ki-reader-nav__collapsed-toggle"
            onClick={() => setReaderGroupCollapsed(false)}
            title="展开 Group 树"
            aria-label="展开 Group 树"
            type="button"
          >
            <span className="ki-reader-nav__collapsed-mark">{ICON_NAV_TREE}</span>
            <span className="ki-reader-nav__collapsed-label">知识目录</span>
          </button>
        ) : (
          <>
            <div className="ki-reader-nav__head">
              <div>
                <div className="ki-card__title">知识目录</div>
                <div className="ki-card__sub">{visibleDocCount} 篇</div>
              </div>
              <div className="ki-reader-nav__actions">
                <button
                  className="ki-reader-nav__refresh"
                  onClick={refreshNow}
                  title="刷新 Group 与文档列表"
                  type="button"
                >
                  <span className={busy ? 'ki-icon--spin' : undefined}>{ICON_NAV_REFRESH}</span>
                  {busy ? '刷新中' : '刷新'}
                </button>
                {/* 折叠 / 展开全部目录（用户要的入口） */}
                <button
                  className="ki-icon-button ki-icon-button--sm"
                  data-action={allExpanded ? 'collapse' : 'expand'}
                  onClick={() => setAllOpen(!allExpanded)}
                  title={allExpanded ? '折叠全部目录' : '展开全部目录'}
                  aria-label={allExpanded ? '折叠全部目录' : '展开全部目录'}
                  type="button"
                >
                  <Icon name={allExpanded ? 'collapse' : 'expand'} />
                </button>
                <button
                  className="ki-reader-nav__collapse"
                  onClick={() => setReaderGroupCollapsed(true)}
                  title="收起 Group 树"
                  aria-label="收起 Group 树"
                  type="button"
                >
                  {ICON_NAV_COLLAPSE}
                </button>
              </div>
            </div>
            <div ref={fullscreenDirectoryRef} className="ki-reader-nav__body ki-reader-nav__body--tree">{renderTreeBody(true)}</div>
          </>
        )}
      </aside>

    </div>
  );

  /**
   * 文档阅读器：inline = 就地渲染在右侧阅读区（树入口）；
   * 抽屉 = 覆盖式滑出、结果列表留在主区（检索结果入口，与语义检索页一致）。
   */
  const renderViewer = (asDrawer: boolean, slot?: ReactNode): JSX.Element | null => {
    if (!currentViewing) return null;
    return (
      <ModuleDrawer
        key={`${asDrawer ? 'drawer' : 'inline'}:${scope}:${currentViewing.group}:${currentViewing.module}`}
        inline={!asDrawer}
        scope={scope}
        module={currentViewing.module}
        group={currentViewing.group}
        highlightQuery={currentViewing.highlightQuery}
        targetAnchor={currentViewing.anchor}
        editable
        /* 抽屉（检索结果打开）关闭时**保留文档**，避免头部回落到页级工具栏（见 closeSearchDrawer） */
        onClose={asDrawer ? closeSearchDrawer : closeDocument}
        // 正文读取走 read 通道的 HTTP 接口（不再用 MCP）：导入/向量化期间不被排队
        fetcher={getDocContent}
        onLocalLink={handleLocalLink}
        canGoBack={history.length > 0}
        onBack={goBack}
        canGoForward={forwardHistory.length > 0}
        onForward={goForward}
        fullscreen={readerFullscreen}
        fullscreenActions={<ChatToggleButton />}
        onFullscreenChange={(fullscreen) => {
          setReaderFullscreen(fullscreen);
          // 大纲进出全屏一律折叠（用户要求默认折叠，需要时手动展开）
          setReaderOutlineCollapsed(true);
          // 全屏态写进 URL（reader=1），刷新后仍以全屏阅读同一篇
          writeBrowseUrl(currentViewing, fullscreen);
        }}
        outlineCollapsed={readerOutlineCollapsed}
        onOutlineCollapsedChange={setReaderOutlineCollapsed}
        fullscreenNavigation={fullscreenNavigation}
        /* ── 一行头部（2026-10-16）：只有**内联阅读态**把页级控件交给查看器头部 ──
           检索结果点开的抽屉（asDrawer）保持原样：那时主区是结果列表，搜索框仍属结果区工具条。
           头部高度因此由两行 126.5px 降为一行（.plans/2026-10-16-browse-reader-single-row-header）。 */
        inlineBar={asDrawer ? undefined : (
          <TagSelect scope={scope} value={selectedTag} onChange={setSelectedTag} />
        )}
        inlineSearch={asDrawer ? undefined : {
          value: q,
          onChange: handleSearchInput,
          onClear: clearFilters,
          // 与 Tag / 范围分段 / 动作按钮同排后，搜索框可用宽度由独占 420px 收到约 260px：
          // 原「（结果在此处展示）」会被截断，只留主句（结果出现的位置已由使用形成预期）
          placeholder: '搜索全库文档…',
        }}
        inlineActions={asDrawer ? undefined : (
          <div className="ki-segmented ki-drawer__inline-width" role="group" aria-label="正文宽度">
            {/* 全库结果态下正文不是文档，宽度切换无处作用 ⇒ 与其它文档动作一起禁用（用户 2026-10-16） */}
            <button type="button" aria-pressed={!readerWide} disabled={showingResults} onClick={() => setReaderWide(false)}>居中</button>
            <button type="button" aria-pressed={readerWide} disabled={showingResults} onClick={() => setReaderWide(true)}>铺满</button>
          </div>
        )}
        /* 全库搜索结果列表：交给查看器的正文区承载 —— 头部因此**一套到底**，
           不再出现"一搜索头部样式就大变样"（用户 2026-10-16）。结果态下文档动作由
           ModuleDrawer 自行禁用（docActionsDisabled） */
        bodySlot={slot}
      />
    );
  };

  /**
   * 焦点接力（配合 `pageSearchRef`）：搜索框换宿主时把焦点交到新宿主，
   * 让「连续输入」不被打断。只在最近 1.5s 内确有输入时接管，避免抢焦点。
   */
  const prevReadingInlineRef = useRef(readingInline);
  useEffect(() => {
    const was = prevReadingInlineRef.current;
    prevReadingInlineRef.current = readingInline;
    if (was === readingInline) return;
    if (Date.now() - lastTypingAtRef.current > 1500) return;
    const frame = window.requestAnimationFrame(() => {
      const target = readingInline
        ? document.querySelector<HTMLInputElement>('[data-ki-drawer-search="global"]')
        : pageSearchRef.current;
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [readingInline]);

  return (
    <>
      {/* 页头副标题：由「功能罗列」改为**当前上下文路径**（用户 2026-10-16）。
          为什么不写死功能罗列：那三件事左栏与右栏本身就看得见，而"我现在在读哪一篇、在哪一级"
          只有这里能一眼给全 —— 也因此让阅读区头部可以取消标题（单行头部放标题会把搜索框压到 ~80px）。 */}
      <div className="ki-page-head" style={{ flexShrink: 0 }}>
        <div>
          {currentViewing ? (
            <p className="ki-page-head__path" title={`${scope} / ${currentViewing.group} / ${currentViewing.module}`}>
              {/* scope 芯片在最前（用户 2026-10-16：参考抽屉 meta 行的 scope 徽标样式），
                  其后是「主题短语 · Group 路径 / 文档名」—— 与检索页/总览页页头同句式 */}
              <span className="ki-badge ki-badge--kb ki-page-head__scope">{scope}</span>
              <span className="ki-page-head__hint">原文阅读</span>
              <span className="ki-page-head__sep">·</span>
              <span className="ki-page-head__group">{currentViewing.group}</span>
              <span className="ki-page-head__sep">/</span>
              <span className="ki-page-head__doc">{currentViewing.module}</span>
            </p>
          ) : (
            /* 未选文档时保持**同一句式**（用户 2026-10-16：避免开关文档时那行字"跳"）——
               scope 芯片、主题短语、分隔符都在，只有路径段换成提示语 */
            <p className="ki-page-head__path">
              <span className="ki-badge ki-badge--kb ki-page-head__scope">{scope}</span>
              <span className="ki-page-head__hint">原文阅读</span>
              <span className="ki-page-head__sep">·</span>
              <span className="ki-page-head__group">未选择文档，从左侧目录选择</span>
            </p>
          )}
        </div>
      </div>

      {/* 高度由 .ki-content-inner 的 grid 行提供（见 ki.css），不在这里按内容估算 */}
      <div className={`ki-split${treeCollapsed ? ' ki-split--tree-collapsed' : ''}`}>
        {/* 左：Group 树 */}
        <aside className="ki-split__side">
          {treeCollapsed ? (
            <div className="ki-tree-collapsed">
              <button
                type="button"
                className="ki-icon-button ki-icon-button--sm"
                onClick={() => setTreeCollapsed(false)}
                title="展开知识目录"
                aria-label="展开知识目录"
              >
                <Icon name="expand" />
              </button>
              <span className="ki-tree-collapsed__label">知识目录</span>
            </div>
          ) : (
          <div className="ki-card">
            <div className="ki-card__head">
              <span className="ki-panel-heading">
                <span className="ki-panel-kicker">LIBRARY INDEX</span>
                <span className="ki-card__title">知识目录</span>
              </span>
              <div className="ki-card__actions">
                <span className="ki-card__sub">{visibleDocCount} 篇</span>
                <button
                  className="ki-icon-button ki-icon-button--sm"
                  onClick={refreshNow}
                  title="重新拉取 scope 与文档列表（导入完成后无需重启服务，点此即可看到新 Group）"
                  aria-label={busy ? '刷新中' : '刷新目录'}
                  aria-busy={busy}
                >
                  <Icon name="refresh" className={busy ? 'ki-icon ki-icon--spin' : undefined} />
                </button>
                <button
                  className="ki-icon-button ki-icon-button--sm"
                  data-action={allExpanded ? 'collapse' : 'expand'}
                  onClick={() => setAllOpen(!allExpanded)}
                  title={allExpanded ? '折叠全部目录' : '展开全部目录'}
                  aria-label={allExpanded ? '折叠全部目录' : '展开全部目录'}
                >
                  <Icon name={allExpanded ? 'collapse' : 'expand'} />
                </button>
                <button
                  className="ki-icon-button ki-icon-button--sm"
                  onClick={() => setTreeCollapsed(true)}
                  title="收起知识目录"
                  aria-label="收起知识目录"
                >
                  <Icon name="chevron-left" />
                </button>
              </div>
            </div>
            {/* 目录状态行（对齐 demo .tree-meta）：搜索不改写目录，恒为「全部文档 · N 篇」 */}
            <div className="ki-tree-meta" role="status" aria-live="polite">
              全部文档
              <strong> · {visibleDocCount} 篇</strong>
            </div>
            <div ref={directoryRef} className="ki-card__body" style={{ padding: 12 }}>
              {/* 同样展平唯一的根目录（scope 已由顶栏确定，根行是重复信息） */}
              {renderTreeBody(true)}
            </div>
          </div>
          )}
        </aside>

        {/* 右：文档内容（常驻阅读区，对齐 demo：右侧专注展示正文） */}
        <section className={`ki-browse-reader${mobileReaderOpen ? ' ki-browse-reader--mobile-open' : ''}`}>
          <div className="ki-card ki-browse-reader__card">
            {/* 阅读区头部（对齐 demo .reader-head：左「文档内容」标签，右侧整组搜索/标签/清除/宽度）
                ⚠️ 内联阅读态整行**不渲染**：此时搜索框 / 标签 / 宽度切换由查看器的一行头部承载
                （见 ModuleDrawer 的 inlineBar / inlineSearch / inlineActions），否则「页级工具条 +
                抽屉头部」两行会把正文下推 126.5px（占阅读区 16%，且不随滚动消失）。
                结果列表态与空态仍用本行 —— 那时没有内联查看器承载搜索框。 */}
            {/* 工具栏只在**从未打开文档**时出现（空态）——
                一旦有 currentViewing，头部就交给查看器并**一直保持**（含全库搜索出结果时），
                避免"搜索前一套头部、搜索后另一套"的割裂（用户 2026-10-16） */}
            {currentViewing === null && (
            <div className="ki-reader-toolbar">
              {/* 顺序与阅读态的一行头部保持一致：**Tag 在最左 → 搜索框**（用户 2026-10-16：
                  「一开始全库搜索，头部样式就大变样」）。原先这里是「文档内容标签 + 搜索框 + Tag」，
                  与阅读态完全相反，一切换就整体错位；「文档内容」标签同时去掉（阅读态也没有它）。
                  结果态与阅读态的**故意差异**只剩右侧：此处按语境给「清空 + 居中|铺满」，
                  阅读态给「全库|本文 + 文档动作」—— 那些动作依赖当前文档，结果态没有它。 */}
              <TagSelect scope={scope} value={selectedTag} onChange={setSelectedTag} />
              <div className="ki-reader-tools">
                <div className="ki-reader-filters">
                  <label className="ki-reader-search">
                    <Icon name="search" className="ki-icon ki-icon--sm ki-reader-search__icon" />
                    <input
                      ref={pageSearchRef}
                      className="ki-form-input ki-reader-toolbar__search"
                      placeholder="搜索全库文档…（结果在此处展示）"
                      value={q}
                      onChange={(e) => handleSearchInput(e.target.value)}
                      data-ki-search-input
                      aria-label="搜索全部目录与文档，结果显示在右侧内容区"
                    />
                    <button
                      type="button"
                      className="ki-reader-search__clear"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setQ('')}
                      title="清空检索词"
                      aria-label="清空检索词"
                    >
                      <Icon name="x" className="ki-icon ki-icon--sm" />
                    </button>
                  </label>
                  <button
                    className="ki-btn ki-btn--secondary ki-btn--small"
                    type="button"
                    onClick={clearFilters}
                    disabled={!q && !selectedTag}
                    title="清空检索词与标签筛选"
                  >
                    清空
                  </button>
                </div>
                <div className="ki-segmented ki-reader-width" role="group" aria-label="正文宽度">
                  <button type="button" aria-pressed={!readerWide} onClick={() => setReaderWide(false)}>居中</button>
                  <button type="button" aria-pressed={readerWide} onClick={() => setReaderWide(true)}>铺满</button>
                </div>
                <button
                  className="ki-icon-button ki-reader-back"
                  type="button"
                  onClick={() => setMobileReaderOpen(false)}
                  title="返回目录"
                  aria-label="返回目录"
                >
                  <Icon name="chevron-left" />
                </button>
              </div>
            </div>
            )}
            <div className={`ki-browse-reader__body${readerWide ? ' ki-browse-reader__body--wide' : ''}`}>
              {currentViewing !== null ? (
                /* 结果列表作为 bodySlot 交给查看器承载：头部（含搜索框 / 分段 / 清空 / 文档动作）
                   全程不换，动作按钮在结果态由 ModuleDrawer 自动置灰 */
                renderViewer(false, showingResults ? renderSearchResults() : undefined)
              ) : showingResults ? (
                /* 极端情况：没有 currentViewing 时也可能在搜（URL 带 q 但文档已关）—— 直接渲染结果 */
                renderSearchResults()
              ) : (
                <div className="ki-empty" style={{ padding: 64 }}>
                  <div>
                    <h3>从左侧目录选择文档开始阅读</h3>
                    <p>
                      展开目录，点击文档名即可在此处连续阅读；用上方搜索框检索时，结果会显示在这里：
                      点击结果在右侧抽屉预览，点行尾的「页内打开」直接在此处阅读并同步定位左侧目录。
                      页内阅读时搜索框会清空，输入新的检索词（或切换 tag）即回到结果列表。
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* 结果行默认点击打开的文档：右侧抽屉（与语义检索页一致），结果列表保持可见。
          「在页内打开」走 viewMode='inline'，此时不渲染抽屉 —— 同一篇正文只留一个实例（护栏 #5）。 */}
      {currentViewing && browseView.viewMode === 'drawer' && renderViewer(true)}
    </>
  );
}
