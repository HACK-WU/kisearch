/**
 * 只读路径树（「新增的文档」/ 任务详情里的「待删除」）。
 *
 * 复用数据源「待删除」卡的目录形态（`ki-tree-dir` / `ki-tree-group` / `ki-tree-doc` + 折叠 + 计数），
 * 去掉勾选；传 `onOpenDoc` 时**点文件名直接打开正文**（不另设按钮）。
 */
import { useState } from 'react';
import { Icon } from '@/components/icons';
import type { DataSourcePendingTreeNode } from '@/lib/dataSourceDetailModel';

const FOLDER_ICON = (
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

export function ReadOnlyPathTree({
  nodes,
  label,
  onOpenDoc,
}: {
  nodes: DataSourcePendingTreeNode[];
  label: string;
  /** 给了就点文件名打开正文（键盘 Enter/Space 同样可用） */
  onOpenDoc?: (item: { group: string; relation: string }) => void;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderNode = (node: DataSourcePendingTreeNode): JSX.Element => {
    if (node.kind === 'file') {
      const clickable = Boolean(onOpenDoc && node.item);
      const open = (): void => {
        if (onOpenDoc && node.item) onOpenDoc({ group: node.item.group, relation: node.item.relation });
      };
      return (
        <div
          key={node.path}
          className={`ki-tree-doc ki-tree-doc--readonly${clickable ? ' ki-tree-doc--clickable' : ''}`}
          role={clickable ? 'button' : undefined}
          tabIndex={clickable ? 0 : undefined}
          title={clickable ? '查看内容' : undefined}
          onClick={clickable ? open : undefined}
          onKeyDown={clickable ? (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            open();
          } : undefined}
        >
          <span className="ki-tree-arrow" aria-hidden="true" />
          <Icon name="file" className="ki-icon ki-icon--sm" />
          <span className="ki-tree-doc__name">{node.name}</span>
        </div>
      );
    }
    const open = !collapsed.has(node.path);
    return (
      <div key={node.path}>
        <div
          className={`ki-tree-dir${open ? ' ki-tree-dir--open' : ''}`}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-label={`${node.name}，共 ${node.total} 篇`}
          title={node.path}
          onClick={() => toggle(node.path)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggle(node.path);
          }}
        >
          <button
            type="button"
            className="ki-tree-arrow"
            tabIndex={-1}
            aria-hidden="true"
            onClick={(event) => { event.stopPropagation(); toggle(node.path); }}
          >{open ? '▾' : '▸'}</button>
          {FOLDER_ICON}
          <span className="ki-tree-dir__label">{node.name}</span>
          <span className="ki-cell-sub">{node.total}</span>
        </div>
        {open ? <div className="ki-tree-group">{node.children.map(renderNode)}</div> : null}
      </div>
    );
  };

  return (
    // role=group：内部是「展开按钮 + 可点行」的混合结构，标成 tree 却放 button 属非法 ARIA
    <div className="ki-ds-tree ki-ds-tree--readonly" role="group" aria-label={label}>
      {nodes.map(renderNode)}
    </div>
  );
}
