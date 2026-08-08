/**
 * BrowsePage.tsx —— 知识库浏览（对齐 demo 双栏：左 Group 递归树 + 右文档列表 + 原文抽屉）
 *
 * 数据源：/api/doc/list（返回 Group 路径 + 文档，支持 q 文件名搜索）
 * 原文：ki_get_module_info
 */

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useScopeValue } from '@/lib/scopeContext';
import { useDocList } from '@/lib/hooks';
import type { DocItem } from '@/api/httpApi';
import { kiGetModuleInfo } from '@/api/mcpClient';
import { ModuleDrawer } from '@/components/ModuleDrawer';

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

/** Group 树节点：按路径段递归聚合，docs 为直接挂载的文档 */
interface TreeNode {
  name: string;
  path: string;
  docs: DocItem[];
  children: TreeNode[];
  open: boolean;
}

/** 从 docs 的 group 路径构建递归层级树；根目录只有一个文件夹时上提一级（不显示该层） */
function buildTree(docs: DocItem[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const map = new Map<string, TreeNode>();
  const getNode = (path: string): TreeNode => {
    let n = map.get(path);
    if (!n) {
      n = { name: path.split('/').pop() || path, path, docs: [], children: [], open: false };
      map.set(path, n);
    }
    return n;
  };
  for (const d of docs) {
    const segs = d.group.split('/').filter(Boolean);
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
    prev!.docs.push(d);
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

/** 子树文档总数（父目录显示含子级计数） */
function countDocs(node: TreeNode): number {
  return node.docs.length + node.children.reduce((s, c) => s + countDocs(c), 0);
}

export function BrowsePage(): JSX.Element {
  const scope = useScopeValue();
  const [q, setQ] = useState('');
  const [activeGroup, setActiveGroup] = useState('');
  const [viewing, setViewing] = useState<{ module: string; group: string } | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);

  const { data, isLoading } = useDocList(scope);

  // 浏览页：禁止外层 .ki-content 滚动，让双栏内部各自滚动
  useEffect(() => {
    const el = document.querySelector('.ki-content');
    if (el) el.classList.add('ki-content--noscroll');
    return () => { el?.classList.remove('ki-content--noscroll'); };
  }, []);

  // 前端内存模糊过滤（一次拉取全量，无需每次输入请求后端）
  const filteredDocs = useMemo(() => {
    const docs = data?.docs ?? [];
    const kw = q.trim().toLowerCase();
    if (!kw) return docs;
    return docs.filter(
      (d) =>
        d.name.toLowerCase().includes(kw) ||
        (d.path ?? '').toLowerCase().includes(kw) ||
        d.group.toLowerCase().includes(kw),
    );
  }, [data, q]);

  // 数据（scope/过滤）变化时重建树；保留仍在树中的选中项
  useEffect(() => {
    const t = buildTree(filteredDocs);
    setDefaultOpen(t);
    setTree(t);
    setActiveGroup((prev) => {
      if (prev) {
        const stack = [...t];
        while (stack.length) {
          const n = stack.pop()!;
          if (n.path === prev) return prev;
          stack.push(...n.children);
        }
      }
      return t.length > 0 ? t[0].path : '';
    });
  }, [filteredDocs]);

  // 当前选中组文档（按完整路径匹配）
  const activeDocs = useMemo(() => {
    if (!activeGroup) return [];
    const stack = [...tree];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.path === activeGroup) return n.docs;
      stack.push(...n.children);
    }
    return [];
  }, [tree, activeGroup]);

  // 展示列表：搜索时展示全部匹配（跨目录扁平），否则展示选中目录文档
  const shownDocs = useMemo(() => {
    if (q.trim()) return filteredDocs;
    return activeDocs;
  }, [q, filteredDocs, activeDocs]);
  const isSearching = q.trim().length > 0;

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

  const handleDirClick = (node: TreeNode): void => {
    if (node.children.length > 0) toggleOpen(node.path);
    setActiveGroup(node.path);
    setViewing(null);
  };

  const renderNode = (node: TreeNode): JSX.Element => {
    const hasSub = node.children.length > 0;
    const isActive = node.path === activeGroup;
    return (
      <Fragment key={node.path}>
        <div
          className={`ki-tree-dir${node.open && hasSub ? ' ki-tree-dir--open' : ''}${isActive ? ' ki-tree-dir--active' : ''}`}
          onClick={() => handleDirClick(node)}
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

  return (
    <>
      <div className="ki-page-head" style={{ flexShrink: 0 }}>
        <div>
          <h1>知识库浏览</h1>
          <p>Group 树 · 文档列表 · 原文查看</p>
        </div>
      </div>

      <div className="ki-split" style={{ minHeight: 0, height: 'calc(100% - 60px)' }}>
        {/* 左：Group 树 */}
        <aside className="ki-split__side">
          <div className="ki-card">
            <div className="ki-card__head">
              <span className="ki-card__title">Group 树</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="ki-card__sub">{tree.length} 个目录</span>
                <button className="ki-mini-btn" onClick={() => setAllOpen(true)} title="展开全部目录">
                  展开全部
                </button>
                <button className="ki-mini-btn" onClick={() => setAllOpen(false)} title="折叠全部目录">
                  折叠全部
                </button>
              </div>
            </div>
            <div className="ki-card__body" style={{ padding: 12 }}>
              {isLoading ? (
                <>
                  <div className="ki-skeleton" style={{ width: '100%', height: 28, marginBottom: 8 }} />
                  <div className="ki-skeleton" style={{ width: '80%', height: 28, marginBottom: 8 }} />
                  <div className="ki-skeleton" style={{ width: '90%', height: 28 }} />
                </>
              ) : tree.length === 0 ? (
                <div className="ki-empty" style={{ padding: 24 }}>
                  <div>
                    <h3>空知识库</h3>
                    <p>该 scope 暂无 Group，可前往上传导入。</p>
                  </div>
                </div>
              ) : (
                <div className="ki-tree-root">{tree.map(renderNode)}</div>
              )}
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
                  ? `搜索「${q.trim()}」 · ${shownDocs.length} 条`
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
                gap: 8,
                alignItems: 'center',
              }}
            >
              <input
                className="ki-form-input"
                placeholder="按文件名/路径模糊搜索…"
                style={{ maxWidth: 220 }}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <span className="ki-cell-sub" style={{ marginLeft: 'auto' }}>
                /api/doc/list
              </span>
            </div>
            <div className="ki-card__body" style={{ padding: 12, flex: 1, overflowY: 'auto' }}>
              {isLoading ? (
                <div className="ki-skeleton" style={{ width: '100%', height: 60 }} />
              ) : shownDocs.length === 0 ? (
                <div className="ki-empty" style={{ border: 'none' }}>
                  <div>
                    <h3>无匹配文档</h3>
                    <p>{isSearching ? '未找到包含该关键词的文件，换个关键词试试。' : '调整文件名关键词后重试。'}</p>
                  </div>
                </div>
              ) : (
                shownDocs.map((d) => (
                  <div
                    key={`${d.group}/${d.name}`}
                    className="ki-doc-item"
                    onClick={() => setViewing({ module: d.name, group: d.group })}
                  >
                    <span className="ki-scope-name__dot ki-dot--blue" style={{ marginTop: 3 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="ki-doc-item__name">{d.name}</div>
                      {d.path && <div className="ki-doc-item__path">{d.path}</div>}
                      <div className="ki-doc-item__meta">
                        <span className="ki-badge ki-badge--kb">{d.group}</span>
                      </div>
                    </div>
                    <span className="ki-cell-sub" style={{ alignSelf: 'center' }}>
                      查看原文 ›
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </div>

      {viewing && (
        <ModuleDrawer
          scope={scope}
          module={viewing.module}
          group={viewing.group}
          onClose={() => setViewing(null)}
          fetcher={kiGetModuleInfo}
        />
      )}
    </>
  );
}
