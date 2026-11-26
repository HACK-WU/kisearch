/**
 * event-type-closing.test.mjs —— 末位阶段统一「已关闭」（2026-11-26 用户需求）
 *
 * web 单测不渲染 React（无 jsdom），沿用仓库既有做法做**源码契约断言**。
 * 这里钉住四件容易被后续改版悄悄改坏的事：
 *   ① 新建弹窗预置末位且**锁定**（删得掉 / 拖得动就等于没有末位约束）
 *   ② 追加阶段插到末位之前（追加到末尾会顶掉收口入口，该类型再也收不了口）
 *   ③ 阶段表把末位标出来（否则用户看不出哪条是固定的）
 *   ④ 前端常量与后端 `TERMINAL_STAGE_NAME` 同字（跨端漂移会让比对全部失效）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webRoot, '..');
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const page = read('src/pages/EventsPage.tsx');
const backendTypes = fs.readFileSync(path.join(repoRoot, 'src/lib/events/types.ts'), 'utf-8');

/** 新建类型弹窗整块（它是文件里最后一个组件，切到文件末尾即可） */
const newTypeModal = page.slice(page.indexOf('function NewTypeModal('));
/** 追加阶段弹窗整块 */
const addStageModal = page.slice(page.indexOf('function AddStageModal('), page.indexOf('function TransitionModal('));

describe('① 常量：前后端同字', () => {
  it('后端 TERMINAL_STAGE_NAME 是「已关闭」', () => {
    assert.match(backendTypes, /export const TERMINAL_STAGE_NAME = '已关闭';/);
  });

  it('前端 LOCKED_STAGE_NAME 与后端一致', () => {
    assert.match(page, /const LOCKED_STAGE_NAME = '已关闭';/);
  });
});

describe('② 新建弹窗：预置 + 锁定末位', () => {
  it('初始阶段就含末位（不是提交后才由后端补）', () => {
    assert.match(
      newTypeModal,
      /useState<Array<\{ name: string; visibility: Visibility \}>>\(\[\s*\{ name: '进行中', visibility: 'hidden' \},\s*\{ name: LOCKED_STAGE_NAME, visibility: 'full' \},?\s*\]\)/,
    );
  });

  it('末位不可拖动 / 不可前后移 / 不可删除', () => {
    assert.match(newTypeModal, /const locked = i === stages\.length - 1;/);
    assert.match(newTypeModal, /draggable=\{!locked\}/);
    assert.match(newTypeModal, /disabled=\{locked \|\| i === 0\}/, '前移要禁用');
    assert.match(newTypeModal, /disabled=\{locked \|\| i === stages\.length - 2\}/, '后移要禁用（尤其不能移到末位之后）');
    assert.match(newTypeModal, /disabled=\{locked \|\| stages\.length <= 1\}/, '删除要禁用');
  });

  it('拖到末位位置 = 无效（不能把别的阶段挪到它之后）', () => {
    assert.match(newTypeModal, /if \(locked \|\| from === null \|\| from === i\) return;/);
  });

  it('新加的阶段插在末位之前', () => {
    assert.match(
      newTypeModal,
      /setStages\(\(prev\) => \[\.\.\.prev\.slice\(0, -1\), \{ name: v, visibility: 'hidden' \}, \.\.\.prev\.slice\(-1\)\]\)/,
    );
  });

  it('复用已有类型时同样补末位（源可能是未迁移的老形状）', () => {
    assert.match(newTypeModal, /const closing = copied\.find\(\(s\) => s\.name === LOCKED_STAGE_NAME\);/);
    assert.match(newTypeModal, /closing \?\? \{ name: LOCKED_STAGE_NAME, visibility: 'full' as Visibility \}/);
  });

  it('末位标签与说明文案', () => {
    assert.match(newTypeModal, /末位·收口/);
    assert.match(newTypeModal, /末位「已关闭」由系统预置并锁定/);
  });
});

describe('③ 追加阶段：说明与实际落位一致', () => {
  it('弹窗明示插在「已关闭」之前', () => {
    assert.match(addStageModal, /新阶段将插在末位「已关闭」之前/);
    assert.match(addStageModal, /末位「已关闭」是固定收口阶段/);
  });

  it('提交时把新阶段插到末位之前（不依赖后端兜底）', () => {
    assert.match(
      page,
      /stages: \[\.\.\.stages\.slice\(0, -1\), \{ name, visibility \}, \.\.\.\(terminal \? \[terminal\] : \[\]\)\]/,
    );
  });

  it('追加阶段不再提供「进入时动作」（那是类型级字段，只在末位行配）', () => {
    assert.equal(addStageModal.includes('进入时动作</span>'), false, '追加中间阶段不该出现终态动作选择');
  });
});

describe('④ 阶段表：末位可见', () => {
  it('末位行标「末位·收口」并说明不可停用 / 改名 / 删除', () => {
    assert.match(page, /i === selectedType\.stages\.length - 1 \? \(\s*<span className="gov-cell-muted"[\s\S]{0,80}末位·收口/);
    assert.match(page, /末位固定为「已关闭」（收口入口）：追加的新阶段会自动插到它之前/);
  });
});
