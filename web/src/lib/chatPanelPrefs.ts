/**
 * AI 对话面板的个人偏好 ⇄ localStorage（面板宽度 / 开合态）。
 *
 * ═══ 为什么需要（2026-10-13 用户反馈）═══
 * · **开合态**原先只活在 `chatStore` 内存里（`INITIAL_CHAT_STATE.open === false`，且 store
 *   在 AppShell 每次挂载时新建）⇒ **刷新即关**；而同一操作场景里的「全屏阅读」早已由 URL 的
 *   `reader=1` 持久化（见 lib/browseUrl.ts + BrowsePage）⇒ 刷新后出现「全屏还在、AI 面板消失」
 *   的不对称（用户报的 Bug）。
 * · **宽度**原先硬编码 380px（ki.css 两处，其中一处是全屏阅读器的让位宽度）⇒ 无法按当前
 *   任务在「正文 / 对话」之间分配空间。
 *
 * ═══ 为什么放 localStorage 而不是 URL（与 browseUrl.ts 的分工）═══
 * URL 承载**可分享的文档定位**（分享出去别人看到同一篇）；面板开合与宽度是**个人界面偏好**，
 * 与文档无关、也不该让别人打开链接时继承我的面板宽度 —— 同 lib/browseTreeState.ts 的口径。
 *
 * ═══ 降级约定（与 browseTreeState 一致）═══
 * 读写全程 try/catch；坏值 / 存储不可用一律回默认，不让脏数据把面板变成 0 宽或打不开。
 */

/** 默认宽度（与既有视觉基线一致：S03 §3.2 的 380px） */
export const CHAT_PANEL_DEFAULT_WIDTH = 380;

/** 可用下限：再窄消息气泡与输入区就没法用了 */
export const CHAT_PANEL_MIN_WIDTH = 320;

/** 绝对上限：再宽正文就没地方了 */
export const CHAT_PANEL_MAX_WIDTH = 720;

/** 宽度偏好键 */
const WIDTH_KEY = 'ki.chatPanelWidth';

/** 开合偏好键（`'1'` = 打开；其它/缺失 = 关闭） */
const OPEN_KEY = 'ki.chatOpen';

/**
 * 视口决定的上限：不超过绝对上限，也不超过视口一半（防正文被挤没）。
 * 视口非法时退回绝对上限（调用方宁可用大值也不要 NaN）。
 */
export function chatPanelWidthUpperBound(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return CHAT_PANEL_MAX_WIDTH;
  return Math.max(
    CHAT_PANEL_MIN_WIDTH,
    Math.min(CHAT_PANEL_MAX_WIDTH, Math.round(viewportWidth * 0.5)),
  );
}

/**
 * 把「可能是任意类型」的宽度解析成有限数；解析不出返回 `null`。
 *
 * ⚠️ 不能直接 `Number(width)`：`Number('')` / `Number('  ')` / `Number([])` 都是 **0**
 * （会被误当成「合法但极小」→ 钳到下限 320，而不是回默认）—— 空白与空数组属脏数据，
 * 必须与真正的 0 区分开。
 */
function parseWidth(width: unknown): number | null {
  if (typeof width === 'number') return Number.isFinite(width) ? width : null;
  if (typeof width === 'string') {
    const trimmed = width.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 把任意宽度收敛到 `[MIN, 视口上限]`。
 *
 * 解析不出的值（`NaN` / 字符串垃圾 / 空白 / `null` / 对象）一律回默认 —— 存储里可能躺着
 * 任意脏数据，这里必须是唯一的兜底点（读取与拖拽共用同一个函数，规则只有一份）。
 */
export function clampChatPanelWidth(width: unknown, viewportWidth: number): number {
  const n = parseWidth(width);
  if (n === null) return CHAT_PANEL_DEFAULT_WIDTH;
  return Math.max(
    CHAT_PANEL_MIN_WIDTH,
    Math.min(Math.round(n), chatPanelWidthUpperBound(viewportWidth)),
  );
}

/** 当前视口宽度（非浏览器环境退回 1600，与桌面基线一致） */
function currentViewportWidth(): number {
  return typeof window === 'undefined' ? 1600 : window.innerWidth;
}

/** 读宽度偏好：无记录 / 坏值 / 存储不可用 → 默认值；越界值按当前视口收敛 */
export function readChatPanelWidth(viewportWidth: number = currentViewportWidth()): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw === null) return CHAT_PANEL_DEFAULT_WIDTH;
    // 直接传原始字符串：空白等脏值由 clampChatPanelWidth 的解析兜底（见 parseWidth）
    return clampChatPanelWidth(raw, viewportWidth);
  } catch {
    return CHAT_PANEL_DEFAULT_WIDTH;
  }
}

/** 写宽度偏好（存储不可用时静默：本次会话内宽度仍然生效） */
export function writeChatPanelWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    /* 隐私模式 / 存储禁用：不影响本次会话内的显示 */
  }
}

/** 读开合偏好（缺失 / 存储不可用 → 关闭，与既有「默认关闭」口径一致） */
export function readChatOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 写开合偏好。
 *
 * ⚠️ **只记「用户意图」**：顶栏开关 / 全屏阅读器内的开关 / 面板关闭按钮三处调用；
 * 路由派生（进入 `/chat` 自动收起、离开恢复先态，见 AppShell）**不得**调用 ——
 * 否则 `/chat` 页的一次刷新就会把「派生状态」写成用户意图（AppShell.tsx 「Q4/Q5」段）。
 */
export function writeChatOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* 存储不可用：本次会话内开合仍正常 */
  }
}
