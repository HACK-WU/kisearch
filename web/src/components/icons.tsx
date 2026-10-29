/**
 * icons.tsx —— 内联 SVG 图标表（对齐 v2 demo symbol 表：24 视框、1.8px 描边、
 * stroke 取 currentColor，尺寸由 CSS `.ki-icon` / `.ki-icon--sm` 控制）。
 *
 * 用法：<Icon name="grid" />（导航）；<Icon name="x" className="ki-icon ki-icon--sm" />
 */
import type { JSX } from 'react';

const PATHS: Record<string, JSX.Element> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  book: (
    <>
      <path d="M4 4.8A2.8 2.8 0 0 1 6.8 2H20v17H6.8A2.8 2.8 0 0 0 4 21.8z" />
      <path d="M4 19.5A2.8 2.8 0 0 1 6.8 17H20" />
      <path d="M8 7h8M8 11h6" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.8" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  upload: <path d="M12 16V3m0 0L7.5 7.5M12 3l4.5 4.5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />,
  edit: <path d="m4 20 4.5-1 10.8-10.8-3.5-3.5L5 15.5zM14.8 5.8l3.5 3.5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  // REQ-20261020-001：数据源（库/数据盘意象）
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  // 资源（MCP 接入 / Skill 安装）：指南针意象
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  check: <path d="m5 13 4.5 4.5L19 7" />,
  // 提示信息卡片语义图标（Notice 组件用）
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <circle cx="12" cy="7.6" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.4 2.7 2.7 4.9-5.6" />
    </>
  ),
  'x-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
    </>
  ),
  warn: (
    <>
      <path d="M12 4 2.5 20h19z" />
      <path d="M12 10v4M12 17.5v.5" />
    </>
  ),
  'chevron-left': <path d="m14 6-6 6 6 6" />,
  collapse: <path d="m6 17 6-6 6 6M6 11l6-6 6 6" />,
  expand: <path d="m6 7 6 6 6-6m-12 6 6 6 6-6" />,
  x: <path d="M5 5 19 19M19 5 5 19" />,
  dash: <path d="M6 12h12" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  refresh: <path d="M20 11a8 8 0 1 0-2.2 6.7M20 4v7h-7" />,
  folder: (
    <path d="M3 6.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  ),
  file: (
    <>
      <path d="M13 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V11z" />
      <path d="M13 3v8h8M7.5 15h9M7.5 18h6" />
    </>
  ),
  /** 「在页内打开」：左侧文档 + 右侧展开箭头（区别于全屏 / 外部链接） */
  'open-inline': (
    <>
      <path d="M4 4.5h8.5v15H4z" />
      <path d="M13.5 12h7m-3.2-3.2L20.5 12l-3.2 3.2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  code: <path d="m9 18-6-6 6-6m6-2-4 16m10-8-6 6-6-6" />,
  chat: (
    <>
      <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 3V11.5a9 9 0 0 1 18 0Z" />
      <path d="M7 11h.01M11 11h.01M15 11h.01" strokeWidth="3" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'ki-icon' }: { name: string; className?: string }): JSX.Element | null {
  const path = PATHS[name];
  if (!path) return null;
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      {path}
    </svg>
  );
}
