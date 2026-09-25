/**
 * ChatPanel —— 右侧常驻对话面板（**视图**）
 *
 * ═══ ★ 两条硬约束（D15）═══
 * 1. **关闭 = 隐藏，不卸载、不中止生成**：本组件在 `open === false` 时返回 `null`
 *    （组件仍在树中，**未卸载**），且状态全在 `chatStore`（AppShell 级）→ 不丢内容
 * 2. **本组件不持有业务状态**：所有状态从 `store` 读；组件只是视图
 *
 * ═══ 骨架期说明 ═══
 * 本组件在骨架期渲染**占位 UI**（不抛错）——因为它在**首屏渲染路径**上，
 * 抛错会导致整个 AppShell 白屏（主干"可编译但不可用"）。
 * 业务动作（发送/检索/生成）的抛错点在 `useChatStream`。
 *
 * ═══ 布局契约（S03）═══
 * · 落位：`ki-shell`（flex 容器）的新 flex 子项，插在 `ki-main` **之后**
 * · 宽度：360~420px；窄屏降级为浮层抽屉（阈值待前置门② 的真实基线补测）
 * · `ki-main` 已是 `flex:1; min-width:0` → 不会破坏现有页面
 * · 全屏阅读器（`ki-drawer--fullscreen`）打开时**自动收起**本面板（避免空间与层级冲突）
 *
 * @see design/S03_前端对话面板与流式对话_DESIGN.md
 */

import type { ChatStore } from './chatStore';
import { SourcesList } from './SourcesList';

export interface ChatPanelProps {
  store: ChatStore;
  /** 由 AppShell 控制（对应顶部开关按钮，D15） */
  open: boolean;
}

export function ChatPanel({ store, open }: ChatPanelProps) {
  // ★ 隐藏而非卸载：返回 null 不触发组件卸载，store 状态与进行中的流均保留
  if (!open) return null;

  const state = store.getState();

  return (
    <aside className="ki-chat-panel" data-stub="SR-02:ChatPanel" aria-label="AI 对话面板">
      <header className="ki-chat-panel__head">
        <span>AI 对话</span>
      </header>

      <div className="ki-chat-panel__body">
        <p role="status">
          对话面板 · 骨架期占位（未实现）
        </p>
        <p className="ki-chat-panel__hint">
          当前会话：{state.activeConvId ?? '（未选择）'}
        </p>
        {/* 来源引用列表（R20）—— 骨架期渲染占位 */}
        <SourcesList sources={[]} onOpen={undefined} />
      </div>
    </aside>
  );
}
