/**
 * chatStoreContext —— 全局对话 store 的 React Context（REQ-20261008-001）
 *
 * 背景：chatStore 由 AppShell 创建一次并驻留（D15：面板关闭 = 隐藏不卸载，不丢对话态）。
 * 独立对话页（/chat）与右侧面板必须共享**同一个** store（A1：面板生成中切到独立页接着看），
 * 而 ChatPage 是路由组件拿不到 AppShell 的 props → 经 Context 下发。
 *
 * 注意：ChatPanel 自身仍走 props 传 store（既有契约不动）；本 Context 只服务路由级消费方。
 */

import { createContext, useContext } from 'react';
import type { ChatStore } from './chatStore';

export const ChatStoreContext = createContext<ChatStore | null>(null);

export function useChatStore(): ChatStore {
  const store = useContext(ChatStoreContext);
  if (!store) throw new Error('useChatStore 必须在 ChatStoreContext.Provider 内使用（AppShell 提供）');
  return store;
}
