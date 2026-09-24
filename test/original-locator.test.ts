import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildChunkLineRanges,
  locateOriginalMatches,
  selectTopOriginalMatches,
  totalOriginalLines,
} from '../src/lib/original-locator.js';

describe('original-locator', () => {
  it('清洗后的 chunk 可以通过稳定正文锚点定位到原文行范围', () => {
    const original = [
      '---',
      'title: demo',
      '---',
      '',
      '<!-- removed -->',
      '# FTS-only Collection',
      'FTS-only Collection 不调用 embedding。',
      '每个 scope 使用独立全文索引。',
    ].join('\n');
    const ranges = buildChunkLineRanges(original, [{ index: 1, text: 'FTS-only Collection\nFTS-only Collection 不调用 embedding。' }]);
    assert.deepEqual(ranges.get(1), { lineStart: 6, lineEnd: 7 });
  });

  it('同一文档多个命中区域分别返回，且带 1-based 行号', () => {
    const original = ['标题', '无关', 'FTS-only Collection', '中间', 'FTS-only Collection 不调用 embedding。'].join('\n');
    const matches = locateOriginalMatches(original, 'FTS-only Collection');
    assert.deepEqual(matches.map((match) => [match.lineStart, match.lineEnd]), [[3, 3], [5, 5]]);
    assert.match(matches[0].excerpt, /^3 \|/);
    assert.equal(totalOriginalLines(original), 5);
  });

  it('全部候选行都被清洗改写且原文有空行时，返回 undefined 而不是空行锚点', () => {
    // 表格行内引用了「路径:行号」，清洗会删掉 src/... 与 :120 → chunk 行不再与原文连续，
    // 逐行 indexOf 全部失配。历史实现此处回退比较「骨架」，而原文空行骨架为 '' →
    // `候选.includes('')` 恒真 → 返回指向空行（第 2 行）的伪造行号。
    const original = [
      '# 部署手册',
      '',
      '| 服务 | 入口 |',
      '| --- | --- |',
      '| 网关 | src/gateway/server.ts:120 |',
      '| 用户 | src/user/handler.ts:88 |',
    ].join('\n');
    const cleanedChunk = '| 网关 |  |\n| 用户 |  |';
    assert.equal(
      buildChunkLineRanges(original, [{ index: 1, text: cleanedChunk }]).get(1),
      undefined,
      '没有任何可复核锚点时必须返回 undefined',
    );
    // 对照：chunk 中仍有与原文连续的行时照常返回真实范围（表头行在原文里没被改写）
    const ranged = buildChunkLineRanges(original, [{ index: 1, text: '| 服务 | 入口 |\n| 网关 |  |' }]);
    assert.deepEqual(ranged.get(1), { lineStart: 3, lineEnd: 3 });
  });

  it('查询词和 fallback chunk 都无法在原文复核时不返回伪造行号', () => {
    const matches = locateOriginalMatches('只剩不可匹配内容', '不存在的词', { fallbackText: 'cleaned chunk' });
    assert.deepEqual(matches, []);
  });

  it('优先保留命中率最高的前 N 个区域，并按原文行号输出', () => {
    const matches = locateOriginalMatches([
      '低相关内容',
      'FTS-only Collection 精确命中',
      '间隔',
      'FTS-only Collection 另一个命中',
      '间隔',
      'FTS-only Collection 精确命中且再次出现 Collection',
      '间隔',
      'FTS-only Collection 第四个命中',
    ].join('\n'), 'FTS-only Collection');

    const selected = selectTopOriginalMatches(matches, 'FTS-only Collection', 2);
    assert.deepEqual(selected.map((match) => [match.lineStart, match.lineEnd]), [[2, 2], [4, 4]]);
  });

  it('命中密度优先于低密度区域中的总出现次数', () => {
    const matches = [
      { lineStart: 1, lineEnd: 1, excerpt: `1 | ${'alpha beta '.repeat(8)}${'unrelated '.repeat(30)}` },
      { lineStart: 20, lineEnd: 20, excerpt: '20 | alpha beta / alpha beta' },
    ];

    const selected = selectTopOriginalMatches(matches, 'alpha beta', 1);
    assert.deepEqual(selected.map((match) => match.lineStart), [20]);
  });

  it('fallback 区域使用产生它的 chunk 文本评分，而非其他 chunk 的内容', () => {
    const matches = [
      { lineStart: 1, lineEnd: 1, excerpt: '1 | apple' },
      { lineStart: 10, lineEnd: 10, excerpt: '10 | alpha beta alpha beta' },
    ];
    const fallbackContexts = [
      { matches: [matches[0]], fallbackText: 'apple', score: 99 },
      { matches: [matches[1]], fallbackText: 'alpha beta', score: 1 },
    ];

    const selected = selectTopOriginalMatches(matches, 'absent query', 1, {
      fallbackText: 'apple',
      fallbackContexts,
    });
    assert.deepEqual(selected.map((match) => match.lineStart), [10]);
  });

  it('英文查询词和完整短语不把更长 token 中的子串算作命中', () => {
    const matches = [
      { lineStart: 1, lineEnd: 1, excerpt: '1 | catapult' },
      { lineStart: 2, lineEnd: 2, excerpt: '2 | cat landed' },
    ];

    const selected = selectTopOriginalMatches(matches, 'cat', 1);
    assert.deepEqual(selected.map((match) => match.lineStart), [2]);
    assert.deepEqual(
      locateOriginalMatches('catapult\ncat', 'cat').map((match) => match.lineStart),
      [2],
      '完整计数扫描也必须遵守英文 token 边界',
    );
    assert.deepEqual(
      locateOriginalMatches('C+++\nC++', 'C++').map((match) => match.lineStart),
      [2],
      '以标点结尾的技术 token 也必须拒绝更长子串',
    );
  });
});
