/**
 * 单库检索的字面加权 RRF 回归测试。
 *
 * 公式：
 * ```
 * w     = bm25 > 50 ? round3(bm25 / 50) : 1        // 不放大也不打折
 * score = round5( 1/(60+rank_v) + w × 1/(60+rank_f) )
 * ```
 *
 * 期望值来自需求讨论时的手算表 —— 改公式必须同步改这里。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FTS_WEIGHT_DIVISOR,
  SEARCH_SCORE_DIGITS,
  ftsWeight,
  ftsWeightedRrfScore,
  roundSignificant,
} from '../src/zvec-engine/scoring.js';

/** 断言浮点相等（五位有效数字的落点，容差放在第 6 位之后） */
function near(actual: number, expected: number, msg?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, msg ?? `实际 ${actual}，期望 ${expected}`);
}

describe('单库 · 有效数字', () => {
  it('按有效数字截断，不是按小数位', () => {
    near(roundSignificant(0.016393442622950819, 5), 0.016393);
    near(roundSignificant(2.8000000001, 3), 2.8);
    near(roundSignificant(246.9, 3), 247);
    near(roundSignificant(0.000123456, 3), 0.000123);
  });

  it('0 与非有限值原样返回（避免 toPrecision 产出 "0.00" 之类）', () => {
    assert.equal(roundSignificant(0, 3), 0);
    assert.equal(roundSignificant(Number.NaN, 3), Number.NaN);
    assert.equal(roundSignificant(Number.POSITIVE_INFINITY, 3), Number.POSITIVE_INFINITY);
  });
});

describe('单库 · 字面权重', () => {
  /** [bm25, 期望权重] */
  const cases: [number, number][] = [
    [0, 1], //    未被字面路召回 / 空命中 → 不放大
    [3, 1], //    弱命中 → 不放大（也不打折）
    [50, 1], //   边界：等于 50 仍按 1 倍
    [50.1, 1], // 50.1/50 = 1.002，3 位有效数字仍是 1
    [75, 1.5],
    [140, 2.8], // 需求里的典型值
    [500, 10],
    [1234.5, 24.7],
    [12345, 247], // 246.9 → 3 位有效数字 = 247（不是 246）
  ];

  for (const [bm25, want] of cases) {
    it(`bm25=${bm25} → 权重 ${want}`, () => {
      near(ftsWeight(bm25), want);
    });
  }

  it('非法输入按不加权处理（不抛错、不产生 NaN 分）', () => {
    assert.equal(ftsWeight(Number.NaN), 1);
    assert.equal(ftsWeight(-10), 1);
    assert.equal(ftsWeight(Number.POSITIVE_INFINITY), 1, '无穷大按不加权处理，不产生 Infinity 分');
  });

  it('分母常量就是 50', () => {
    assert.equal(FTS_WEIGHT_DIVISOR, 50);
  });
});

describe('单库 · 最终分', () => {
  it('bm25 ≤ 50 时退化为原 RRF（两路名次分相加）', () => {
    // 与改造前的 Σ 1/(60+rank) 一致（只多一道 5 位有效数字截断）——
    // 弱字面命中不会因为这次改动而变分
    const legacy = (a: number, b: number): number =>
      roundSignificant(1 / (60 + a) + 1 / (60 + b), SEARCH_SCORE_DIGITS);
    near(ftsWeightedRrfScore(1, 1, 0), legacy(1, 1));
    near(ftsWeightedRrfScore(1, 1, 50), legacy(1, 1));
    near(ftsWeightedRrfScore(1, 2, 3), legacy(1, 2));
  });

  it('bm25 > 50 后字面项按倍率放大', () => {
    // 向量 rank1 + 字面 rank2，BM25 140 → 2.8 倍
    near(ftsWeightedRrfScore(1, 2, 140), 0.061555);
    // 同上但字面更弱：一分不变地退到 1 倍
    near(ftsWeightedRrfScore(1, 2, 40), 0.032522);
    // 只被字面路召回：没有向量项
    near(ftsWeightedRrfScore(undefined, 1, 100), 0.032787);
    // 只被向量路召回：没有字面项（bm25 自然是 0）
    near(ftsWeightedRrfScore(1, undefined, 0), 0.016393);
    // 两路都没有名次（防御场景）
    assert.equal(ftsWeightedRrfScore(undefined, undefined, 0), 0);
  });

  it('字面极强时分数会明显越过原 RRF 天花板（2/61 ≈ 0.0328）', () => {
    const score = ftsWeightedRrfScore(1, 2, 500);
    near(score, 0.17768);
    assert.ok(score > 2 / 61 * 5, `实际 ${score}`);
  });

  it('字面强但名次一般，可以反超字面弱但名次靠前的文档', () => {
    // A：向量第 1、字面第 5，BM25 400（8 倍）
    const a = ftsWeightedRrfScore(1, 5, 400);
    // B：向量第 2、字面第 1，BM25 60（1.2 倍）
    const b = ftsWeightedRrfScore(2, 1, 60);
    near(a, 0.13947);
    near(b, 0.035801);
    assert.ok(a > b, `A=${a} 应高于 B=${b}`);
  });

  it('分数保留 5 位有效数字', () => {
    assert.equal(SEARCH_SCORE_DIGITS, 5);
    const s = ftsWeightedRrfScore(1, 2, 140);
    assert.equal(s, Number(s.toPrecision(5)));
    // 原始值 0.061554732945… → 0.061555
    assert.equal(s, 0.061555);
  });
});
