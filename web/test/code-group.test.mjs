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
after(async () => vite.close());

const group = (...lines) => lines.join('\n');
const countOf = (html, pattern) => (html.match(pattern) ?? []).length;

/** 第 n 个 `<code>` 的文本（去标签 + 解实体）：高亮后内容被 span 切分，只能按文本口径断言 */
const codeText = (html, index) => {
  const inner = [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)][index]?.[1] ?? '';
  return inner
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
};

describe('多语言代码块（VitePress ::: code-group）', () => {
  it('把同一功能的多种语言实现收成一个组：标签条 + 面板 + 默认展示第一个', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group',
      '',
      '```python [Python]',
      'print(1)',
      '```',
      '',
      '```ts [TypeScript]',
      'console.log(1)',
      '```',
      '',
      ':::',
    ));

    assert.equal(countOf(html, /data-ki-code-group/g), 1);
    assert.match(html, /class="ki-code-block ki-code-group"/);
    // 标签条（ARIA tablist）与两个标签，标签文本取 `[显示名]`
    assert.match(html, /<div class="ki-code-tabs" role="tablist" aria-label="代码语言">/);
    assert.equal(countOf(html, /role="tab"/g), 2);
    assert.match(html, /data-ki-code-tab="0" title="python">Python<\/button>/);
    assert.match(html, /data-ki-code-tab="1" title="ts">TypeScript<\/button>/);
    // 默认展示第一个：选中态与可聚焦性都只落在它身上
    assert.match(html, /aria-selected="true" tabindex="0" data-ki-code-tab="0"/);
    assert.match(html, /aria-selected="false" tabindex="-1" data-ki-code-tab="1"/);
    // 面板：第一个可见、其余 hidden；语言类名沿用既有约定（mermaid 后处理也依赖它）
    assert.equal(countOf(html, /role="tabpanel"/g), 2);
    // 代码内容自 2026-10-20 起带语法高亮（token 被 span 切分），故断言「面板各自持有自己的代码」
    // 用「去标签 + 解实体」口径；`pre > code.language-X` 的外层形状仍严格保留（mermaid / 复制依赖它）
    assert.match(html, /data-ki-code-panel="0"><pre><code class="language-python">/);
    assert.match(html, /data-ki-code-panel="1" hidden><pre><code class="language-ts">/);
    assert.equal(codeText(html, 0), 'print(1)');
    assert.equal(codeText(html, 1), 'console.log(1)');
    // 两个面板都被着色（未选中的也要着好色，切换时不得出现"白块待渲染"）
    assert.match(html, /hljs-built_in/);
    // 整个组共用工具条上的一个复制按钮
    assert.equal(countOf(html, /data-ki-copy-code/g), 1);
    // 容器标记不得泄漏成正文
    assert.doesNotMatch(html, /:::/);
  });

  it('标签与面板的 id 一一对应（aria-controls / aria-labelledby 无障碍关联）', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group', '', '```go', 'a', '```', '', '```rust', 'b', '```', '', ':::',
    ));

    // id 前缀是模块级自增（同一页面多次渲染不得重复），只校验关联关系本身
    assert.match(html, /id="(ki-code-group-\d+)-tab-1"/);
    const label = /aria-labelledby="(ki-code-group-\d+)-tab-1"/.exec(html);
    assert.ok(label, '面板必须用 aria-labelledby 指回自己的标签');
    assert.match(html, new RegExp(`id="${label[1]}-panel-1"`));
    const controls = /id="(ki-code-group-\d+)-tab-1"[^>]*aria-controls="\1-panel-1"/.exec(html);
    assert.ok(controls, '标签必须用 aria-controls 指向自己的面板');
  });

  it('省略 [标签] 时用语言名当标签', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group', '', '```go', 'a', '```', '', '```rust', 'b', '```', '', ':::',
    ));

    assert.match(html, /data-ki-code-tab="0" title="go">go<\/button>/);
    assert.match(html, /data-ki-code-tab="1" title="rust">rust<\/button>/);
  });

  it('支持三语言，且容器与代码块之间不强制空行', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group',
      '```bash [Linux / macOS]',
      'export A=1',
      '```',
      '```powershell [Windows PowerShell]',
      '$env:A = 1',
      '```',
      '```cmd [Windows CMD]',
      'set A=1',
      '```',
      ':::',
    ));

    assert.equal(countOf(html, /role="tab"/g), 3);
    assert.equal(countOf(html, /role="tabpanel"/g), 3);
    assert.match(html, /title="bash">Linux \/ macOS<\/button>/);
    assert.match(html, /title="cmd">Windows CMD<\/button>/);
  });

  it('组内只有一块时降级为普通代码块（没有可切换的对象）', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group', '', '```python [Python]', 'print(1)', '```', '', ':::',
    ));

    assert.equal(countOf(html, /data-ki-code-group/g), 0);
    assert.equal(countOf(html, /data-ki-copy-code/g), 1);
    assert.match(html, /class="ki-code-block__bar"><span class="ki-code-lang">python<\/span>/);
    // 降级 = 交回默认解析，容器标记会以正文形式出现（VitePress 语法的固有代价）
    assert.match(html, /<p>::: code-group<\/p>/);
  });

  it('组内空代码块按普通块同口径丢弃；丢到一个时整组降级', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group', '', '```python', 'print(1)', '```', '', '```js', '   ', '```', '', ':::',
    ));

    // 空块不产出空白面板，剩下 1 个有效块 → 不成组
    assert.equal(countOf(html, /data-ki-code-group/g), 0);
    assert.equal(countOf(html, /data-ki-copy-code/g), 1);
    assert.doesNotMatch(html, /language-js/);
  });

  it('容器未闭合（流式输出到一半）不接管，且不吞掉后续内容', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group', '', '```python [Python]', 'print(1)', '```', '', '## 后面的标题', '', '后续段落',
    ));

    assert.equal(countOf(html, /data-ki-code-group/g), 0);
    assert.match(html, /<h2>后面的标题<\/h2>/);
    assert.match(html, /<p>后续段落<\/p>/);
    assert.match(html, /class="language-python"/);
  });

  it('组内混入非代码块内容时整组降级，且正文与代码一个都不能丢', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group', '', '```python', 'a', '```', '', '中间说明文字', '', '```js', 'b', '```', '', ':::',
    ));

    assert.equal(countOf(html, /data-ki-code-group/g), 0);
    assert.match(html, /<p>中间说明文字<\/p>/);
    assert.equal(countOf(html, /data-ki-copy-code/g), 2);
  });

  it('CRLF 换行的文档同样能成组（Windows 编辑 / 导出场景）', () => {
    const html = renderMarkdownHtml([
      '::: code-group', '',
      '```python [Python]', 'print(1)', '```', '',
      '```js [JavaScript]', 'console.log(1)', '```', '',
      ':::', '',
    ].join('\r\n'));

    assert.equal(countOf(html, /data-ki-code-group/g), 1);
    assert.equal(countOf(html, /role="tab"/g), 2);
  });

  it('代码内容里含 ::: 行时不得误判为容器结束（关闭标记须跳过围栏内部）', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group', '',
      '```yaml', 'note: 下面这行是内容', ':::', '```', '',
      '```json', '{"a": 1}', '```', '',
      ':::',
    ));

    assert.equal(countOf(html, /data-ki-code-group/g), 1);
    assert.equal(countOf(html, /role="tabpanel"/g), 2);
    // 内容含 `:::` 行的 yaml 块：高亮会把 token 切分，按文本口径断言整段未被截断
    assert.equal(codeText(html, 0), 'note: 下面这行是内容\n:::');
  });

  it('组内含 mermaid 时按一个语言变体处理（面板内仍带 language-mermaid，后处理选择器才能命中）', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group', '', '```text [纯文本]', 'A -> B', '```', '', '```mermaid', 'graph TD\n  A-->B', '```', '', ':::',
    ));

    assert.equal(countOf(html, /data-ki-code-group/g), 1);
    assert.equal(countOf(html, /role="tab"/g), 2);
    assert.match(html, /<code class="language-mermaid">graph TD/);
    // mermaid 在第二个面板（默认隐藏）：后处理替换的是面板内的 pre，不影响容器结构
    assert.match(html, /data-ki-code-panel="1" hidden><pre><code class="language-mermaid">/);
  });

  it('围栏内展示的 ::: 示例不被误解析（写文档讲这个语法时的真实场景）', () => {
    // docs/markdown-multilang.md 就是这种形态：用四反引号围栏展示 ::: code-group 的写法
    const md = [
      '下面演示写法：',
      '',
      '````markdown',
      '::: code-group',
      '',
      '```python [Python]',
      'print(1)',
      '```',
      '',
      ':::',
      '````',
      '',
      '后面的正文',
    ].join('\n');
    const html = renderMarkdownHtml(md);

    assert.equal(countOf(html, /data-ki-code-group/g), 0);
    assert.match(html, /::: code-group/);
    assert.match(html, /&lt;|print\(1\)/);
    assert.match(html, /<p>后面的正文<\/p>/);
  });

  it('不接管其它 ::: 容器（如 VitePress 的 ::: tip）', () => {
    const html = renderMarkdownHtml(group('::: tip', '提示内容', ':::', '', '正文'));

    assert.equal(countOf(html, /data-ki-code-group/g), 0);
    assert.match(html, /提示内容/);
    assert.match(html, /<p>正文<\/p>/);
  });

  it('嵌套容器不受支持：外层标记降级为正文，内层两个块仍成组（内容一个不丢）', () => {
    // marked 逐块尝试扩展：外层因组内不是纯代码块而放弃，内层位置仍会被识别为一个组。
    // 这是可接受的降级形态——关键红线是"不吞内容"。
    const html = renderMarkdownHtml(group(
      '::: code-group', '', '::: code-group', '', '```a', '1', '```', '', '```b', '2', '```', '', ':::', '', ':::',
    ));

    assert.equal(countOf(html, /data-ki-code-group/g), 1);
    assert.equal(countOf(html, /role="tabpanel"/g), 2);
    assert.match(html, /<pre><code class="language-a">1<\/code><\/pre>/);
    assert.match(html, /<pre><code class="language-b">2<\/code><\/pre>/);
    assert.match(html, /<p>::: code-group<\/p>/);
  });

  it('标签与语言名一律转义（容器不引入新的原始 HTML 通路）', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group', '',
      '```js [<img src=x onerror="alert(1)">]', 'a', '```', '',
      '```py" onload="alert(2)', 'b', '```', '',
      ':::',
    ));

    assert.equal(countOf(html, /data-ki-code-group/g), 1);
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /onerror="alert\(1\)"/);
    assert.doesNotMatch(html, /onload="alert\(2\)"/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  });

  it('普通代码块的结构与行为完全不变（回归）', () => {
    const html = renderMarkdownHtml('```bash\necho hi\n```\n\n```\nplain\n```');

    assert.equal(countOf(html, /data-ki-code-group/g), 0);
    assert.match(html, /<div class="ki-code-block__bar"><span class="ki-code-lang">bash<\/span>/);
    assert.match(html, /<\/button><\/div><pre><code class="language-bash">/);
    assert.match(html, /<span class="ki-code-lang">代码<\/span>/);
  });

  it('同一文档多个组各自独立（id 不重复）', () => {
    const html = renderMarkdownHtml(group(
      '::: code-group', '', '```a', '1', '```', '', '```b', '2', '```', '', ':::', '',
      '::: code-group', '', '```c', '3', '```', '', '```d', '4', '```', '', ':::',
    ));

    assert.equal(countOf(html, /data-ki-code-group/g), 2);
    const ids = [...html.matchAll(/id="(ki-code-group-\d+)-panel-0"/g)].map((m) => m[1]);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });

  it('流式渲染：容器未闭合时是普通代码块，闭合后同一段变成可切换的组', () => {
    const half = group('::: code-group', '', '```python [Python]', 'print(1)', '```', '');
    const blocksHalf = renderMarkdownBlocks(half);
    assert.equal(blocksHalf.some((block) => block.html.includes('data-ki-code-group')), false);

    const full = half + '\n```ts [TypeScript]\nconsole.log(1)\n```\n\n:::\n';
    const blocksFull = renderMarkdownBlocks(full, blocksHalf);
    assert.equal(blocksFull.some((block) => block.html.includes('data-ki-code-group')), true);
  });

  it('组的 token 被视为完整块（未闭合时根本不产 token，故 complete 判定无需特殊分支）', () => {
    const blocks = renderMarkdownBlocks(
      group('::: code-group', '', '```a', '1', '```', '', '```b', '2', '```', '', ':::'),
    );
    const withGroup = blocks.filter((block) => block.html.includes('data-ki-code-group'));

    assert.equal(withGroup.length, 1);
    assert.equal(withGroup[0].complete, true);
    assert.equal(withGroup[0].raw.trimStart().startsWith('::: code-group'), true);
  });
});
