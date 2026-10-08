/**
 * ChatPage —— 独立对话页（/chat，REQ-20261008-001）
 *
 * 职责极薄：
 * · 从 ChatStoreContext 取 AppShell 级 store（与右侧面板**共享同一个 store**，
 *   A1：面板生成中切到独立页接着看，切路由不断流）；
 * · 渲染 ChatPanel 的 page 宽体变体（左栏常驻会话列表 + 对话列 880px 居中）；
 * · 给 `.ki-content` 挂 noscroll（双栏高度链与浏览页同款：外层不滚、栏内各自滚）。
 *
 * 会话深链 `/chat/:convId` 的双向同步在 ChatPanel 内部（URL 契约见 design/ui-design.md §2.4）。
 */

import { useEffect } from 'react';
import { ChatPanel } from '@/chat/ChatPanel';
import { useChatStore } from '@/chat/chatStoreContext';

export function ChatPage(): JSX.Element {
  const store = useChatStore();

  // 双栏工作台模式：禁止外层 .ki-content 滚动，让对话页内部各自滚动（同 BrowsePage 做法）
  useEffect(() => {
    const el = document.querySelector('.ki-content');
    if (el) el.classList.add('ki-content--noscroll');
    return () => { el?.classList.remove('ki-content--noscroll'); };
  }, []);

  // page 变体恒 open；page 无关闭按钮，onClose 不会被触发，传 noop 满足契约
  return (
    <div className="ki-chatpage-host">
      <ChatPanel store={store} open onClose={() => undefined} variant="page" />
    </div>
  );
}
