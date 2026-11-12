/**
 * markdown-anchor.test.mjs —— 正文「目录」锚点跳转（2026-11-12）
 *
 * 现象：文档里的 `[一、执行摘要](#一、执行摘要)` 点了不动。
 * 根因：marked v18 不再生成标题 id（headerIds 自 v5 移除），渲染器也没有补，
 * 于是 `#anchor` 永远没有目标元素。真机取证见
 * `.debug/md-heading-anchor-no-jump-20261112/`（18 个标题 0 个带 id、点击后 scrollTop 不变）。
 *
 * 本文件挡四类回退：
 *   1. 标题又丢了 id（回到「点了没反应」）
 *   2. slug 规则跑偏（中文标点没去掉 → 与 GitHub 风格的目录锚点对不上）
 *   3. 重名标题生成重复 id
 *   4. 锚点点击代理被删，或退化成 `document.getElementById` 跨块匹配
 *      （同一页多篇 markdown 时会滚到别的消息里）
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { renderMarkdownHtml, headingSlug, normalizeAnchorKey } = await vite.ssrLoadModule(
  '/src/components/MarkdownPreview.tsx',
);
after(async () => vite.close());

describe('标题 id', () => {
  test('中文标点按 GitHub 规则去掉，空格转连字符', () => {
    assert.equal(headingSlug('一、执行摘要'), '一执行摘要');
    assert.equal(headingSlug('附录：命令速查与示例'), '附录命令速查与示例');
    assert.equal(headingSlug('Hello World'), 'hello-world');
    // 纯标点标题没有可用 slug，由渲染器兜底成 section（见下一条）
    assert.equal(headingSlug('!!!'), '');
  });

  test('渲染出的标题带 id，且内联格式照旧', () => {
    const html = renderMarkdownHtml('## 一、执行摘要\n\n## **加粗**与 `code`\n');
    assert.match(html, /<h2 id="一执行摘要">一、执行摘要<\/h2>/);
    assert.match(html, /<h2 id="加粗与-code"><strong>加粗<\/strong>与 <code>code<\/code><\/h2>/);
  });

  test('重名标题追加序号，不产生重复 id', () => {
    const html = renderMarkdownHtml('## 简介\n\nA\n\n## 简介\n\nB\n\n## 简介\n\nC\n');
    const ids = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, ['简介', '简介-1', '简介-2']);
  });

  test('纯标点标题回落到 section，不留空 id', () => {
    const html = renderMarkdownHtml('## !!!\n');
    assert.match(html, /<h2 id="section">/);
  });

  test('锚点归一化：带标点与否都能对到同一个标题', () => {
    // 作者的目录常把标题原文写进锚点（`#一、执行摘要`），与 slug（`一执行摘要`）不等
    assert.equal(normalizeAnchorKey('#一、执行摘要'), normalizeAnchorKey('一执行摘要'));
    assert.equal(normalizeAnchorKey('附录：命令速查与示例'), normalizeAnchorKey('附录命令速查与示例'));
    assert.equal(normalizeAnchorKey('  Hello, World! '), normalizeAnchorKey('hello-world'));
  });
});

describe('锚点点击代理（源码守卫）', () => {
  const source = read('src/components/MarkdownPreview.tsx');

  test('组件注册了页内锚点点击处理', () => {
    assert.ok(source.includes("href.startsWith('#')"), '应识别 `#` 开头的链接');
    assert.ok(source.includes('resolveAnchorTarget(root'), '应在正文块内解析锚点目标');
    assert.ok(source.includes('scrollToAnchorTarget(root'), '应自行滚动容器而不是交给浏览器');
  });

  test('只在当前正文块内解析，不跨块取全文档第一个同名 id', () => {
    assert.ok(!source.includes('document.getElementById'), '锚点解析不应查全文档（同页多篇 markdown 会串台）');
    assert.ok(source.includes("root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')"), '兜底匹配限定在本块标题上');
  });

  test('滚动的是最近可滚动祖先（阅读器是 .ki-drawer__body，不是 window）', () => {
    assert.ok(source.includes('overflowY'), '应按 overflowY 找可滚动祖先');
    assert.ok(source.includes('scroller.scrollTo('), '应滚动容器本身');
    assert.ok(source.includes('ANCHOR_SCROLL_OFFSET'), '应留出顶部偏移，标题不贴着容器边缘');
  });

  test('锚点按 id 属性比对，不用会抛异常的属性选择器', () => {
    // 真机实测：`[id="a\nb"]` 让 querySelector 抛 SyntaxError，点击变成「报错 + 不跳」
    assert.ok(!source.includes('querySelector<HTMLElement>(`[id='), '不应拼属性选择器匹配锚点');
    assert.ok(source.includes("el.id === anchor"), '应逐个比对 id 属性');
  });

  test('目标在折叠的 details 里时先展开再滚动（否则没有布局盒、会跳错位置）', () => {
    assert.ok(source.includes("target.closest('details')"), '应找到目标外层 details');
    assert.ok(source.includes('details.open = true'), '应展开 details');
  });
});
