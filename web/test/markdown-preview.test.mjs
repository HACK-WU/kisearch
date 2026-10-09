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
const { isBlankMermaidSvg, normalizeCodeForCopy, renderMarkdownHtml } = await vite.ssrLoadModule('/src/components/MarkdownPreview.tsx');
after(async () => vite.close());

describe('MarkdownPreview safe interactive Markdown', () => {
  it('renders Markdown headings while ignoring heading-looking text inside fenced code', () => {
    const html = renderMarkdownHtml(
      '# 第一章\n\n## 第二节\n\n```md\n# 代码中的文本\n```',
    );

    assert.match(html, /<h1>第一章<\/h1>/);
    assert.match(html, /<h2>第二节<\/h2>/);
    assert.equal((html.match(/<h[1-6][^>]*>/g) ?? []).length, 2);
    assert.match(html, /# 代码中的文本/);
  });

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

  it('labels each code block toolbar with its language, falling back to 代码', () => {
    const html = renderMarkdownHtml('```bash\necho hi\n```\n\n```\nplain\n```');

    assert.match(html, /<div class="ki-code-block__bar"><span class="ki-code-lang">bash<\/span>/);
    assert.match(html, /<div class="ki-code-block__bar"><span class="ki-code-lang">代码<\/span>/);
    // 工具条替代了旧的绝对定位浮层：按钮收在工具条内，其后紧随 pre（内容区拿到完整宽度）
    assert.match(html, /<\/button><\/div><pre><code class="language-bash">/);
  });

  it('drops empty fenced code blocks instead of rendering a bare copy button（走查 2026-10-09）', () => {
    const html = renderMarkdownHtml('```\n```\n\n```text\n   \n```\n\n有内容\n');

    assert.equal((html.match(/data-ki-copy-code/g) ?? []).length, 0);
    assert.doesNotMatch(html, /ki-code-block/);
    assert.match(html, /有内容/);
  });

  it('treats graphic-less mermaid output as blank so the source block is kept', () => {
    // 语法成立但无节点：mermaid 返回只有外壳的 svg（不抛错）→ 判定为空白
    assert.equal(isBlankMermaidSvg('<svg id="x" width="100%"><style>#x{font-family:sans-serif;}</style><g></g></svg>'), true);
    assert.equal(isBlankMermaidSvg('<svg id="y"><defs></defs></svg>'), true);
    assert.equal(isBlankMermaidSvg('<svg id="z"><g><path d="M0 0L1 1"></path><text>hi</text></g></svg>'), false);
  });

  it('removes only trailing line breaks from copied code, preserving internal lines and spaces', () => {
    assert.equal(normalizeCodeForCopy('echo hello\n'), 'echo hello');
    assert.equal(normalizeCodeForCopy('one\r\ntwo  \r\n\r\n'), 'one\r\ntwo  ');
    assert.equal(normalizeCodeForCopy('no newline'), 'no newline');
  });
});
