/**
 * SourcesList —— 来源引用（R20）
 *
 * ═══ 契约 ═══
 * · 位置：assistant 消息**下方**；点击 → 打开原文并**高亮命中**（复用 `ModuleDrawer`
 *   既有的 `highlightQuery`，**不新建高亮机制**）
 * · 空值：`sources` 为空或 undefined → **渲染 `null`**（不显示"引用 0 处"）
 * · 行号：`lineStart === 0` → 只显示文档名（格式化逻辑在 `format.ts`，可单测）
 * · 原文已不可用（文档被删/重导覆盖）→ 打开时提示「原文已不可用」，**不报错、不隐藏该条引用**
 * · 副作用：无（点击由上游 `onOpen` 承担）
 *
 * ═══ 为什么是 chip 而不是折叠列表 ═══
 * 上一版是 `<details>`「§ 引用 N 处」，摘要要点开才看得到，与思考块、会话列表叠成三层折叠。
 * 现改为**编号 chip**：文档名与行号直接可见，摘要走悬停/聚焦预览浮层（不占对话流空间）。
 *
 * ⚠️ chip 用 `<button>` 承载（要可点击、可键盘聚焦），预览是其**子元素 span**，
 *    不得在 chip 内再放按钮 —— 交互元素不可嵌套。
 */

import type { SourceRef } from '@/api/chatContract';
import { formatLineRange } from './format';

export interface SourcesListProps {
  sources: SourceRef[];
  /** 打开原文并高亮；由上层注入（复用 ModuleDrawer 的高亮定位能力） */
  onOpen?: (ref: SourceRef) => void;
}

export function SourcesList({ sources, onOpen }: SourcesListProps): JSX.Element | null {
  // 空值契约：无来源时不渲染（不显示"引用 0 处"）
  if (!sources || sources.length === 0) return null;

  return (
    <div className="ki-chat-srcs">
      <span className="ki-chat-srcs__label">来源</span>
      {sources.map((s, i) => (
        <button
          key={`${s.group}/${s.doc}/${s.lineStart}/${i}`}
          type="button"
          className="ki-chat-src"
          onClick={onOpen ? () => onOpen(s) : undefined}
        >
          <span className="ki-chat-src__no">{i + 1}</span>
          <span className="ki-chat-src__doc">{s.doc}</span>
          {formatLineRange(s) ? <span className="ki-chat-src__lines">{formatLineRange(s)}</span> : null}

          {/* 悬停 / 键盘聚焦时的摘要预览：绝对定位，不撑开对话流；
              纯装饰信息 → aria-hidden，避免把摘要塞进按钮的可访问名称里 */}
          <span className="ki-chat-src__pop" role="tooltip" aria-hidden="true">
            <b>{s.doc}</b>
            <em>{s.group}{formatLineRange(s) ? ` · ${formatLineRange(s)}` : ''}</em>
            {s.snippet ? <q>{s.snippet}</q> : null}
            <u>打开原文并定位</u>
          </span>
        </button>
      ))}
    </div>
  );
}
