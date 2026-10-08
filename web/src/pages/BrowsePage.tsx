/**
 * BrowsePage.tsx —— 知识库浏览（对齐 demo 双栏：左 Group 递归树 + 右文档列表 + 原文抽屉）
 *
 * 数据源：/api/doc/list（返回 Group 路径 + 文档，支持 q 文件名搜索）
 * 原文：ki_get_module_info
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useScope } from '@/lib/scopeContext';
import { useDocList, useGroupDocs, getDocList, fetchGroupDocsAll, type DocListResponse } from '@/lib/hooks';
import { getTasks, scopeImportRunning, type TaskRecord } from '@/api/tasksApi';
import type { DocItem } from '@/api/httpApi';
import { kiGetModuleInfo, kiSearch, type SearchHit, type SearchResult } from '@/api/mcpClient';
import { ModuleDrawer } from '@/components/ModuleDrawer';
import { TagSelect } from '@/components/TagSelect';
import { Icon } from '@/components/icons';
import { resolveDocumentLink, type DocumentView } from '@/lib/documentLinks';
import { highlightMatch, makeSearchSnippet } from '@/lib/searchText';
import { revealTreeRow } from '@/lib/treeReveal';
import {
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
  const [searchParams] = useSearchParams();
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
  const [activeGroup, setActiveGroup] = useState('');
  const [viewing, setViewing] = useState<DocumentView | null>(null);
  const [history, setHistory] = useState<DocumentView[]>([]);
  const [forwardHistory, setForwardHistory] = useState<DocumentView[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [searchQ, setSearchQ] = useState('');
  /**
   * 文档打开来源：树点击 → 就地渲染在右侧阅读区（inline）；
   * 检索结果点击 → 右侧抽屉滑出、结果列表保持可见（与语义检索页一致）。
   */
  const [viewingSource, setViewingSource] = useState<'tree' | 'search'>('tree');
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
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  // 窄屏：点树内文档后阅读区以覆盖层展开（CSS 仅在 ≤959px 生效），「返回目录」关闭
  const [mobileReaderOpen, setMobileReaderOpen] = useState(false);
  const appliedDirectTarget = useRef('');
  const directoryRef = useRef<HTMLDivElement>(null);
  const fullscreenDirectoryRef = useRef<HTMLDivElement>(null);
  const revealedDirectoryTarget = useRef('');

  const directTarget = searchParams.toString();
  const { data, isLoading, isError, error, refetch } = useDocList(scope);

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
    if (!directTarget) {
      appliedDirectTarget.current = '';
      return;
    }
    if (appliedDirectTarget.current === directTarget) return;
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
      setTreeCollapsed(false);
      setActiveGroup(group);
      setViewingSource('tree');
      setMobileReaderOpen(true);
      setQ('');
      setSearchQ('');
      setSelectedTag('');
      setViewing({ group, module: relation, anchor: params.get('anchor') ?? undefined });
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
    appliedDirectTarget.current = directTarget;
  }, [directTarget, scope, setScope, data?.scope, data?.groups]);

  // 可用 tag 列表由 TagSelect 自行从 /api/doc/list 的 tags 字段读取（KB 层 relation.tags 去重，
  // 而非 /api/tags 的向量库 tag）；react-query 同 key 缓存，不会产生额外请求

  // 选中 group 的完整文档（后端按 group 精确返回，不受 500 条全量分页截断影响）
  const groupQuery = useGroupDocs(scope, activeGroup || null, selectedTag || undefined);
  const groupDocs = groupQuery.data?.docs ?? [];

  // 切换 scope 后清理旧 scope 的筛选条件，避免旧 tag / 关键词在新 scope 中造成“无结果”误导。
  useEffect(() => {
    setQ('');
    setSearchQ('');
    setSelectedTag('');
  }, [scope]);

  // 搜索防抖：保留现有“跨 Group 搜索”语义，只减少逐字请求与列表闪烁。
  useEffect(() => {
    if (!q.trim()) {
      setSearchQ('');
      return;
    }
    const timer = window.setTimeout(() => setSearchQ(q.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [q]);

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
    setTree(base);
    // 默认选中第一个有自身文档的 Group，包括有子级的父 Group。
    setActiveGroup((prev) => {
      // 已有选中且仍在树中 → 保留（避免重复请求）
      if (prev && findGroupNode(base, prev)) return prev;
      return firstGroupWithDocuments(base) || (base.length > 0 ? base[0].path : '');
    });
  }, [data?.groups]); // ← 仅依赖 groups，不依赖 activeGroup

  // 选中项变化（含首次默认选中、链接跳转）后展开其祖先链，保证高亮在树中可见。
  // revealGroupPath 幂等：已可见时返回原引用，不会触发额外渲染。
  useEffect(() => {
    if (!activeGroup) return;
    setTree((prev) => {
      const revealed = revealGroupPath(prev, activeGroup);
      const target = findGroupNode(revealed, activeGroup);
      return target && !target.open ? toggleNodeOpen(revealed, activeGroup) : revealed;
    });
  }, [activeGroup, data?.groups, viewing?.group, viewing?.module, readerFullscreen]);

  // Wait for ancestor expansion and document loading, then reveal once per navigation.
  useEffect(() => {
    const directoryCollapsed = readerFullscreen ? readerGroupCollapsed : treeCollapsed;
    if (!activeGroup || directoryCollapsed) return;
    const documentName = viewing?.group === activeGroup ? viewing.module : '';
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
  }, [scope, activeGroup, viewing, readerFullscreen, treeCollapsed, readerGroupCollapsed, groupQuery.isFetching, tree, docsByGroup]);

  // ── 全局搜索：有搜索词时发起后端 q 参数请求（跨组模糊匹配，limit=2000）──
  const searchQuery = useQuery<DocListResponse>({
    queryKey: ['docList', scope, 'search', searchQ, selectedTag],
    queryFn: () => getDocList(scope, { q: searchQ, tag: selectedTag || undefined }),
    enabled: searchQ.length > 0,
    staleTime: 10_000,
    retry: 1,
    placeholderData: (previousData) => previousData,
  });
  const searchDocs = searchQuery.data?.docs ?? [];
  const isSearching = q.trim().length > 0;

  // 文档列表搜索之外，按同一关键词查询正文；结果独立展示，避免把“文件名命中”
  // 与“正文命中”混成一个排序口径。仅使用 FTS-only/hybrid 的全文分支，不调用 embedding。
  const fullTextQuery = useQuery<SearchResult>({
    queryKey: ['fullTextSearch', scope, searchQ, selectedTag],
    queryFn: () => kiSearch(searchQ, {
      scope,
      tags: selectedTag ? [selectedTag] : ['ki-search'],
      limit: 20,
      mode: 'fulltext',
    }),
    enabled: searchQ.length > 0,
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

  /** 手动打开文档是新的导航起点，不沿用上一次文档链接产生的历史。 */
  const openDocument = useCallback((doc: DocumentView, source: 'tree' | 'search' = 'tree'): void => {
    setViewingSource(source);
    setHistory([]);
    setForwardHistory([]);
    setViewing(doc);
  }, []);

  /**
   * 默认打开第一篇：数据就绪、有文档、且用户尚未打开任何文档时，自动展示第一篇内容。
   * 只有文档数为 0 时才显示「从左侧目录选择文档开始阅读」的真实空白页（用户要求）。
   * autoOpenRef 保证每个 scope 只自动打开一次——用户主动关闭后不再抢回焦点。
   */
  const autoOpenRef = useRef(false);
  useEffect(() => {
    autoOpenRef.current = false;
  }, [scope]);
  useEffect(() => {
    if (autoOpenRef.current || isLoading || viewing || isSearching) return;
    // A document deep link is applied in another effect in this same render.
    // Do not let the default first-document selection overwrite it.
    if (searchParams.get('scope') && searchParams.get('group') && searchParams.get('relation')) return;
    const first = knownDocs[0];
    if (!first) return;
    autoOpenRef.current = true;
    openDocument({ module: first.name, group: first.group, path: first.path });
  }, [isLoading, isSearching, knownDocs, openDocument, scope, viewing, searchParams]);

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
    const current = viewing?.group === activeGroup ? viewing.module : '';
    const visibleDocs = current && !docs.some((doc) => doc.name === current)
      ? [...docs, { group: activeGroup, name: current }] : docs;
    setDocsByGroup((previous) => ({ ...previous, [activeGroup]: visibleDocs }));
  }, [scope, activeGroup, data?.docs, groupQuery.data, viewing?.group, viewing?.module]);

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

  /** 关闭抽屉后再次打开文档时从头开始记录导航历史。 */
  const closeDocument = useCallback((): void => {
    setHistory([]);
    setForwardHistory([]);
    setReaderFullscreen(false);
    setReaderOutlineCollapsed(true);
    setViewing(null);
  }, []);

  /** 返回最近一次本地链接跳转前的文档，并同步恢复其 Group（祖先展开由选中 effect 统一处理）。 */
  const goBack = useCallback((): void => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((prev) => prev.slice(0, -1));
    if (viewing) setForwardHistory((prev) => [...prev, viewing]);
    setActiveGroup(previous.group ?? '');
    setViewing(previous);
  }, [history, viewing]);

  /** 前进到最近一次返回前的文档，并同步恢复其 Group（祖先展开由选中 effect 统一处理）。 */
  const goForward = useCallback((): void => {
    const next = forwardHistory[forwardHistory.length - 1];
    if (!next) return;
    setForwardHistory((prev) => prev.slice(0, -1));
    if (viewing) setHistory((prev) => [...prev, viewing]);
    setActiveGroup(next.group ?? '');
    setViewing(next);
  }, [forwardHistory, viewing]);

  /** 在当前 Browse 页面内切换到 Markdown 链接指向的文档。 */
  const handleLocalLink = useCallback((href: string): boolean => {
    const target = resolveDocumentLink(href, viewing?.path, viewing?.group, knownDocs);
    if (!target) return false;
    if (viewing) setHistory((prev) => [...prev, viewing]);
    setForwardHistory([]);
    setActiveGroup(target.group);
    setViewing({
      module: target.name,
      group: target.group,
      path: target.path,
      highlightQuery: viewing?.highlightQuery,
    });
    return true;
  }, [knownDocs, viewing]);

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

  // 搜索命中集（后端跨组检索结果）：仅用于过滤树内文档叶子，不隐藏目录本身
  const matchedDocKeys = useMemo(
    () => (isSearching ? new Set(searchDocs.map((d) => `${d.group}\u0000${d.name}`)) : null),
    [isSearching, searchDocs],
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
                className={`ki-tree-doc${viewing?.group === doc.group && viewing.module === doc.name ? ' ki-tree-doc--active' : ''}`}
                data-ki-group={doc.group}
                data-ki-document={doc.name}
                onClick={() => {
                  // 检索态下从树打开文档也走抽屉，避免把结果列表顶掉
                  openDocument(
                    { module: doc.name, group: doc.group, path: doc.path },
                    isSearching ? 'search' : 'tree',
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

  /**
   * 全文检索结果面板——展示在右侧主区，与语义检索页同构（RESULTS kicker + 标题 + meta + 结果项点击打开）。
   * 交互约定：结果只在主区出现，左侧目录保持原样（仅叠加命中高亮，不筛选、不换标题、不替换树）。
   */
  const renderSearchResults = (): JSX.Element => {
    const total = searchDocs.length + fullTextHits.length;
    const searching = searchQuery.isFetching || fullTextQuery.isFetching;
    const failed = searchQuery.isError && fullTextQuery.isError;
    return (
      <div className="ki-browse-results" aria-live="polite">
        <div className="ki-results__head">
          <span className="ki-panel-heading">
            <span className="ki-panel-kicker">RESULTS</span>
            <span className="ki-results__title">检索结果</span>
          </span>
          <span className="ki-results__meta">
            「{searchQ || q.trim()}」 · {searching ? '搜索中…' : `${total} 条`}
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
              <p>建议：调整关键词 / 切换 tag 过滤；正文检索只覆盖已建立 FTS 索引的文档。</p>
            </div>
          </div>
        ) : (
          <div className="ki-browse-results__list">
            {searchDocs.length > 0 && (
              <section className="ki-browse-results__group">
                <div className="ki-browse-results__group-head">
                  文件名命中
                  <span className="ki-card__sub">
                    {searchQuery.isFetching ? '搜索中…' : `${searchDocs.length} 条`}
                  </span>
                </div>
                {searchDocs.map((doc) => (
                  <button
                    type="button"
                    className="ki-browse-fulltext__item"
                    key={`name:${doc.group}\u0000${doc.name}`}
                    onClick={() => {
                      // 带上 highlightQuery：正文若含该词，打开后自动高亮并出现「取消高亮 / 下一个命中」导航
                      openDocument(
                        { module: doc.name, group: doc.group, path: doc.path, highlightQuery: searchQ },
                        'search',
                      );
                    }}
                  >
                    <span className="ki-browse-fulltext__title">{highlightMatch(doc.name, searchQ)}</span>
                    <span className="ki-browse-fulltext__path">{doc.group}</span>
                  </button>
                ))}
              </section>
            )}
            <section className="ki-browse-results__group">
              <div className="ki-browse-results__group-head">
                正文命中
                <span className="ki-card__sub">
                  {fullTextQuery.isFetching ? '搜索中…' : `${fullTextHits.length} 条`}
                </span>
              </div>
              {fullTextQuery.isError ? (
                <div className="ki-browse-fulltext__empty">正文检索暂时失败，可继续查看文件名命中。</div>
              ) : fullTextHits.length === 0 && !fullTextQuery.isFetching ? (
                <div className="ki-browse-fulltext__empty">暂未找到正文命中。</div>
              ) : (
                fullTextHits.map((hit: SearchHit, index) => {
                  const known = knownDocs.find((doc) => doc.group === hit.group && doc.name === hit.relation);
                  const group = hit.group ?? known?.group ?? '';
                  const relation = hit.relation ?? known?.name ?? '';
                  return (
                    <button
                      type="button"
                      className="ki-browse-fulltext__item"
                      key={`${hit.memoryId ?? index}:${hit.group ?? ''}:${hit.relation ?? ''}`}
                      onClick={() => {
                        if (!relation || !group) return;
                        openDocument({ module: relation, group, path: known?.path, highlightQuery: searchQ }, 'search');
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
  const renderViewer = (asDrawer: boolean): JSX.Element | null => {
    if (!viewing) return null;
    return (
      <ModuleDrawer
        key={`${asDrawer ? 'drawer' : 'inline'}:${scope}:${viewing.group}:${viewing.module}`}
        inline={!asDrawer}
        scope={scope}
        module={viewing.module}
        group={viewing.group}
        highlightQuery={viewing.highlightQuery}
        targetAnchor={viewing.anchor}
        editable
        onClose={closeDocument}
        fetcher={kiGetModuleInfo}
        onLocalLink={handleLocalLink}
        canGoBack={history.length > 0}
        onBack={goBack}
        canGoForward={forwardHistory.length > 0}
        onForward={goForward}
        fullscreen={readerFullscreen}
        onFullscreenChange={(fullscreen) => {
          setReaderFullscreen(fullscreen);
          // 大纲进出全屏一律折叠（用户要求默认折叠，需要时手动展开）
          setReaderOutlineCollapsed(true);
        }}
        outlineCollapsed={readerOutlineCollapsed}
        onOutlineCollapsedChange={setReaderOutlineCollapsed}
        fullscreenNavigation={fullscreenNavigation}
      />
    );
  };

  /**
   * 检索态下主区**恒为结果列表**（搜索结果要像语义检索页那样展示，不能被之前的阅读态顶掉——
   * 用户实测：先打开着文档再搜索时，主区仍是旧文档，看不到结果）。
   * 此时无论从结果还是从树打开文档，都走右侧抽屉，结果列表不被打断。
   * 非检索态：树入口就地阅读（保持原浏览体验）。
   */
  const showingResults = isSearching;
  const readingInline = viewing !== null && !showingResults;

  return (
    <>
      <div className="ki-page-head" style={{ flexShrink: 0 }}>
        <div>
          <p>Group 树 · 文档列表 · 原文查看</p>
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
            {/* 阅读区头部（对齐 demo .reader-head：左「文档内容」标签，右侧整组搜索/标签/清除/宽度） */}
            <div className="ki-reader-toolbar">
              <span className="ki-reader-toolbar__label">文档内容</span>
              <div className="ki-reader-tools">
                {/* 检索组（搜索框 + Tags + 清除）整组居中，对齐全屏头部 .ki-drawer__fs-toolbar 的检索组 */}
                <div className="ki-reader-filters">
                  <label className="ki-reader-search">
                    <Icon name="search" className="ki-icon ki-icon--sm ki-reader-search__icon" />
                    <input
                      className="ki-form-input ki-reader-toolbar__search"
                      placeholder="搜索全库文档…（结果在此处展示）"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
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
                  <TagSelect scope={scope} value={selectedTag} onChange={setSelectedTag} />
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
            <div className={`ki-browse-reader__body${readerWide ? ' ki-browse-reader__body--wide' : ''}`}>
              {showingResults ? (
                renderSearchResults()
              ) : readingInline ? (
                renderViewer(false)
              ) : (
                <div className="ki-empty" style={{ padding: 64 }}>
                  <div>
                    <h3>从左侧目录选择文档开始阅读</h3>
                    <p>展开目录，点击文档名即可在此处连续阅读；用上方搜索框检索时，结果会显示在这里，点击结果从右侧抽屉打开原文。</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* 检索结果点开的文档：右侧抽屉（与语义检索页一致），结果列表保持可见 */}
      {viewing && viewingSource === 'search' && renderViewer(true)}
    </>
  );
}
