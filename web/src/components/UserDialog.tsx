/**
 * 用户管理 v2 弹窗外壳：遮罩关闭 / Esc / 初始焦点 / 宽度变体。
 */
import { useEffect, useRef, type JSX, type ReactNode } from 'react';

export interface UserDialogProps {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  danger?: boolean;
  /** 覆盖默认宽度类（默认 min(680px, 100vw-32px)） */
  className?: string;
}

export function UserDialog({
  title,
  children,
  footer,
  onClose,
  busy = false,
  wide = false,
  className,
}: UserDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const classes = [
    'ki-dialog',
    'u2-dialog',
    wide ? 'u2-dialog--edit' : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className="ki-overlay ki-overlay--show ki-overlay--front"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={classes}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="ki-dialog__head">
          <h3 className="ki-dialog__title" title={title}>{title}</h3>
          <button type="button" className="ki-dialog__close" aria-label={`关闭${title}`} onClick={onClose} disabled={busy}>✕</button>
        </header>
        <div className="u2-dialog__body">{children}</div>
        {footer ? <footer className="ki-dialog__foot">{footer}</footer> : null}
      </section>
    </div>
  );
}
