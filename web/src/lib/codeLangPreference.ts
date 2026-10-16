/**
 * codeLangPreference.ts —— 读者的「首选代码语言」偏好。
 *
 * 口径（2026-10-16 与用户确认）：
 * ① 这是**读者的属性**，不是文档 / scope 的属性 ⇒ 全站一份、跨 scope 生效；
 * ② 只在「某个多语言代码块组确实含这门语言」时生效，其余组照旧展示第一个（不提示、不报错）；
 * ③ 手动切换标签**不写回**偏好（否则就不叫默认了），刷新或重进文档即回到偏好。
 *
 * 存储用 localStorage（键 `ki-preferred-code-lang`，空串 = 不指定）；跨组件通知走自定义事件
 * + `storage` 事件（多标签页），读取侧统一用 `usePreferredLang()`，无需 Provider。
 */
import { useSyncExternalStore } from 'react';

export const CODE_LANG_KEY = 'ki-preferred-code-lang';
const CODE_LANG_CHANGE_EVENT = 'ki:code-lang-change';

/** 语言别名分组：组内互为别名，归一后取组内**第一个**为规范名。首项同时充当设置面板的候选项。 */
export const CODE_LANG_GROUPS: readonly (readonly string[])[] = [
  ['python', 'py', 'python3', 'pyi'],
  ['typescript', 'ts', 'tsx'],
  ['javascript', 'js', 'jsx', 'mjs', 'cjs', 'node', 'nodejs'],
  ['bash', 'sh', 'shell', 'zsh', 'console'],
  ['go', 'golang'],
  ['rust'],
  ['java'],
  ['kotlin'],
  ['csharp', 'cs', 'c#'],
  ['cpp', 'c++'],
  ['sql'],
  ['yaml', 'yml'],
  ['json'],
  ['html'],
  ['css', 'scss', 'less'],
  ['vue'],
  ['php'],
  ['ruby', 'rb'],
  ['swift'],
  ['dockerfile', 'docker'],
];

/** 设置面板的候选语言（各组规范名） */
export const CODE_LANG_OPTIONS: readonly string[] = CODE_LANG_GROUPS.map((group) => group[0]);

const CANONICAL_BY_ALIAS: ReadonlyMap<string, string> = new Map(
  CODE_LANG_GROUPS.flatMap((group) => group.map((alias) => [alias, group[0]] as const)),
);

/** 归一到规范名（如 `py` / `python3` → `python`）；未知语言返回小写原值（不丢弃） */
export function canonicalLang(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  return CANONICAL_BY_ALIAS.get(normalized) ?? normalized;
}

/** 读取首选语言（空串 = 不指定）；localStorage 不可用时静默降级为不指定 */
export function readPreferredLang(): string {
  try {
    return localStorage.getItem(CODE_LANG_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 写入首选语言并广播（供设置面板调用） */
export function writePreferredLang(value: string): void {
  const next = value.trim();
  try {
    if (next) localStorage.setItem(CODE_LANG_KEY, next);
    else localStorage.removeItem(CODE_LANG_KEY);
  } catch {
    /* ignore：隐私模式下不可写，仅本会话内不持久化 */
  }
  window.dispatchEvent(new CustomEvent(CODE_LANG_CHANGE_EVENT));
}

/** 订阅偏好变化（本页事件 + 多标签页 storage 事件） */
export function subscribePreferredLang(listener: () => void): () => void {
  window.addEventListener(CODE_LANG_CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CODE_LANG_CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

/** 首选语言 hook：任何组件都可直接用，不需要 Provider */
export function usePreferredLang(): string {
  return useSyncExternalStore(subscribePreferredLang, readPreferredLang, () => '');
}

/**
 * 算出组内应当默认选中的那一项。
 *
 * 匹配顺序：语言名（归一 + 别名） → 标签（`[Python 3.12]` 这类带版本的显示名） → 第一个。
 * 不做模糊包含匹配 —— 宁可回退第一个，也不要因为 `java` ⊂ `javascript` 这类前缀关系选错。
 */
export function pickPreferredIndex(
  items: readonly { lang: string; label: string }[],
  preferred: string,
): number {
  if (items.length === 0) return 0;
  const wanted = canonicalLang(preferred);
  if (!wanted) return 0;

  const byLang = items.findIndex((item) => item.lang.trim() !== '' && canonicalLang(item.lang) === wanted);
  if (byLang >= 0) return byLang;

  // 语言名没命中时再看标签（组内可能只写了标签，如 ```` ``` [Python 3.12] ````）。
  // 比对用「整串相等」或「首词相等」：`Python 3.12` / `TypeScript / TSX` 这类带版本或别名的
  // 显示名能命中，而 `java` 不会误配 `JavaScript`（首词是 javascript，不等）。
  const wantedLower = preferred.trim().toLowerCase();
  const byLabel = items.findIndex((item) => {
    const label = item.label.trim().toLowerCase();
    return label === wantedLower || label.split(/[\s/·、,，]+/)[0] === wantedLower;
  });
  return byLabel >= 0 ? byLabel : 0;
}
