import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { normalizeCodeForCopy, renderMarkdownHtml } = await vite.ssrLoadModule('/src/components/MarkdownPreview.tsx');
after(async () => vite.close());

describe('MarkdownPreview safe interactive Markdown', () => {
  it('renders foldable details and summary while preserving Markdown in the body', () => {
    const html = renderMarkdownHtml(
      '<details>\n<summary>答案与解析</summary>\n\n**答案：** B\n</details>\n\n后续内容',
    );

    assert.match(html, /<details><summary>答案与解析<\/summary>/);
    assert.match(html, /<strong>答案：<\/strong> B/);
    assert.match(html, /<\/details>/);
    assert.match(html, /<p>后续内容<\/p>/);
  });

  it('supports nested details and ignores closing-tag examples inside fenced code', () => {
    const html = renderMarkdownHtml(
      '<details open>\n<summary>外层</summary>\n\n'
      + '<details>\n<summary>内层</summary>\n\n内容\n</details>\n\n'
      + '```html\n</details>\n```\n</details>',
    );

    assert.match(html, /<details open><summary>外层<\/summary>/);
    assert.match(html, /<details><summary>内层<\/summary>/);
    assert.match(html, /&lt;\/details&gt;/);
    assert.equal((html.match(/<details(?:\s|>)/g) ?? []).length, 2);
  });

  it('preserves only the open boolean attribute and strips other raw HTML attributes/content', () => {
    const html = renderMarkdownHtml(
      '<details class="unsafe" title=" open " onmouseover="alert(1)">\n'
      + '<summary onclick="alert(1)">Safe</summary>\n\n<script>alert(1)</script>\n</details>',
    );

    assert.match(html, /<details><summary>Safe<\/summary>/);
    assert.doesNotMatch(html, /class="unsafe"|title=|onmouseover|onclick|<script/i);
  });

  it('preserves the HTML boolean open state when written with an explicit empty value', () => {
    const html = renderMarkdownHtml('<details open="">\n<summary>已展开</summary>\n\n内容\n</details>');
    assert.match(html, /<details open><summary>已展开<\/summary>/);
  });

  it('supports a summary on the same line as the details opener', () => {
    const html = renderMarkdownHtml('<details><summary>紧凑标题</summary>\n\n正文\n</details>');
    assert.match(html, /<details><summary>紧凑标题<\/summary>/);
    assert.match(html, /<p>正文<\/p>/);
  });

  it('adds copy controls to code and Mermaid while escaping code as text', () => {
    const html = renderMarkdownHtml(
      '```html\n<img src=x onerror="alert(1)">\n```\n\n'
      + '```mermaid\ngraph TD\n  A-->B\n```',
    );

    assert.equal((html.match(/data-ki-copy-code/g) ?? []).length, 2);
    assert.match(html, /class="language-html"/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /class="language-mermaid"/);
  });

  it('removes only trailing line breaks from copied code, preserving internal lines and spaces', () => {
    assert.equal(normalizeCodeForCopy('echo hello\n'), 'echo hello');
    assert.equal(normalizeCodeForCopy('one\r\ntwo  \r\n\r\n'), 'one\r\ntwo  ');
    assert.equal(normalizeCodeForCopy('no newline'), 'no newline');
  });
});
