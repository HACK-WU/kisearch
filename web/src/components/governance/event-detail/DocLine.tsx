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
 * 相对时间，与事件列表 `relTime` 同口径（超过 30 天退成 `M-D`，避免「1100 天前」）。
 *
 * 未来时间 / 时钟偏差：`min < 1` 落「刚刚」，不出现负数。
 */
function relTime(ms: number, now = Date.now()): string {
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 精确时刻（`title` 悬停用）：相对时间看不出具体哪天，必须给可核对的绝对值 */
function exactTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 文档行（关联文档 / 参考文档 / 已确认位置共用外观）。
 * 检查点：I-01~I-09。点击热区是**名称行（名称 + 紧跟的更新时间）**；× 默认淡化，hover 才提亮。
 * 行内二次确认由父级给 `confirmRemove`（同一时刻只允许一行确认）。
 *
 * `time`（2026-11-23）：行内「最近更新」列。**未知就不渲染**（老数据 / 引用失效），
 * 不显示占位符、不兜底成 now —— 空着比撒谎好。
 */
export function DocLine(props: DocLineProps) {
  const { kind, name, meta, time, vis, canRemove, removeTitle, confirmRemove, onConfirm, onCancelConfirm, onOpen, onRemove } = props;
  return (
    <div className="gov-docline">
      <span className="gov-docline__icon" aria-hidden="true">{kind === 'code' ? ICON_CODE : ICON_DOC}</span>
      <button type="button" className="gov-docline__main" onClick={onOpen} title={onOpen ? `查看「${name}」` : undefined} disabled={!onOpen}>
        <span className="gov-docline__name">{name}</span>
        {/*
         * 时间必须跟**名称同一行盒**（2026-11-23 用户拍板）：放进独立栅格列会被 1fr 推到
         * 卡片最右侧、和可见性胶囊挤在一起，看着像另一列数据；这里紧跟名称、留一点点间距。
         */}
        {typeof time === 'number' && Number.isFinite(time) ? (
          <span className="gov-docline__time" title={`最近更新 ${exactTime(time)}`}>{relTime(time)}</span>
        ) : null}
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
