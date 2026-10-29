/**
 * ChatToggleButton —— 全屏阅读器内的「AI 对话」开关（REQ-20261009-002 需求 A / R2）
 *
 * 为什么需要它：全屏阅读器是 `position: fixed; inset: 0; z-index: 1000` 的视口级覆盖层，
 * 会盖住顶栏的 `.ki-topbar__chat-toggle` —— 面板未打开时，用户在全屏状态下
 * **没有任何可达的 AI 入口**（既看不到面板、也点不到开关）。
 *
 * 开合态经 `ChatStoreContext` 读取，与顶栏开关是同一份数据源（`chatStore.open`）。
 * ⚠️ 因此本组件只能挂在 AppShell 的 `ChatStoreContext.Provider` 之下
 *    （全屏阅读器位于页面子树内，满足该条件）。
 */
import { useChatToggle } from './chatStoreContext';

export function ChatToggleButton(): JSX.Element {
  const { open, toggle } = useChatToggle();
  return (
    <button
      className={`ki-drawer__copy ki-drawer__chat${open ? ' ki-drawer__chat--on' : ''}`}
      type="button"
      aria-pressed={open}
      onClick={toggle}
      title={open ? '收起 AI 对话' : '打开 AI 对话'}
    >
      {open ? '收起 AI' : 'AI 对话'}
    </button>
  );
}
