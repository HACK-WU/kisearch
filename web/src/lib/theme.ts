/**
 * theme.ts —— 主题的读写口径：入口初始化（`applyStoredTheme`）+ 启动/切换时的读取。
 *
 * 写 `<body data-theme>` 有**两个**入口，缺一不可：
 * ① `main.tsx` 首渲染前调 `applyStoredTheme()` —— 登录页与「页面不存在」兜底页渲染在
 *    AppShell 之外，没有这一步它们拿不到 `[data-theme="dark"]` 的 token 覆盖；
 * ② AppShell 的 `useTheme()` —— 负责用户点切换之后的即时生效与持久化。
 *
 * 读取面（MarkdownPreview 等）只需要知道「现在是什么主题」，走 `useDocumentTheme`。
 * 数据源取 `<body data-theme>` 这个**已经生效**的属性，而不是 localStorage：
 * ① 它才是 CSS 与 SVG 真正看到的事实（`[data-theme="dark"]` 正是匹配它）；
 * ② 主题将来若来自系统偏好 / 其他页面入口，本 hook 无需改动；
 * ③ 用 MutationObserver 订阅，任何就地切换（含非 AppShell 的入口）都能立刻感知。
 *
 * 只在浏览器侧有 Document；SSR / 单测（Node）下 `document` 不存在，统一按 light 处理。
 */
import { useSyncExternalStore } from 'react';

export type KiTheme = 'light' | 'dark';

/** 主题偏好在 localStorage 里的键（入口初始化与 AppShell 切换器共用，禁止两处各写字符串） */
export const THEME_STORAGE_KEY = 'ki-theme';

function isTheme(value: string | undefined): value is KiTheme {
  return value === 'light' || value === 'dark';
}

/** 当前生效主题：优先读 `<body data-theme>`（事实），缺失时退回 localStorage 里的偏好 */
export function readDocumentTheme(): KiTheme {
  if (typeof document === 'undefined') return 'light';
  const attr = document.body?.dataset?.theme;
  if (isTheme(attr)) return attr;
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
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

/**
 * 入口初始化：把已保存的主题偏好落到 `<body data-theme>`，供 CSS 与 SVG 使用。
 *
 * 必须在首次渲染前调用 —— 登录页与「页面不存在」兜底页不在 AppShell 内，走不到
 * `useTheme()`（2026-11-23 实测：暗色偏好下这两类页面 body 无 data-theme、背景仍是亮色）。
 */
export function applyStoredTheme(): void {
  // `body` 也要判：本函数目前由 main.tsx 在模块顶层调用（module 默认 defer，body 已解析），
  // 但一旦被搬到 `<head>` 里的前置脚本，body 还不存在 —— 直接写会抛错，整站白屏。
  if (typeof document === 'undefined' || !document.body) return;
  document.body.dataset.theme = readDocumentTheme();
}

/** 组件用：主题变化时重新渲染（mermaid 图必须重绘才能换配色） */
export function useDocumentTheme(): KiTheme {
  return useSyncExternalStore(subscribeDocumentTheme, readDocumentTheme, () => 'light');
}
