/**
 * event-expected-edit.test.mjs —— 事件详情页「预期效果」区域（2026-11-24）
 *
 * 需求：在「事件描述」下方补一个同构的「预期效果」区域，样式与操作与描述一致。
 *
 * 无 jsdom，沿用仓库既有做法做源码契约断言。锁住五类容易回退的约定：
 *   1) 位置与结构：在描述块**之后**、同为 `gov-summary__desc` 结构（虚线分区）；
 *   2) 样式零新增：读态 / 编辑态 / 按钮行全部复用描述那三组类名；
 *   3) 高度自适应是**两套独立实现**（不抽 hook）—— 描述那套被
 *      `event-desc-edit-grow.test.mjs` 逐字锁着，抽走会让那条历史缺陷失去守卫；
 *   4) 两区编辑态互不干扰、各自提交（保存预期效果时不得带 description，反之亦然）；
 *   5) 切事件时两区一起复位（漏一个就会把 A 的草稿挂到 B 上）。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const card = read('src/components/governance/event-detail/EventSummaryCard.tsx');
const cardTypes = read('src/components/governance/event-detail/types.ts');
const page = read('src/pages/EventsPage.tsx');
const api = read('src/api/governanceApi.ts');

/** 统计某个字面量在源码里出现几次（用来断言「两块复用同一套类名」） */
const countOf = (src, needle) => src.split(needle).length - 1;

describe('① 区块位置与结构', () => {
  it('「预期效果」排在「事件描述」之后（同卡片内）', () => {
    const descAt = card.indexOf('事件描述');
    const expectAt = card.indexOf('>预期效果</span>');
    assert.ok(descAt > 0, '描述块标题应存在');
    assert.ok(expectAt > descAt, '预期效果标题必须在描述之后');
  });

  it('标题行结构与描述同构（标题 + hint + 编辑按钮）', () => {
    assert.match(card, /<span className="gov-summary__desc-title">预期效果<\/span>/);
    // hint 与描述同一句：它确实会进 AI 分析上下文（主分析 / recall 预取 / 追问三处）
    assert.equal(
      countOf(card, '<span className="gov-dcard__hint">会进入 AI 分析上下文</span>'),
      2,
      '两个区域的 hint 文案应一致',
    );
  });
});

describe('② 样式零新增（复用描述那套类名）', () => {
  it('两块都用 .gov-summary__desc 容器（自带虚线分隔，天然分区）', () => {
    assert.equal(countOf(card, 'className="gov-summary__desc"'), 2);
  });

  it('读态 / 编辑态 / 按钮行三组类名各被复用两次', () => {
    assert.equal(countOf(card, 'className="gov-desc-text"'), 2, '读态块');
    assert.equal(countOf(card, 'className="gov-textarea gov-textarea--fit"'), 2, '编辑框');
    assert.equal(countOf(card, 'className="gov-desc-edit__foot"'), 2, '取消/保存行');
  });

  it('空态文案与描述区分开（描述讲现象证据，这里讲可核验结果）', () => {
    assert.match(card, /暂无预期效果 —— 补充可核验的预期结果，收口时可对照/);
    assert.doesNotMatch(card, /暂无预期效果[^<]*暂无描述/);
  });

  it('只读账号：编辑按钮与描述同一条门禁与 title', () => {
    const block = card.slice(card.indexOf('>预期效果</span>'));
    const head = block.slice(0, block.indexOf('暂无预期效果'));
    assert.match(head, /disabled=\{busy \|\| !canWrite\}/);
    assert.match(head, /title=\{readOnlyTitle\}/);
  });
});

describe('③ 高度自适应：两套独立实现（刻意不抽 hook）', () => {
  it('预期效果有自己的 ref / 同步函数 / 观察器', () => {
    assert.match(card, /const expectRef = useRef<HTMLTextAreaElement \| null>\(null\);/);
    assert.match(card, /const syncExpectHeight = useCallback\(\(\) => \{/);
    assert.match(card, /expectRoRef\.current\?\.disconnect\(\);/);
    assert.match(card, /ref=\{bindExpect\}/);
  });

  it('补边框差与「只比宽度」两条口径与描述一致', () => {
    const block = card.slice(card.indexOf('syncExpectHeight = useCallback'));
    assert.match(block, /offsetHeight - ta\.clientHeight/);
    assert.match(block, /if \(el\.clientWidth === lastWidth\) return;/);
  });

  it('内容驱动：预期效果的 useLayoutEffect 只看 expectEdit', () => {
    assert.match(
      card,
      /useLayoutEffect\(\(\) => \{\s*if \(expectEdit\.open\) syncExpectHeight\(\);\s*\}, \[expectEdit\.open, expectEdit\.draft, syncExpectHeight\]\);/,
    );
  });
});

describe('④ 两区编辑态独立、各自提交', () => {
  it('props 契约里 expectEdit 与四个回调齐备', () => {
    assert.match(cardTypes, /expectEdit: \{ open: boolean; draft: string; saving: boolean \};/);
    for (const cb of ['onExpectEdit', 'onExpectChange', 'onExpectSave', 'onExpectCancel']) {
      assert.match(cardTypes, new RegExp(`${cb}: \\(`), `props 缺 ${cb}`);
    }
  });

  it('保存预期效果只提交 expectedEffect（带 description 会覆盖用户没在编辑的那栏）', () => {
    const at = page.indexOf('onExpectSave=');
    assert.ok(at > 0, 'EventsPage 应接上 onExpectSave');
    const body = page.slice(at, page.indexOf('onExpectCancel=', at));
    assert.match(body, /updateEvent\(eventScope, active\.id, \{ expectedEffect: expectEdit\.draft, revision: active\.revision \}\)/);
    assert.doesNotMatch(body, /description:/, '保存预期效果不得携带 description');
  });

  it('保存描述只提交 description', () => {
    const at = page.indexOf('onDescSave=');
    const body = page.slice(at, page.indexOf('onExpectEdit=', at));
    assert.match(body, /updateEvent\(eventScope, active\.id, \{ description: descEdit\.draft, revision: active\.revision \}\)/);
    assert.doesNotMatch(body, /expectedEffect:/);
  });

  it('切事件时两区一起复位（同一段复位 effect 内）', () => {
    const start = page.indexOf('setDelConfirm(false);');
    const end = page.indexOf('if (activeId) void loadDetail');
    assert.ok(start > 0 && end > start, '复位 effect 结构变了，请同步本断言');
    const resetBlock = page.slice(start, end);
    assert.match(resetBlock, /setDescEdit\(\{ open: false, draft: '', saving: false \}\);/);
    assert.match(resetBlock, /setExpectEdit\(\{ open: false, draft: '', saving: false \}\);/);
  });
});

describe('⑤ 数据契约', () => {
  it('EventView 带 expectedEffect（列表项也要有：页面 active 优先取列表项）', () => {
    assert.match(api, /export interface EventView \{[\s\S]*?expectedEffect\?: string;/);
  });

  it('updateEvent patch 接受 expectedEffect（空串 = 清除）', () => {
    assert.match(api, /patch: \{ title\?: string; description\?: string; expectedEffect\?: string; revision: number \}/);
  });
});
