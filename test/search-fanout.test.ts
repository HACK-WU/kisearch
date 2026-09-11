/**
 * 阶段 2：多 scope fan-out 检索纯函数与 embedding 复用契约。
 * 运行：npx jiti test/search-fanout.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { embedQueryOnce, mergeVectorSearchHits } from '../src/lib/vector-client.js';

describe('阶段 2 · fan-out 检索', () => {
  it('多 scope fan-out 只需一次 query embedding，并校验维度', async () => {
    let calls = 0;
    const vector = await embedQueryOnce('查询', {
      dimension: 3,
      embed: async (texts, opts) => {
        calls++;
        assert.deepEqual(texts, ['查询']);
        assert.equal(opts?.batchSize, 1);
        return [[0.1, 0.2, 0.3]];
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  });

  it('各 scope 候选按全局 score 合并并稳定截断 top-k', () => {
    const result = mergeVectorSearchHits([
      [
        { memoryId: 'a', content: 'A', score: 0.7 },
        { memoryId: 'c', content: 'C', score: 0.4 },
      ],
      [
        { memoryId: 'b', content: 'B', score: 0.9 },
        { memoryId: 'd', content: 'D', score: 0.4 },
      ],
    ], 3);
    assert.deepEqual(result.map((x) => x.memoryId), ['b', 'a', 'c']);
  });
});
