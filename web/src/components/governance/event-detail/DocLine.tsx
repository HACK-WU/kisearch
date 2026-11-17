import type { DocLineProps } from './types';

const ICON_DOC = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M4 1.8h5l3 3v9.4H4z" /><path d="M9 1.8v3h3" />
  </svg>
);
const ICON_CODE = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M5.6 4.4 2.2 8l3.4 3.6M10.4 4.4 13.8 8l-3.4 3.6" />
  </svg>
);

/**
 * 文档行（关联文档 / 参考文档 / 已确认位置共用外观）。
 * 检查点：I-01~I-09。点击热区**只有名称**；× 默认淡化，hover 才提亮。
 * 行内二次确认由父级给 `confirmRemove`（同一时刻只允许一行确认）。
 */
export function DocLine(props: DocLineProps) {
  const { kind, name, meta, vis, canRemove, removeTitle, confirmRemove, onConfirm, onCancelConfirm, onOpen, onRemove } = props;
  return (
    <div className="gov-docline">
      <span className="gov-docline__icon" aria-hidden="true">{kind === 'code' ? ICON_CODE : ICON_DOC}</span>
      <button type="button" className="gov-docline__main" onClick={onOpen} title={onOpen ? `查看「${name}」` : undefined} disabled={!onOpen}>
        <span className="gov-docline__name">{name}</span>
        {meta ? <span className="gov-docline__meta">{meta}</span> : null}
      </button>
      {vis ? (
        <span className={`gov-vis gov-vis--pill gov-vis--${vis.tone}`}>
          <span className="gov-vis__dot" aria-hidden="true" />
          {vis.text}
        </span>
      ) : null}
      <button
        type="button"
        className="gov-btn gov-btn--ghost gov-btn--sm gov-docline__x"
        disabled={!canRemove}
        title={confirmRemove ? '再点一次确认移除' : (removeTitle ?? '移除')}
        onClick={() => {
          if (confirmRemove) onRemove?.();
          else onConfirm?.();
        }}
        onBlur={() => { if (confirmRemove) onCancelConfirm?.(); }}
      >
        {confirmRemove ? '确认' : '×'}
      </button>
    </div>
  );
}
