/**
 * governance-doc-open-ui.test.mjs —— 治理页「文档行点开正文」的静态守卫（2026-11-15）
 *
 * 背景：事件页「关联文档 / 参考文档」与分类页文档列表原先都是**纯文本行**，点了没有任何反应
 * （demo 里有抽屉、实现漏接线；用户反馈「点击以后无法查看文档内容」）。交互本身靠真机验证，
 * 这里只挡会被"顺手清理"掉的结构性约定：
 *   1. 文档名必须是 <button>（可聚焦、可回车），不许退回纯 <div>
 *   2. 点击必须落到 setDocTarget，并渲染 ModuleDrawer + getDocContent（read 通道，不排 MCP 写队列）
 *   3. ModuleDrawer 载入正文后不再重取（`if (content !== null) return`）
 *      ⇒ scope / 事件变化时必须收起抽屉，否则会静默显示上一个库的正文
 *   4. 可点击态用 ki token（hover 可发现性 + focus-visible），不新造字面色值
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');

const events = read('src/pages/EventsPage.tsx');
const lifecycle = read('src/pages/LifecyclePage.tsx');
const css = read('src/styles/governance.css');

/** 数出「<button> 上挂了某个 className」的出现次数（跨行匹配，容忍属性换行） */
function clickableCount(src, className) {
  return [...src.matchAll(/<button[\s\S]{0,200}?className="([^"]*)"/g)]
    .filter((m) => m[1].split(/\s+/).includes(className))
    .length;
}

test('事件页：关联文档与参考文档的文档名都是可点按钮，且落到 setDocTarget', () => {
  const mains = events.match(/className="gov-docline__main"/g) ?? [];
  assert.equal(mains.length, 2, '关联文档 / 参考文档各应有 1 个 .gov-docline__main');

  for (const m of events.matchAll(/<button[\s\S]{0,160}?className="gov-docline__main"/g)) {
    assert.ok(m[0].startsWith('<button'), '.gov-docline__main 必须挂在 <button> 上（可聚焦 / 可回车）');
  }
  assert.match(events, /setDocTarget\(\{ group: m\.group, name: m\.name \}\)/, '关联文档点击需落到 setDocTarget');
  assert.match(events, /setDocTarget\(\{ group: ref\.group, name: ref\.name \}\)/, '参考文档点击需落到 setDocTarget');
  assert.ok(
    !events.includes('<div className="gov-docline__name">'),
    '文档名不许退回纯 <div>（那正是「点了没反应」的原始形态）',
  );
});

test('事件页：抽屉复用 ModuleDrawer，正文走 doc/get（read 通道）', () => {
  assert.match(events, /import \{ ModuleDrawer \} from '@\/components\/ModuleDrawer';/);
  assert.match(events, /import \{ getDocContent \} from '@\/api\/httpApi';/);
  assert.match(events, /<ModuleDrawer[\s\S]{0,320}?fetcher=\{getDocContent\}/, '抽屉必须用 getDocContent 取正文');
  assert.match(events, /key=\{`\$\{docTarget\.group\}\/\$\{docTarget\.name\}`\}/, 'key 含 group+name，换篇需重挂载');
});

test('分类页：文档名是可点按钮，且同样复用 ModuleDrawer', () => {
  assert.match(
    lifecycle,
    /<button[\s\S]{0,160}?className="gov-cell-name gov-cell-name--link"/,
    '分类页文档名必须是按钮（表格里可聚焦）',
  );
  assert.match(lifecycle, /setDocTarget\(\{ group: doc\.group, name: doc\.name \}\)/);
  assert.ok(
    !lifecycle.includes('<div className="gov-cell-name">'),
    '文档名不许退回纯 <div>',
  );
  assert.match(lifecycle, /import \{ ModuleDrawer \} from '@\/components\/ModuleDrawer';/);
  assert.match(lifecycle, /<ModuleDrawer[\s\S]{0,320}?fetcher=\{getDocContent\}/);
});

test('切 scope（事件页还要换事件）时收起抽屉，避免串库', () => {
  assert.match(
    events,
    /useEffect\(\(\) => \{ setDocTarget\(null\); \}, \[scope, activeId\]\);/,
    '事件页：scope 或选中事件变化即收起抽屉',
  );
  assert.match(
    lifecycle,
    /useEffect\(\(\) => \{ setDocTarget\(null\); \}, \[scope\]\);/,
    '分类页：scope 变化即收起抽屉',
  );
});

test('可点击态用 ki token，且带 focus-visible（键盘可达）', () => {
  assert.match(css, /\.gov-docline__main:hover \{ background: var\(--ki-color-hover\); \}/);
  assert.match(css, /\.gov-docline__main:hover \.gov-docline__name \{ color: var\(--ki-color-primary\); \}/);
  assert.match(css, /\.gov-docline__main:focus-visible \{ outline: 2px solid var\(--ki-color-primary\)/);
  assert.match(css, /\.gov-cell-name--link:hover \{ color: var\(--ki-color-primary\); text-decoration: underline; \}/);
  assert.match(css, /\.gov-cell-name--link:focus-visible \{ outline: 2px solid var\(--ki-color-primary\)/);
});

/**
 * 计数辅助的兜底断言：上面的 clickableCount 目前未被用到（保留给后续扩展多入口时使用），
 * 这里显式断言它至少能数出 2 个，避免函数被误改成永远返回 0 还一路绿。
 */
test('辅助计数函数可用（防被改坏后静默失效）', () => {
  assert.equal(clickableCount(events, 'gov-docline__main'), 2);
});

test('治理页抽屉保持只读：不得开启 editable，也不得挂删除 / 移动回调', () => {
  for (const [page, src] of [['EventsPage', events], ['LifecyclePage', lifecycle]]) {
    const start = src.indexOf('<ModuleDrawer');
    assert.ok(start > 0, `${page} 应渲染 ModuleDrawer`);
    const block = src.slice(start, src.indexOf('/>', start));
    assert.ok(!/\beditable\b/.test(block), `${page}：治理页是读入口，抽屉不得开启 editable（会带出编辑写入口）`);
    assert.ok(!/\bonDeleted\b|\bonMoved\b/.test(block), `${page}：抽屉不得挂删除 / 移动回调（无后续导航承接）`);
  }
});
