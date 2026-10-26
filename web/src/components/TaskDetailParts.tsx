/**
 * 详情明细树（疑似重复 / 同名冲突 / 待删候选），任务详情与数据源详情共用。
 *
 * 键值行已统一到 `DetailParts.tsx::DetailParams`（含 hint / 链接 / 层级树），
 * 本文件只保留树形明细分组的渲染（`ItemTree`）。
 */
import { buildPathTree, type DetailItem } from '@/lib/taskDetailModel';

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
