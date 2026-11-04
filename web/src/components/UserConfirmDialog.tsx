/**
 * 用户管理 v2 通用确认弹窗（删除账号 / 撤销 Token）。
 */
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { UserDialog } from './UserDialog';

export interface UserConfirmDialogProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function UserConfirmDialog({ title, body, confirmLabel, busy, onConfirm, onClose }: UserConfirmDialogProps): JSX.Element {
  // 渲染时抓取触发元素：子 UserDialog 的 mount effect 会把焦点移进弹窗，
  // 放到 useEffect 里再抓只会抓到弹窗容器本身。
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useEffect(() => () => {
    const target = returnFocusRef.current;
    if (target && document.contains(target)) window.setTimeout(() => target.focus(), 0);
  }, []);

  return createPortal(
    <UserDialog
      title={title}
      onClose={onClose}
      busy={busy}
      className="u2-dialog--danger"
      footer={(
        <>
          <button type="button" className="ki-btn ki-btn--secondary" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="ki-btn ki-btn--danger" onClick={onConfirm} disabled={busy}>
            {busy ? '处理中…' : confirmLabel}
          </button>
        </>
      )}
    >
      {body}
    </UserDialog>,
    document.body,
  );
}
