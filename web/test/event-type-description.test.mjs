/**
 * event-type-description.test.mjs —— 事件类型描述（REQ-20261123-007 · S-01）
 *
 * web 单测不渲染 React（无 jsdom），沿用仓库既有做法做**源码契约断言**。
 * 这里钉住四件容易在后续改版中被悄悄改坏的事：
 *   ① 无描述时整行不渲染（老用户体验零变化）
 *   ② 描述的「清空」不能被真值判断吃掉（空串必须是合法输入）
 *   ③ 切类型要丢弃草稿（否则会把 A 的描述写进 B）
 *   ④ 字数上限前后端一致 200
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
const api = read('src/api/governanceApi.ts');

/** 类型页分支：从 `tab === 'types'` 到事件列表分支开始 */
const typesSection = page.slice(
  page.indexOf("{tab === 'types' ? ("),
  page.indexOf('{/* 左：事件列表'),
);
/** 新建类型弹窗整块 */
const newTypeModal = page.slice(page.indexOf('function NewTypeModal('));

describe('① 描述行：位置与显隐', () => {
  it('描述卡在类型卡片之后（不是 tab 条与阶段表之间）', () => {
    /*
     * 2026-11-23 用户两次纠正：要求的是「类型列表**下面**」——描述要作为独立一张卡
     * 放在整个类型卡之后；放在 tab 条与阶段表之间属于「卡里面」。
     */
    const desc = typesSection.indexOf('gov-typedesc');
    const tbl = typesSection.indexOf('gov-tbl');
    const foot = typesSection.indexOf('gov-card__foot');
    assert.ok(tbl >= 0 && foot > tbl, '锚点异常：阶段表/卡底栏找不到');
    assert.ok(desc > foot, '描述卡必须排在整个类型卡（阶段表 + 底栏）之后');
  });

  it('无描述时渲染「＋ 添加描述」入口，而不是整行消失', () => {
    /*
     * 2026-11-23 真机走查发现的坑：原设计「无描述整行不渲染」会让
     * 「新建时没写描述」或「清空描述」之后**永远补不回来**（页面上再无入口）。
     */
    assert.match(
      typesSection,
      /\{selectedType \? \(selectedType\.description \|\| descDraft !== null \? \(/,
      '外层必须按「有描述/无描述」分两态',
    );
    assert.match(typesSection, /gov-typedesc--empty/, '无描述态要有独立的类名');
    assert.match(typesSection, /＋ 添加描述/, '无描述态必须给出添加入口');
  });

  it('描述文本单行截断 + title 给全文（200 字不能撑开页面）', () => {
    assert.match(typesSection, /gov-typedesc__text[^>]*title=\{selectedType\.description\}/);
    assert.match(css, /\.gov-typedesc__text\s*\{[\s\S]{0,200}text-overflow: ellipsis/);
  });
});

describe('② 清空语义：空串必须能提交', () => {
  it('patchType 用 !== undefined 判断（真值判断会让用户永远清不掉）', () => {
    assert.match(
      page,
      /patch\.description !== undefined \? \{ description: patch\.description \}/,
    );
  });

  it('前端提交描述时不 trim 成「省略」（空串代表清除）', () => {
    assert.match(typesSection, /description: next/, '保存时应传原值，含空串');
  });

  it('编辑态用 null 区分「没在编辑」与「编辑中且已清空」', () => {
    assert.match(page, /const \[descDraft, setDescDraft\] = useState<string \| null>\(null\)/);
  });

  it('Enter 保存、Esc 取消', () => {
    assert.match(typesSection, /e\.key === 'Enter'[\s\S]{0,400}patchType/);
    assert.match(typesSection, /e\.key === 'Escape'[\s\S]{0,140}setDescDraft\(null\)/);
  });
});

describe('③ 切换类型丢弃草稿', () => {
  it('tab 点击先清 descDraft 再切 selectedTypeId', () => {
    const tabBtn = typesSection.slice(typesSection.indexOf('typeTabs.map('));
    const seg = tabBtn.slice(0, tabBtn.indexOf('</button>'));
    assert.ok(
      seg.indexOf('setDescDraft(null)') >= 0 && seg.indexOf('setDescDraft(null)') < seg.indexOf('setSelectedTypeId'),
      '必须先清草稿再切类型',
    );
  });
});

describe('④ 字数上限 200：前端两处输入 + 契约字段', () => {
  it('描述行与新建弹窗都限制 200', () => {
    const hits = typesSection.split('maxLength={200}').length - 1;
    assert.ok(hits >= 1, '描述行编辑框应限制 200');
    assert.match(newTypeModal, /maxLength=\{200\}/);
    assert.match(newTypeModal, /\{description\.length\}\/200/);
  });

  it('新建弹窗把描述透传给 onCreate，空值不上传', () => {
    assert.match(newTypeModal, /description\.trim\(\) \? \{ description: description\.trim\(\) \}/);
  });

  it('API 层 EventTypeView 与 updateEventType 都有可选 description', () => {
    assert.match(api, /export interface EventTypeView \{[\s\S]{0,200}description\?: string/);
    assert.match(api, /patch: \{[\s\S]{0,300}description\?: string/);
  });
});

describe('⑤ 只读账号', () => {
  it('编辑入口受写权限门禁控制', () => {
    const editBtn = typesSection.slice(typesSection.indexOf('gov-typedesc__edit'));
    assert.match(editBtn.slice(0, 400), /disabled=\{busy \|\| libWriteBlocked\}/);
  });
});

describe('⑥ 视图 scope：类型 tab 不重复、不同时高亮两份', () => {
  /* 2026-11-23 真机走查：视图下 4 个类型渲染成 7 个 tab，两个「性能优化」同时高亮 */
  it('tab 列表按名称去重', () => {
    assert.match(page, /const typeTabs = useMemo\(\(\) => \{[\s\S]{0,220}seen\.has\(t\.name\)/);
    assert.match(typesSection, /\{typeTabs\.map\(\(t\) => \(/);
  });

  it('React key 与选中键都用 typeKey ?? id（裸 id 在视图下必撞车）', () => {
    assert.match(typesSection, /key=\{t\.typeKey \?\? t\.id\}/);
    assert.match(typesSection, /setSelectedTypeId\(t\.typeKey \?\? t\.id\)/);
    assert.match(typesSection, /\(t\.typeKey \?\? t\.id\) === \(selectedType\.typeKey \?\? selectedType\.id\)/);
    assert.match(page, /const selectedType = useMemo\([\s\S]{0,120}\(t\.typeKey \?\? t\.id\) === selectedTypeId/);
  });

  it('复用下拉也用去重后的列表', () => {
    assert.match(page, /<NewTypeModal\s+types=\{typeTabs\}/);
  });
});

describe('⑦ 样式：只走 ki token，不写字面色值', () => {
  it('.gov-typedesc 段落无色值字面量', () => {
    const start = css.indexOf('.gov-typedesc {');
    assert.ok(start >= 0, '缺少 .gov-typedesc 样式');
    const block = css.slice(start, css.indexOf('/* ════════ 回收站', start));
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(block), false, '类型描述样式不得出现字面色值');
    assert.equal(/rgba?\(/.test(block), false, '不得使用 rgba 字面色');
  });
});
