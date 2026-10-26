/**
 * Notice —— 提示信息卡片（视觉参考库 `ui-tools/design-reference/components/notice.html`，v1.0.0）
 *
 * 结构与语气色阶见参考库 spec：图标 + 标题 + 正文（+ 可选操作/关闭）。
 * 颜色只做语气，语义由图标与文字承担（不只靠颜色）。
 */
import type { JSX, ReactNode } from 'react';
import { Icon } from '@/components/icons';

export type NoticeTone = 'info' | 'success' | 'warn' | 'danger';

const TONE_ICON: Record<NoticeTone, string> = {
  info: 'info',
  success: 'check-circle',
  warn: 'warn',
  danger: 'x-circle',
};

export interface NoticeProps {
  tone: NoticeTone;
  /** 结论行（可选）；无标题时正文升为正文色 */
  title?: string;
  children: ReactNode;
  /** 单行形态：卡片内补充说明 / 表格行内 */
  slim?: boolean;
  className?: string;
}

export function Notice({ tone, title, children, slim = false, className }: NoticeProps): JSX.Element {
  const classes = [
    'ki-notice',
    `ki-notice--${tone}`,
    slim ? 'ki-notice--slim' : '',
    className ?? '',
  ].filter(Boolean).join(' ');
  return (
    <div className={classes} role={tone === 'warn' || tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={TONE_ICON[tone]} className="ki-notice__icon" />
      <div className="ki-notice__body">
        {title ? <p className="ki-notice__title">{title}</p> : null}
        <div className="ki-notice__text">{children}</div>
      </div>
    </div>
  );
}
