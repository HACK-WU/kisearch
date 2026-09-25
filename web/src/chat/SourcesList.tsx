/**
 * SourcesList —— 来源引用列表（R20）
 *
 * ═══ 契约 ═══
 * · 位置：assistant 消息**下方**；折叠态「引用 N 处」，展开显示 `group / 文档名 / 行号区间 / 摘要`
 * · 点击 → 打开原文并**高亮命中**：复用既有能力
 *   （`ModuleDrawer.tsx` + `MarkdownPreview.tsx` + `SearchPage.tsx` 已实现"正文命中高亮 +
 *   首个命中定位 + 循环下一个命中"），**不新建高亮机制**
 * · 空值：`sources` 为空或 undefined → **渲染 `null`**（不显示"引用 0 处"）
 * · 行号：`lineStart === 0` → 只显示文档名（格式化逻辑在 `format.ts`，可单测）
 * · 原文已不可用（文档被删/重导覆盖）→ 打开时提示「原文已不可用」，**不报错、不隐藏该条引用**
 * · 副作用：无（点击由上游 `onOpen` 承担）
 *
 * ═══ 骨架期说明 ═══
 * 在首屏渲染路径上 → 渲染占位（不抛错）；交互（点击打开）由 `onOpen` 实现方承担。
 *
 * @see design/S03_前端对话面板与流式对话_DESIGN.md §9.2 · requirement.md R20
 */

import type { SourceRef } from '@/api/chatContract';
import { formatLineRange, sourceRefTitle } from './format';

export interface SourcesListProps {
  sources: SourceRef[];
  /** 打开原文并高亮；由上层注入（复用 ModuleDrawer 的高亮定位能力） */
  onOpen?: (ref: SourceRef) => void;
}

export function SourcesList({ sources, onOpen }: SourcesListProps) {
  // 空值契约：无来源时不渲染（不显示"引用 0 处"）
  if (!sources || sources.length === 0) return null;

  return (
    <details className="ki-chat-sources" data-stub="SR-02:SourcesList">
      <summary>引用 {sources.length} 处</summary>
      <ul>
        {sources.map((s, i) => (
          <li key={`${s.group}/${s.doc}/${s.lineStart}/${i}`}>
            <button
              type="button"
              title={sourceRefTitle(s)}
              onClick={onOpen ? () => onOpen(s) : undefined}
            >
              <span className="ki-chat-sources__doc">{s.doc}</span>
              {formatLineRange(s) ? (
                <span className="ki-chat-sources__lines">{formatLineRange(s)}</span>
              ) : null}
            </button>
            {s.snippet ? <p className="ki-chat-sources__snippet">{s.snippet}</p> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
