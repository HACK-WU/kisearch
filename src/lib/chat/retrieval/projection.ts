/**
 * 检索结果投影（S07 §3.5）
 *
 * ═══ 两种投影，用途不同，**不可混用** ═══
 * | 投影 | 给谁看 | 落盘 | 用途 |
 * |------|-------|:---:|------|
 * | `ToolProjection` | **模型** | ❌ | 进上游上下文（瘦身） |
 * | `SourceRef[]` | **人** | ✅ | 引用列表，点击回原文 |
 *
 * ═══ 通用语义契约 ═══
 * · 前置：入参为 `executeSearch` 的原始返回
 * · 空值：`ok:false` 或无命中 → 返回空结构（**不抛错**）
 * · 幂等：是（纯函数）
 * · 副作用：无（**不落盘、不调模型**）
 * · 确定性：同输入同输出（排序保持 `executeSearch` 返回顺序，**不自作排序**）
 *
 * ═══ 两条硬约束 ═══
 * 1. **原始检索结果不进上游、不落盘**（N22）—— 只出投影
 * 2. `SourceRef.lineStart === 0` 表示"只能定位到文档级"（chunk fallback 无法映射），
 *    此时 UI **不得显示 "0-0"**，只显示文档名
 *
 * @see design/S07_检索与工具调用_DESIGN.md §3.5
 */

import type { SearchResult } from '../../../search.js';
import { CHAT_BUDGET, type SourceRef } from '../chat-contract.js';

/** 进上游上下文的瘦身投影（工具返回值，给模型看） */
export interface ToolProjection {
  hits: Array<{
    group: string;
    /** = SearchHit.relation（文档名） */
    doc: string;
    /** `"12-18"`（1-based，含端）；无法映射时为 `"?"` */
    lines: string;
    /** ≤ `CHAT_BUDGET.snippetChars` */
    snippet: string;
  }>;
  /** 命中总数（`SearchResult.total ?? hits.length`） */
  total: number;
  /** 如 `"仅返回前 5 条"` / `"语义检索降级为全文"` */
  note?: string;
}

/**
 * `SearchResult` → 模型可见投影。
 *
 * · 条数：取前 `CHAT_BUDGET.maxHitsPerCall` 条
 * · 去重：同 `(group, doc, lineStart)` 去重（多 tag 会产生重复命中）
 * · 降级透传：`result.degraded === true` → `note` 追加「语义检索降级为全文」
 *   （**并发 `degraded` 事件，不让用户误以为用了语义检索**）
 */
export function toToolProjection(result: SearchResult, budget = CHAT_BUDGET): ToolProjection {
  throw new Error(`STUB:SR-01:toToolProjection`);
}

/**
 * `SearchResult` → 落盘来源引用。
 *
 * · `snippet` 截断至 `CHAT_BUDGET.sourceSnippetChars`（200）
 * · 行号缺失 → `lineStart = lineEnd = 0`（文档级定位）
 * · **同一结果可同时产出两种投影**（调用方各取所需）
 */
export function toSourceRefs(result: SearchResult, budget = CHAT_BUDGET): SourceRef[] {
  throw new Error(`STUB:SR-01:toSourceRefs`);
}
