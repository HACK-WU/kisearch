/**
 * chat 面板的纯格式化逻辑（**与视图分离**，便于单测）
 *
 * 为什么要单独成文件：放在 `.tsx` 里会导致逻辑无法被 Node 侧的验收测试 import
 * （需要 JSX 转换）。本文件是**纯 TS、无副作用**，可直接单测。
 */

// ⚠️ 必须用**相对路径**：本模块被 node 侧验收测试（jiti）直接 import，
//    而 jiti 不认 `@/` 别名 —— 值导入（非 type-only）用别名会在测试环境解析失败。
//    `acceptance-sr02.test.ts` 正是通过本模块读取 `DEGRADED_LABELS` 的。
import type { SourceRef } from '../api/chatContract';

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
 *
 * ★ **唯一来源 = `chatContract.ts`**（该文件自述"前端唯一来源，避免多处硬编码不一致"）。
 *   本处改为**再导出**，消除此前的第二份副本（两份逐字相同 → 任一侧改动都会静默漂移）。
 *   保留从本模块导出的形式，以免改动既有 import 点（`SourcesList` / `acceptance-sr02`）。
 */
export { DEGRADED_LABELS } from '../api/chatContract';

/** 来源引用的标题（`group / doc / 行号`），行号缺失时省略该段 */
export function sourceRefTitle(ref: SourceRef): string {
  const lines = formatLineRange(ref);
  return lines ? `${ref.doc} · ${ref.group} · ${lines}` : `${ref.doc} · ${ref.group}`;
}
