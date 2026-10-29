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

/** 检索不可用 / 无命中的统一空投影 */
function emptyProjection(): ToolProjection {
  return { hits: [], total: 0 };
}

/** 从命中的原文片段 / 已有摘录取可展示文本 */
function snippetOf(hit: SearchResult extends { ok: true; results: Array<infer H> } ? H : never, maxChars: number): string {
  const h = hit as {
    originalExcerpt?: string;
    original?: string;
    matches?: Array<{ excerpt?: string }>;
  };
  // 优先级：originalExcerpt（已拼接命中片段）→ 首个 match.excerpt → original（原文，可能很长，截断）
  const raw = h.originalExcerpt
    ?? h.matches?.[0]?.excerpt
    ?? h.original
    ?? '';
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxChars ? oneLine.slice(0, maxChars) : oneLine;
}

/** 取行号区间（1-based，含端）；缺失时返回 null（由调用方决定降级表示） */
function linesOf(hit: unknown): { lineStart: number; lineEnd: number } | null {
  const h = hit as { lineStart?: number; lineEnd?: number; matches?: Array<{ lineStart?: number; lineEnd?: number }> };
  const start = typeof h.lineStart === 'number' && h.lineStart > 0
    ? h.lineStart
    : (typeof h.matches?.[0]?.lineStart === 'number' && (h.matches[0].lineStart as number) > 0
      ? (h.matches[0].lineStart as number)
      : undefined);
  if (start === undefined) return null;
  const end = typeof h.lineEnd === 'number' && h.lineEnd >= start
    ? h.lineEnd
    : (typeof h.matches?.[0]?.lineEnd === 'number' && (h.matches[0].lineEnd as number) >= start
      ? (h.matches[0].lineEnd as number)
      : start);
  return { lineStart: start, lineEnd: end };
}

/** 去重键：同 `(group, doc, lineStart)` 视为重复（多 tag 会产生重复命中） */
function dedupeKey(hit: unknown, lines: { lineStart: number } | null): string {
  const h = hit as { group?: string; relation?: string };
  return `${h.group ?? ''}\u0000${h.relation ?? ''}\u0000${lines ? lines.lineStart : 0}`;
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
  // 空值：ok:false 或无命中 → 空结构，不抛错
  if (!result || result.ok !== true) return emptyProjection();
  const results = Array.isArray(result.results) ? result.results : [];
  if (results.length === 0) {
    // 无命中：仍透传 degraded 标记（语义侧降级可能伴随 0 命中）
    const note = result.degraded === true ? '语义检索降级为全文' : undefined;
    return note ? { hits: [], total: result.total ?? 0, note } : { hits: [], total: 0 };
  }

  const maxHits = budget.maxHitsPerCall;
  const seen = new Set<string>();
  const hits: ToolProjection['hits'] = [];
  let truncated = false;

  for (const hit of results) {
    const lines = linesOf(hit);
    const key = dedupeKey(hit, lines);
    if (seen.has(key)) continue;
    seen.add(key);
    if (hits.length >= maxHits) {
      truncated = true;
      break;
    }
    const h = hit as { group?: string; relation?: string };
    hits.push({
      group: h.group ?? '',
      doc: h.relation ?? '',
      lines: lines ? `${lines.lineStart}-${lines.lineEnd}` : '?',
      snippet: snippetOf(hit as never, budget.snippetChars),
    });
  }

  const notes: string[] = [];
  if (truncated || results.length > hits.length) notes.push(`仅返回前 ${maxHits} 条`);
  if (result.degraded === true) notes.push('语义检索降级为全文');

  const total = result.total ?? results.length;
  const projection: ToolProjection = { hits, total };
  if (notes.length > 0) projection.note = notes.join('；');
  return projection;
}

/**
 * `SearchResult` → 落盘来源引用。
 *
 * · `snippet` 截断至 `CHAT_BUDGET.sourceSnippetChars`（200）
 * · 行号缺失 → `lineStart = lineEnd = 0`（文档级定位）
 * · **同一结果可同时产出两种投影**（调用方各取所需）
 */
export function toSourceRefs(result: SearchResult, budget = CHAT_BUDGET): SourceRef[] {
  if (!result || result.ok !== true) return [];
  const results = Array.isArray(result.results) ? result.results : [];
  if (results.length === 0) return [];

  const maxHits = budget.maxHitsPerCall;
  const seen = new Set<string>();
  const refs: SourceRef[] = [];

  for (const hit of results) {
    const lines = linesOf(hit);
    const key = dedupeKey(hit, lines);
    if (seen.has(key)) continue;
    seen.add(key);
    if (refs.length >= maxHits) break;

    const h = hit as { group?: string; relation?: string };
    refs.push({
      group: h.group ?? '',
      doc: h.relation ?? '',
      // ★ 行号缺失 → 0（UI 不得显示 "0-0"，只显示文档名）
      lineStart: lines ? lines.lineStart : 0,
      lineEnd: lines ? lines.lineEnd : 0,
      snippet: snippetOf(hit as never, budget.sourceSnippetChars),
    });
  }

  return refs;
}
