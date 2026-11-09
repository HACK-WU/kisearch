/**
 * 多库检索的**库内评分**（引擎侧唯一实现）。
 *
 * 为什么放在引擎里：跨库合并时，各库必须先算出**可比的最终分**再截断。
 * 若先按名次融合截断、上层再重排，「字面分最高但名次一般」的文档会在库内就被挤掉，
 * 公式根本没机会看到它。
 *
 * 公式只依赖名次分的**量级**（不含候选池最大值），所以库内算完即可跨库比较。
 */

/** 最小名次档：单路 rank1 = 1/(60+1)。用于 rrf=0 的防御场景。 */
export const RRF_FLOOR = 1 / 61;

/**
 * 语义补充项的系数（`calibrated-semantic` 专用）。
 *
 * 最终分 = 定标加权 + `SEMANTIC_BONUS × vectorScore`。
 * 取 0.1 是因为 vectorScore 的跨度（0.33~1）比定标加权（0~0.075）大一个量级，
 * 乘 0.1 后两项量级接近，语义作为「补充项」参与而不会完全覆盖字面/名次信号。
 */
export const SEMANTIC_BONUS = 0.1;

/** 名次项权重（1 = 不加权；调小等于降低名次的话语权） */
export const RRF_WEIGHT = 1;

/**
 * `rrf` 的**量级位数**（小数点后第几位出现首个非零数字）。
 *
 * ```
 * 0.1   → 1
 * 0.04  → 2
 * 0.016 → 2      （首个非零数字 1 在小数点后第 2 位）
 * 0.003 → 3
 * ```
 *
 * 不用 `Math.ceil(-Math.log10(rrf))`：`-log10(0.01)` 在浮点下可能是 1.9999… 或 2.0000…，
 * 边界上会随机跳一档。这里用乘法步进，边界值稳定。
 */
export function decimalScale(rrf: number): number {
  let d = 0;
  let x = rrf;
  while (x > 0 && x < 1 && d < 12) {
    x *= 10;
    d += 1;
  }
  return d;
}

/**
 * 动态比值算法的最终分。
 *
 * ```
 * ratio = bm25 / (rrf × 1000)
 * m     = ratio < 10 ? rrf : 5 / 10^(d+1)
 * score = ratio × m + 0.5 × rrf
 * ```
 *
 * ★ 不再除以 2：名次项已经带 0.5 权重（本身就把量级压了一半），再除一次只是缩窄展示值。
 *
 * ★ 名次项带 **0.5 权重**：名次分的取值范围只有 2.6 倍（0.0125~0.0328），
 *   而字面分跨度为上百倍。不降权时「临界字面分」高达 16.4 —— 字面分低于它的文档
 *   排序几乎完全由名次决定，小库靠库内名次就能霸榜。降到 0.5 后临界点降到 8.2。
 *
 * - `ratio < 10`：加成恒为 `bm25/1000`，与 rrf 的量级无关；
 * - `ratio ≥ 10`：改用 `5/10^(d+1)`，按名次量级压制。
 *
 * @param rrf  该文档在库内的名次分（`Σ 1/(60+rank)`，两路都不命中时为 0）
 * @param fts  该文档的字面分（BM25 原值；字面路没召回时为 0）
 */
export function dynamicRatioScore(rrf: number, fts: number): number {
  const rrfSafe = rrf > 0 ? rrf : RRF_FLOOR;
  const ratio = fts / (rrfSafe * 1000);
  const m = ratio >= 10
    ? 5 / Math.pow(10, decimalScale(rrfSafe) + 1)
    : rrfSafe;
  return ratio * m + RRF_WEIGHT * rrfSafe;
}

// ─── 单库检索：字面加权 RRF ───

/**
 * 单库检索的库内评分标识。
 *
 * 由 adapter 在**单库请求**时固定注入，不进用户可选算法列表（`--ranking` / 检索页下拉
 * 只列多库算法）—— 它不是待对比的候选方案，而是单库当前唯一的打分方式。
 */
export const SINGLE_SCOPE_RANKING = 'fts-weighted-rrf' as const;

/** 字面权重 `bm25 / 50` 的分母 */
export const FTS_WEIGHT_DIVISOR = 50;
/** 字面权重的有效数字位数 */
export const FTS_WEIGHT_DIGITS = 3;
/** 检索最终分的有效数字位数 */
export const SEARCH_SCORE_DIGITS = 5;

/** 保留 n 位有效数字（0 与非有限值原样返回，避免 `toPrecision` 的字符串尾巴） */
export function roundSignificant(value: number, digits: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(digits));
}

/**
 * 字面权重：`bm25 > 50` 时取 `round3(bm25 / 50)`，否则**按 1 倍**（不放大也不打折）。
 *
 * - 用除法不用整除：`bm25 = 140` 得 2.8 倍；整除会只剩 2 倍，且弱命中会被直接归零；
 * - `bm25 ≤ 50` 保持 1 倍：字面证据弱时不做惩罚，否则「正文只出现一次查询词」的文档
 *   会比「一个字都没命中」更差；
 * - **不封顶**：字面越强字面项越大（BM25 上千即 20 倍以上）；
 * - 字面路完全没召回该文档时不会调用本函数（没有字面名次，字面项恒为 0）。
 */
export function ftsWeight(bm25: number): number {
  if (!Number.isFinite(bm25) || bm25 <= FTS_WEIGHT_DIVISOR) return 1;
  return roundSignificant(bm25 / FTS_WEIGHT_DIVISOR, FTS_WEIGHT_DIGITS);
}

/**
 * 单库检索的最终分：`向量名次分 + 字面权重 × 字面名次分`。
 *
 * 与多库公式的差别：多库要跨库比较，字面只能用绝对量（`bm25 / 1000`）；单库只在一个库内
 * 排序，字面项保留「名次分 × 强度倍率」——名次仍是主轴，强度只放大字面的份额。
 *
 * @param vectorRank 向量路名次（1 起；未被向量路召回时传 undefined）
 * @param ftsRank    字面路名次（1 起；未被字面路召回时传 undefined）
 * @param bm25       字面路 BM25 原值（未被字面路召回时为 0）
 */
export function ftsWeightedRrfScore(
  vectorRank: number | undefined,
  ftsRank: number | undefined,
  bm25: number,
  rankConstant = 60,
): number {
  const vectorPart = vectorRank ? 1 / (rankConstant + vectorRank) : 0;
  const ftsPart = ftsRank ? ftsWeight(bm25) / (rankConstant + ftsRank) : 0;
  return roundSignificant(vectorPart + ftsPart, SEARCH_SCORE_DIGITS);
}
