/**
 * DetailDrawer —— 详情抽屉外壳（数据源详情 / 任务详情共用，视觉基线来自数据源详情）
 *
 * 结构：头部两行（标题 + 关闭；状态 pill + 元信息）+ 可滚动正文。
 * 行为：遮罩点击关闭、Esc 由页面处理、Tab 焦点陷阱（不落到遮罩后）、打开时焦点进入关闭按钮。
 * 分区用 `DetailSection`（data / meta / action 三种材质）。
 */
import { useEffect, useRef, type JSX, type ReactNode, type RefObject } from 'react';

export type DetailStatusTone =
  | 'succeeded' | 'partial' | 'failed' | 'running' | 'queued' | 'cancelled' | 'never' | 'unknown';

export interface DetailStatusView {
  tone: DetailStatusTone;
  label: string;
}

export function DetailStatus({ tone, label }: DetailStatusView): JSX.Element {
  return (
    <span className={`ki-detail__status ki-detail__status--${tone}`}>
      <span className="ki-detail__status-dot" aria-hidden />
      {label}
    </span>
  );
}

export interface DetailSectionProps {
  title: ReactNode;
  /** 数据区（主结果）/ 参数区（键值）/ 操作区（后续动作、危险操作） */
  material?: 'data' | 'meta' | 'action';
  hint?: ReactNode;
  /** 标题行右侧的额外操作（如「展开全部 / 折叠全部」） */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function DetailSection({ title, material = 'meta', hint, actions, className, children }: DetailSectionProps): JSX.Element {
  const classes = [
    'ki-detail-sec',
    `ki-detail-sec--${material}`,
    className ?? '',
  ].filter(Boolean).join(' ');
  return (
    <section className={classes}>
      <div className="ki-detail-sec__head">
        <span className="ki-detail-sec__mark" aria-hidden />
        <h3 className="ki-detail-sec__title">{title}</h3>
        {hint ? <span className="ki-detail-sec__hint">{hint}</span> : null}
        {actions ? <div className="ki-detail-sec__actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export interface DetailDrawerProps {
  ariaLabel: string;
  title: ReactNode;
  status?: DetailStatusView | null;
  /** 第二行状态 pill 右侧的元信息（id / 来源 / 时间） */
  meta?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** 透传到 aside 的 data-* 属性（如 `data-task-detail-id`） */
  dataAttributes?: Record<string, string>;
  /** 外部需要把焦点还给关闭按钮时传入（如数据源删除后复位） */
  closeRef?: RefObject<HTMLButtonElement>;
}

export function DetailDrawer({
  ariaLabel,
  title,
  status,
  meta,
  onClose,
  children,
  dataAttributes,
  closeRef,
}: DetailDrawerProps): JSX.Element {
  const drawerRef = useRef<HTMLElement>(null);

  /**
   * 焦点陷阱：抽屉是 aria-modal，Tab 不能落到遮罩后的列表。
   * 折叠的 <details> 内容仍有尺寸但 focus() 无效，摘要本身始终可见，故只放行 summary。
   */
  useEffect(() => {
    const root = drawerRef.current;
    if (!root) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
        + 'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )).filter((element) => {
        if (element.tagName !== 'SUMMARY' && element.closest('details:not([open])')) return false;
        return element.offsetWidth > 0 || element.offsetHeight > 0 || element === document.activeElement;
      });
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !root.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <div className="ki-detail__scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={drawerRef}
        className="ki-detail"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        {...dataAttributes}
      >
        <header className="ki-detail__head">
          <div className="ki-detail__row">
            <h2 className="ki-detail__title" title={typeof title === 'string' ? title : undefined}>{title}</h2>
            <button
              ref={closeRef}
              type="button"
              className="ki-detail__close"
              aria-label="关闭详情"
              autoFocus
              onClick={onClose}
            >✕</button>
          </div>
          {status || meta ? (
            <div className="ki-detail__meta-row">
              {status ? <DetailStatus {...status} /> : null}
              {meta ? <div className="ki-detail__meta">{meta}</div> : null}
            </div>
          ) : null}
        </header>
        <div className="ki-detail__body">{children}</div>
      </aside>
    </>
  );
}
