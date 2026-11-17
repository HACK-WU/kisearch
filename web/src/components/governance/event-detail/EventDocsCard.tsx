import type { EventDocsCardProps } from './types';
import { DocLine } from './DocLine';

/**
 * 关联文档 / 参考文档卡（同一个组件两种 mode）。
 * 检查点：B-01/B-06/B-09/B-10、I-01~I-13。
 * 批 1 只做卡壳与列表；AI 查找面板在批 3 接入（`mode='ref'` 的 actions 里先只放「＋ 添加」）。
 */
export function EventDocsCard(props: EventDocsCardProps) {
  const { mode, docs, canWrite, busy, hint, actions, notice, panel, emptyText, confirmKey, onConfirmChange, onOpen, onRemove } = props;
  const isMember = mode === 'member';
  return (
    <section className={`gov-dcard ${isMember ? 'gov-dcard--member' : 'gov-dcard--ref'}`}>
      <div className="gov-dcard__head">
        <span className="gov-dcard__icon" aria-hidden="true">{isMember ? '▤' : '❝'}</span>
        <span className="gov-dcard__title">{isMember ? '关联文档' : '参考文档'}</span>
        <span className="gov-dcard__hint">{hint}</span>
        <span className="gov-dcard__actions">
          <span className="gov-dchip gov-dchip--idle">{docs.length} 篇</span>
          {actions}
        </span>
      </div>
      <div className="gov-dcard__body" style={docs.length ? { padding: 6 } : undefined}>
        {notice}
        {panel}
        {docs.length ? (
          <div className="gov-doclist">
            {docs.map((row) => (
              <DocLine
                key={row.key}
                kind="doc"
                name={row.name}
                meta={row.group}
                vis={row.vis}
                canRemove={canWrite && !busy && !row.lockedReason}
                removeTitle={row.lockedReason ?? (isMember ? '从事件移除（解绑，文档保留）' : '移除该参考文档')}
                confirmRemove={confirmKey === row.key}
                onConfirm={() => onConfirmChange(row.key)}
                onCancelConfirm={() => onConfirmChange(null)}
                onOpen={() => onOpen(row.group, row.name)}
                onRemove={() => { onConfirmChange(null); onRemove(row); }}
              />
            ))}
          </div>
        ) : (
          <div className="gov-empty">{emptyText}</div>
        )}
      </div>
    </section>
  );
}
