/**
 * chat 面板的纯格式化逻辑（**与视图分离**，便于单测）
 *
 * 为什么要单独成文件：放在 `.tsx` 里会导致逻辑无法被 Node 侧的验收测试 import
 * （需要 JSX 转换）。本文件是**纯 TS、无副作用**，可直接单测。
 */

import type { DegradedReason, SourceRef } from '@/api/chatContract';

/**
 * 行号区间显示。
 *
 * ★ 契约：`lineStart === 0` 表示"只能定位到文档级"（chunk fallback 无法映射）
 *   → 返回空串，**不得显示 "0-0"**（S07 §3.5 / api/retrieval.md §1.3）
 */
export function formatLineRange(ref: Pick<SourceRef, 'lineStart' | 'lineEnd'>): string {
  if (!ref.lineStart || ref.lineStart <= 0) return '';
  if (!ref.lineEnd || ref.lineEnd === ref.lineStart) return `L${ref.lineStart}`;
  return `L${ref.lineStart}-${ref.lineEnd}`;
}

/**
 * 降级原因 → 用户可见文案。
 *
 * ★ 契约：`degraded` **必须可见，不得静默**（N17）——用户看不到标记就会把
 *   "没检索"当成"检索了但没找到"。
 */
export const DEGRADED_LABELS: Record<DegradedReason, string> = {
  'tools-unsupported': '本次未使用工具检索',
  'retrieval-unavailable': '本次未检索',
  'semantic-degraded': '语义检索降级为全文',
};

/** 来源引用的标题（`group / doc / 行号`），行号缺失时省略该段 */
export function sourceRefTitle(ref: SourceRef): string {
  const lines = formatLineRange(ref);
  return lines ? `${ref.doc} · ${ref.group} · ${lines}` : `${ref.doc} · ${ref.group}`;
}
