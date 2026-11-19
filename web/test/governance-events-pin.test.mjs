/**
 * governance-events-pin.test.mjs —— 事件置顶（2026-11-19）
 *
 * web 单测不渲染 React（无 jsdom），沿用仓库既有做法做**源码契约断言**：
 * 把「先分区后排序」「置顶区两行共用一个行渲染」「按钮在动作区最左且是开关语义」钉住，
 * 避免后续改版把置顶悄悄改回"跟随筛选"或复制成两份行 JSX。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const page = read('src/pages/EventsPage.tsx');
const card = read('src/components/governance/event-detail/EventSummaryCard.tsx');
const cardTypes = read('src/components/governance/event-detail/types.ts');
const api = read('src/api/governanceApi.ts');
const css = read('src/styles/governance.css');

describe('① 请求：事件页显式开启「置顶免疫」', () => {
  it('loadList 传 includePinned: true', () => {
    assert.match(page, /includePinned: true/, '事件页不带该参数时，置顶项会被服务端筛选掉');
  });

  it('接口层只在显式要求时才带 includePinned', () => {
    assert.match(api, /if \(opts\.includePinned\) params\.set\('includePinned', '1'\)/);
  });
});

describe('② 排序：先分区、后排序', () => {
  it('普通区排序前先滤掉置顶项', () => {
    const m = page.match(/const sortedEvents = useMemo\(\(\) => \{[\s\S]*?const arr = ([^;]+);/);
    assert.ok(m, '未定位 sortedEvents 的初始数组');
    assert.match(m[1], /!isPinnedEvent\(e\)/, `普通区必须排除置顶项，实际=${m[1].trim()}`);
  });

  it('置顶区单独 memo，按 pinnedAt 倒序（最近置顶在上）', () => {
    assert.match(page, /const pinnedEvents = useMemo\([\s\S]{0,200}isPinnedEvent\(e\)[\s\S]{0,120}pinnedAt \?\? 0\) - \(a\.pinnedAt \?\? 0\)/);
  });

  it('置顶项不参与 sort 下拉（三种排序键只在普通区生效）', () => {
    const start = page.indexOf('const pinnedEvents = useMemo(');
    const end = page.indexOf('const listTimeText', start);
    assert.ok(start > 0 && end > start, '未定位 pinnedEvents 区块');
    const block = page.slice(start, end);
    // 依赖数组是判据：`.sort((a,b)=>...)` 是对 pinnedAt 排序，不算读取 sort 状态
    assert.match(block, /\[events\],/, '置顶区应只依赖事件列表');
    assert.ok(!/\bsort\b(?!\s*\()/.test(block), '置顶区不得读取 sort 状态变量');
  });
});

describe('③ 渲染：两个分区共用一个行渲染函数', () => {
  it('置顶区 / 普通区都走 renderEventRow（不复制行 JSX）', () => {
    assert.match(page, /pinnedEvents\.map\(\(event\) => renderEventRow\(event, true\)\)/);
    assert.match(page, /sortedEvents\.map\(\(event\) => renderEventRow\(event, false\)\)/);
    const nameCount = (page.match(/className="gov-ev__name"/g) ?? []).length;
    assert.equal(nameCount, 1, `行标题 JSX 应只有一处（实际 ${nameCount} 处，疑似复制了行渲染）`);
  });

  it('没有置顶项时不出现分区标题（升级前后默认视图一致）', () => {
    assert.match(page, /pinnedEvents\.length > 0 \? \(/, '分组标题必须以「有置顶项」为前提');
  });

  it('置顶区标题写明「不受筛选与排序影响」', () => {
    assert.match(page, /不受筛选与排序影响/);
  });

  it('行内有置顶标识（不看分区标题也能认出为什么它在结果里）', () => {
    assert.match(page, /gov-ev__pin/);
    assert.match(css, /\.gov-ev__pin svg/);
  });

  it('行底色不被置顶抢（三态叠加时仍可分辨）', () => {
    const pinCss = css.slice(css.indexOf('.gov-ev--pinned'));
    const rule = pinCss.slice(0, pinCss.indexOf('}'));
    assert.ok(!/background/.test(rule), `.gov-ev--pinned 不得设背景色，实际规则=${rule.trim()}`);
  });
});

describe('④ 详情动作区：置顶是开关，且在最左', () => {
  it('按钮用 aria-pressed 表达状态（不是两个不同动作）', () => {
    assert.match(card, /aria-pressed=\{pinned\}/);
  });

  it('文案随状态切换：置顶 / 取消置顶', () => {
    assert.match(card, /\{pinned \? '取消置顶' : '置顶'\}/);
  });

  it('置顶按钮排在 AI 分析之前、重新打开 / 删除事件不变', () => {
    const actions = card.slice(card.indexOf('gov-dcard__actions'));
    assert.ok(actions.indexOf('onTogglePin') < actions.indexOf('onAnalyze'), '置顶应在 AI 分析左侧');
    assert.ok(actions.indexOf('onAnalyze') < actions.indexOf('onReopen'), 'AI 分析仍应在重新打开左侧');
  });

  it('props 契约里 pinned / onTogglePin 都在', () => {
    assert.match(cardTypes, /pinned: boolean;/);
    assert.match(cardTypes, /onTogglePin: \(\) => void;/);
  });

  it('点击取反当前态（不是永远置顶）', () => {
    assert.match(page, /setEventPinned\(scope, active\.id, !isPinnedEvent\(active\)\)/);
  });

  it('只读账号仍被禁用', () => {
    const actions = card.slice(card.indexOf('gov-dcard__actions'));
    const pinBtn = actions.slice(actions.indexOf('onTogglePin') - 400, actions.indexOf('onTogglePin'));
    assert.match(pinBtn, /disabled=\{busy \|\| !canWrite\}/, '置顶按钮必须跟其它写操作一样受 canWrite 门禁');
  });
});

describe('⑤ 样式：分区标题与开关态', () => {
  it('分区标题样式存在且不接收点击（只是标签）', () => {
    assert.match(css, /\.gov-evgroup \{/);
    assert.match(css, /\.gov-evgroup \{[^}]*user-select: none/);
  });

  it('已置顶按钮有独立视觉态（与 AI 入口的紫区分）', () => {
    assert.match(css, /\.gov-btn--pinned \{/);
    assert.match(card, /pinned \? ' gov-btn--pinned' : ''/);
  });
});
