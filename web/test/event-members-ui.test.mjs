/**
 * event-members-ui.test.mjs —— 事件页「关联文档 / 参考文档」入口（REQ-20261116-004 · S-01/S-02）
 *
 * web 单测不渲染 React（无 jsdom），这里按仓库既有做法做**源码契约断言**：
 * 把"入口必须存在、必须走哪个接口、必须在哪些条件下禁用"钉住，避免实现漂移。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const page = read('src/pages/EventsPage.tsx');
/** 2026-11-17 改版：文档行与文档卡抽到 event-detail/，源码断言改指向新组件 */
const docLine = read('src/components/governance/event-detail/DocLine.tsx');
const docsCard = read('src/components/governance/event-detail/EventDocsCard.tsx');
const picker = read('src/components/governance/DocPickerModal.tsx');
const api = read('src/api/governanceApi.ts');

describe('① 新建事件弹窗：两类文档可选', () => {
  it('弹窗含「关联文档（可选）」与「参考文档（可选）」两个区块', () => {
    assert.match(page, /关联文档（可选）/);
    assert.match(page, /参考文档（可选）/);
  });

  it('弹窗用 DocPickerModal 选择，并区分 member / ref 两种模式', () => {
    assert.match(page, /<DocPickerModal/);
    assert.match(page, /mode=\{picker\}/);
    // 已选进另一侧的文档要能被剪枝（同一篇不能既关联又引用）
    assert.match(page, /alsoPicked=/);
  });

  it('创建时把 docs / refs 一并提交（不是建完再补）', () => {
    assert.match(page, /pickedDocs,\s*\n\s*pickedRefs,/);
  });
});

describe('② 详情页「关联文档」区：添加 + 移除', () => {
  it('区头有「＋ 添加」入口（与参考文档同款样式）', () => {
    assert.match(page, /＋ 添加/);
  });

  it('添加走 addMembers，移除走 removeMember', () => {
    assert.match(page, /await addMembers\(scope, active\.id, docs\)/);
    assert.match(page, /await removeMember\(scope, active\.id, row\.group, row\.name\)/);
  });

  it('移除是两步确认（文案用「确认」而不是弹窗删除）', () => {
    // 两步确认的文案在 DocLine，确认态由卡片的 confirmKey 控制（同一时刻只有一行）
    assert.match(docLine, /confirmRemove \? '确认' : '×'/);
    assert.match(docsCard, /confirmRemove=\{confirmKey === row\.key\}/);
    assert.match(page, /confirmKey=\{pendingRemove\}/);
    assert.match(docsCard, /解绑|移除该参考文档/);
  });

  it('空态指向按钮，不再让用户去用 ki_sync_relation 绑定', () => {
    assert.match(page, /emptyText="暂无关联文档，点右上「＋ 添加」/);
    assert.doesNotMatch(page, /暂无关联文档（用 ki_sync_relation 的 event 参数绑定）/);
  });

  it('索引未能摘除时有警示，不谎报「已隐藏」', () => {
    assert.match(page, /memberVisWarn/);
    assert.match(page, /notice=\{memberVisWarn \?/);
    assert.match(page, /仍可能被检索到/);
  });
});

describe('③ 只读账号门禁（写入口不隐藏、只禁用）', () => {
  it('新增的两个写入口都按 canWrite 禁用（收口后连添加都禁用）', () => {
    // 「＋ 添加」：只读账号禁用，事件已收口也禁用
    assert.match(page, /disabled=\{busy \|\| !canWrite \|\| closed\}/);
    // 行内「×」：只读账号禁用
    // 行内「×」：由卡片把 canWrite 折算成 canRemove，再交给 DocLine 禁用
    assert.match(docsCard, /canRemove=\{canWrite && !busy && !row\.lockedReason\}/);
    assert.match(docLine, /disabled=\{!canRemove\}/);
    assert.match(docsCard, /removeTitle=\{row\.lockedReason \?\? \(isMember \? '从事件移除（解绑，文档保留）'/);
  });
});

describe('④ DocPickerModal 的候选规则', () => {
  it('已属其他未收口事件的候选禁用并标注', () => {
    assert.match(picker, /boundElsewhere/);
    assert.match(picker, /已属 #/);
    assert.match(picker, /const disabled = already \|\| boundElsewhere;/);
    assert.match(picker, /disabled=\{disabled\}/);
  });

  it('已选进另一侧（关联 / 引用互斥）也禁用', () => {
    assert.match(picker, /alsoPicked/);
  });

  it('搜索带 eventId 让后端排除已关联 / 已加入（R31 服务端兜底）', () => {
    assert.match(picker, /searchRefDocs\(args\.scope, q\.trim\(\), args\.eventId\)/);
  });
});

describe('⑤ API 契约', () => {
  it('addMembers 走 POST /governance/events/:id/members', () => {
    assert.match(api, /export function addMembers/);
    assert.match(api, /\/api\/governance\/events\/\$\{encodeURIComponent\(eventId\)\}\/members/);
    assert.match(api, /method: 'POST'/);
  });

  it('removeMember 走 DELETE + query 参数（与 refs 删除同形）', () => {
    assert.match(api, /export function removeMember/);
    assert.match(api, /new URLSearchParams\(\{ scope, group, name \}\)/);
  });

  it('createEvent 入参支持 docs / refs', () => {
    const createBlock = api.slice(api.indexOf('export function createEvent'));
    assert.match(createBlock.slice(0, 600), /docs\?:/);
    assert.match(createBlock.slice(0, 600), /refs\?:/);
  });
});
