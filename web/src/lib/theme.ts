/**
 * theme.ts —— 读取「当前生效的主题」，供需要按主题自适应渲染的组件使用（目前是 mermaid 图表）。
 *
 * 为什么不复用 AppShell 的 `useTheme()`：那是**控制面**（持有状态、负责写 localStorage 与
 * `<body data-theme>`），只在 AppShell 内部可见。渲染面（MarkdownPreview）只需要知道
 * 「现在是什么主题」，不该反向依赖布局组件。
 *
 * 数据源取 `<body data-theme>` 这个**已经生效**的属性，而不是 localStorage：
 * ① 它才是 CSS 与 SVG 真正看到的事实（`[data-theme="dark"]` 正是匹配它）；
 * ② 主题将来若来自系统偏好 / 其他页面入口，本 hook 无需改动；
 * ③ 用 MutationObserver 订阅，任何就地切换（含非 AppShell 的入口）都能立刻感知。
 *
 * 只在浏览器侧有 Document；SSR / 单测（Node）下 `document` 不存在，统一按 light 处理。
 */
import { useSyncExternalStore } from 'react';

export type KiTheme = 'light' | 'dark';

/** AppShell 写入 localStorage 时用的键（作为 body 属性缺失时的初值兜底） */
const THEME_KEY = 'ki-theme';

function isTheme(value: string | undefined): value is KiTheme {
  return value === 'light' || value === 'dark';
}

/** 当前生效主题：优先读 `<body data-theme>`（事实），缺失时退回 localStorage 里的偏好 */
export function readDocumentTheme(): KiTheme {
  if (typeof document === 'undefined') return 'light';
  const attr = document.body?.dataset?.theme;
  if (isTheme(attr)) return attr;
  try {
    const stored = globalThis.localStorage?.getItem(THEME_KEY);
    if (isTheme(stored ?? undefined)) return stored as KiTheme;
  } catch {
    /* 隐私模式下不可读：按 light */
  }
  return 'light';
}

/** 订阅 `<body data-theme>` 变化；返回取消订阅函数 */
export function subscribeDocumentTheme(listener: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/** 组件用：主题变化时重新渲染（mermaid 图必须重绘才能换配色） */
export function useDocumentTheme(): KiTheme {
  return useSyncExternalStore(subscribeDocumentTheme, readDocumentTheme, () => 'light');
}
