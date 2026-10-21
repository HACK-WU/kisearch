/**
 * 任务/数据源详情共用的渲染组件（从 TasksPage 抽出，设计 S-05 D1）。
 *
 * 为什么抽：数据源详情与任务详情同构（三段 + 明细树）。复制一份会在
 * 「hint 取舍 / 折叠阈值 / 树的 meta 去重」上立刻漂移。
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { buildGroupTreeLines, buildPathTree, type DetailItem, type DetailRow } from '@/lib/taskDetailModel';

/** 详情分组标题（参数 / 结果 / 时间三段） */
export function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return <h3 className="ki-task-detail__section">{children}</h3>;
}

/** `className` 供调用方按段调整栅格（如数据源抽屉的「同步参数」走单列），默认不改变任务详情页 */
export function RowList({ rows, className }: { rows: DetailRow[]; className?: string }): JSX.Element {
  return (
    <dl className={className ? `ki-task-detail__grid ${className}` : 'ki-task-detail__grid'}>
      {rows.map((row) => (
        <div key={row.label} className={row.full ? 'ki-task-detail__cell--full' : undefined}>
          <dt>{row.label}</dt>
          <dd className={row.tone && row.tone !== 'normal' ? `ki-task-detail__value--${row.tone}` : undefined}>
            {row.tree && row.tree.items.length > 0 ? (
              row.tree.summary ? (
                <details className="ki-task-detail__details">
                  <summary>{row.tree.summary}</summary>
                  <pre className="ki-task-tree" tabIndex={0} aria-label={`${row.label} 层级树，共 ${row.tree.items.length} 个`}>{buildGroupTreeLines(row.tree.items).join('\n')}</pre>
                </details>
              ) : (
                <pre className="ki-task-tree" tabIndex={0} aria-label={`${row.label} 层级树，共 ${row.tree.items.length} 个`}>{buildGroupTreeLines(row.tree.items).join('\n')}</pre>
              )
            ) : (
              <>
                {row.href ? <Link to={row.href}>{row.value}</Link> : row.value}
                {row.hint ? <small className="ki-task-detail__hint">{row.hint}</small> : null}
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 明细树（疑似重复 / 同名冲突 / 待删候选）：路径按目录建树，说明挂在条目行 */
export function ItemTree({ items, label }: { items: DetailItem[]; label: string }): JSX.Element {
  const lines = buildPathTree(items.map((item) => ({ path: item.title, meta: item.meta })));
  const metas = lines.filter((line) => line.item).map((line) => line.meta ?? '');
  const sharedMeta = metas.length > 1 && metas[0] !== '' && metas.every((meta) => meta === metas[0])
    ? metas[0]
    : undefined;
  return (
    <>
      {sharedMeta ? <p className="ki-task-tree__shared">{sharedMeta}</p> : null}
      <ul className="ki-task-tree ki-task-tree--list" tabIndex={0} aria-label={`${label}层级树，共 ${items.length} 条`}>
        {lines.map((line, index) => (
          <li
            key={`${index}-${line.text}`}
            className={line.item ? 'ki-task-tree__row ki-task-tree__row--item' : 'ki-task-tree__row'}
          >
            <span className="ki-task-tree__path">{line.text}</span>
            {line.meta && line.meta !== sharedMeta
              ? <span className="ki-task-tree__meta">{line.meta}</span>
              : null}
          </li>
        ))}
      </ul>
    </>
  );
}
