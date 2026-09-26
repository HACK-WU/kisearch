/**
 * ConversationList —— 会话列表（最近 / 已归档）与「新建会话」入口
 *
 * ═══ 为什么需要它 ═══
 * 设计 `S03` 明确要求 `ConversationList.tsx`（会话列表抽屉，见 S-04），但骨架期未生成、
 * 实现期也未补 → `activeConvId` 恒为 `null`，`stream.send('')` 打到
 * `/api/chat/conversations//messages`，面板**端到端不可用**。本组件补上这一环。
 *
 * ═══ 契约 ═══
 * · 纯视图：不持有业务状态（列表数据与选中态由 `ChatPanel` 持有并注入）
 * · 空值：无会话 → 只显示「新建会话」按钮（不算错误）
 * · `corrupted: true` 的会话仍列出（后端已降级为该条标记），但点击提示不可用
 * · 点击 → `onSelect(id)`；由上层负责「先 abort 进行中的流，再切会话」
 *
 * @see design/S03_前端对话面板与流式对话_DESIGN.md §9 · api/conversations.md
 */

import type { ConversationSummary } from '@/api/chatContract';

export interface ConversationListProps {
  items: ConversationSummary[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  /** 切换会话（上层负责 abort 进行中的流） */
  onSelect: (id: string) => void;
  /** 新建会话并切换过去 */
  onCreate: () => void;
  /** 重新拉取列表 */
  onRefresh: () => void;
}

/** 列表项的标题：标题为空时用末条预览兜底（都不为空时不显示） */
function itemTitle(c: ConversationSummary): string {
  if (c.title && c.title.trim()) return c.title;
  if (c.lastMessagePreview && c.lastMessagePreview.trim()) return c.lastMessagePreview;
  return '（空会话）';
}

export function ConversationList({
  items,
  activeId,
  loading,
  error,
  onSelect,
  onCreate,
  onRefresh,
}: ConversationListProps): JSX.Element {
  return (
    <details className="ki-chat-convs">
      <summary>
        会话（{items.length}）
        {loading ? <span className="ki-chat-convs__loading">读取中…</span> : null}
      </summary>

      <div className="ki-chat-convs__body">
        <div className="ki-chat-convs__actions">
          <button type="button" className="ki-chat-convs__new" onClick={onCreate}>
            新建会话
          </button>
          <button type="button" className="ki-chat-convs__refresh" onClick={onRefresh}>
            刷新
          </button>
        </div>

        {error ? (
          <p className="ki-chat-convs__err" role="alert">
            {error}
          </p>
        ) : null}

        {!loading && items.length === 0 ? (
          <p className="ki-chat-convs__empty">还没有会话，发送第一条消息即可开始。</p>
        ) : null}

        <ul className="ki-chat-convs__list">
          {items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`ki-chat-convs__item${c.id === activeId ? ' ki-chat-convs__item--active' : ''}`}
                aria-current={c.id === activeId ? 'true' : undefined}
                disabled={c.corrupted}
                title={c.corrupted ? '该会话文件已损坏，无法打开' : itemTitle(c)}
                onClick={() => onSelect(c.id)}
              >
                <span className="ki-chat-convs__title">{itemTitle(c)}</span>
                <span className="ki-chat-convs__meta">
                  {c.corrupted ? '已损坏' : `${c.messageCount} 条`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
