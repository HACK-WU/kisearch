/**
 * 用户管理 v2 通用确认弹窗（删除账号 / 撤销 Token）。
 */
import type { JSX, ReactNode } from 'react';
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
