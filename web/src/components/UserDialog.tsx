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

  useEffect(() => {
    const root = dialogRef.current;
    if (!root) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
        + 'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      )).filter((element) => (
        !element.closest('[hidden]')
        && (element.offsetWidth > 0 || element.offsetHeight > 0 || element === document.activeElement)
      ));
      if (focusables.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, []);

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
