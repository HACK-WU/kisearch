/**
 * chatStoreContext —— 全局对话 store 的 React Context（REQ-20261008-001）
 *
 * 背景：chatStore 由 AppShell 创建一次并驻留（D15：面板关闭 = 隐藏不卸载，不丢对话态）。
 * 独立对话页（/chat）与右侧面板必须共享**同一个** store（A1：面板生成中切到独立页接着看），
 * 而 ChatPage 是路由组件拿不到 AppShell 的 props → 经 Context 下发。
 *
 * 注意：ChatPanel 自身仍走 props 传 store（既有契约不动）；本 Context 只服务路由级消费方。
 */

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { ChatStore } from './chatStore';

export const ChatStoreContext = createContext<ChatStore | null>(null);

export function useChatStore(): ChatStore {
  const store = useContext(ChatStoreContext);
  if (!store) throw new Error('useChatStore 必须在 ChatStoreContext.Provider 内使用（AppShell 提供）');
  return store;
}

/**
 * 面板开合态（REQ-20261009-002 需求 A）。
 *
 * 为什么收敛到 store：全屏阅读器内的「AI 对话」开关与顶栏开关分处两个组件树分支，
 * props 够不着；`chatStore.open` 此前是无人消费的死状态。
 *
 * 只订阅 `open` 一个字段：流式推进时 getSnapshot 返回值恒等（Object.is），
 * 消费者不会因为每个 chunk 而重渲染。
 */
export function useChatToggle(): {
  open: boolean;
  toggle: () => void;
  setOpen: (next: boolean) => void;
} {
  const store = useChatStore();
  const open = useSyncExternalStore(store.subscribe, () => store.getState().open);
  const setOpen = useCallback(
    (next: boolean) => {
      store.dispatch({ type: 'setOpen', open: next });
    },
    [store],
  );
  const toggle = useCallback(() => {
    // 用 getState 读现值而非闭包 open：同一帧内连点两次不会都按旧值取反
    store.dispatch({ type: 'setOpen', open: !store.getState().open });
  }, [store]);
  return { open, toggle, setOpen };
}
