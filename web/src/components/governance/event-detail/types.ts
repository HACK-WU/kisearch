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
  /**
   * 文档所在的**真实** Group 路径 —— 点开正文、移除都拿它当业务键。
   *
   * 禁止往这里塞展示文案（2026-11-20 教训）：参考文档卡曾把「来源库 · 组名 · 失效标记」
   * 拼进本字段，视图下点开就变成 `Group "kisearch-memory · 错误库" 未匹配到有效路径`
   * —— 视图的顶栏 scope 是视图名，与 `sourceScope` 必然不等，于是每次都拼串。
   * 展示该拼什么请用 `meta`。
   */
  group: string;
  /** 行内副标题（缺省 = `group`）。跨库来源、失效标记等只影响展示，不参与取数 */
  meta?: string;
  /** 文档实际所在库（视图模式下的跨库引用）；缺省 = 事件所属库 */
  sourceScope?: string;
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
  /** `sourceScope` 仅跨库引用（参考文档）会带，缺省 = 事件所属库 */
  onOpen: (group: string, name: string, sourceScope?: string) => void;
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
