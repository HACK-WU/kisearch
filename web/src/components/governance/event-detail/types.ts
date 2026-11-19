import type { ReactNode } from 'react';
import type { AnalysisDraft, ConfirmedCodeLocation, EventView } from '@/api/governanceApi';

/**
 * 事件详情页卡片族的展示层契约（2026-11-17 改版 · 批 1）。
 *
 * 约定：
 * - 展示组件**不取数、不调接口**，只收 props（数据与动作在 `EventsPage.tsx`）。
 * - `canWrite`（knowledge.write）与 `canAsk`（knowledge.ask）必须分开传，
 *   否则只读角色（viewer 有 ask 无 write）会连追问都被挡。
 * - 阶段线与可见性提示条由页面渲染后以 `stageSlot` 传入，避免把事件类型计算搬进展示组件。
 */
export type VisTone = 'full' | 'fts' | 'hidden';

export interface DocRow {
  /** 行唯一键（`${group}\u0000${name}`） */
  key: string;
  name: string;
  group: string;
  vis?: { tone: VisTone; text: string };
  /** 不可操作原因（如文档已进回收站） */
  lockedReason?: string;
}

export interface EventSummaryCardProps {
  event: EventView;
  typeName: string;
  stageName: string;
  memberCount: number;
  refCount: number;
  closed: boolean;
  /** 已置顶（pinnedAt 有值）：决定按钮文案与 aria-pressed（2026-11-19） */
  pinned: boolean;
  canWrite: boolean;
  busy: boolean;
  delConfirm: boolean;
  descEdit: { open: boolean; draft: string; saving: boolean };
  /** 阶段线 + 可见性提示条（页面渲染） */
  stageSlot?: ReactNode;
  /** C-15：未分析态入口引导（`draft === null && confirmed.length === 0`） */
  showAnalyzeGuide: boolean;
  onAnalyze: () => void;
  /** 置顶 / 取消置顶（2026-11-19）：置顶项不受列表筛选与排序影响 */
  onTogglePin: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onTransition: () => void;
  onDescEdit: () => void;
  onDescChange: (value: string) => void;
  onDescSave: () => void;
  onDescCancel: () => void;
}

export interface EventDocsCardProps {
  mode: 'member' | 'ref';
  docs: DocRow[];
  canWrite: boolean;
  busy: boolean;
  /** 关联文档：可见性随阶段变化；参考文档：随文档自身 */
  hint: string;
  /** 参考文档卡的右侧动作（AI 查找 / 添加） */
  actions?: ReactNode;
  /** 卡内提示条（如「索引未摘除」告警），渲染在列表上方 */
  notice?: ReactNode;
  /** 卡内执行面板（参考文档卡的 AI 查找），渲染在提示条之后、列表之前 */
  panel?: ReactNode;
  emptyText: string;
  /** 行内二次确认的 key（全局唯一，同一时刻只有一行进入确认态） */
  confirmKey: string | null;
  onConfirmChange: (key: string | null) => void;
  onOpen: (group: string, name: string) => void;
  onRemove: (row: DocRow) => void;
}

export interface DocLineProps {
  kind: 'doc' | 'code';
  name: string;
  meta?: string;
  vis?: { tone: VisTone; text: string };
  canRemove: boolean;
  removeTitle?: string;
  confirmRemove: boolean;
  onConfirm?: () => void;
  onCancelConfirm?: () => void;
  onOpen?: () => void;
  onRemove?: () => void;
}

/** 代码位置行（快照展开在批 4 接入，本批只保留契约） */
export interface CodeLocRowProps {
  loc: ConfirmedCodeLocation;
  open: boolean;
  onToggle: () => void;
  canRemove: boolean;
  onRemove: () => void;
}

/** 分析卡的 props 需要 `conclusion` 与 ask 记录类型，随批 2 / 批 6 定稿（见 DESIGN §3.5） */
export type AnalysisCardPlaceholder = {
  draft: AnalysisDraft | null;
  confirmed: ConfirmedCodeLocation[];
};
