/**
 * GroupPathSelect.tsx —— Group 路径下拉选择（combobox + 递归树）
 *
 * 从当前 scope 的 doc list 构建 Group 树；默认支持下拉选择已有路径或手动输入新建。
 * selectOnly（浏览/筛选场景）：不允许新建 Group —— 展开时输入框转为关键字过滤（与顶栏 Scope 选择器一致），
 * 收起时显示当前 Group；从树中点选即生效，不进入「确认 / 新建」流程。
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

/** 关键字过滤 Group 树：保留命中节点及其祖先链（命中处强制展开，便于定位） */
function filterGroupTree(nodes: GTreeNode[], keyword: string): { nodes: GTreeNode[]; matches: GTreeNode[] } {
  const k = keyword.trim().toLowerCase();
  if (!k) return { nodes, matches: [] };
  const matches: GTreeNode[] = [];
  const walk = (list: GTreeNode[]): GTreeNode[] =>
    list.reduce<GTreeNode[]>((acc, n) => {
      const children = walk(n.children);
      const hit = n.path.toLowerCase().includes(k);
      if (hit) matches.push(n);
      if (hit || children.length > 0) acc.push({ ...n, children, open: true });
      return acc;
    }, []);
  return { nodes: walk(nodes), matches };
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

/** 递归 Group 树（点击节点选中并关闭）；activePath 用于高亮当前选中项 */
function GroupTreeView({ nodes, onPick, activePath, allowParentPick }: { nodes: GTreeNode[]; onPick: (n: GTreeNode) => void; activePath?: string; allowParentPick: boolean }): JSX.Element {
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
          className={`ki-gtree-dir${activePath && n.path === activePath ? ' ki-gtree-dir--active' : ''}`}
          role="treeitem"
          tabIndex={0}
          aria-expanded={hasSub ? n.open : undefined}
          aria-selected={activePath === n.path}
          onClick={(e) => {
            e.stopPropagation();
            if (hasSub) toggleOpen(n.path);
            if (!hasSub || allowParentPick) onPick(n);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            if (hasSub) toggleOpen(n.path);
            if (!hasSub || allowParentPick) onPick(n);
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
  /** 校验错误文案（用于红框 + 错误提示） */
  error?: string | null;
  /**
   * 只选模式：输入框只读，仅允许从下拉树中点选，禁止手动输入新建。
   * 浏览/筛选场景使用（输入不存在的 Group 只会得到空列表）；导入等需要新建 Group 的场景保持默认 false。
   */
  selectOnly?: boolean;
}

export function GroupPathSelect({ scope, value, onChange, placeholder, hint, error, selectOnly = false }: GroupPathSelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  /** 是否已确认（回车确认或从下拉选中） */
  const [confirmed, setConfirmed] = useState(false);
  /** 只选模式的搜索词：展开时输入框显示它，选中/收起后清空，输入框回到当前 Group */
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const { data: docData } = useDocList(scope);
  const [tree, setTree] = useState<GTreeNode[]>([]);
  useEffect(() => {
    // 用完整 groups 列表构建树（不受 docs 500 条分页截断影响；空 Group 也能显示）
    const t = buildGroupTree(docData?.groups ?? []);
    setDefaultOpen(t);
    setTree(t);
  }, [docData]);

  // 点击外部关闭（同时清空搜索词，收起态输入框回到当前 Group）
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter('');
      }
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
    setFilter('');
    setOpen(false);
  };

  const openPicker = (): void => {
    setFilter('');
    setOpen(true);
  };
  const closePicker = (): void => {
    setFilter('');
    setOpen(false);
  };

  /** 只选模式下按关键字过滤后的树；非只选模式恒为原树（filter 始终为空） */
  const filtered = filterGroupTree(tree, selectOnly ? filter : '');
  const searching = selectOnly && filter.trim().length > 0;

  /**
   * 回车：非只选模式为「确认输入新建 / 已有」；
   * 只选模式为搜索语义 —— 唯一匹配直接选中，否则仅收起面板（不会写入任何新路径）。
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && selectOnly && open) {
      e.preventDefault();
      closePicker();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (selectOnly) {
      if (filtered.matches.length === 1) pick(filtered.matches[0]);
      else closePicker();
      return;
    }
    if (value.trim()) {
      setConfirmed(true);
      setOpen(false);
    }
  };

  /** 当前输入值是否为新建 Group（不在已有树中）；只选模式不存在新建 */
  const isNew = !selectOnly && value && !isPathInTree(tree, value);

  return (
    <div className={`ki-combobox${selectOnly ? ' ki-combobox--select-only' : ''}`} ref={rootRef}>
      <div className="ki-combobox__input-wrap">
        <input
          className={`ki-form-input${isNew ? ' ki-form-input--new' : ''}${!selectOnly && confirmed ? ' ki-form-input--confirmed' : ''}${error ? ' ki-form-input--error' : ''}`}
          placeholder={
            selectOnly
              ? open ? '搜索 Group…' : '从列表中选择 Group'
              : placeholder ?? '选择或输入 Group 路径，如：wiki/我的文档'
          }
          value={selectOnly && open ? filter : value}
          onChange={(e) => {
            // 只选模式：输入只作为过滤词，不写入 Group 值
            if (selectOnly) {
              setFilter(e.target.value);
              return;
            }
            setConfirmed(false);
            onChange(e.target.value);
          }}
          onFocus={() => { if (!open) openPicker(); }}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
        />
        {/* 只选模式选中即生效，不再显示「确认」标记与确认配色 */}
        {!selectOnly && confirmed && <span className="ki-combobox__confirm">✓</span>}
        <button
          type="button"
          className={`ki-combobox__toggle${open ? ' ki-combobox__toggle--open' : ''}`}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            if (open) closePicker();
            else openPicker();
          }}
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      <div className={`ki-combobox__panel${open ? ' ki-combobox__panel--open' : ''}`}>
        <div className="ki-combobox__tree" role="tree">
          {filtered.nodes.length === 0 ? (
            <div className="ki-cell-sub" style={{ padding: 6 }}>
              {selectOnly
                ? searching ? '没有匹配的 Group' : '当前 scope 暂无 Group'
                : '当前 scope 暂无 Group，可直接输入新建'}
            </div>
          ) : (
            <GroupTreeView nodes={filtered.nodes} onPick={pick} activePath={selectOnly ? value : undefined} allowParentPick={!selectOnly} />
          )}
        </div>
        <div className="ki-combobox__footer">
          <span className="ki-cell-sub">
            {selectOnly ? (
              searching ? (
                `${filtered.matches.length} 个匹配`
              ) : value ? (
                <span style={{ color: 'var(--ki-color-success)' }}>✓ 已选：{value}</span>
              ) : (
                '从下方列表中选择 Group'
              )
            ) : confirmed ? (
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
      {hint && !error && <div className="ki-form-hint">{hint}</div>}
      {error && <div className="ki-form-error">{error}</div>}
    </div>
  );
}
