import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { ensureScopeDir, writeJson } from '../src/lib/store.js';
import { getLocalKbDir, getRelationsCachePath } from '../src/lib/scope.js';

const scope = `fulltext-locator-${Date.now()}`;

describe('executeSearch fulltext 原文定位', () => {
  before(async () => {
    registerTestScope(scope);
    ensureScopeDir(scope);

    const { ftsBulkStore, getFtsDocId } = await import('../src/lib/fts-client.js');
    const entries = [
      { scope, group: 'group/a', relation: 'doc-a', text: 'FTS-only Collection first hit', tag: 'ki-search' },
      { scope, group: 'group/a', relation: 'doc-a', text: 'FTS-only Collection second hit', tag: 'ki-search' },
      { scope, group: 'group/b', relation: 'doc-b', text: 'FTS-only Collection another document', tag: 'ki-search' },
      { scope, group: 'group/c', relation: 'doc-c', text: 'FTS-only Collection missing original', tag: 'ki-search' },
    ];
    const stored = await ftsBulkStore(entries);

    writeJson(getLocalKbDir(scope, 'group/a'), {
      'doc-a': '# Doc A\n\nFTS-only Collection first hit\n\n无关内容\n\nFTS-only Collection second hit',
    });
    writeJson(getLocalKbDir(scope, 'group/b'), {
      'doc-b': '# Doc B\n\nFTS-only Collection another document',
    });
    writeJson(getRelationsCachePath(scope), {
      scope,
      groups: {
        'group/a': {
          hot_relations: [{
            id: 'a',
            text: 'doc-a',
            memoryIds: [],
            ftsIds: stored.ids.slice(0, 2),
            ftsLocators: stored.ids.slice(0, 2).map((ftsId, index) => ({
              ftsId,
              sourcePath: 'doc-a.md',
              chunkIndex: index + 1,
              lineStart: index === 0 ? 3 : 7,
              lineEnd: index === 0 ? 3 : 7,
            })),
          }],
        },
        'group/b': {
          hot_relations: [{
            id: 'b',
            text: 'doc-b',
            memoryIds: [],
            ftsIds: [stored.ids[2]],
            ftsLocators: [{ ftsId: stored.ids[2], sourcePath: 'doc-b.md', chunkIndex: 1, lineStart: 3, lineEnd: 3 }],
          }],
        },
        'group/c': {
          hot_relations: [{
            id: 'c',
            text: 'doc-c',
            memoryIds: [],
            ftsIds: [stored.ids[3]],
            ftsLocators: [{ ftsId: stored.ids[3], sourcePath: 'doc-c.md', chunkIndex: 1, lineStart: 1, lineEnd: 1 }],
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
    const result = await executeSearch({ scope, query: 'FTS-only Collection', mode: 'fulltext', limit: 10 });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.mode, 'fulltext');
    assert.equal(result.total, 3, '最终 total 应按文档计数');
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
    assert.equal(docA.ftsIds?.length, 2, '同一文档的两个 FTS chunk 应聚合');
    assert.deepEqual(docA.matches?.map((match) => [match.lineStart, match.lineEnd]), [[3, 3], [7, 7]]);
    assert.match(docA.originalExcerpt ?? '', /3 \| FTS-only Collection first hit/);
    assert.match(docA.originalExcerpt ?? '', /7 \| FTS-only Collection second hit/);
    assert.equal(docA.original, undefined, '默认只返回命中片段，不返回完整原文');
    assert.deepEqual(docC.matches, [], '缺失原文时不返回伪造的行号片段');
    assert.match(docC.originalHint ?? '', /原文不可用/);
  });
});
