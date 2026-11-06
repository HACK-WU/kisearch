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

/**
 * 字面分的**下限**（仅 `requireSemanticRecall` 时启用）。
 *
 * 只有语义命中的文档字面分为 0，若直接代入公式，字面项就是 0 ——
 * 用 1 兜底让它保留一个极小但非零的字面项，避免在「字面分做加法」的公式里被彻底抹平。
 */
export const MIN_FTS_SCORE = 1;

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
