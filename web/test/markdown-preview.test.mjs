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
const {
  isBlankMermaidSvg,
  mermaidErrorDetail,
  mermaidFallbackNotice,
  normalizeCodeForCopy,
  renderMarkdownHtml,
  repairMermaidLabelQuotes,
} = await vite.ssrLoadModule('/src/components/MarkdownPreview.tsx');
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

  it('ignores decorator containers when deciding whether a mermaid svg is blank（实测形态 2026-10-13）', () => {
    // 空 flowchart 实机输出：装饰 <marker> 内含 path，且**不在 <defs> 内** + 空 <g class="nodes">
    const marker = '<marker id="x_flowchart-v2-pointEnd" class="marker flowchart-v2" viewBox="0 0 10 10" refX="5" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" class="arrowMarkerPath"></path></marker>';
    assert.equal(isBlankMermaidSvg(`<svg id="a" viewBox="-8 -8 16 16"><style>#a{fill:#333;}</style>${marker}<g class="nodes"></g></svg>`), true);
    // 空 stateDiagram：装饰落在 <defs> 内
    assert.equal(isBlankMermaidSvg('<svg id="b"><defs><marker id="m"><path d="M0 0"></path></marker></defs><g></g></svg>'), true);
    // 1 节点流程图：<g class="node"> 内的 rect / foreignObject 是真图元，不能当装饰剥掉
    const node = '<g class="nodes"><g class="node default" id="n" transform="translate(54, 35)"><rect class="basic label-container" x="-46" y="-27" width="92" height="54"></rect><g class="label"><rect></rect><foreignObject width="32" height="24"></foreignObject></g></g></g>';
    assert.equal(isBlankMermaidSvg(`<svg id="c" viewBox="0 0 108 70">${marker}${node}</svg>`), false);
    // 有边就有 path（同样不能因剥离装饰而误判为空白）
    assert.equal(isBlankMermaidSvg(`<svg id="d">${marker}<g class="edgePaths"><path d="M0 0L10 10"></path></g></svg>`), false);
  });

  it('repairs unescaped quotes inside a mermaid label string（截图案例 2026-10-13）', () => {
    const broken = 'flowchart TD\n    YOU["你：写 YAML（spec "）"] --> API["kube-apiserver<br/>校验并写入"]';
    const repaired = repairMermaidLabelQuotes(broken);

    assert.equal(
      repaired,
      'flowchart TD\n    YOU["你：写 YAML（spec #quot;）"] --> API["kube-apiserver<br/>校验并写入"]',
    );
    // 只把内层那一个引号换成实体：结构引号（[" 与 "]）原样保留
    assert.equal((repaired.match(/#quot;/g) ?? []).length, 1);
    assert.match(repaired, /\["你：写 YAML（spec #quot;）"\]/);
  });

  it('leaves valid mermaid sources byte-identical', () => {
    const cases = [
      'flowchart TD\n    A["合法"] --> B["含 <br/> 的文本"]',
      'flowchart LR\n  A -->|"是"| B\n  B -->|"否"| C',
      'flowchart TD\n  A(("圆")) --> B{"菱形"}\n  B --> C("圆角")\n  C --> D(["胶囊"])',
      'flowchart TD\n  A["甲"] --> B["乙"] --> C["丙"]',
      'flowchart TD\n  %% 注释里的 " 引号 " 不参与解析\n  A["甲"] --> B["乙"]\n  style A fill:#f9f',
      'flowchart TD\n  A["已转义 #quot;引号#quot;"]\n  B --> C',
    ];
    for (const src of cases) assert.equal(repairMermaidLabelQuotes(src), src);
  });

  it('does not touch unclosed labels or lines without label strings', () => {
    const unclosed = 'flowchart TD\n  A["未闭合 --> B';
    assert.equal(repairMermaidLabelQuotes(unclosed), unclosed);
    assert.equal(repairMermaidLabelQuotes('flowchart TD\n  A --> B'), 'flowchart TD\n  A --> B');
  });

  it('describes mermaid fallbacks for the toolbar notice and its details panel', () => {
    const failed = mermaidFallbackNotice('failed', 'Parse error on line 2');
    assert.equal(failed.label, '⚠ 图表渲染失败');
    assert.match(failed.title, /Parse error on line 2/);
    // 面板正文把「原因」与「去路」分开给（触屏 / 键盘用户靠它，不再只依赖 hover 的 title）
    assert.match(failed.reason, /Parse error on line 2/);
    assert.match(failed.hint, /修正源码后重新打开/);
    assert.match(mermaidFallbackNotice('blank').title, /没有可渲染的节点/);
    assert.match(mermaidFallbackNotice('blank').hint, /补上节点后重新打开/);
    assert.match(mermaidFallbackNotice('unavailable').title, /加载失败/);
    assert.match(mermaidFallbackNotice('unavailable').hint, /刷新页面可重试/);
  });

  it('keeps only the first line of a mermaid error and truncates long ones', () => {
    assert.equal(mermaidErrorDetail(new Error('Parse error on line 2:\n...arrow...\n---^')), 'Parse error on line 2:');
    assert.equal(mermaidErrorDetail('boom'), 'boom');
    assert.equal(mermaidErrorDetail('x'.repeat(300)).length, 158);
  });

  it('removes only trailing line breaks from copied code, preserving internal lines and spaces', () => {
    assert.equal(normalizeCodeForCopy('echo hello\n'), 'echo hello');
    assert.equal(normalizeCodeForCopy('one\r\ntwo  \r\n\r\n'), 'one\r\ntwo  ');
    assert.equal(normalizeCodeForCopy('no newline'), 'no newline');
  });
});
