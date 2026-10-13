/**
 * contextUsage.ts —— 上下文用量（**字符口径**）的纯函数与本地偏好
 * （REQ-20261013-001）
 *
 * ═══ 口径（与后端 `chat-contract.ts::ContextCharsParts` 一致）═══
 * · 分子：**该轮真实发送给上游的 messages 字符数**（后端计算，前端只展示）
 * · 分母：`GET /api/chat/config` 的 `contextChars`（缺省 1000K = 1,000,000 字符）
 * · 单位：K = 1000 字符；字符 ≠ token（中文 ≈1 token/1~1.5 字，英文/代码 ≈1 token/3~4 字
 *   ⇒ 该口径**偏保守**：不会漏报"快满了"，可能在英文/代码为主时提前提示）
 *
 * ═══ 为什么这些函数放 lib 而不是组件里 ═══
 * 格式化与阈值判定是**纯逻辑**，放这里可以被 node 单测直接覆盖（`web/test/*.test.mjs`），
 * 组件只负责渲染。
 */

import type { ContextCharsParts } from '@/api/chatContract';

/** 上限缺省值（与后端 `CHAT_BUDGET.defaultContextChars` 同值；仅在后端字段缺失时兜底） */
export const DEFAULT_CONTEXT_CHARS = 1_000_000;

/** 压缩时保留的最近消息条数（与后端 `chat-store.ts::COMPACT_KEEP_RECENT` 一致） */
export const COMPACT_KEEP_RECENT = 4;
/** 最少可压缩条数（与后端 `COMPACT_MIN_COVERED` 一致；低于则不显示压缩入口的可用态） */
export const COMPACT_MIN_COVERED = 2;

/** 当前消息数是否够压缩（前端据此禁用入口，后端仍会二次判定并给出人话原因） */
export function canCompactMessages(messageCount: number): boolean {
  return messageCount - COMPACT_KEEP_RECENT >= COMPACT_MIN_COVERED;
}

/** 提示阈值：≥80% 黄色提醒 */
export const CONTEXT_WARN_RATIO = 0.8;
/** 强化阈值：≥90% 红色提醒（**不设 95%**：字符口径对英文/代码偏保守，留足反应时间） */
export const CONTEXT_DANGER_RATIO = 0.9;

export type ContextLevel = 'ok' | 'warn' | 'danger' | 'unknown';

/**
 * 字符数 → 展示文本（K 单位，1 位小数；小于 1000 时直接显示原数）。
 * 非有限值 / 负数一律 `—`（**不显示 0**：0 会被读成"没有用量"）。
 */
export function formatK(chars: number | null | undefined): string {
  if (chars === null || chars === undefined || !Number.isFinite(chars) || chars < 0) return '—';
  if (chars < 1000) return String(Math.round(chars));
  return `${(chars / 1000).toFixed(1)}K`;
}

/**
 * **一律 K 单位**的展示文本（用户口径 2026-10-13：「不是显示多少字，而是多少 K」）。
 *
 * 与 `formatK` 的差别：小值也带 K（`482` → `0.48K`），**不再出现裸字符数**——
 * 面板里混着 `482` 与 `3.4K` 两套量纲会被读成不同单位。
 * · `0` 仍显示 `0`（不带 K，避免 `0.0K` 的噪声）
 * · 非零但极小值抬到 `0.01K`（`1` 字符 → `0.01K`：宁可轻微高估，也不显示成 `0.00K` 被读成"没有"）
 */
export function formatKUnit(chars: number | null | undefined): string {
  if (chars === null || chars === undefined || !Number.isFinite(chars) || chars < 0) return '—';
  if (chars === 0) return '0';
  if (chars < 1000) return `${Math.max(chars / 1000, 0.01).toFixed(2)}K`;
  return `${(chars / 1000).toFixed(1)}K`;
}

/** 占比（0~∞）；分母无效时返回 null */
export function contextRatio(chars: number | null | undefined, limit: number | null | undefined): number | null {
  if (chars === null || chars === undefined || !Number.isFinite(chars)) return null;
  if (limit === null || limit === undefined || !Number.isFinite(limit) || limit <= 0) return null;
  return chars / limit;
}

/** 占比文案（如 `1.2%` / `82.0%`）；无效时 `—` */
export function contextPercentLabel(chars: number | null | undefined, limit: number | null | undefined): string {
  const r = contextRatio(chars, limit);
  if (r === null) return '—';
  const pct = r * 100;
  return `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`;
}

/** 阈值档位（`unknown` = 缺分子或缺分母 → 只显示绝对量，**不猜**） */
export function contextLevel(chars: number | null | undefined, limit: number | null | undefined): ContextLevel {
  const r = contextRatio(chars, limit);
  if (r === null) return 'unknown';
  if (r >= CONTEXT_DANGER_RATIO) return 'danger';
  if (r >= CONTEXT_WARN_RATIO) return 'warn';
  return 'ok';
}

/**
 * 用量文案（如 `3.9K / 6.0K · 65%`；分母缺失时只给绝对值）。
 * **一律 K 单位、不带「字」后缀**（K 已在数字里，再加单位词会重复）。
 */
export function contextUsageLabel(chars: number | null | undefined, limit: number | null | undefined): string {
  if (chars === null || chars === undefined || !Number.isFinite(chars)) return '—';
  const hasLimit = limit !== null && limit !== undefined && Number.isFinite(limit) && limit > 0;
  if (!hasLimit) return formatKUnit(chars);
  return `${formatKUnit(chars)} / ${formatKUnit(limit)} · ${contextPercentLabel(chars, limit)}`;
}

/**
 * 展示值 = **最新 `context` 基数 + 正在生成的正文字符数**。
 *
 * 为什么这样算：本轮生成的正文会成为下一轮历史的一部分，所以"此刻已占用"应含它；
 * 而基数（system / 历史 / 工具返回）只有后端知道 ⇒ 前端**只做加法，不做估算**
 * （护栏 #7：不得自行求和 system/工具部分充精确值）。
 */
export function liveContextChars(
  base: number | null | undefined,
  streamingContentChars: number,
): number | null {
  if (base === null || base === undefined || !Number.isFinite(base)) return null;
  const extra = Number.isFinite(streamingContentChars) ? Math.max(0, streamingContentChars) : 0;
  return base + extra;
}

/** 环形指示器的**最小弧长比例**：有数据但极小时也留一段可见弧，避免"看着像空环" */
export const RING_MIN_ARC = 0.04;

/**
 * 环形进度：`0..1`，越界自动夹取；**无数据返回 0**（空环 = 未知，不得画成"已满"）。
 * 极小正值抬到 `RING_MIN_ARC`，让"用了一点点"在视觉上可辨。
 */
export function ringProgress(ratio: number | null): number {
  if (ratio === null || !Number.isFinite(ratio)) return 0;
  if (ratio <= 0) return 0;
  return Math.min(1, Math.max(RING_MIN_ARC, ratio));
}

/**
 * 字符口径的解释文案（面板与 title 共用，避免两处措辞漂移）。
 * ★ 必须保留"字符 ≠ token"与"偏保守"两句：否则用户会把它当成精确的模型额度。
 */
export const CONTEXT_MEASURE_NOTE =
  '思考过程不计入；工具返回单次最多 10000 字。字符 ≠ token（英文/代码更省），故该数字偏保守：不会漏报「快满了」。';

/** 分量明细行（顺序即展示顺序；`refs` 是 `user` 的子集，单独标注不参与合计） */
export const CONTEXT_PART_ROWS: ReadonlyArray<{ key: keyof ContextCharsParts; label: string; hint: string }> = [
  { key: 'system', label: '系统提示', hint: '会话提示词 + 检索规则（每次请求都会带上）' },
  { key: 'user', label: '提问', hint: '历史与当前的用户消息（含当轮引用片段）' },
  { key: 'assistant', label: '回答', hint: '历史回答正文（思考过程不计入）' },
  { key: 'tool', label: '工具返回', hint: '知识库检索结果（单次最多 10000 字）' },
];

/** 汇总分量为总字符数（与后端 `chars` 同口径；`refs` 不计） */
export function sumContextParts(parts: ContextCharsParts | null | undefined): number | null {
  if (!parts) return null;
  const { system, user, assistant, tool } = parts;
  const total = system + user + assistant + tool;
  return Number.isFinite(total) ? total : null;
}

// ─────────────────────────────────────────────────────────────
// 阈值提示的"不重复打扰"（按 会话 × 档位 记本地偏好）
// ─────────────────────────────────────────────────────────────

const DISMISS_KEY = 'ki.chatCtxWarnDismissed';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // 隐私模式等：静默降级为"不记忆"，提示照常显示
  }
}

/** 读取已忽略的档位表（`{ [convId]: level }`）；异常一律降级空表 */
export function readDismissedContextWarn(): Record<string, string> {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(DISMISS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: Record<string, string>): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(DISMISS_KEY, JSON.stringify(map));
  } catch {
    /* 写失败不影响主流程 */
  }
}

/**
 * 是否应显示阈值提示。
 *
 * 规则：**同一会话同一档位只提示一次**；档位升级（warn → danger）会再次提示；
 * 会话 id 为空（未落盘会话）时不提示（此时也没有稳定的记账键）。
 */
export function shouldShowContextWarn(
  convId: string | null | undefined,
  level: ContextLevel,
): boolean {
  if (!convId) return false;
  if (level !== 'warn' && level !== 'danger') return false;
  return readDismissedContextWarn()[convId] !== level;
}

/** 忽略本会话当前档位的提示 */
export function dismissContextWarn(convId: string, level: ContextLevel): void {
  if (!convId || (level !== 'warn' && level !== 'danger')) return;
  const map = readDismissedContextWarn();
  map[convId] = level;
  write(map);
}

/** 清除本会话的忽略记录（压缩完成 / 撤销 / 新建会话后调用：状态已变，提示应重新可用） */
export function clearContextWarnDismiss(convId: string): void {
  if (!convId) return;
  const map = readDismissedContextWarn();
  if (!(convId in map)) return;
  delete map[convId];
  write(map);
}

/** 阈值提示文案（含占比与出路；单位一律"字"以避免被读成 token） */
export function contextWarnText(chars: number, limit: number, level: ContextLevel): string {
  const pct = contextPercentLabel(chars, limit);
  const amount = `${formatKUnit(chars)} / ${formatKUnit(limit)}`;
  if (level === 'danger') {
    return `上下文已用 ${pct}（${amount}）：继续提问可能超出模型上限，建议先压缩上下文或新建会话`;
  }
  return `上下文已用 ${pct}（${amount}），建议压缩上下文或新建会话`;
}
