/**
 * searchLimit.ts —— 语义检索页「Limit」（返回条数）的取值范围与归一化
 *
 * ═══ 为什么不再用固定下拉（5 / 10 / 20）═══
 * 原实现是 `<select>`，用户想要 30 条只能从 20 里凑，或回 CLI 加 `--limit`。
 * 改为数字输入 + −/+ 步进后，任意条数可填；步进只是省手输，不是唯一通路。
 *
 * ═══ 上界为什么是 1000 ═══
 * 对齐后端引擎单次检索的 topk 上限（`SEARCH_TOPK_MAX = 1000`，`src/lib/vector-client.ts:298`）。
 * 超过它后端会把 topk 收敛到 1000 并回一条 skipped 提示（"结果可能少于 limit"）；
 * 前端直接挡住，免得用户以为「要了 5000 只给 1000」是丢结果。
 *
 * ★ 上界 ≠ 承诺：1000 是**引擎单次候选上限**，不是"填 1000 就回 1000 条"。
 *   实际候选还要先放大再截断 —— 全文模式 `max(limit×10, 50) + 隐藏补位`
 *   （`src/search.ts:414`）、无 tags 的向量模式还要乘以 tag 数（`src/search.ts:493`）、
 *   多库再 ×2（`src/search.ts:435`）。放大值一旦越过 1000 就被截断，文档聚合后
 *   条数可能明显少于所填值。这类情况后端会回 skipped，检索页结果区展示为
 *   「已跳过或受限 N 项，结果可能不完整」并附原因，不是静默少给。
 *   文案（输入框 title）必须照这个口径写，不要给"填多少得多少"的预期。
 */

export const SEARCH_LIMIT_MIN = 1;
export const SEARCH_LIMIT_MAX = 1000;
export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_STEP = 1;

/** 整数化 + clamp；非有限值（NaN / Infinity）按默认值兜底 */
export function normalizeSearchLimit(value: number): number {
  if (!Number.isFinite(value)) return SEARCH_LIMIT_DEFAULT;
  const n = Math.floor(value);
  if (n < SEARCH_LIMIT_MIN) return SEARCH_LIMIT_MIN;
  if (n > SEARCH_LIMIT_MAX) return SEARCH_LIMIT_MAX;
  return n;
}

/**
 * 解析输入框里的字符串。
 *
 * ★ 空串 / 非数字 → 默认值 10。**不是** 0 或 NaN：原实现 `Number(limit) || 10`
 *   对空串也是这个语义，此处保持一致，避免清空输入框后请求里出现 `limit: 0`。
 * ★ 调用点只在**失焦**与**发起检索**时使用，绝不放进 onChange —— 否则用户删光重输
 *   （先变 1 再变 12）时会被逐字符打断。
 */
export function parseSearchLimit(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') return SEARCH_LIMIT_DEFAULT;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return SEARCH_LIMIT_DEFAULT;
  return normalizeSearchLimit(n);
}

/**
 * −/+ 步进：以当前输入（可能是非法中间态）为基准，走与提交同一套归一化。
 * 非法输入点一下步进即可回到合法值，不必先手动清空。
 */
export function stepSearchLimit(raw: string, dir: 1 | -1): number {
  return normalizeSearchLimit(parseSearchLimit(raw) + dir * SEARCH_LIMIT_STEP);
}

/**
 * 输入值是否**超出**上下界（用来在界面上把「这个值不会被原样接受」显示出来）。
 *
 * ★ 为什么需要：失焦归一会在用户眼皮底下把 5000 改成 1000。数字确实变了，
 *   但"为什么变"只有 hover `title` 才看得到 —— 不标一下就成了静默改写。
 * ★ 空串 / 非数字**不算**越界：那是录入中间态（删光重输），标红会一路闪。
 */
export function isSearchLimitOutOfRange(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return false;
  return n < SEARCH_LIMIT_MIN || n > SEARCH_LIMIT_MAX;
}
