/**
 * 工具预算的纯逻辑（REQ-20261015-001）—— 从 `PromptConfigLayer` 抽出以便单测。
 *
 * 口径：
 * · 返回上限在 UI 以 **K 字符**输入（与「上下文窗口」同口径），落盘为**字符数**
 * · 检索条数以 **条** 输入
 * · **空串 = 未覆盖**（调用方据此删除字段，与「恢复默认」等价）；非法输入返回 `null`
 * · 边界一律由调用方从服务端 `limits` 传入（本文件不硬编码任何数字）
 */

/** K 字符文本 → 字符数；空串或非法 → `null`（只接受 `123` / `10.5` 这类十进制） */
export function parseKChars(v: string): number | null {
  const t = v.trim();
  if (t === '' || !/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t) * 1000;
  return Number.isInteger(n) ? n : null;
}

/** 严格整数文本（条数用）；空串或非法 → `null` */
export function parseStrictInt(v: string): number | null {
  const t = v.trim();
  return t !== '' && /^\d+$/.test(t) ? Number(t) : null;
}

/**
 * 返回上限输入是否**非法**（空串视为未覆盖 → `false`）。
 * 范围缺省（旧 daemon 未返回 limits）时只做格式校验，不拦保存。
 */
export function isResponseCharsInputInvalid(v: string, min?: number, max?: number): boolean {
  if (v.trim() === '') return false;
  const n = parseKChars(v);
  if (n === null) return true;
  return (min !== undefined && n < min) || (max !== undefined && n > max);
}

/** 检索条数输入是否**非法**（空串视为未覆盖 → `false`） */
export function isHitsInputInvalid(v: string, min: number, max: number): boolean {
  if (v.trim() === '') return false;
  const n = parseStrictInt(v);
  return n === null || n < min || n > max;
}

/**
 * 组合提示（场景推演发现，🟡）：两个旋钮在同一分组里会被一起调 ——
 * 当「条数 × 典型单条长度」超过「返回上限」时，多数检索返回会被截断，
 * 反而比"条数小但完整"更差。任一侧为空/非法 → `false`（不提示）。
 *
 * @param perHit 单条命中片段的典型字符数（默认 1200，来自 ki_search 返回的实测量级）
 */
export function budgetComboWarn(hits: number | null, responseChars: number | null, perHit = 1200): boolean {
  if (hits === null || responseChars === null) return false;
  return hits * perHit > responseChars;
}
