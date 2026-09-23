import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { registerTestScope, cleanupTestConfig, testConfigPath } from './test-config.js';
import { ensureScopeDir, writeJson } from '../src/lib/store.js';
import { getLocalKbDir, getRelationsCachePath } from '../src/lib/scope.js';

const scope = `fulltext-locator-${Date.now()}`;

describe('executeSearch fulltext 原文定位', () => {
  before(async () => {
    registerTestScope(scope);
    const config = JSON.parse(fs.readFileSync(testConfigPath, 'utf-8')) as {
      scopes: Record<string, Record<string, unknown>>;
    };
    config.scopes[scope].kbDir = path.join(path.dirname(testConfigPath), 'test-kb');
    fs.writeFileSync(testConfigPath, JSON.stringify(config), 'utf-8');
    ensureScopeDir(scope);

    const { ftsBulkStore } = await import('../src/lib/fts-client.js');
    const overflowCount = 55;
    const overflowOriginal = Array.from({ length: 60 }, (_, index) => `overflow marker direct hit ${index}`).join('\n\n');
    const fallbackOriginal = [
      'needle exact direct match',
      ...Array.from({ length: overflowCount }, (_, index) => `fallback-token-${index} original content`),
    ].join('\n\n');
    const fallbackRankingOriginal = [
      `focus-a ${'noise '.repeat(50)}`,
      `focus-b ${'noise '.repeat(6)}`,
      'focus-c',
      `focus-d ${'noise '.repeat(10)}`,
    ].join('\n\n');
    const entries = [
      { scope, group: 'group/a', relation: 'doc-a', text: 'FTS-only Collection first hit', tag: 'ki-search' },
      { scope, group: 'group/a', relation: 'doc-a', text: 'FTS-only Collection second hit', tag: 'ki-search' },
      { scope, group: 'group/a', relation: 'doc-a', text: 'FTS-only Collection third hit', tag: 'ki-search' },
      { scope, group: 'group/a', relation: 'doc-a', text: 'FTS-only Collection fourth hit', tag: 'ki-search' },
      { scope, group: 'group/b', relation: 'doc-b', text: 'FTS-only Collection another document', tag: 'ki-search' },
      { scope, group: 'group/c', relation: 'doc-c', text: 'FTS-only Collection missing original', tag: 'ki-search' },
      ...Array.from({ length: overflowCount }, (_, index) => ({
        scope, group: 'group/a', relation: 'doc-overflow', text: `overflow marker chunk ${index}`, tag: 'overflow-test',
      })),
      ...Array.from({ length: overflowCount }, (_, index) => ({
        scope, group: 'group/a', relation: 'doc-fallback', text: `needle fallback-token-${index} chunk`, tag: 'fallback-test',
      })),
      { scope, group: 'group/d', relation: 'doc-fallback-small', text: 'needle compact fallback', tag: 'fallback-small-test' },
      { scope, group: 'group/e', relation: 'doc-fallback-ranking', text: `${'needle '.repeat(4)}focus-a context`, tag: 'fallback-ranking-test' },
      { scope, group: 'group/e', relation: 'doc-fallback-ranking', text: 'needle focus-b context', tag: 'fallback-ranking-test' },
      { scope, group: 'group/e', relation: 'doc-fallback-ranking', text: 'needle focus-c context', tag: 'fallback-ranking-test' },
      { scope, group: 'group/e', relation: 'doc-fallback-ranking', text: 'needle focus-d context', tag: 'fallback-ranking-test' },
      { scope, group: 'a|b', relation: 'c', text: 'pipe key collision marker first', tag: 'collision-test' },
      { scope, group: 'a', relation: 'b|c', text: 'pipe key collision marker second', tag: 'collision-test' },
    ];
    const stored = await ftsBulkStore(entries);
    assert.equal(stored.failed, 0, '所有 FTS fixture 必须成功写入');
    assert.equal(stored.ids.length, entries.length, '返回的 FTS ID 数量必须与 fixture 数量一致');

    writeJson(getLocalKbDir(scope, 'group/a'), {
      'doc-a': '# Doc A\n\nFTS-only Collection first hit\n\n无关内容\n\nFTS-only Collection second hit\n\nFTS-only Collection third hit\n\nFTS-only Collection fourth hit',
      'doc-overflow': overflowOriginal,
      'doc-fallback': fallbackOriginal,
    });
    writeJson(getLocalKbDir(scope, 'group/b'), {
      'doc-b': '# Doc B\n\nFTS-only Collection another document',
    });
    writeJson(getLocalKbDir(scope, 'group/d'), {
      'doc-fallback-small': 'compact fallback appears in original',
    });
    writeJson(getLocalKbDir(scope, 'group/e'), {
      'doc-fallback-ranking': fallbackRankingOriginal,
    });
    writeJson(getLocalKbDir(scope, 'a|b'), { c: 'pipe key collision marker first' });
    writeJson(getLocalKbDir(scope, 'a'), { 'b|c': 'pipe key collision marker second' });
    const overflowStart = 6;
    const fallbackStart = overflowStart + overflowCount;
    const smallFallbackIndex = fallbackStart + overflowCount;
    const rankingStart = smallFallbackIndex + 1;
    const pipeAIndex = rankingStart + 4;
    const pipeBIndex = pipeAIndex + 1;
    writeJson(getRelationsCachePath(scope), {
      scope,
      groups: {
        'group/a': {
          hot_relations: [{
            id: 'a',
            text: 'doc-a',
            memoryIds: [],
            ftsIds: stored.ids.slice(0, 4),
            ftsLocators: stored.ids.slice(0, 4).map((ftsId, index) => ({
              ftsId,
              sourcePath: 'doc-a.md',
              chunkIndex: index + 1,
              lineStart: [3, 7, 9, 11][index],
              lineEnd: [3, 7, 9, 11][index],
            })),
          }, {
            id: 'overflow',
            text: 'doc-overflow',
            memoryIds: [],
            ftsIds: stored.ids.slice(overflowStart, fallbackStart),
            ftsLocators: stored.ids.slice(overflowStart, fallbackStart).map((ftsId, index) => ({
              ftsId, sourcePath: 'doc-overflow.md', chunkIndex: index + 1,
              lineStart: index * 2 + 1, lineEnd: index * 2 + 1,
            })),
          }, {
            id: 'fallback',
            text: 'doc-fallback',
            memoryIds: [],
            ftsIds: stored.ids.slice(fallbackStart, smallFallbackIndex),
            ftsLocators: stored.ids.slice(fallbackStart, smallFallbackIndex).map((ftsId, index) => ({
              ftsId, sourcePath: 'doc-fallback.md', chunkIndex: index + 1,
              lineStart: index * 2 + 3, lineEnd: index * 2 + 3,
            })),
          }],
        },
        'group/b': {
          hot_relations: [{
            id: 'b',
            text: 'doc-b',
            memoryIds: [],
            ftsIds: [stored.ids[4]],
            ftsLocators: [{ ftsId: stored.ids[4], sourcePath: 'doc-b.md', chunkIndex: 1, lineStart: 3, lineEnd: 3 }],
          }],
        },
        'group/c': {
          hot_relations: [{
            id: 'c',
            text: 'doc-c',
            memoryIds: [],
            ftsIds: [stored.ids[5]],
            ftsLocators: [{ ftsId: stored.ids[5], sourcePath: 'doc-c.md', chunkIndex: 1, lineStart: 1, lineEnd: 1 }],
          }],
        },
        'group/d': {
          hot_relations: [{
            id: 'fallback-small', text: 'doc-fallback-small', memoryIds: [], ftsIds: [stored.ids[smallFallbackIndex]],
            ftsLocators: [{ ftsId: stored.ids[smallFallbackIndex], sourcePath: 'doc-fallback-small.md', chunkIndex: 1, lineStart: 1, lineEnd: 1 }],
          }],
        },
        'group/e': {
          hot_relations: [{
            id: 'fallback-ranking', text: 'doc-fallback-ranking', memoryIds: [],
            ftsIds: stored.ids.slice(rankingStart, pipeAIndex),
            ftsLocators: stored.ids.slice(rankingStart, pipeAIndex).map((ftsId, index) => ({
              ftsId, sourcePath: 'doc-fallback-ranking.md', chunkIndex: index + 1,
              lineStart: index * 2 + 1, lineEnd: index * 2 + 1,
            })),
          }],
        },
        'a|b': {
          hot_relations: [{
            id: 'pipe-a', text: 'c', memoryIds: [], ftsIds: [stored.ids[pipeAIndex]],
            ftsLocators: [{ ftsId: stored.ids[pipeAIndex], sourcePath: 'c.md', chunkIndex: 1, lineStart: 1, lineEnd: 1 }],
          }],
        },
        a: {
          hot_relations: [{
            id: 'pipe-b', text: 'b|c', memoryIds: [], ftsIds: [stored.ids[pipeBIndex]],
            ftsLocators: [{ ftsId: stored.ids[pipeBIndex], sourcePath: 'b|c.md', chunkIndex: 1, lineStart: 1, lineEnd: 1 }],
          }],
        },
      },
    });
  });

  after(async () => {
    const { closeFtsEngine } = await import('../src/lib/fts-client.js');
    await closeFtsEngine(scope);
    cleanupTestConfig();
  });

  it('多个 Group 独立返回，同文档多个 chunk 合并并返回原文命中行', async () => {
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope, query: 'FTS-only Collection', mode: 'fulltext', limit: 10, tags: 'ki-search' });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.mode, 'fulltext');
    assert.equal(
      result.total,
      3,
      `最终 total 应按文档计数：${JSON.stringify(result.results.map(({ group, relation, ftsIds, content }) => ({ group, relation, ids: ftsIds?.length, content })))}`,
    );
    assert.equal(result.results.length, 3);

    const docA = result.results.find((hit) => hit.relation === 'doc-a');
    const docB = result.results.find((hit) => hit.relation === 'doc-b');
    const docC = result.results.find((hit) => hit.relation === 'doc-c');
    assert.ok(docA);
    assert.ok(docB);
    assert.ok(docC);
    assert.equal(docA.group, 'group/a');
    assert.equal(docB.group, 'group/b');
    assert.equal(docA.indexType, 'fts');
    assert.equal(docA.ftsIds?.length, 4, '同一文档的多个 FTS chunk 应聚合');
    assert.deepEqual(docA.matches?.map((match) => [match.lineStart, match.lineEnd]), [[3, 3], [7, 7], [9, 9]]);
    assert.equal(docA.matchCount, 4, 'matchCount 应保留文档的完整命中区域数');
    assert.equal(docA.matchCountComplete, true);
    assert.equal(docA.matchesTruncated, true, '超过默认前 3 个区域时应标记截断');
    assert.match(docA.originalExcerpt ?? '', /3 \| FTS-only Collection first hit/);
    assert.match(docA.originalExcerpt ?? '', /7 \| FTS-only Collection second hit/);
    assert.match(docA.originalExcerpt ?? '', /9 \| FTS-only Collection third hit/);
    assert.doesNotMatch(docA.originalExcerpt ?? '', /11 \| FTS-only Collection fourth hit/);
    assert.equal(docA.original, undefined, '默认只返回命中片段，不返回完整原文');
    assert.equal(docB.matchCount, 1, '单个命中区域应保留准确计数');
    assert.equal(docB.matchCountComplete, true);
    assert.equal(docB.matchesTruncated, false, '未超过前 3 个区域时不应标记截断');
    assert.deepEqual(docC.matches, [], '缺失原文时不返回伪造的行号片段');
    assert.equal(docC.matchCount, 0, '缺失原文时可复核命中区域数应为 0');
    assert.equal(docC.matchCountComplete, false, '缺失原文时不能声称计数完整');
    assert.equal(docC.matchesTruncated, false, '缺失原文时不应报告截断');
    assert.match(docC.originalHint ?? '', /原文不可用/);
  });

  it('完整原文扫描不受 FTS 候选 chunk 上限影响', async () => {
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope, query: 'overflow marker', mode: 'fulltext', limit: 1, tags: 'overflow-test' });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.results.length, 1);
    const hit = result.results[0];
    assert.equal(hit.relation, 'doc-overflow');
    assert.equal(hit.matchCount, 60, '应扫描原文全部 60 个区域，而不是只计候选 chunk');
    assert.equal(hit.ftsIds?.length, 50, '应确认底层 FTS 候选池确实达到 50 条上限');
    assert.equal(hit.matchCountComplete, true);
    assert.equal(hit.matchesTruncated, true);
    assert.equal(hit.matches?.length, 3);
  });

  it('fallback 候选池饱和时明确标记计数不完整', async () => {
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope, query: 'needle', mode: 'fulltext', limit: 1, tags: 'fallback-test' });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const hit = result.results.find((item) => item.relation === 'doc-fallback');
    assert.ok(hit);
    assert.equal(hit.matchCountComplete, false);
    assert.equal(hit.ftsIds?.length, 50, 'fallback 场景应确认候选池已饱和');
    assert.equal(hit.matchesTruncated, true);
    assert.equal(hit.matchCount, 51, '应合并原文直接命中与 50 个 chunk fallback 命中');
    assert.ok(hit.matches?.some((match) => match.lineStart === 1), '原文直接命中应保留');
    assert.ok(hit.matches?.some((match) => match.lineStart >= 3), '候选 chunk 的 fallback 命中也应保留');
  });

  it('fallback 候选池未饱和时可声明计数完整', async () => {
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope, query: 'needle', mode: 'fulltext', limit: 1, tags: 'fallback-small-test' });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const hit = result.results.find((item) => item.relation === 'doc-fallback-small');
    assert.ok(hit);
    assert.equal(hit.matchCount, 1);
    assert.equal(hit.matchCountComplete, true);
    assert.equal(hit.matchesTruncated, false);
  });

  it('全文搜索按各 fallback chunk 自己的内容为原文区域排序', async () => {
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope, query: 'needle', mode: 'fulltext', limit: 1, tags: 'fallback-ranking-test' });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const hit = result.results.find((item) => item.relation === 'doc-fallback-ranking');
    assert.ok(hit);
    assert.match(hit.content ?? '', /focus-a/, 'fixture 需让低密度 focus-a chunk 成为最高分原文样本');
    assert.deepEqual(
      hit.matches?.map((match) => match.lineStart),
      [3, 5, 7],
      '应按每个 chunk 的 fallback 词项覆盖和原文命中密度选出 B/C/D，而非错误地抬高最高分 chunk A',
    );
    assert.equal(hit.matchCount, 4);
    assert.equal(hit.matchCountComplete, true);
  });

  it('Group 与 relation 中的竖线不会造成文档聚合 key 碰撞', async () => {
    const { executeSearch } = await import('../src/search.js');
    const result = await executeSearch({ scope, query: 'pipe key collision', mode: 'fulltext', limit: 10, tags: 'collision-test' });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(
      result.results.length,
      2,
      `应保留两份独立文档：${JSON.stringify(result.results.map(({ group, relation, content }) => ({ group, relation, content })))}`,
    );
    assert.deepEqual(
      result.results.map((hit) => [hit.group, hit.relation]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [['a', 'b|c'], ['a|b', 'c']],
    );
  });
});
