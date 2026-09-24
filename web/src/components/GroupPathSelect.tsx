/**
 * GroupPathSelect.tsx —— Group 路径下拉选择（combobox + 递归树）
 *
 * 从当前 scope 的 doc list 构建 Group 树；默认支持下拉选择已有路径或手动输入新建。
 * selectOnly（浏览/筛选场景）：不允许新建 Group —— 展开时输入框转为关键字过滤（与顶栏 Scope 选择器一致），
 * 收起时显示当前 Group；从树中点选即生效，不进入「确认 / 新建」流程。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDocList } from '@/lib/hooks';
import { buildGroupTree, isGroupSelectable, toggleNodeOpen, withDefaultOpen, type GroupTreeNode as GTreeNode } from '@/lib/groupTree';

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

  /** 切换展开态（纯函数，不改写旧节点） */
  const toggleOpen = (path: string): void => {
    setTree((prev) => toggleNodeOpen(prev, path));
  };

  /**
   * 点击/激活节点：
   * - 可选节点：直接选中（面板随即关闭，无需再切换展开态）
   * - 不可选父目录（浏览场景的纯目录）：仅展开/折叠
   */
  const activate = (n: GTreeNode): void => {
    if (isGroupSelectable(n, allowParentPick)) {
      onPick(n);
      return;
    }
    if (n.children.length > 0) toggleOpen(n.path);
  };

  const render = (n: GTreeNode): JSX.Element => {
    const hasSub = n.children.length > 0;
    const selectable = isGroupSelectable(n, allowParentPick);
    const label = hasSub && n.count > 0
      ? `${n.name}，本组 ${n.count} 条文档，点击选中；箭头可展开子组`
      : `${n.name}，本组 ${n.count} 条文档`;
    return (
      <div key={n.path}>
        <div
          className={`ki-gtree-dir${activePath && n.path === activePath ? ' ki-gtree-dir--active' : ''}`}
          role="treeitem"
          tabIndex={0}
          title={label}
          aria-label={label}
          aria-expanded={hasSub ? n.open : undefined}
          aria-selected={activePath === n.path}
          onClick={(e) => {
            e.stopPropagation();
            activate(n);
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            activate(n);
          }}
        >
          {hasSub ? (
            <button
              className="ki-gtree-arrow"
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              onClick={(e) => { e.stopPropagation(); toggleOpen(n.path); }}
            >
              {n.open ? '▾' : '▸'}
            </button>
          ) : <span className="ki-gtree-arrow" aria-hidden="true" />}
          {ICON_FOLDER_SM}
          <span className="ki-gtree-label">{n.name}</span>
          {!selectable && <span className="ki-cell-sub">仅目录</span>}
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
    setTree(withDefaultOpen(buildGroupTree(docData?.groups ?? [])));
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

  /** 只选模式下按关键字过滤后的树；非只选模式恒为原树（filter 始终为空）。
   *  memo 化：否则每次渲染都重建节点对象，子组件同步本地展开态的 effect 会被反复触发。 */
  const filtered = useMemo(
    () => filterGroupTree(tree, selectOnly ? filter : ''),
    [tree, filter, selectOnly],
  );
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
        <div className="ki-combobox__tree" role="tree" aria-label="Group 树">
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
