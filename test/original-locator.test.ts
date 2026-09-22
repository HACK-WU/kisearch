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
    assert.deepEqual(selected.map((match) => [match.lineStart, match.lineEnd]), [[2, 2], [6, 6]]);
  });
});
