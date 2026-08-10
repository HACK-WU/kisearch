/**
 * GroupPathSelect.tsx —— Group 路径下拉选择（combobox + 递归树）
 *
 * 从当前 scope 的 doc list 构建 Group 树；支持下拉选择已有路径或手动输入新建。
 */

import { useEffect, useRef, useState } from 'react';
import { useDocList } from '@/lib/hooks';

interface GTreeNode {
  name: string;
  path: string;
  children: GTreeNode[];
  open: boolean;
}

/** 从 groups 列表（完整 group 路径 + count）构建递归树（全路径节点，唯一顶层折叠） */
function buildGroupTree(groups: { name: string }[]): GTreeNode[] {
  const roots: GTreeNode[] = [];
  const map = new Map<string, GTreeNode>();
  const getNode = (path: string): GTreeNode => {
    let n = map.get(path);
    if (!n) {
      n = { name: path.split('/').pop() || path, path, children: [], open: false };
      map.set(path, n);
    }
    return n;
  };
  for (const g of groups) {
    const segs = g.name.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    let prev: GTreeNode | null = null;
    for (let i = 0; i < segs.length; i++) {
      const node = getNode(segs.slice(0, i + 1).join('/'));
      if (prev) {
        if (!prev.children.some((c) => c.path === node.path)) prev.children.push(node);
      } else if (!roots.some((r) => r.path === node.path)) {
        roots.push(node);
      }
      prev = node;
    }
  }
  if (roots.length === 1 && roots[0].children.length > 0) return roots[0].children;
  return roots;
}

/** 默认展开一层 */
function setDefaultOpen(nodes: GTreeNode[], depth = 0): void {
  for (const n of nodes) {
    n.open = depth === 0;
    setDefaultOpen(n.children, depth + 1);
  }
}

function isPathInTree(nodes: GTreeNode[], path: string): boolean {
  for (const n of nodes) {
    if (n.path === path) return true;
    if (isPathInTree(n.children, path)) return true;
  }
  return false;
}

const ICON_FOLDER_SM = (
  <svg className="ki-gtree-icon" viewBox="0 0 16 16" fill="none">
    <path
      d="M1.5 3.2c0-.5.4-.9.9-.9h3.2l1.5 1.6h6c.5 0 .9.4.9.9v7.1c0 .5-.4.9-.9.9H2.4c-.5 0-.9-.4-.9-.9V3.2z"
      fill="#7db3ef"
      stroke="#5f97d6"
      strokeWidth="0.6"
    />
  </svg>
);

/** 递归 Group 树（点击节点选中并关闭） */
function GroupTreeView({ nodes, onPick }: { nodes: GTreeNode[]; onPick: (n: GTreeNode) => void }): JSX.Element {
  const [tree, setTree] = useState<GTreeNode[]>(nodes);
  useEffect(() => setTree(nodes), [nodes]);

  const toggleOpen = (path: string): void => {
    setTree((prev) => {
      const walk = (items: GTreeNode[]): boolean => {
        for (const n of items) {
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

  const render = (n: GTreeNode): JSX.Element => {
    const hasSub = n.children.length > 0;
    return (
      <div key={n.path}>
        <div
          className="ki-gtree-dir"
          onClick={(e) => {
            e.stopPropagation();
            if (hasSub) toggleOpen(n.path);
            onPick(n);
          }}
        >
          <span className="ki-gtree-arrow">{hasSub ? (n.open ? '▾' : '▸') : ''}</span>
          {ICON_FOLDER_SM}
          <span className="ki-gtree-label">{n.name}</span>
        </div>
        {hasSub && n.open && <div className="ki-gtree-group">{n.children.map(render)}</div>}
      </div>
    );
  };

  return <>{tree.map(render)}</>;
}

interface GroupPathSelectProps {
  scope: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  /** 底部提示文本定制（默认提示新建/已有） */
  newLabel?: string;
}

export function GroupPathSelect({ scope, value, onChange, placeholder, hint }: GroupPathSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  /** 是否已确认（回车确认或从下拉选中） */
  const [confirmed, setConfirmed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const { data: docData } = useDocList(scope);
  const [tree, setTree] = useState<GTreeNode[]>([]);
  useEffect(() => {
    // 用完整 groups 列表构建树（不受 docs 500 条分页截断影响；空 Group 也能显示）
    const t = buildGroupTree(docData?.groups ?? []);
    setDefaultOpen(t);
    setTree(t);
  }, [docData]);

  // 点击外部关闭
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  // 外部清空值时重置确认态
  useEffect(() => {
    if (!value) setConfirmed(false);
  }, [value]);

  const pick = (n: GTreeNode): void => {
    onChange(n.path);
    setConfirmed(true);
    setOpen(false);
  };

  /** 回车确认：关闭面板并标记已确认（输入变更时自动重置） */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (value.trim()) {
        setConfirmed(true);
        setOpen(false);
      }
    }
  };

  /** 当前输入值是否为新建 Group（不在已有树中） */
  const isNew = value && !isPathInTree(tree, value);

  return (
    <div className="ki-combobox" ref={rootRef}>
      <div className="ki-combobox__input-wrap">
        <input
          className={`ki-form-input${isNew ? ' ki-form-input--new' : ''}${confirmed ? ' ki-form-input--confirmed' : ''}`}
          placeholder={placeholder ?? '选择或输入 Group 路径，如：wiki/我的文档'}
          value={value}
          onChange={(e) => { setConfirmed(false); onChange(e.target.value); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
        />
        {confirmed && <span className="ki-combobox__confirm">✓</span>}
        <button
          type="button"
          className={`ki-combobox__toggle${open ? ' ki-combobox__toggle--open' : ''}`}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      <div className={`ki-combobox__panel${open ? ' ki-combobox__panel--open' : ''}`}>
        <div className="ki-combobox__tree">
          {tree.length === 0 ? (
            <div className="ki-cell-sub" style={{ padding: 6 }}>
              当前 scope 暂无 Group，可直接输入新建
            </div>
          ) : (
            <GroupTreeView nodes={tree} onPick={pick} />
          )}
        </div>
        <div className="ki-combobox__footer">
          <span className="ki-cell-sub">
            {confirmed ? (
              <span style={{ color: 'var(--ki-color-success)' }}>✓ 已确认：{value}</span>
            ) : value && !isPathInTree(tree, value) ? (
              <span style={{ color: 'var(--ki-color-success)' }}>✚ 将新建 Group：{value}（回车确认）</span>
            ) : value ? (
              <span style={{ color: 'var(--ki-color-primary)' }}>✓ 已有 Group</span>
            ) : (
              '输入新路径可新建 Group'
            )}
          </span>
        </div>
      </div>
      {hint && <div className="ki-form-hint">{hint}</div>}
    </div>
  );
}
