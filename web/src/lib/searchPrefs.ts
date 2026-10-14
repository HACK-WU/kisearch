/**
 * 检索页的展示偏好（REQ-20261014-003）。
 *
 * 与 `searchUrl.ts` 的分工：URL 承载**检索态**（q / mode / tags / threshold / limit，
 * 可分享、可刷新恢复）；本文件承载**纯展示偏好** —— 不进 URL，因为开关只影响
 * "点开文档后是否高亮"，分享链接不该替接收者决定这件事。
 *
 * 与 `chatPanelPrefs.ts` 同约定：`'1'` / `'0'`，读写全程 try/catch，坏值回默认。
 */

/** 混合检索「文档内高亮」开关的存储键 */
const DOC_HIGHLIGHT_KEY = 'ki.searchDocHighlight';

/** 默认开：混合检索点开文档即高亮；不希望被语义近似结果打扰的用户可关闭（R2 / Q4） */
export const DOC_HIGHLIGHT_DEFAULT = true;

/** 读开关值；非 `'1'` / `'0'`（含空值、坏值、无 localStorage）一律回默认 */
export function readDocHighlight(): boolean {
  try {
    const raw = localStorage.getItem(DOC_HIGHLIGHT_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    /* 隐私模式 / 存储禁用：回默认，不影响检索本身 */
  }
  return DOC_HIGHLIGHT_DEFAULT;
}

/** 写开关值（只记用户意图：仅在用户点击开关时调用）；存储不可用时静默 —— 本次会话内仍生效 */
export function writeDocHighlight(value: boolean): void {
  try {
    localStorage.setItem(DOC_HIGHLIGHT_KEY, value ? '1' : '0');
  } catch {
    /* 同上 */
  }
}
