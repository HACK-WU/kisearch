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
const { canonicalLang, pickPreferredIndex } = await vite.ssrLoadModule('/src/lib/codeLangPreference.ts');
const { renderMarkdownHtml } = await vite.ssrLoadModule('/src/components/MarkdownPreview.tsx');
after(async () => vite.close());

const item = (lang, label = lang) => ({ lang, label });
const DOC = [
  '::: code-group', '',
  '```python [Python]', 'MARK_PY', '```', '',
  '```ts [TypeScript]', 'MARK_TS', '```', '',
  ':::',
].join('\n');
const countOf = (html, pattern) => (html.match(pattern) ?? []).length;

describe('首选代码语言（读者偏好）', () => {
  it('把别名归一到规范名；未知语言只做小写归一，不丢弃', () => {
    assert.equal(canonicalLang('py'), 'python');
    assert.equal(canonicalLang('Python3'), 'python');
    assert.equal(canonicalLang('TS'), 'typescript');
    assert.equal(canonicalLang('sh'), 'bash');
    assert.equal(canonicalLang('yml'), 'yaml');
    assert.equal(canonicalLang('  Go  '), 'go');
    assert.equal(canonicalLang('haskell'), 'haskell');
    assert.equal(canonicalLang(''), '');
  });

  it('命中语言名（含别名与大小写）', () => {
    const items = [item('python'), item('ts', 'TypeScript'), item('go')];
    assert.equal(pickPreferredIndex(items, 'python'), 0);
    assert.equal(pickPreferredIndex(items, 'TypeScript'), 1);
    assert.equal(pickPreferredIndex(items, 'typescript'), 1);
    assert.equal(pickPreferredIndex(items, 'GO'), 2);
  });

  it('回退标签匹配：整串相等或首词相等（`Python 3.12` 这类带版本的显示名）', () => {
    // 语言名已命中（走语言名分支）
    assert.equal(pickPreferredIndex([item('bash'), item('python', 'Python 3.12')], 'Python'), 1);
    // 组内只写标签、没有语言名 ⇒ 只能靠标签命中（这才是真正的标签回退路径）
    assert.equal(pickPreferredIndex([item('bash'), item('', 'Python 3.12')], 'python'), 1);
    assert.equal(pickPreferredIndex([item('', 'TypeScript / TSX'), item('go')], 'typescript'), 0);
    // 首词相等才算：`JavaScript` 不能被 `java` 命中（用前缀包含匹配就会选错）
    assert.equal(pickPreferredIndex([item('go'), item('', 'JavaScript')], 'java'), 0);
  });

  it('同一语言的常见后缀写法归到同一门（tsx / jsx / mjs / pyi / scss）', () => {
    assert.equal(canonicalLang('tsx'), 'typescript');
    assert.equal(canonicalLang('jsx'), 'javascript');
    assert.equal(canonicalLang('mjs'), 'javascript');
    assert.equal(canonicalLang('cjs'), 'javascript');
    assert.equal(canonicalLang('pyi'), 'python');
    assert.equal(canonicalLang('scss'), 'css');
    // 文档里写 ```tsx 时，选 typescript 也要命中
    assert.equal(pickPreferredIndex([item('python'), item('tsx', 'TSX')], 'typescript'), 1);
  });

  it('组内不含该语言 / 未指定偏好 / 空组 → 展示第一个', () => {
    const items = [item('python'), item('go')];
    assert.equal(pickPreferredIndex(items, 'rust'), 0);
    assert.equal(pickPreferredIndex(items, ''), 0);
    assert.equal(pickPreferredIndex([], 'python'), 0);
  });

  it('不做前缀包含匹配（java 不得选中 javascript）', () => {
    const items = [item('go'), item('javascript')];
    assert.equal(pickPreferredIndex(items, 'java'), 0);
    // 反过来：选 javascript 时只认它自己
    assert.equal(pickPreferredIndex(items, 'javascript'), 1);
  });

  it('语言标识为空的块不参与语言名匹配（只可能被标签命中）', () => {
    const items = [item('', '代码'), item('go')];
    assert.equal(pickPreferredIndex(items, 'python'), 0);
    assert.equal(pickPreferredIndex(items, 'go'), 1);
  });
});

describe('首选代码语言对渲染的影响', () => {
  it('未指定偏好时，仍默认展开第一个（既有行为不变）', () => {
    const html = renderMarkdownHtml(DOC);
    assert.match(html, /aria-selected="true" tabindex="0" data-ki-code-tab="0"/);
    assert.match(html, /data-ki-code-panel="0"><pre><code class="language-python">/);
    assert.match(html, /data-ki-code-panel="1" hidden>/);
  });

  it('指定 TypeScript 时，默认展开并只选中它', () => {
    const html = renderMarkdownHtml(DOC, undefined, 'typescript');
    assert.match(html, /aria-selected="true" tabindex="0" data-ki-code-tab="1"/);
    assert.match(html, /aria-selected="false" tabindex="-1" data-ki-code-tab="0"/);
    // 高亮会把 token 切分（`MARK_TS` 被 ts 语法标成常量变量），故只断言面板归属与内容在场
    assert.match(html, /data-ki-code-panel="1"><pre><code class="language-ts">/);
    assert.match(html, /MARK_TS/);
    assert.match(html, /data-ki-code-panel="0" hidden><pre><code class="language-python">/);
    // 结构本身不变：仍是两个标签 + 两个面板 + 一个复制按钮
    assert.equal(countOf(html, /role="tab"/g), 2);
    assert.equal(countOf(html, /role="tabpanel"/g), 2);
    assert.equal(countOf(html, /data-ki-copy-code/g), 1);
  });

  it('别名写法的偏好同样生效（写 ts 也能选中 TypeScript）', () => {
    const html = renderMarkdownHtml(DOC, undefined, 'ts');
    assert.match(html, /aria-selected="true" tabindex="0" data-ki-code-tab="1"/);
  });

  it('组内不含偏好语言时回退第一个（不报错、不提示）', () => {
    const html = renderMarkdownHtml(DOC, undefined, 'rust');
    assert.match(html, /aria-selected="true" tabindex="0" data-ki-code-tab="0"/);
    assert.match(html, /data-ki-code-panel="1" hidden>/);
  });

  it('普通代码块不受偏好影响', () => {
    const html = renderMarkdownHtml('```bash\necho hi\n```', undefined, 'typescript');
    assert.match(html, /<div class="ki-code-block__bar"><span class="ki-code-lang">bash<\/span>/);
    assert.equal(countOf(html, /data-ki-code-group/g), 0);
  });
});
