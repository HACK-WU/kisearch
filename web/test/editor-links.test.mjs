import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
const { encodeKiLink, parseKiLink, paragraphAnchor, deepLink } = await vite.ssrLoadModule('/src/lib/kiLinks.ts');
const { renderMarkdownHtml } = await vite.ssrLoadModule('/src/components/MarkdownPreview.tsx');
after(async () => vite.close());

describe('editor jump links', () => {
  it('opens only the new document link in a new page and keeps the old relative link unchanged', () => {
    const target = { v: 1, type: 'document', scope: 'docs', group: 'guide', relation: 'intro', anchor: paragraphAnchor('p', '目标段落') };
    const encoded = encodeKiLink(target);
    const html = renderMarkdownHtml(`[跳转](${encoded}) 和 [旧链接](other.md)`);
    assert.deepEqual(parseKiLink(encoded), target);
    assert.match(html, /class="ki-jump-link"[^>]+target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /href="\/browse\?scope=docs&amp;group=guide&amp;relation=intro&amp;anchor=p-/);
    assert.match(html, /<a href="other\.md">旧链接<\/a>/);
    assert.equal(deepLink(target).includes('anchor='), true);
  });

  it('allows HTTP(S) external targets and rejects unsafe encoded targets', () => {
    const external = encodeKiLink({ v: 1, type: 'external', url: 'https://example.com/x' });
    assert.match(renderMarkdownHtml(`[资料](${external})`), /href="https:\/\/example\.com\/x" target="_blank"/);
    const unsafe = `ki-link:${encodeURIComponent(JSON.stringify({ v: 1, type: 'external', url: 'javascript:alert(1)' }))}`;
    assert.equal(parseKiLink(unsafe), null);
    assert.doesNotMatch(renderMarkdownHtml(`[坏链接](${unsafe})`), /href="javascript:/);
    const withParen = encodeKiLink({ v: 1, type: 'external', url: 'https://example.com/a)' });
    assert.match(withParen, /%29/);
    assert.match(renderMarkdownHtml(`[括号](${withParen})`), /href="https:\/\/example\.com\/a\)"/);
  });
});
