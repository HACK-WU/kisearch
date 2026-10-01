import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { createServer } from 'vite';
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ root: webRoot, configFile: path.join(webRoot, 'vite.config.ts'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
const { renderMarkdownBlocks, renderMarkdownHtml } = await vite.ssrLoadModule('/src/components/MarkdownPreview.tsx');
const { buildTimeline, mergeInterleaveItems, layoutAnswerFlow } = await vite.ssrLoadModule('/src/chat/answerFlow.ts');
const { chatReducer, INITIAL_CHAT_STATE } = await vite.ssrLoadModule('/src/chat/chatStore.ts');
after(() => vite.close());
describe('complete Markdown parse with trace layout at legal block boundaries', () => {
  for (const fixture of [
    { name: 'fenced code', prefix: '```ts\nconst a = 1;\n', suffix: 'console.log(a);\n```\n\nExplanation.' },
    { name: 'table', prefix: '| Name | Meaning |\n| --- | --- |\n', suffix: '| a | variable |\n| b | constant |' },
    { name: 'reference link', prefix: 'See [docs][doc].\n\n', suffix: '[doc]: https://example.com/docs' },
    { name: 'nested list', prefix: '1. First\n   - nested\n', suffix: '   - another\n2. Second\n' },
    { name: 'blockquote', prefix: '> first\n', suffix: '> second\n' },
  ]) {
    it(`preserves ${fixture.name} when a trace occurs inside its source`, () => {
      const text = fixture.prefix + fixture.suffix;
      const blocks = renderMarkdownBlocks(text);
      const parts = layoutAnswerFlow(blocks, [{ key: 't0', kind: 'tool', running: false, label: 'search', afterChars: fixture.prefix.length }]);
      const html = parts.filter((p) => p.kind === 'markdown').map((p) => p.block.html).join('');
      assert.equal(html, renderMarkdownHtml(text));
      assert.equal(parts.filter((p) => p.kind === 'trace').length, 1);
    });
  }
  it('preserves image paths with spaces and raw trace offsets after preprocessing', () => {
    const prefix = '![图](./my image.png)\r\n\r\n';
    const text = prefix + 'After image.\r\n\r\n[unused]: https://example.com';
    const blocks = renderMarkdownBlocks(text);
    assert.equal(blocks.filter((b) => b.html).map((b) => b.html).join(''), renderMarkdownHtml(text));
    assert.match(blocks[0].html, /my%20image.png/);
    const paragraph = blocks.find((b) => b.raw.startsWith('After image.'));
    assert.equal(paragraph.start, prefix.length);
    const parts = layoutAnswerFlow(blocks, [{ key: 'tool', kind: 'tool', label: 'search', running: false, afterChars: prefix.length }]);
    assert.ok(parts.findIndex((p) => p.kind === 'trace') < parts.findIndex((p) => p.kind === 'markdown' && p.block === paragraph));
  });
  it('keeps trace parent keys stable while an unfinished fenced block grows', () => {
    const trace = { key: 't0', kind: 'tool', running: true, label: 'search', afterChars: 12 };
    const before = layoutAnswerFlow(renderMarkdownBlocks('```js\nvalue();'), [trace]);
    const after = layoutAnswerFlow(renderMarkdownBlocks('```js\nvalue();\nmore();'), [trace]);
    assert.equal(before.find((p) => p.kind === 'trace').key, after.find((p) => p.kind === 'trace').key);
  });
  it('keeps completed Mermaid/details blocks stable while the trailing paragraph grows', () => {
    const initial = '```mermaid\ngraph TD\n  A-->B\n```\n\n<details>\n<summary>Detail</summary>\n\nbody\n</details>\n\nTail';
    const first = renderMarkdownBlocks(initial), next = renderMarkdownBlocks(initial + ' expands', first);
    for (const block of first.filter((b) => b.raw.includes('mermaid') || b.raw.includes('<details>'))) {
      const updated = next.find((b) => b.key === block.key);
      assert.equal(updated.html, block.html); assert.equal(updated.complete, true);
    }
    assert.equal(renderMarkdownBlocks('```mermaid\ngraph TD\nA-->B')[0].complete, false);
  });
  it('uses the same tool key before and after its end event', () => {
    const start = { kind: 'tool', phase: 'start', label: 'search', afterChars: 0, order: 1 };
    const end = { kind: 'tool', phase: 'end', label: '2 hits', hits: 2, afterChars: 0, order: 2 };
    assert.equal(buildTimeline([start])[0].key, buildTimeline([start, end])[0].key);
  });
  it('preserves reasoning → tool → reasoning when all share one text anchor', () => {
    let state = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm2' });
    for (const action of [
      { type: 'streamReasoning', text: 'before' },
      { type: 'streamProgress', step: { kind: 'tool', phase: 'start', label: 'search' } },
      { type: 'streamProgress', step: { kind: 'tool', phase: 'end', label: 'hits', hits: 2 } },
      { type: 'streamReasoning', text: 'after' },
    ]) state = chatReducer(state, action);
    const items = mergeInterleaveItems(buildTimeline(state.streaming.progress), state.streaming.reasoningSegs);
    assert.deepEqual(items.map((i) => i.kind === 'reason' ? i.text : i.kind), ['before', 'tool', 'after']);
  });
});
