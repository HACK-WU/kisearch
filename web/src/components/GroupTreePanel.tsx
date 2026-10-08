/**
 * GroupTreePanel.tsx —— 自包含的知识目录树面板。
 * 供搜索页等场景的全屏导航复用：自行拉取 scope 文档、本地管理展开态，
 * 点击文档叶子回调 onOpenDoc；样式复用浏览页树的全部类名（对齐 demo .tree-panel）。
 */

import { Fragment, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { DocItem } from '@/api/httpApi';
import { useDocList, useGroupDocs } from '@/lib/hooks';
import { revealTreeRow } from '@/lib/treeReveal';
import {
  buildGroupTree,
  countDocs,
  findGroupNode,
  revealGroupPath,
  toggleNodeOpen,
  withAllOpen,
  withDefaultOpen,
  type GroupTreeNode,
} from '@/lib/groupTree';
import { Icon } from './icons';

/** 树内所有 Group 是否都已展开（决定折叠按钮当前动作与图标，demo 为单按钮切换） */
function isAllOpen(nodes: GroupTreeNode[]): boolean {
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

export interface DirectoryScrollPosition {
  scope: string;
  group: string;
  left: number;
}

export interface GroupTreePanelProps {
  scope: string;
  /** 当前阅读的 Group（行高亮） */
  activeGroup?: string;
  /** 当前阅读的文档名（叶子高亮） */
  activeDocName?: string;
  /** Reader remounts when its document changes; keep horizontal context for same-group navigation. */
  scrollPositionRef?: MutableRefObject<DirectoryScrollPosition | null>;
  /** 点击文档叶子 */
  onOpenDoc: (doc: { group: string; name: string; path?: string }) => void;
}

export function GroupTreePanel({
  scope,
  activeGroup,
  activeDocName,
  scrollPositionRef,
  onOpenDoc,
}: GroupTreePanelProps): JSX.Element {
  const { data, isLoading } = useDocList(scope);
  const activeGroupDocs = useGroupDocs(scope, activeGroup || null);
  const docs = data?.docs ?? [];
  /** 展开态保存在本地树：首次由 groups 构建，之后文档刷新不重置用户的展开选择 */
  const [userTree, setUserTree] = useState<GroupTreeNode[] | null>(null);
  const treeScope = useRef(scope);
  const treeGroups = useRef(data?.groups);
  const bodyRef = useRef<HTMLDivElement>(null);
  const revealedTarget = useRef('');
  const startingScrollPosition = useRef(scrollPositionRef?.current);

  useEffect(() => {
    const scopeChanged = treeScope.current !== scope;
    const groupsChanged = treeGroups.current !== data?.groups;
    treeScope.current = scope;
    treeGroups.current = data?.groups;
    setUserTree((previous) => {
      const base = scopeChanged || groupsChanged || !previous
        ? withDefaultOpen(buildGroupTree(data?.groups ?? [])) : previous;
      if (!activeGroup) return base;
      const revealed = revealGroupPath(base, activeGroup);
      const target = findGroupNode(revealed, activeGroup);
      return activeDocName && target && !target.open
        ? toggleNodeOpen(revealed, activeGroup) : revealed;
    });
    revealedTarget.current = '';
  }, [scope, activeGroup, activeDocName, data?.groups]);

  const tree = useMemo(() => {
    if (userTree) return userTree;
    return withDefaultOpen(buildGroupTree(data?.groups ?? []));
  }, [userTree, data]);

  const docsByGroup = useMemo(() => {
    const map = new Map<string, DocItem[]>();
    for (const doc of docs) {
      const list = map.get(doc.group) ?? [];
      list.push(doc);
      map.set(doc.group, list);
    }
    if (activeGroup && activeGroupDocs.data?.scope === scope) {
      map.set(activeGroup, activeGroupDocs.data.docs);
    }
    // The reader supplies the current document's identity. Keep its navigation leaf
    // even when the list API caps the group; this does not change counts or stored data.
    const current = activeGroup && activeDocName ? { group: activeGroup, name: activeDocName } : undefined;
    if (current) {
      const groupDocs = map.get(current.group) ?? [];
      if (!groupDocs.some((doc) => doc.name === current.name)) map.set(current.group, [...groupDocs, current]);
    }
    return map;
  }, [docs, scope, activeGroup, activeDocName, activeGroupDocs.data]);

  useEffect(() => {
    // Wait until the group settles: its documents can move the fallback leaf down.
    if (!activeGroup || activeGroupDocs.isFetching) return;
    const key = JSON.stringify([scope, activeGroup, activeDocName]);
    if (revealedTarget.current === key) return;
    const frame = requestAnimationFrame(() => {
      const container = bodyRef.current;
      if (!container) return;
      const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-ki-group]'));
      const row = rows.find((item) => item.dataset.kiGroup === activeGroup
        && (activeDocName ? item.dataset.kiDocument === activeDocName : !item.dataset.kiDocument));
      if (!row) return;
      const saved = startingScrollPosition.current;
      const preserveHorizontal = saved?.scope === scope && saved.group === activeGroup;
      if (preserveHorizontal) container.scrollLeft = saved.left;
      revealTreeRow(container, row, preserveHorizontal);
      if (scrollPositionRef) scrollPositionRef.current = { scope, group: activeGroup, left: container.scrollLeft };
      revealedTarget.current = key;
    });
    return () => cancelAnimationFrame(frame);
  }, [scope, activeGroup, activeDocName, activeGroupDocs.isFetching, tree, docsByGroup, scrollPositionRef]);

  const toggleOpen = (path: string): void => setUserTree(toggleNodeOpen(tree, path));
  const allExpanded = tree.length > 0 && isAllOpen(tree);
  const totalDocs = tree.reduce((sum, node) => sum + countDocs(node), 0);

  /** hideSelf=true 时跳过本行、只渲染其内容（展平单根目录用） */
  const renderNode = (node: GroupTreeNode, hideSelf = false): JSX.Element => {
    const nodeDocs = node.open ? (docsByGroup.get(node.path) ?? []) : [];
    const isActive = node.path === activeGroup;
    const total = countDocs(node);
    return (
      <Fragment key={node.path}>
        {!hideSelf && (
        <div
          className={`ki-tree-dir${node.open ? ' ki-tree-dir--open' : ''}${isActive ? ' ki-tree-dir--active' : ''}`}
          role="treeitem"
          data-ki-group={node.path}
          tabIndex={0}
          aria-expanded={node.open}
          aria-label={`${node.name}，共 ${total} 篇`}
          onClick={() => toggleOpen(node.path)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            toggleOpen(node.path);
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
          <span className="ki-cell-sub" title={`本组共 ${total} 篇`}>
            {total}
          </span>
        </div>
        )}
        {node.open && (node.children.length > 0 || nodeDocs.length > 0) && (
          <div className="ki-tree-group">
            {nodeDocs.map((doc) => (
              <button
                key={`${doc.group}\u0000${doc.name}`}
                type="button"
                className={`ki-tree-doc${activeGroup === doc.group && activeDocName === doc.name ? ' ki-tree-doc--active' : ''}`}
                data-ki-group={doc.group}
                data-ki-document={doc.name}
                onClick={() => onOpenDoc({ group: doc.group, name: doc.name, path: doc.path })}
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

  return (
    <div className="ki-reader-nav ki-reader-nav--group">
      <div className="ki-reader-nav__head">
        <div>
          <div className="ki-card__title">知识目录</div>
          <div className="ki-card__sub">{isLoading ? '加载中…' : `${totalDocs} 篇`}</div>
        </div>
        <div className="ki-reader-nav__actions">
          <button
            className="ki-icon-button ki-icon-button--sm"
            data-action={allExpanded ? 'collapse' : 'expand'}
            onClick={() => setUserTree(withAllOpen(tree, !allExpanded))}
            title={allExpanded ? '折叠全部目录' : '展开全部目录'}
            aria-label={allExpanded ? '折叠全部目录' : '展开全部目录'}
            type="button"
          >
            <Icon name={allExpanded ? 'collapse' : 'expand'} />
          </button>
        </div>
      </div>
      <div className="ki-tree-meta" role="status" aria-live="polite">
        全部文档 <strong>· {totalDocs} 篇</strong>
      </div>
      <div
        ref={bodyRef}
        className="ki-reader-nav__body ki-reader-nav__body--tree"
        style={{ padding: 12 }}
        onScroll={(event) => {
          if (scrollPositionRef && activeGroup) {
            scrollPositionRef.current = { scope, group: activeGroup, left: event.currentTarget.scrollLeft };
          }
        }}
      >
        {/* 单根目录（如 consul）展平：scope 已确定，根行只是冗余壳（用户要求） */}
        {tree.length === 1
          ? renderNode({ ...tree[0], open: true }, true)
          : tree.map((node) => renderNode(node))}
      </div>
    </div>
  );
}
