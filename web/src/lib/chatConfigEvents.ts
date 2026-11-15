/**
 * 对话配置变更的跨组件通知（2026-11-15）
 *
 * 背景：AI 设置从「对话面板内的覆盖层」搬到独立页面后，**保存方与消费方分居两处** ——
 * 保存发生在 `/settings/ai`，而消费方 `ChatPanel` 是常驻不卸载的（D15：关闭 = 隐藏不卸载），
 * 它只在挂载时 GET 一次 `/api/chat/config`。于是「在设置页改完上下文窗口」后，
 * 面板的占比分母（`config.contextChars`）会一直用旧值，直到整页刷新。
 *
 * 为什么用事件而不是把它塞进 store / context：
 *   · 面板与设置页**不在同一棵子树**（面板在 AppShell，设置页在 Outlet 里），props 够不着；
 *   · 只有一个布尔语义（"配置变了，重拉一次"），为它引入 store 字段或 context 是过度设计；
 *   · `refreshConfig` 本就是幂等的 GET，重复通知没有副作用。
 */

export const CHAT_CONFIG_SAVED_EVENT = 'ki:chat-config-saved';

/** 保存成功方调用（当前仅 AI 设置页） */
export function emitChatConfigSaved(): void {
  window.dispatchEvent(new Event(CHAT_CONFIG_SAVED_EVENT));
}

/** 消费方订阅；返回解除函数（供 useEffect 清理） */
export function onChatConfigSaved(handler: () => void): () => void {
  window.addEventListener(CHAT_CONFIG_SAVED_EVENT, handler);
  return () => window.removeEventListener(CHAT_CONFIG_SAVED_EVENT, handler);
}
