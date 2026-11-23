/**
 * analysis-edit.test.ts —— 人工校正的严格校验单测（REQ-20261123-001 · S01 批 1）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-edit.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONCLUSION_MAX_CHARS,
  MANUAL_LOCATION_ADD_MAX,
  MANUAL_LOCATION_WHY_MAX,
  UNCONFIRMED_ITEM_MAX,
  UNCONFIRMED_MAX_ITEMS,
  hasEditFields,
  validateDraftEdit,
} from '../../src/lib/events/analysis-edit.js';
import { CHAIN_MAX_NODES, CHAIN_TEXT_MAX } from '../../src/lib/events/conclusion-chain.js';

const run = (payload: Parameters<typeof validateDraftEdit>[0]) => validateDraftEdit(payload);

describe('hasEditFields：空 patch 判定', () => {
  it('全缺省 → false（不写盘、不打 editedAt）', () => {
    assert.equal(hasEditFields({}), false);
  });
  it('conclusion=null 算改动（显式清空）', () => {
    assert.equal(hasEditFields({ conclusion: null }), true);
  });
  it('空链 [] 算改动', () => {
    assert.equal(hasEditFields({ chain: [] }), true);
  });
});

describe('conclusion：4000 硬上限与清空（H10）', () => {
  it('4000 字通过（旧 120 上限已取消）', () => {
    const text = 'a'.repeat(CONCLUSION_MAX_CHARS);
    const { errors, value } = run({ conclusion: text });
    assert.deepEqual(errors, []);
    assert.equal(value.conclusion, text);
  });

  it('4001 字被拒，且原因带实际字数与上限', () => {
    const { errors } = run({ conclusion: 'a'.repeat(CONCLUSION_MAX_CHARS + 1) });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.field, 'conclusion');
    assert.match(errors[0]!.reason, /4001 字/);
    assert.match(errors[0]!.reason, /4000 字/);
  });

  it('既有 2000 字（解析层兜底值）可原样保存 —— 不再需要"既有超长豁免"', () => {
    assert.deepEqual(run({ conclusion: 'a'.repeat(2000) }).errors, []);
  });

  it('null 与全空白都归一为 null', () => {
    assert.equal(run({ conclusion: null }).value.conclusion, null);
    assert.equal(run({ conclusion: '   \n ' }).value.conclusion, null);
  });

  it('多行压成一行（节点/结论都是"一句话"）', () => {
    assert.equal(run({ conclusion: '第一行\n第二行' }).value.conclusion, '第一行 第二行');
  });
});

describe('chain：节点数与文本', () => {
  const node = (text: string, extra: Record<string, unknown> = {}) => ({ kind: 'symptom', text, ...extra });

  it('5 个节点通过，6 个被拒', () => {
    const five = { chain: Array.from({ length: CHAIN_MAX_NODES }, (_, i) => node(`节点${i}`)) };
    assert.deepEqual(run(five).errors, []);
    const six = { chain: Array.from({ length: CHAIN_MAX_NODES + 1 }, (_, i) => node(`节点${i}`)) };
    assert.match(run(six).errors[0]!.reason, /最多 5 个节点/);
  });

  it('空链合法（清空结论）', () => {
    const { errors, value } = run({ chain: [] });
    assert.deepEqual(errors, []);
    assert.deepEqual(value.chain, []);
  });

  it('非法 kind 被拒并给出 index', () => {
    const { errors } = run({ chain: [node('a'), { kind: 'nope', text: 'b' }] });
    assert.equal(errors[0]!.index, 1);
    assert.equal(errors[0]!.field, 'chain');
    assert.match(errors[0]!.reason, /节点类型/);
  });

  it('空文本被拒', () => {
    assert.match(run({ chain: [node('   ')] }).errors[0]!.reason, /不能为空/);
  });

  it('200 字通过，201 字被拒', () => {
    assert.deepEqual(run({ chain: [node('a'.repeat(CHAIN_TEXT_MAX))] }).errors, []);
    assert.match(run({ chain: [node('a'.repeat(CHAIN_TEXT_MAX + 1))] }).errors[0]!.reason, /201 字/);
  });
});

describe('chain：ref 与 branches', () => {
  it('合法 ref 被规范化', () => {
    const { errors, value } = run({ chain: [{ kind: 'cause', text: 'a', ref: ' ./src/a.ts:42 ' }] });
    assert.deepEqual(errors, []);
    assert.equal(value.chain![0]!.ref, './src/a.ts:42');
  });

  it('行号 0 被拒（会渲染成点不开的胶囊）', () => {
    assert.match(run({ chain: [{ kind: 'cause', text: 'a', ref: 'src/a.ts:0' }] }).errors[0]!.reason, /路径:行号/);
  });

  it('带说明文字的 ref 被拒（含空格）', () => {
    assert.equal(run({ chain: [{ kind: 'cause', text: 'a', ref: 'src/a.ts: 12（第 12 行）' }] }).errors.length, 1);
  });

  it('branches 仅允许 root', () => {
    const bad = { chain: [{ kind: 'cause', text: 'a', branches: ['x'] }] };
    assert.match(run(bad).errors[0]!.reason, /只能挂在/);
    const ok = { chain: [{ kind: 'root', text: 'a', branches: ['条件A', '反例B'] }] };
    assert.deepEqual(run(ok).errors, []);
    assert.deepEqual(run(ok).value.chain![0]!.branches, ['条件A', '反例B']);
  });

  it('branches 超过 3 条被拒', () => {
    const bad = { chain: [{ kind: 'root', text: 'a', branches: ['1', '2', '3', '4'] }] };
    assert.match(run(bad).errors[0]!.reason, /最多 3 条/);
  });

  it('单条分支超过 120 字被拒', () => {
    const bad = { chain: [{ kind: 'root', text: 'a', branches: ['b'.repeat(121)] }] };
    assert.match(run(bad).errors[0]!.reason, /121 字/);
  });
});

describe('unconfirmed：条数、长度、重复', () => {
  it('20 条通过，21 条被拒', () => {
    const ok = Array.from({ length: UNCONFIRMED_MAX_ITEMS }, (_, i) => `第${i}条`);
    assert.deepEqual(run({ unconfirmed: ok }).errors, []);
    assert.match(run({ unconfirmed: [...ok, '多一条'] }).errors[0]!.reason, /最多 20 条/);
  });

  it('300 字通过，301 字被拒', () => {
    assert.deepEqual(run({ unconfirmed: ['a'.repeat(UNCONFIRMED_ITEM_MAX)] }).errors, []);
    assert.match(run({ unconfirmed: ['a'.repeat(UNCONFIRMED_ITEM_MAX + 1)] }).errors[0]!.reason, /301 字/);
  });

  it('重复条目被拒', () => {
    assert.match(run({ unconfirmed: ['同一条', '同一条'] }).errors[0]!.reason, /重复/);
  });

  it('空行被拒', () => {
    assert.match(run({ unconfirmed: ['  '] }).errors[0]!.reason, /不能是空行/);
  });
});

describe('confirmed.add：手工位置', () => {
  const loc = { file: 'src/a.ts', line: 12, why: '手工补充' };

  it('合法位置通过', () => {
    const { errors, value } = run({ confirmedAdd: [loc] });
    assert.deepEqual(errors, []);
    assert.deepEqual(value.confirmedAdd, [loc]);
  });

  it('超过单次上限被拒', () => {
    const many = Array.from({ length: MANUAL_LOCATION_ADD_MAX + 1 }, (_, i) => ({ ...loc, line: i + 1 }));
    assert.match(run({ confirmedAdd: many }).errors[0]!.reason, /单次最多/);
  });

  it('含空格路径被拒', () => {
    assert.match(run({ confirmedAdd: [{ ...loc, file: 'src/a b.ts' }] }).errors[0]!.reason, /不能含空格/);
  });

  it('行号 0 / 小数被拒', () => {
    assert.match(run({ confirmedAdd: [{ ...loc, line: 0 }] }).errors[0]!.reason, /正整数/);
    assert.match(run({ confirmedAdd: [{ ...loc, line: 1.5 }] }).errors[0]!.reason, /正整数/);
  });

  it('结束行号小于起始行被拒', () => {
    assert.match(run({ confirmedAdd: [{ ...loc, endLine: 5 }] }).errors[0]!.reason, /不小于起始行号/);
  });

  it('理由为空或超长被拒', () => {
    assert.match(run({ confirmedAdd: [{ ...loc, why: ' ' }] }).errors[0]!.reason, /理由不能为空/);
    assert.match(
      run({ confirmedAdd: [{ ...loc, why: 'a'.repeat(MANUAL_LOCATION_WHY_MAX + 1) }] }).errors[0]!.reason,
      /超过上限/,
    );
  });
});

describe('confirmed.update：改理由', () => {
  it('合法通过', () => {
    const { errors, value } = run({ confirmedUpdate: [{ id: 'loc_1', why: '新理由' }] });
    assert.deepEqual(errors, []);
    assert.deepEqual(value.confirmedUpdate, [{ id: 'loc_1', why: '新理由' }]);
  });

  it('缺 id 被拒', () => {
    assert.match(run({ confirmedUpdate: [{ id: '', why: 'x' }] }).errors[0]!.reason, /缺少位置 id/);
  });

  it('理由超长被拒', () => {
    const { errors } = run({ confirmedUpdate: [{ id: 'loc_1', why: 'a'.repeat(201) }] });
    assert.match(errors[0]!.reason, /超过上限/);
  });
});

describe('多块同时错误：一次全部返回', () => {
  it('结论 + 链 + 未确认点各自报错，不短路', () => {
    const { errors } = validateDraftEdit({
      conclusion: 'a'.repeat(CONCLUSION_MAX_CHARS + 1),
      chain: [{ kind: 'nope', text: 'x' }],
      unconfirmed: [''],
    });
    const fields = errors.map((e) => e.field).sort();
    assert.deepEqual(fields, ['chain', 'conclusion', 'unconfirmed']);
  });
});
