/**
 * content-vector-match.test.ts —— 内容向量归属判据的唯一实现（纯函数，离线可跑）
 *
 * 背景：这份判据决定「哪些向量属于待删/待隐藏的这篇文档」，两侧（delete-relation /
 * visibility-index）共用。判错任一方向都不可逆——多删会让别人的文档静默失去语义召回，
 * 少删则留下能被搜到的孤儿向量。故单独立测，不依赖向量引擎。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/content-vector-match.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  pickContentVectorHits,
  recomputeContentVectorIds,
  contentVectorTags,
  extractKbBody,
  MIN_CONTENT_MATCH_LEN,
} from '../src/lib/content-vector-match.js';
import { generateDocId } from '../src/lib/vector-client.js';

const LONG_TEXT = '这是一段足够长的正文片段，用于验证正文比对判据能够正确识别归属关系，长度远超阈值。';

function hit(memoryId: string, content: string, tag?: string) {
  return { memoryId, content, tag };
}

describe('pickContentVectorHits', () => {
  it('正文包含候选内容 → 归属本篇', () => {
    const body = `# 标题\n\n${LONG_TEXT}\n\n## 小节\n\n补充`;
    const result = pickContentVectorHits([hit('v1', LONG_TEXT, 'ki-search')], { relation: '标题', body });
    assert.deepEqual(result.hits.map((h) => h.memoryId), ['v1']);
    assert.equal(result.bodyMatched, 1);
    assert.equal(result.ambiguous, 0);
  });

  it('候选短于阈值 → 不参与正文比对（避免公共短串撞车）', () => {
    const shortText = '短片段';
    assert.ok(shortText.length < MIN_CONTENT_MATCH_LEN);
    const body = `# 标题\n\n${shortText}\n\n${LONG_TEXT}`;
    const result = pickContentVectorHits([hit('v1', shortText, 'ki-search')], { relation: '标题', body });
    assert.equal(result.hits.length, 0, '过短内容不得据此判定归属');
  });

  it('同时被同组其他文档正文包含 → 判歧义，宁可不删', () => {
    const body = `# 标题\n\n${LONG_TEXT}`;
    const sibling = `# 另一篇\n\n${LONG_TEXT}`;
    const result = pickContentVectorHits([hit('v1', LONG_TEXT, 'ki-search')], {
      relation: '标题',
      body,
      siblingBodies: [sibling],
    });
    assert.equal(result.hits.length, 0);
    assert.equal(result.ambiguous, 1);
  });

  it('ki-relation / ki-path 一律排除（由专职函数清理）', () => {
    const body = `# 标题\n\n${LONG_TEXT}`;
    const result = pickContentVectorHits(
      [hit('r1', '标题', 'ki-relation'), hit('p1', '标题 子组', 'ki-path'), hit('v1', LONG_TEXT, 'ki-search')],
      { relation: '标题', body },
    );
    assert.deepEqual(result.hits.map((h) => h.memoryId), ['v1']);
  });

  it('无正文时退回标题前缀判据（历史行为保留）', () => {
    const result = pickContentVectorHits(
      [hit('v1', `# 归档标题\n\n${LONG_TEXT}`, 'ki-search')],
      { relation: '归档标题', body: null },
    );
    assert.deepEqual(result.hits.map((h) => h.memoryId), ['v1']);
  });

  it('剥离「【标签:xxx】」前缀后再比对', () => {
    const body = `# 标题\n\n${LONG_TEXT}`;
    const result = pickContentVectorHits([hit('v1', `【标签:api】${LONG_TEXT}`, 'ki-search')], { relation: '标题', body });
    assert.deepEqual(result.hits.map((h) => h.memoryId), ['v1']);
  });

  it('标题前缀判据要求 relation 后是边界（不误吃「标题工具」这类长名）', () => {
    const result = pickContentVectorHits([hit('v1', '# 标题工具的说明文档，内容与本篇无关但足够长', 'ki-search')], {
      relation: '标题',
      body: null,
    });
    assert.equal(result.hits.length, 0, '「标题工具」不是「标题」的标题行');
  });
});

describe('recomputeContentVectorIds', () => {
  it('按 ki-search + 自定义 tag 各算一条 docId', () => {
    const ids = recomputeContentVectorIds('s1', '正文', ['api', 'auth']);
    assert.equal(ids.length, 3);
    assert.ok(ids.includes(generateDocId('正文', 's1', 'ki-search')));
    assert.ok(ids.includes(generateDocId('正文', 's1', 'api')));
    assert.ok(ids.includes(generateDocId('正文', 's1', 'auth')));
  });

  it('重复 / 空 tag 去重，空正文不产生候选', () => {
    assert.deepEqual(contentVectorTags(['api', 'api', '', 'ki-search']), ['ki-search', 'api']);
    assert.deepEqual(recomputeContentVectorIds('s1', '', ['api']), []);
  });
});

describe('extractKbBody', () => {
  it('支持 string / {moduleInfo} / {content} 三种形态', () => {
    assert.equal(extractKbBody('正文'), '正文');
    assert.equal(extractKbBody({ moduleInfo: 'm' }), 'm');
    assert.equal(extractKbBody({ content: 'c' }), 'c');
  });

  it('条目不存在或形态不认识 → null（调用方据此放弃重算，不当作空正文）', () => {
    assert.equal(extractKbBody(undefined), null);
    assert.equal(extractKbBody({ foo: 1 }), null);
  });
});
