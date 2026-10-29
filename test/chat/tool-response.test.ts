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
