/**
 * clipboard.ts —— 剪贴板写入（带非安全上下文回退）
 *
 * 先走 Clipboard API（需安全上下文 / 用户授权），失败或不可用时回退到
 * textarea + execCommand；两者都失败即抛错，让调用方给出**可见**的失败提示
 * （静默失败等于点了没反应，项目明确不接受）。
 *
 * ⚠️ 项目里另有两处同款私有实现：`MarkdownPreview.tsx:670` 的 `copyText`、
 *    `ModuleDrawer.tsx:877` / `TasksPage.tsx:278` 的内联版本。本次未合并它们，
 *    避免超出 REQ-20261016-003 的改动范围（已登记为遗留项，见
 *    `.plans/2026-10-16-health-detail-panel/plan.md` 工作项 8 备注）。
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* 非安全上下文 / 权限拒绝：走下面的兼容回退 */
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.select();
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
  }
  if (!copied) throw new Error('浏览器未能复制文本');
}
