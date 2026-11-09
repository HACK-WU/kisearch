/**
 * 多库「语义相似度」绝对分的回归测试。
 *
 * 公式：
 * ```
 * w     = bm25 > 50 ? round3(bm25 / 50) : 1        // 与单库同一套
 * score = round5( sim_v + w × 1/61 )               // 字面名次固定为 1
 * ```
 *
 * 与单库 `fts-weighted-rrf` 的唯一差别：向量项用绝对相似度（0.33~1），
 * 不用库内名次（`1/(60+r_v)`）—— 名次跨库不可比。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RRF_FLOOR, SEMANTIC_FTS_BASE, semanticSimilarityScore } from '../src/zvec-engine/scoring.js';

/** 分数保留 5 位有效数字，误差上界约 5e-6（0.7 量级），容差取 1e-5 */
function near(actual: number, expected: number, msg?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-5, msg ?? `实际 ${actual}，期望 ${expected}`);
}

describe('多库绝对分 · 基本形态', () => {
  it('字面路没召回（bm25 = undefined）：只有相似度，不加字面分', () => {
    assert.equal(semanticSimilarityScore(0.7, undefined), 0.7);
    assert.equal(semanticSimilarityScore(0.5234, undefined), 0.5234);
  });

  it('★ bm25 传 0 与传 undefined 不同：0 会被当成「召回了但分数为 0」，白送一份字面分', () => {
    // 这是缺陷陷阱，不是期望行为 —— 调用方必须按「未召回」传 undefined
    near(semanticSimilarityScore(0.7, 0), 0.7 + SEMANTIC_FTS_BASE);
    assert.notEqual(semanticSimilarityScore(0.7, 0), semanticSimilarityScore(0.7, undefined));
  });

  it('bm25 ≤ 50：字面项按 1 倍（与单库同一门槛）', () => {
    const base = 0.7;
    for (const bm25 of [1, 10, 50]) {
      near(semanticSimilarityScore(base, bm25), base + SEMANTIC_FTS_BASE);
    }
  });

  it('字面基准是 1/23，不是单路的 1/61', () => {
    assert.equal(SEMANTIC_FTS_BASE, 1 / 23);
    assert.ok(SEMANTIC_FTS_BASE > RRF_FLOOR);
  });

  it('bm25 > 50 后按倍率加成', () => {
    near(semanticSimilarityScore(0.7, 140), 0.82174); //  0.7 + 2.8/23
    near(semanticSimilarityScore(0.7, 399), 1.047); // 0.7 + 7.98/23（399/50=7.98），5 位有效数字落到 1.0470
    near(semanticSimilarityScore(0, 140), 0.12174); // 只有字面命中，没有语义项
  });

  it('分数保留 5 位有效数字', () => {
    const s = semanticSimilarityScore(0.7, 140);
    assert.equal(s, Number(s.toPrecision(5)));
  });
});

describe('多库绝对分 · 三种字面口径', () => {
  it('dominant：字面分 ÷ 100 直接相加，低 BM25 也生效', () => {
    near(semanticSimilarityScore(0.67, 16.42, 'dominant'), 0.8342);
    near(semanticSimilarityScore(0.67, 5, 'dominant'), 0.72);
  });

  it('boost：BM25 超过 30 才跳一档，否则回到 balanced', () => {
    near(semanticSimilarityScore(0.67, 16.42, 'boost'), 0.67 + SEMANTIC_FTS_BASE);
    near(semanticSimilarityScore(0.67, 31, 'boost'), 0.72);
    near(semanticSimilarityScore(0.67, 500, 'boost'), 0.72, '门槛以上固定同一档，不随 BM25 继续增长');
  });

  it('三种口径对「未被字面召回」的处理一致：都不加字面分', () => {
    for (const mode of ['balanced', 'dominant', 'boost'] as const) {
      assert.equal(semanticSimilarityScore(0.7, undefined, mode), 0.7, `mode=${mode}`);
    }
  });

  it('dominant 对中等 BM25 明显更敏感（16.42：0.164 vs 0.043）', () => {
    const balanced = semanticSimilarityScore(0.67, 16.42, 'balanced');
    const dominant = semanticSimilarityScore(0.67, 16.42, 'dominant');
    assert.ok(dominant - balanced > 0.1, `实际差 ${dominant - balanced}`);
  });
});

describe('多库绝对分 · 跨库可比', () => {
  it('库内名次相同的两篇文档，靠相似度分出高下', () => {
    // 旧公式：两库的头名都拿 1/61，完全同分
    assert.equal(1 / (60 + 1), RRF_FLOOR);
    // 新公式：相似度不同 → 分数不同
    const weak = semanticSimilarityScore(0.52, undefined);
    const strong = semanticSimilarityScore(0.78, undefined);
    assert.ok(strong > weak, `strong=${strong} 应高于 weak=${weak}`);
    near(strong - weak, 0.26);
  });

  it('★ 两篇文档 w 同为 1 时，基准只是公共加数 —— 抬高基准不改变它们之间的差距', () => {
    // 实测数据：第 1 名 sim 0.71189（bm25 未进全文前 10 → ≤50），目标文档 sim 0.66817（bm25 16.42）
    const first = semanticSimilarityScore(0.71189, 12);
    const target = semanticSimilarityScore(0.66817, 16.42);
    near(first - target, 0.71189 - 0.66817);
    assert.ok(first > target, 'w 都是 1 时，sim 高者恒胜，抬基准没用');
  });

  it('大库的高相似度文档可以压过小库的头名（旧公式做不到）', () => {
    // 小库：相似度一般，但因库里只有两篇而必然排第 1
    const smallLibTop = semanticSimilarityScore(0.55, 8);
    // 大库：相似度明显更高，但库内只排第 7（旧公式会给 1/67 ≈ 0.0149）
    const bigLibDoc = semanticSimilarityScore(0.79, undefined);
    assert.ok(bigLibDoc > smallLibTop, `big=${bigLibDoc} 应高于 small=${smallLibTop}`);
  });
});
