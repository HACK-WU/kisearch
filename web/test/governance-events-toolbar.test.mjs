/**
 * governance-events-toolbar.test.mjs —— 事件页工具条布局 / 列表排序 / 已收口灰底（2026-11-17）
 *
 * web 单测不渲染 React（无 jsdom），沿用仓库既有做法做**源码契约断言**：
 * 把「视图切换在页头、过滤器贴左、排序默认降序、已收口行灰底」钉住，避免后续改版悄悄回退。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const page = read('src/pages/EventsPage.tsx');
const css = read('src/styles/governance.css');

/** 页头 actions 区 / 工具条区（工具条区截到「事件类型」分支开始，避免误伤类型页的 typebar） */
const headerEnd = page.indexOf('</header>');
const headActions = page.slice(page.indexOf('gov-head__actions'), headerEnd);
const toolbarSection = page.slice(headerEnd, page.indexOf("{tab === 'types' ? ("));

describe('① 视图切换：挪进页头，位于主操作左侧', () => {
  it('「事件列表 / 事件类型」在 gov-head__actions 内', () => {
    assert.match(headActions, /事件列表/);
    assert.match(headActions, /事件类型/);
  });

  it('视图切换排在「＋ 新建事件」之前', () => {
    assert.ok(
      headActions.indexOf('事件列表') < headActions.indexOf('＋ 新建事件'),
      '视图切换应在新建事件按钮左侧',
    );
  });

  it('视图切换带分组语义（role=group + aria-label）', () => {
    assert.match(headActions, /role="group"[\s\S]{0,40}aria-label="视图"/);
  });
});

describe('② 过滤器：贴左、只在列表视图渲染', () => {
  it('工具条不再用 spacer 把过滤器顶到视口右侧', () => {
    assert.doesNotMatch(toolbarSection, /gov-toolbar__spacer/);
  });

  it('工具条只在 tab === list 时渲染（类型页没有事件可过滤）', () => {
    assert.match(toolbarSection, /tab === 'list' \? \(/);
  });

  it('三个过滤器都在工具条内：类型 / 状态 / 排序', () => {
    const ddCount = (toolbarSection.match(/<DropdownFilter/g) ?? []).length;
    assert.equal(ddCount, 3, `工具条应有 3 个下拉，实际 ${ddCount} 个`);
  });
});

describe('③ 排序：默认降序，三种口径', () => {
  it('默认排序为「最近更新」降序（升级前后默认视图不变）', () => {
    assert.match(page, /useState<SortKey>\('updated-desc'\)/);
  });

  it('三个排序选项齐全且默认项排第一', () => {
    for (const label of ['最近更新', '最新创建', '最早创建']) {
      assert.match(page, new RegExp(`label: '${label}'`));
    }
    assert.match(page, /'updated-desc': '最近更新'/);
  });

  it('排序在已取回的当前页内重排，不改请求参数', () => {
    // 排序若进入 loadList 的依赖数组，会触发重新请求（后端无 sort 参数，纯浪费）
    const loadListDeps = page.match(/}, \[scope, status, keyword, typeFilter\]\);/);
    assert.ok(loadListDeps, 'loadList 依赖不应包含 sort');
  });

  it('createdAt 缺失时回退到 updatedAt（老事件文件不整批沉底）', () => {
    assert.match(page, /e\.createdAt \?\? e\.updatedAt \?\? 0/);
  });

  it('第二行时间标签随排序键切换', () => {
    assert.match(page, /创建 \$\{relTime\(e\.createdAt \?\? e\.updatedAt\)\}/);
  });
});

describe('④ 已收口事件：灰底但不禁用', () => {
  it('列表行按 closedAt 打上 gov-ev--closed', () => {
    assert.match(page, /isClosed \? ' gov-ev--closed' : ''/);
    assert.match(page, /closedAt !== null && event\.closedAt !== undefined/);
  });

  it('灰底只降背景，不覆盖选中态的左侧竖条', () => {
    assert.match(css, /\.gov-ev--closed \{[^}]*--ki-color-bg-muted/);
    // 竖条由 `.gov-ev.gov-ev--active` 提供，closed 联合选择器再写 box-shadow 会抢值
    assert.doesNotMatch(css, /\.gov-ev--closed\.gov-ev--active \{[^}]*box-shadow/);
  });

  it('灰底行的 hover 用 hover-strong（普通 hover 叠在灰底上看不出）', () => {
    assert.match(css, /\.gov-ev--closed:hover \{[^}]*--ki-color-hover-strong/);
  });
});

describe('⑤ 下拉浮层：左侧按钮上的菜单向右展开', () => {
  it('.gov-dd__menu 左对齐（改用 right:0 会溢出视口左边界）', () => {
    assert.match(css, /\.gov-dd__menu \{[^}]*left: 0;/);
  });
});
