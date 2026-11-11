import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializeToolResponse } from '../../src/lib/chat/retrieval/tool-response.js';

describe('actual tool response with a single total character budget', () => {
  it('preserves every returned field, hit and long excerpt within the budget', () => {
    const raw = { ok: true, total: 12, extra: { cursor: 'next', flags: [false, null] }, results: Array.from({ length: 8 }, (_, i) => ({ relation: `doc-${i}`, score: i / 10, originalExcerpt: '证据'.repeat(200) })) };
    const response = serializeToolResponse(raw);
    assert.equal(response.text, JSON.stringify(raw, null, 2));
    assert.deepEqual(JSON.parse(response.text), raw);
    assert.equal(response.truncated, false);
    assert.equal(response.originalChars, Array.from(response.text).length);
  });
  for (const length of [9999, 10000, 10001]) {
    it(`handles the ${length}-character boundary including the truncation notice`, () => {
      const response = serializeToolResponse('中'.repeat(length - 2));
      assert.equal(response.originalChars, length);
      assert.equal(response.truncated, length > 10000);
      assert.ok(Array.from(response.text).length <= 10000);
      if (length <= 10000) assert.equal(JSON.parse(response.text), '中'.repeat(length - 2));
      else assert.match(response.text, /10000 字符，已截断/);
    });
  }
  it('counts emoji as characters and never leaves a split surrogate pair', () => {
    const response = serializeToolResponse('😀'.repeat(10000));
    assert.equal(response.originalChars, 10002);
    assert.equal(Array.from(response.text).length, 10000);
    assert.ok(response.text.isWellFormed());
    assert.equal(response.truncated, true);
  });
  it('preserves the full returned error envelope', () => {
    const raw = { ok: false, error: 'unavailable', code: 'SEARCH_FAILED', details: { retryable: false } };
    assert.deepEqual(JSON.parse(serializeToolResponse(raw).text), raw);
  });
});

/**
 * 结构化截断（2026-11-11）：超预算时**只压最长的正文字段**，其余字段与 JSON 结构保留。
 *
 * 动机（真实故障）：`ki_get_module_info` 返回 `{ok, scope, content, revision, totalLines}`，
 * 旧实现从字符串尾部硬切 ⇒ 长文档的 `revision` 永远拿不到 ⇒ `ki_edit_relation` 无法开工。
 */
describe('structured truncation keeps every field but the body', () => {
  it('keeps revision/totalLines/ok of a long document and only shrinks content', () => {
    const content = '这一行是正文。'.repeat(4200); // ≈ 33600 字符，单篇长文档
    const raw = {
      ok: true,
      scope: 'k8s',
      content,
      revision: 'a'.repeat(64),
      totalLines: 1043,
    };
    const response = serializeToolResponse(raw);
    const parsed = JSON.parse(response.text) as typeof raw;

    assert.equal(response.truncated, true);
    assert.equal(response.originalChars, Array.from(JSON.stringify(raw, null, 2)).length);
    assert.ok(Array.from(response.text).length <= 10000, '超预算时必须压进上限');

    assert.equal(parsed.ok, true);
    assert.equal(parsed.scope, 'k8s');
    assert.equal(parsed.revision, raw.revision, 'revision 必须原样保留（否则 edit 无法开工）');
    assert.equal(parsed.totalLines, 1043);
    assert.ok(parsed.content.length < content.length, 'content 应被削短');
    assert.match(parsed.content, /…\[已截断：原文 \d+ 字符\]$/);
  });

  it('shrinks every oversized excerpt of a hit list and keeps hit metadata', () => {
    const excerpt = '😀原文'.repeat(4000); // 12000 码点 / 条
    const raw = {
      ok: true,
      scope: 'default',
      total: 8,
      results: Array.from({ length: 8 }, (_, i) => ({
        group: 'reference',
        relation: `doc-${i}`,
        lineStart: 1,
        lineEnd: 2,
        score: i / 10,
        originalExcerpt: excerpt,
      })),
    };
    const response = serializeToolResponse(raw);
    const parsed = JSON.parse(response.text) as typeof raw;

    assert.ok(Array.from(response.text).length <= 10000);
    assert.equal(parsed.results.length, 8, '命中条数不得减少');
    parsed.results.forEach((hit, i) => {
      assert.equal(hit.relation, `doc-${i}`);
      assert.equal(hit.group, 'reference');
      assert.equal(hit.score, i / 10);
      assert.ok(hit.originalExcerpt.length < excerpt.length);
      assert.ok(hit.originalExcerpt.isWellFormed(), '按码点切，不得劈开代理对');
    });
  });

  it('keeps list metadata and cuts the list with a readable sentinel when all fields are short', () => {
    const scopes = Array.from({ length: 157 }, (_, i) => ({
      scope: `scope-${i}`,
      kb: true,
      vector: true,
      registered: i < 4,
      wikiCount: 100 + i,
      topGroups: [`g-${i}-a`, `g-${i}-b`],
    }));
    const raw = { ok: true, scopeMode: 'default', vectorAvailable: true, count: 157, scopes };
    const response = serializeToolResponse(raw);
    const parsed = JSON.parse(response.text) as typeof raw & { scopes: unknown[] };

    assert.ok(Array.from(response.text).length <= 10000);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.count, 157, '总数字段必须原样保留（模型据此知道真实规模）');
    assert.ok(parsed.scopes.length < 157, '列表应被截短');
    assert.equal(typeof parsed.scopes[0], 'object', '前面仍是原始元素');
    const sentinel = parsed.scopes.at(-1);
    assert.equal(typeof sentinel, 'string');
    assert.match(sentinel as string, /^…\[已截断：共 157 项，此处省略 \d+ 项\]$/);
  });

  it('does not throw when an outer list is cut before its nested lists', () => {
    // 外层数组被截断后，内层数组的路径已失效 —— 曾经会在 `arr.length = …` 上抛 TypeError
    const raw = {
      ok: true,
      results: Array.from({ length: 40 }, (_, i) => ({
        relation: `doc-${i}`,
        chunks: Array.from({ length: 60 }, (_, j) => `chunk-${i}-${j}-内容占位`),
      })),
    };
    const response = serializeToolResponse(raw);
    const parsed = JSON.parse(response.text) as { ok: boolean; results: unknown[] };

    assert.ok(Array.from(response.text).length <= 10000);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.results.length < 40, '外层列表应被截短');
  });

  it('handles a mixed payload that needs both the body and the list shrunk', () => {
    const raw = {
      ok: true,
      note: 'N'.repeat(50_000),
      items: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `item-${i}` })),
    };
    const response = serializeToolResponse(raw);
    const parsed = JSON.parse(response.text) as { ok: boolean; note: string; items: unknown[] };

    assert.ok(Array.from(response.text).length <= 10000);
    assert.equal(parsed.ok, true);
    assert.match(parsed.note, /…\[已截断：原文 50000 字符\]$/);
    assert.ok(parsed.items.length < 400);
    assert.match(parsed.items.at(-1) as string, /^…\[已截断：共 400 项/);
  });

  it('falls back to the legacy prefix cut for non-object values', () => {
    const response = serializeToolResponse('中'.repeat(20_000));
    assert.equal(response.truncated, true);
    assert.ok(Array.from(response.text).length <= 10000);
    assert.match(response.text, /工具返回超过 10000 字符，已截断/);
  });

  it('falls back when nothing is worth shrinking (many short fields)', () => {
    const raw = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`key-${i}`, `v${i}`]));
    const response = serializeToolResponse(raw);
    assert.equal(response.truncated, true);
    assert.ok(Array.from(response.text).length <= 10000);
    assert.match(response.text, /工具返回超过 10000 字符，已截断\]$/);
  });

  it('never mutates the caller payload', () => {
    const content = '正文'.repeat(6000);
    const raw = { ok: true, content, revision: 'r'.repeat(64) };
    serializeToolResponse(raw);
    assert.equal(raw.content, content, '调用方对象不得被就地改写');
  });
});
