/**
 * 多库库内评分（动态比值）的回归测试。
 *
 * 公式：
 * ```
 * ratio = bm25 / (rrf × 1000)
 * m     = ratio < 10 ? rrf : 5 / 10^(d+1)     d = rrf 的量级（0.016→2，0.003→3）
 * score = (ratio × m + rrf) / 2
 * ```
 *
 * 期望值来自需求讨论时的手算表 —— 改公式必须同步改这里。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decimalScale, dynamicRatioScore, RRF_FLOOR } from '../src/zvec-engine/scoring.js';

describe('动态比值 · 量级位数', () => {
  it('按名次分的量级取位数', () => {
    assert.equal(decimalScale(0.5), 1);
    assert.equal(decimalScale(0.05), 2);
    assert.equal(decimalScale(0.04), 2);
    assert.equal(decimalScale(0.03), 2);
    assert.equal(decimalScale(0.016), 2);
    assert.equal(decimalScale(0.005), 3);
    assert.equal(decimalScale(0.003), 3);
    assert.equal(decimalScale(0.0009), 4);
  });

  it('边界值稳定（不受浮点误差影响）', () => {
    // 若用 -log10 会在 0.01 处随机跳档
    assert.equal(decimalScale(0.1), 1);
    assert.equal(decimalScale(0.01), 2);
    assert.equal(decimalScale(0.001), 3);
  });
});

describe('动态比值 · 最终分', () => {
  /** [名次分, 字面分, 期望得分]  score = ratio×m + rrf */
  const cases: [number, number, number][] = [
    // ratio < 10：加成 = bm25/1000
    [0.05, 50, 0.1], //  0.05   + 0.05
    [0.05, 1, 0.051], //  0.001  + 0.05
    [0.03, 100, 0.13], //  0.1    + 0.03
    // ratio >= 10：m = 5/10^(d+1)
    [0.005, 50, 0.01], //  0.005  + 0.005   d=3 → m=0.0005
    [0.005, 100, 0.015], //  0.01   + 0.005
    [0.01, 100, 0.06], //  0.05   + 0.01    d=2 → m=0.005
    [0.009, 100, 0.014556], //  0.005556 + 0.009
  ];

  for (const [rrf, fts, want] of cases) {
    it(`rrf=${rrf} 字面分=${fts} → ${want}`, () => {
      const got = dynamicRatioScore(rrf, fts);
      assert.ok(Math.abs(got - want) < 1e-6, `实际 ${got}`);
    });
  }

  it('名次分为 0 时按最小档兜底（不是除零、也不是 0 分）', () => {
    assert.equal(RRF_FLOOR, 1 / 61);
    const s = dynamicRatioScore(0, 1000);
    // rrfSafe=1/61 → ratio=61 ≥ 10 → d=2 → m=0.005
    assert.ok(s > 0 && Number.isFinite(s), `实际 ${s}`);
  });

  it('字面分为 0 时只剩名次项（不加权，不补偿）', () => {
    assert.ok(Math.abs(dynamicRatioScore(0.0328, 0) - 0.0328) < 1e-9);
  });

  it('ratio < 10 段内，字面分越高得分越高（单调）', () => {
    let prev = -1;
    for (const fts of [0, 1, 5, 20, 60, 133]) {
      const s = dynamicRatioScore(0.0164, fts);
      assert.ok(s > prev, `fts=${fts} 时应比前一个更高`);
      prev = s;
    }
  });
});
