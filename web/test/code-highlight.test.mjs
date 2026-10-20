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
const { renderMarkdownHtml, renderMarkdownBlocks } = await vite.ssrLoadModule('/src/components/MarkdownPreview.tsx');
const {
  highlightCodeHtml,
  resolveHighlightLanguage,
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINES,
} = await vite.ssrLoadModule('/src/lib/codeHighlight.ts');
after(async () => vite.close());

const codeText = (html, index = 0) => {
  const inner = [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)][index]?.[1] ?? '';
  return inner
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
};

const TS_SAMPLE = 'const modelA = await initChatModel("qwen3.8-flash", { apiKey: API_KEY }); // 初始化';
const PY_SAMPLE = 'from langchain.chat_models import init_chat_model\nprint(42)';

describe('代码块语法高亮（highlight.js）', () => {
  it('按围栏语言着色，且 DOM 形状仍是 pre > code.language-X', () => {
    const html = renderMarkdownHtml(`\`\`\`ts\n${TS_SAMPLE}\n\`\`\``);

    assert.match(html, /<pre><code class="language-ts">/);
    // 至少三族 token：关键字 / 字符串 / 注释
    assert.match(html, /hljs-keyword/);
    assert.match(html, /hljs-string/);
    assert.match(html, /hljs-comment/);
    // 只允许出现 hljs 的 span，不得混入其他标签
    assert.doesNotMatch(html, /<(?!\/?(?:span|pre|code|div|button)\b)[a-z]/i);
  });

  it('着色不改变代码文本（复制链路取的是 textContent）', () => {
    for (const [lang, sample] of [['ts', TS_SAMPLE], ['python', PY_SAMPLE]]) {
      const html = renderMarkdownHtml(`\`\`\`${lang}\n${sample}\n\`\`\``);
      assert.equal(codeText(html), sample, `${lang} 高亮后文本必须与原文逐字节一致`);
    }
  });

  it('语言别名归一：ts/py/html/yml 命中，text/mermaid/未知语言不着色', () => {
    // 返回的是「归一后的围栏名」，不是 getLanguage().name 的显示名 —— 显示名（如 `HTML, XML`）
    // 再喂回 highlight 会查不到语法并抛 Unknown language（实测 html 块因此整块失去颜色）
    assert.equal(resolveHighlightLanguage('ts'), 'ts');
    assert.equal(resolveHighlightLanguage('TS'), 'ts');
    assert.equal(resolveHighlightLanguage('py'), 'py');
    assert.equal(resolveHighlightLanguage('html'), 'html');
    assert.equal(resolveHighlightLanguage('yml'), 'yml');
    assert.equal(resolveHighlightLanguage('jsonc'), 'jsonc');
    assert.equal(resolveHighlightLanguage('text'), null);
    assert.equal(resolveHighlightLanguage('plaintext'), null);
    assert.equal(resolveHighlightLanguage('mermaid'), null);
    assert.equal(resolveHighlightLanguage(''), null);
    assert.equal(resolveHighlightLanguage(undefined), null);
    assert.equal(resolveHighlightLanguage('rust'), null, '未注册的语法必须降级而不是报错');
  });

  it('html 块按 XML 语法着色（别名解析不能落到显示名 `HTML, XML` 上）', () => {
    const html = renderMarkdownHtml('```html\n<div class="a">x</div>\n```');

    // 显示名回喂会抛 Unknown language → 整块无颜色；这里必须真的出 tag / name token
    assert.match(html, /hljs-tag/);
    assert.match(html, /hljs-name/);
    assert.equal(codeText(html), '<div class="a">x</div>');
  });

  it('mermaid 代码块不参与着色（图表渲染接管，源码只作兜底）', () => {
    const html = renderMarkdownHtml('```mermaid\ngraph TD\n  A-->B\n```');

    assert.match(html, /<code class="language-mermaid">graph TD/);
    assert.doesNotMatch(html, /hljs-/);
  });

  it('未知语言与无语言块退回转义纯文本，不报错也不空白', () => {
    const html = renderMarkdownHtml('```rust\nfn main() { println!("<hi>"); }\n```\n\n```\nplain <b>text</b>\n```');

    assert.match(html, /<pre><code class="language-rust">fn main\(\)/);
    assert.match(html, /&lt;hi&gt;/);
    assert.match(html, /plain &lt;b&gt;text&lt;\/b&gt;/);
    assert.doesNotMatch(html, /hljs-/);
  });

  it('代码内的 HTML 只作为文本：不产生可执行标签，也不逃逸 code 容器', () => {
    const html = renderMarkdownHtml(
      '```js\nconst s = "<script>alert(1)</script>";\nconst t = "</code></pre><img src=x onerror=alert(2)>";\n```',
    );

    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<img src=x/i);
    assert.doesNotMatch(html, /<\/code><\/pre><img/i);
    // 唯一的 </code></pre> 是渲染器自己闭合的那一对
    assert.equal((html.match(/<\/code><\/pre>/g) ?? []).length, 1);
    assert.equal(
      codeText(html),
      'const s = "<script>alert(1)</script>";\nconst t = "</code></pre><img src=x onerror=alert(2)>";',
    );
  });

  it('超过行数阈值直接跳过着色（保护主线程），阈值内正常着色', () => {
    const line = 'const a = 1; // c';
    const within = Array.from({ length: HIGHLIGHT_MAX_LINES }, () => line).join('\n');
    const over = `${within}\n${line}`;

    assert.ok(highlightCodeHtml(within, 'ts'), '阈值内的块应当着色');
    assert.equal(highlightCodeHtml(over, 'ts'), null, '超过阈值必须返回 null（调用方转义）');
    // 单行超长（行数只有 1）：只能靠字符阈值兜住，否则长单行会绕过行数判定
    const wide = `const a = "${'x'.repeat(HIGHLIGHT_MAX_CHARS)}";`;
    assert.equal(highlightCodeHtml(wide, 'ts'), null, '超过字符阈值必须返回 null');
    assert.equal(highlightCodeHtml('', 'ts'), null);
  });

  it('流式未闭合围栏不着色（避免每个 chunk 对整块重复高亮），闭合后的那一帧再着色', () => {
    const partial = renderMarkdownBlocks('```ts\nconst a = 1;\nconst b = 2;');
    assert.equal(partial[0].complete, false);
    assert.match(partial[0].html, /const a = 1;/);
    assert.doesNotMatch(partial[0].html, /hljs-/, '未闭合块不应着色');

    const closed = renderMarkdownBlocks('```ts\nconst a = 1;\nconst b = 2;\n```');
    assert.equal(closed[0].complete, true);
    assert.match(closed[0].html, /hljs-/, '闭合后必须着色');
    // 着色与否都不改变代码文本（复制链路）
    assert.match(closed[0].html, /<pre><code class="language-ts">/);
  });

  it('多语言组内每个面板都着色（未选中项也要着好色，切换不得白块）', () => {
    const html = renderMarkdownHtml([
      '::: code-group', '', '```python [Python]', PY_SAMPLE, '```', '',
      '```ts [TypeScript]', TS_SAMPLE, '```', '', ':::',
    ].join('\n'));

    const panels = html.split('data-ki-code-panel=').slice(1);
    assert.equal(panels.length, 2);
    for (const [index, panel] of panels.entries()) {
      assert.match(panel, /hljs-/, `面板 ${index} 未着色`);
    }
    assert.equal(codeText(html, 0), PY_SAMPLE);
    assert.equal(codeText(html, 1), TS_SAMPLE);
  });
});
