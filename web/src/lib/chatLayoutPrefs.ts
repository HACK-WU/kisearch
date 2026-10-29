/**
 * AI 对话页（/chat）布局偏好 ⇄ localStorage：**内容宽度模式** + **左栏折叠态**（REQ-20261016-004）。
 *
 * ═══ 为什么放 localStorage 而不是 URL ═══
 * 与面板宽度同口径（见 lib/chatPanelPrefs.ts §分工）：这是**个人界面偏好**，与文档定位无关 ——
 * 分享出去的链接不该把「我的阅读宽度」带给别人。（开合态则相反，它描述「这一页在用哪个面板」，
 * 由 URL `chat=1` 承载。）
 *
 * ═══ 降级约定（与 chatPanelPrefs / browseTreeState 一致）═══
 * 读写全程 try/catch；坏值一律回默认（`center` / 展开）。绝不让脏数据把对话列变成 0 宽，
 * 或把左栏永久藏起来（用户会找不到会话列表，且没有第二入口）。
 *
 * ═══ 窄屏只「忽略」不「改写」═══
 * <1024px 时左栏本就是抽屉、两种宽度模式等价（可用宽度 < 880）⇒ 调用方只忽略这两个偏好，
 * **不得回写**；否则用户把窗口缩小再放大，桌面上的选择会被静默丢掉。
 */

/** 内容宽度模式：`center` = 880px 居中（默认）；`full` = 铺满（正文文本块另有护栏） */
export type ChatContentWidth = 'center' | 'full';

/** 默认居中（用户拍板 2026-10-16：「默认是居中」） */
export const CHAT_CONTENT_WIDTH_DEFAULT: ChatContentWidth = 'center';

/** 宽度模式偏好键 */
const CONTENT_WIDTH_KEY = 'ki.chatContentWidth';
/** 左栏折叠偏好键 */
const SIDE_COLLAPSED_KEY = 'ki.chatpageSideCollapsed';

/** 任意存储值 → 合法模式（只认字面量 `full`，其余一律回默认） */
export function parseChatContentWidth(raw: unknown): ChatContentWidth {
  return raw === 'full' ? 'full' : CHAT_CONTENT_WIDTH_DEFAULT;
}

/** 读宽度模式；无记录 / 坏值 / 存储不可用 → `center` */
export function readChatContentWidth(): ChatContentWidth {
  try {
    return parseChatContentWidth(localStorage.getItem(CONTENT_WIDTH_KEY));
  } catch {
    return CHAT_CONTENT_WIDTH_DEFAULT;
  }
}

/** 写宽度模式（存储不可用时静默：本次会话内仍然生效） */
export function writeChatContentWidth(value: ChatContentWidth): void {
  try {
    localStorage.setItem(CONTENT_WIDTH_KEY, value);
  } catch {
    /* 隐私模式 / 存储禁用：不影响本次会话内的显示 */
  }
}

/** 任意存储值 → 折叠态（只认字面量 `'true'`，其余一律展开） */
export function parseSideCollapsed(raw: unknown): boolean {
  return raw === 'true';
}

/** 读左栏折叠态；无记录 / 坏值 / 存储不可用 → `false`（展开） */
export function readChatpageSideCollapsed(): boolean {
  try {
    return parseSideCollapsed(localStorage.getItem(SIDE_COLLAPSED_KEY));
  } catch {
    return false;
  }
}

/** 写左栏折叠态（存储不可用时静默：本次会话内仍然生效） */
export function writeChatpageSideCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDE_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    /* 同上 */
  }
}
