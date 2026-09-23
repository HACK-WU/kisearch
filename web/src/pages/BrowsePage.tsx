/**
 * BrowsePage.tsx —— 知识库浏览（对齐 demo 双栏：左 Group 递归树 + 右文档列表 + 原文抽屉）
 *
 * 数据源：/api/doc/list（返回 Group 路径 + 文档，支持 q 文件名搜索）
 * 原文：ki_get_module_info
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useScopeValue } from '@/lib/scopeContext';
import { useDocList, useGroupDocs, getDocList, type DocListResponse } from '@/lib/hooks';
import type { DocItem } from '@/api/httpApi';
import { kiGetModuleInfo, kiSearch, type SearchHit, type SearchResult } from '@/api/mcpClient';
import { ModuleDrawer } from '@/components/ModuleDrawer';
import { GroupPathSelect } from '@/components/GroupPathSelect';
import { TagSelect } from '@/components/TagSelect';
import { resolveDocumentLink, type DocumentView } from '@/lib/documentLinks';

const ICON_FOLDER = (
  <svg className="ki-tree-icon" viewBox="0 0 16 16" fill="none">
    <path
      d="M1.5 3.2c0-.5.4-.9.9-.9h3.2l1.5 1.6h6c.5 0 .9.4.9.9v7.1c0 .5-.4.9-.9.9H2.4c-.5 0-.9-.4-.9-.9V3.2z"
      fill="#7db3ef"
      stroke="#5f97d6"
      strokeWidth="0.6"
    />
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

const ICON_NAV_DOC = (
  <svg className="ki-reader-nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
    <path d="M15 2v5h5" />
    <path d="M9 13h6" />
    <path d="M9 17h5" />
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightMatch(text: string, query: string): JSX.Element {
  const terms = query.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (terms.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${terms.join('|')})`, 'gi');
  return <>{text.split(pattern).map((part, index) =>
    terms.some((term) => new RegExp(`^${term}$`, 'i').test(part))
      ? <mark key={index} className="ki-search-hit-mark">{part}</mark>
      : <Fragment key={index}>{part}</Fragment>
  )}</>;
}

function makeSnippet(content: string, query: string, maxLength = 320): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  const firstTerm = query.trim().split(/\s+/).find(Boolean)?.toLowerCase() ?? '';
  const index = firstTerm ? normalized.toLowerCase().indexOf(firstTerm) : -1;
  const start = index > 80 ? index - 80 : 0;
  const end = Math.min(normalized.length, start + maxLength);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
}

/** Group 树节点：按路径段递归聚合 */
interface TreeNode {
  name: string;
  path: string;
  /** 后端返回的文档数量（不受分页截断影响） */
  count: number;
  children: TreeNode[];
  open: boolean;
}

/** 从 group 列表（含文档数量）构建递归层级树；根目录只有一个文件夹时上提一级（不显示该层） */
function buildTreeFromGroups(groups: { name: string; count: number }[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const map = new Map<string, TreeNode>();
  const getNode = (path: string): TreeNode => {
    let n = map.get(path);
    if (!n) {
      n = { name: path.split('/').pop() || path, path, count: 0, children: [], open: false };
      map.set(path, n);
    }
    return n;
  };
  for (const g of groups) {
    const segs = g.name.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    let prev: TreeNode | null = null;
    for (let i = 0; i < segs.length; i++) {
      const node = getNode(segs.slice(0, i + 1).join('/'));
      if (prev) {
        if (!prev.children.some((c) => c.path === node.path)) prev.children.push(node);
      } else if (!roots.some((r) => r.path === node.path)) {
        roots.push(node);
      }
      prev = node;
    }
    // 叶子节点：直接挂载后端返回的文档数量
    prev!.count = g.count;
  }
  // 唯一顶层目录：上提其子级（根目录只有一层时不显示该层）
  if (roots.length === 1) {
    const only = roots[0];
    if (only.children.length > 0) return only.children;
  }
  return roots;
}

/** 默认展开一级，子级折叠 */
function setDefaultOpen(nodes: TreeNode[], depth = 0): void {
  for (const n of nodes) {
    n.open = depth === 0;
    setDefaultOpen(n.children, depth + 1);
  }
}

/** 子树文档总数（父目录显示含子级计数，直接使用后端返回的 count 字段） */
function countDocs(node: TreeNode): number {
  return node.count + node.children.reduce((s, c) => s + countDocs(c), 0);
}

export function BrowsePage(): JSX.Element {
  const scope = useScopeValue();
  const queryClient = useQueryClient();
  // 全局在途请求数：> 0 时刷新按钮置为「刷新中…」并禁用，避免重复点击
  const fetching = useIsFetching();
  const [q, setQ] = useState('');
  const [activeGroup, setActiveGroup] = useState('');
  const [viewing, setViewing] = useState<DocumentView | null>(null);
  const [history, setHistory] = useState<DocumentView[]>([]);
  const [forwardHistory, setForwardHistory] = useState<DocumentView[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [searchQ, setSearchQ] = useState('');
  // 阅读器全屏时把 Browse 导航带入工作区；两块导航独立折叠，Group 默认折叠、文档默认展开。
  const [readerFullscreen, setReaderFullscreen] = useState(false);
  const [readerGroupCollapsed, setReaderGroupCollapsed] = useState(true);
  const [readerDocsCollapsed, setReaderDocsCollapsed] = useState(false);
  // tag 过滤：选中则仅显示带该 tag 的文档；空表示不过滤
  const [selectedTag, setSelectedTag] = useState('');

  const { data, isLoading, isError, error, refetch } = useDocList(scope);
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
  // 分离原因：activeGroup 变化时若重建树 + setDefaultOpen，会导致非一级节点被折叠。
  useEffect(() => {
    const rawGroups = data?.groups;
    if (!rawGroups?.length) {
      setTree([]);
      return;
    }
    const t = buildTreeFromGroups(rawGroups);
    setDefaultOpen(t);
    setTree(t);
    // 默认选中第一个叶子 group（无子级），页面加载即显示该 group 文档
    setActiveGroup((prev) => {
      if (prev) {
        // 已有选中且仍在树中 → 保留（避免重复请求）
        const stack = [...t];
        while (stack.length) {
          const n = stack.pop()!;
          if (n.path === prev) return prev;
          stack.push(...n.children);
        }
      }
      const findFirstLeaf = (nodes: TreeNode[]): string => {
        for (const n of nodes) {
          if (n.children.length === 0) return n.path;
          const leaf = findFirstLeaf(n.children);
          if (leaf) return leaf;
        }
        return '';
      };
      return findFirstLeaf(t) || (t.length > 0 ? t[0].path : '');
    });
  }, [data?.groups]); // ← 仅依赖 groups，不依赖 activeGroup

  // ── 选中 group 文档回填（groupDocs 就绪时写入对应树节点，不重建树）──
  useEffect(() => {
    if (!activeGroup || groupDocs.length === 0) return;
    setTree((prev) => {
      const walk = (nodes: TreeNode[]): boolean => {
        for (const n of nodes) {
          if (n.path === activeGroup) {
            n.count = groupDocs.length; // 用实际返回的文档数更新 count
            return true;
          }
          if (walk(n.children)) return true;
        }
        return false;
      };
      const copy = prev.map((n) => ({ ...n }));
      walk(copy);
      return copy;
    });
  }, [activeGroup, groupDocs]);

  // 当前选中组文档（直接使用 useGroupDocs 返回值，无需再从树中取）
  const activeDocs = groupDocs;

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
  const searchPending = isSearching && q.trim() !== searchQ;
  const searchRefreshing = isSearching && (searchPending || searchQuery.isFetching);
  // 首次搜索没有可复用的旧结果时展示 loading；后续输入保留上一次结果，避免列表闪烁。
  const isSearchLoading = isSearching && !searchQuery.data && (searchPending || searchQuery.isLoading);

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

  // 展示列表：有搜索词时展示全局搜索结果，否则展示当前选中 group 文档
  const shownDocs = isSearching ? searchDocs : activeDocs;
  const shownTotal = isSearching ? (searchQuery.data?.total ?? shownDocs.length) : (groupQuery.data?.total ?? activeDocs.length);
  const searchTruncated = isSearching && searchQuery.data?.truncated === true;

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

  /** 展开目标 Group 的父级，让链接跳转后的选中状态在树中可见。 */
  const revealGroup = useCallback((group: string): void => {
    setTree((prev) => {
      const copy = prev.map((node) => ({ ...node }));
      const walk = (nodes: TreeNode[]): void => {
        for (const node of nodes) {
          if (group === node.path || group.startsWith(`${node.path}/`)) {
            node.open = node.children.length > 0;
            walk(node.children);
          }
        }
      };
      walk(copy);
      return copy;
    });
  }, []);

  /** 手动打开文档是新的导航起点，不沿用上一次文档链接产生的历史。 */
  const openDocument = useCallback((doc: DocumentView): void => {
    setHistory([]);
    setForwardHistory([]);
    setViewing(doc);
  }, []);

  /** 关闭抽屉后再次打开文档时从头开始记录导航历史。 */
  const closeDocument = useCallback((): void => {
    setHistory([]);
    setForwardHistory([]);
    setReaderFullscreen(false);
    setViewing(null);
  }, []);

  /** 返回最近一次本地链接跳转前的文档，并同步恢复其 Group。 */
  const goBack = useCallback((): void => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((prev) => prev.slice(0, -1));
    if (viewing) setForwardHistory((prev) => [...prev, viewing]);
    setActiveGroup(previous.group ?? '');
    if (previous.group) revealGroup(previous.group);
    setViewing(previous);
  }, [history, revealGroup, viewing]);

  /** 前进到最近一次返回前的文档，并同步恢复其 Group。 */
  const goForward = useCallback((): void => {
    const next = forwardHistory[forwardHistory.length - 1];
    if (!next) return;
    setForwardHistory((prev) => prev.slice(0, -1));
    if (viewing) setHistory((prev) => [...prev, viewing]);
    setActiveGroup(next.group ?? '');
    if (next.group) revealGroup(next.group);
    setViewing(next);
  }, [forwardHistory, revealGroup, viewing]);

  /** 在当前 Browse 页面内切换到 Markdown 链接指向的文档。 */
  const handleLocalLink = useCallback((href: string): boolean => {
    const target = resolveDocumentLink(href, viewing?.path, viewing?.group, knownDocs);
    if (!target) return false;
    if (viewing) setHistory((prev) => [...prev, viewing]);
    setForwardHistory([]);
    setActiveGroup(target.group);
    revealGroup(target.group);
    setViewing({
      module: target.name,
      group: target.group,
      path: target.path,
      highlightQuery: viewing?.highlightQuery,
    });
    return true;
  }, [knownDocs, revealGroup, viewing]);

  /** 切换节点展开/折叠（原地 mutate + 新数组引用触发渲染） */
  const toggleOpen = (path: string): void => {
    setTree((prev) => {
      const walk = (nodes: TreeNode[]): boolean => {
        for (const n of nodes) {
          if (n.path === path) {
            n.open = !n.open;
            return true;
          }
          if (walk(n.children)) return true;
        }
        return false;
      };
      walk(prev);
      return [...prev];
    });
  };

  /** 展开/折叠全部 */
  const setAllOpen = (open: boolean): void => {
    setTree((prev) => {
      const walk = (nodes: TreeNode[]): void => {
        for (const n of nodes) {
          if (n.children.length > 0) n.open = open;
          walk(n.children);
        }
      };
      walk(prev);
      return [...prev];
    });
  };

  /**
   * 目录点击：
   * - 父目录（有子级）：仅展开/折叠，不选中、不请求文档
   * - 叶子 group：选中并请求该 group 完整文档
   */
  const handleDirClick = (node: TreeNode): void => {
    if (node.children.length > 0) {
      toggleOpen(node.path);
      return;
    }
    setActiveGroup(node.path);
    // 全屏阅读时保留当前阅读器，用户可以在左侧 Group 树和中间文档列表继续选文档。
    if (!readerFullscreen) closeDocument();
  };

  const renderNode = (node: TreeNode): JSX.Element => {
    const hasSub = node.children.length > 0;
    const isActive = node.path === activeGroup;
    return (
      <Fragment key={node.path}>
        <div
          className={`ki-tree-dir${node.open && hasSub ? ' ki-tree-dir--open' : ''}${isActive ? ' ki-tree-dir--active' : ''}`}
          role="treeitem"
          tabIndex={0}
          aria-expanded={hasSub ? node.open : undefined}
          aria-selected={isActive}
          onClick={() => handleDirClick(node)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            handleDirClick(node);
          }}
        >
          <span className="ki-tree-arrow">{hasSub ? (node.open ? '▾' : '▸') : ''}</span>
          {ICON_FOLDER}
          <span className="ki-tree-dir__label">{node.name}</span>
          <span className="ki-cell-sub">{countDocs(node)}</span>
        </div>
        {hasSub && node.open && (
          <div className="ki-tree-group">{node.children.map(renderNode)}</div>
        )}
      </Fragment>
    );
  };

  const renderTreeBody = (): JSX.Element => (
    <>
      {isLoading ? (
        <>
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
        <div className="ki-tree-root" role="tree">{tree.map(renderNode)}</div>
      )}
    </>
  );

  const renderDocumentFilters = (): JSX.Element => (
    <>
      <GroupPathSelect
        scope={scope}
        value={activeGroup}
        onChange={(v) => { setActiveGroup(v); if (!readerFullscreen) closeDocument(); }}
        selectOnly
      />
      <input
        className="ki-form-input"
        placeholder="按文件名、路径或正文搜索…"
        style={{ maxWidth: 250, flex: '1 1 220px' }}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        data-ki-search-input
        aria-label="按文件名、路径或正文搜索文档"
      />
      <TagSelect scope={scope} value={selectedTag} onChange={setSelectedTag} />
      {isSearching && <span className="ki-filter-context">搜索范围：当前 Scope 全部 Group</span>}
      {(q || selectedTag) && (
        <button className="ki-btn ki-btn--ghost ki-btn--small" type="button" onClick={clearFilters}>
          清除筛选
        </button>
      )}
    </>
  );

  const renderDocumentList = (): JSX.Element => {
    const listError = isSearching ? (searchQuery.isError ? searchQuery.error : null) : (groupQuery.isError ? groupQuery.error : null);
    const retryList = isSearching ? searchQuery.refetch : groupQuery.refetch;
    const listLoading = isSearching ? isSearchLoading : isLoading || groupQuery.isLoading;
    return (
    <>
      {isSearching && (
        <div className="ki-browse-fulltext" aria-live="polite">
          <div className="ki-browse-fulltext__head">
            <span>正文命中</span>
            <span className="ki-card__sub">
              {fullTextQuery.isFetching ? '搜索中…' : `${fullTextHits.length} 条`}
            </span>
          </div>
          {fullTextQuery.isError ? (
            <div className="ki-browse-fulltext__empty">正文检索暂时失败，可重试或继续查看文件名命中。</div>
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
                    openDocument({ module: relation, group, path: known?.path, highlightQuery: searchQ });
                  }}
                >
                  <span className="ki-browse-fulltext__title">{relation || '未命名文档'}</span>
                  <span className="ki-browse-fulltext__path">{group}</span>
                  <span className="ki-browse-fulltext__snippet">
                    {highlightMatch(makeSnippet(hit.original ?? hit.content ?? '', searchQ), searchQ)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
      {listLoading ? (
        <div className="ki-skeleton" style={{ width: '100%', height: 60 }} />
      ) : listError ? (
        <div className="ki-empty" style={{ border: 'none' }}>
          <div>
            <h3>文档列表加载失败</h3>
            <p>{listError instanceof Error ? listError.message : '暂时无法读取文档列表。'}</p>
            <div className="ki-empty__actions">
              <button className="ki-btn ki-btn--secondary ki-btn--small" type="button" onClick={() => void retryList()}>
                重试
              </button>
            </div>
          </div>
        </div>
      ) : shownDocs.length === 0 ? (
        <div className="ki-empty" style={{ border: 'none' }}>
          <div>
            <h3>无匹配文档</h3>
            <p>{isSearching ? '未找到包含该关键词的文件，换个关键词试试。' : '该 Group 暂无文档，或选择其他 Group 查看。'}</p>
          </div>
        </div>
      ) : (
        <>
          {shownDocs.map((d) => (
            <div
              key={`${d.group}/${d.name}`}
              className="ki-doc-item"
              role="button"
              tabIndex={0}
              onClick={() => openDocument({
                module: d.name,
                group: d.group,
                path: d.path,
                highlightQuery: isSearching ? searchQ : undefined,
              })}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                openDocument({
                  module: d.name,
                  group: d.group,
                  path: d.path,
                  highlightQuery: isSearching ? searchQ : undefined,
                });
              }}
            >
              <span className="ki-scope-name__dot ki-dot--blue" style={{ marginTop: 3 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ki-doc-item__name">{d.name}</div>
                {d.path && <div className="ki-doc-item__path">{d.path}</div>}
                <div className="ki-doc-item__meta">
                  <span className="ki-badge ki-badge--kb">{d.group}</span>
                  {(d.tags ?? []).map((t) => (
                    <span key={t} className="ki-badge ki-badge--tag">#{t}</span>
                  ))}
                  {d.vectorized === true && (
                    <span className="ki-badge ki-badge--vec">RAG</span>
                  )}
                  {d.fullTextIndexed === true && (
                    <span className="ki-badge ki-badge--fts" title="FTS-only：不生成 dense 向量，通过正文检索">
                      FTS
                    </span>
                  )}
                </div>
              </div>
              <span className="ki-cell-sub" style={{ alignSelf: 'center' }}>
                查看原文 ›
              </span>
            </div>
          ))}
        </>
      )}
    </>
    );
  };

  /** 全屏阅读工作区：导航面板在抽屉内部渲染，因此不会被 scrim 遮挡。 */
  const fullscreenNavigation = (
    <div
      className={`ki-reader-navigation${readerGroupCollapsed ? ' ki-reader-navigation--group-collapsed' : ' ki-reader-navigation--group-open'}${readerDocsCollapsed ? ' ki-reader-navigation--docs-collapsed' : ' ki-reader-navigation--docs-open'}`}
    >
      <aside className={`ki-reader-nav ki-reader-nav--group${readerGroupCollapsed ? ' ki-reader-nav--collapsed' : ''}`}>
        {readerGroupCollapsed ? (
          <button
            className="ki-reader-nav__collapsed-toggle"
            onClick={() => {
              // 展开 Group 树时一并展开文档列表，避免只回来半扇导航
              setReaderGroupCollapsed(false);
              setReaderDocsCollapsed(false);
            }}
            title="展开 Group 树"
            aria-label="展开 Group 树"
            type="button"
          >
            <span className="ki-reader-nav__collapsed-mark">{ICON_NAV_TREE}</span>
          </button>
        ) : (
          <>
            <div className="ki-reader-nav__head">
              <div>
                <div className="ki-card__title">Group 树</div>
                <div className="ki-card__sub">{tree.length} 个目录</div>
              </div>
              <div className="ki-reader-nav__actions">
                <button
                  className="ki-reader-nav__refresh"
                  onClick={() => { void queryClient.invalidateQueries(); }}
                  disabled={fetching > 0}
                  title="刷新 Group 与文档列表"
                  type="button"
                >
                  {ICON_NAV_REFRESH}
                  {fetching > 0 ? '刷新中' : '刷新'}
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
            <div className="ki-reader-nav__body ki-reader-nav__body--tree">{renderTreeBody()}</div>
          </>
        )}
      </aside>

      <aside className={`ki-reader-nav ki-reader-nav--docs${readerDocsCollapsed ? ' ki-reader-nav--collapsed' : ''}`}>
        {readerDocsCollapsed ? (
          <button
            className="ki-reader-nav__collapsed-toggle"
            onClick={() => setReaderDocsCollapsed(false)}
            title="展开文档列表"
            aria-label="展开文档列表"
            type="button"
          >
            <span className="ki-reader-nav__collapsed-mark">{ICON_NAV_DOC}</span>
          </button>
        ) : (
          <>
            <div className="ki-reader-nav__head">
              <div>
                <div className="ki-card__title">文档</div>
                <div className="ki-card__sub">
                  {isSearching ? `搜索「${q.trim()}」${searchRefreshing ? ' · 搜索中…' : ` · ${shownTotal} 条${searchTruncated ? '（仅展示前 2000 条）' : ''}`}` : `${shownTotal} 条`}
                </div>
              </div>
              <div className="ki-reader-nav__actions">
                <button
                  className="ki-reader-nav__collapse"
                  onClick={() => setReaderDocsCollapsed(true)}
                  title="收起文档列表"
                  aria-label="收起文档列表"
                  type="button"
                >
                  {ICON_NAV_COLLAPSE}
                </button>
              </div>
            </div>
            <div className="ki-reader-nav__filters">{renderDocumentFilters()}</div>
            <div className="ki-reader-nav__body">{renderDocumentList()}</div>
          </>
        )}
      </aside>
    </div>
  );

  return (
    <>
      <div className="ki-page-head" style={{ flexShrink: 0 }}>
        <div>
          <h1>知识库浏览</h1>
          <p>Group 树 · 文档列表 · 原文查看</p>
        </div>
      </div>

      {/* 高度由 .ki-content-inner 的 grid 行提供（见 ki.css），不在这里按内容估算 */}
      <div className="ki-split">
        {/* 左：Group 树 */}
        <aside className="ki-split__side">
          <div className="ki-card">
            <div className="ki-card__head">
              <span className="ki-card__title">Group 树</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="ki-card__sub">{tree.length} 个目录</span>
                <button
                  className="ki-mini-btn"
                  onClick={() => { void queryClient.invalidateQueries(); }}
                  disabled={fetching > 0}
                  title="重新拉取 scope 与文档列表（导入完成后无需重启服务，点此即可看到新 Group）"
                >
                  {fetching > 0 ? '刷新中…' : '刷新'}
                </button>
                <button className="ki-mini-btn" onClick={() => setAllOpen(true)} title="展开全部目录">
                  展开全部
                </button>
                <button className="ki-mini-btn" onClick={() => setAllOpen(false)} title="折叠全部目录">
                  折叠全部
                </button>
              </div>
            </div>
            <div className="ki-card__body" style={{ padding: 12 }}>
              {renderTreeBody()}
            </div>
          </div>
        </aside>

        {/* 右：文档列表 */}
        <section>
          <div className="ki-card">
            <div className="ki-card__head">
              <span className="ki-card__title">文档</span>
              <span className="ki-card__sub">
                {isSearching
                  ? `搜索「${q.trim()}」${searchRefreshing ? ' · 搜索中…' : ` · ${shownTotal} 条${searchTruncated ? '（仅展示前 2000 条）' : ''}`}`
                  : activeGroup
                    ? `${activeGroup} · ${activeDocs.length} 条`
                    : '选择左侧 Group 查看文档'}
              </span>
            </div>
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--ki-color-border)',
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <GroupPathSelect
                scope={scope}
                value={activeGroup}
                onChange={(v) => { setActiveGroup(v); if (!readerFullscreen) closeDocument(); }}
                selectOnly
              />
              <input
                className="ki-form-input"
                placeholder="按文件名、路径或正文搜索…"
                style={{ maxWidth: 250, flex: '1 1 220px' }}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                data-ki-search-input
                aria-label="按文件名、路径或正文搜索文档"
              />
              <TagSelect scope={scope} value={selectedTag} onChange={setSelectedTag} />
              {isSearching && <span className="ki-filter-context">搜索范围：当前 Scope 全部 Group</span>}
              {(q || selectedTag) && (
                <button className="ki-btn ki-btn--ghost ki-btn--small" type="button" onClick={clearFilters}>
                  清除筛选
                </button>
              )}
            </div>
            <div className="ki-card__body" style={{ padding: 12, flex: 1, overflowY: 'auto' }}>
              {renderDocumentList()}
            </div>
          </div>
        </section>
      </div>

      {viewing && (
        <ModuleDrawer
          key={`${scope}:${viewing.group}:${viewing.module}`}
          scope={scope}
          module={viewing.module}
          group={viewing.group}
          highlightQuery={viewing.highlightQuery}
          onClose={closeDocument}
          fetcher={kiGetModuleInfo}
          onLocalLink={handleLocalLink}
          canGoBack={history.length > 0}
          onBack={goBack}
          canGoForward={forwardHistory.length > 0}
          onForward={goForward}
          fullscreen={readerFullscreen}
          onFullscreenChange={setReaderFullscreen}
          fullscreenNavigation={fullscreenNavigation}
        />
      )}
    </>
  );
}
