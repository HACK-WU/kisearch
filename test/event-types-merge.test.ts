/**
 * event-types-merge.test.ts —— 内置类型补齐与认领（REQ-20261123-007 · S-02）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/event-types-merge.test.ts
 *
 * 这块改的是 `listTypes` 的返回集合 —— 而 `visibility-index` 正是靠它决定文档档位。
 * 所以每条口径都要钉死，一旦回退症状是「hidden 阶段静默失效」而非报错：
 *   ① 盘上缺新内置 → 补进内存视图
 *   ② 同名 → 认领（builtin:true），阶段等字段保持盘上值
 *   ③ 认领后不可删（且不再依赖固定 id 名单）
 *   ④ id 被不同名类型占用 → 改分配新 id，两者并存，被占方仍可删
 *   ⑤ 读路径不写盘
 *   ⑥ 转正：下次写操作把 builtin:true 落盘
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { listTypes, updateType, deleteType } from '../src/lib/events/type-service.js';
import { writeTypesDoc } from '../src/lib/events/store.js';
import { getKbDir } from '../src/lib/scope.js';
import type { EventTypeRecord } from '../src/lib/events/types.js';

const scope = `evt-merge-${Date.now()}`;
registerTestScope(scope);
after(() => cleanupTestConfig());

function typesFile(s: string): string {
  return path.join(getKbDir(s), '.events', '_types.json');
}

function rec(over: Partial<EventTypeRecord> & { id: string; name: string }): EventTypeRecord {
  const now = Date.now();
  return {
    scope,
    builtin: false,
    stages: [
      { key: 'st_1', name: '待处理', visibility: 'hidden' },
      { key: 'st_2', name: '已收敛', visibility: 'full' },
    ],
    terminalAction: 'keep',
    fallbackDays: 90,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function seed(types: EventTypeRecord[]): void {
  writeTypesDoc(scope, { version: 1, revision: 1, types });
}

describe('内置类型补齐与认领', () => {
  it('① 盘上缺「技术债」→ 补进内存视图', () => {
    seed([rec({ id: 'et_1', name: 'bug 排查' }), rec({ id: 'et_2', name: '性能优化' })]);
    const names = listTypes(scope).map((t) => t.name);
    assert.ok(names.includes('技术债'), '缺失的内置必须补进来');
    assert.ok(names.includes('需求实现'));
    assert.equal(listTypes(scope).find((t) => t.name === '技术债')!.stages.length, 4, '补进来的是四阶段版本');
  });

  it('② 同名条目被认领：builtin 翻 true，阶段仍以盘上为准', () => {
    seed([rec({ id: 'et_4', name: '技术债', stages: [
      { key: 'st_1', name: '待处理', visibility: 'hidden' },
      { key: 'st_2', name: '已收敛', visibility: 'full' },
    ] })]);

    const debt = listTypes(scope).find((t) => t.name === '技术债')!;
    assert.equal(debt.builtin, true, '同名条目应被认领为内置');
    assert.equal(debt.id, 'et_4', 'id 必须保持盘上值，不重新分配');
    assert.deepEqual(
      debt.stages.map((s) => s.name),
      ['待处理', '已收敛'],
      '阶段不得被代码常量覆盖 —— 否则用户改一次就被打回一次',
    );
  });

  it('②-b 盘上无描述时补内置默认；用户已填过的不覆盖', () => {
    seed([rec({ id: 'et_1', name: 'bug 排查' }), rec({ id: 'et_2', name: '性能优化', description: '我自己的说明' })]);
    const types = listTypes(scope);
    const bug = types.find((t) => t.name === 'bug 排查')!;
    const perf = types.find((t) => t.name === '性能优化')!;

    assert.match(String(bug.description), /功能不符合预期/, '早于该字段落盘的库要能拿到内置说明');
    assert.equal(perf.description, '我自己的说明', '用户填过的描述绝不能被内置覆盖');
  });

  it('③ 认领后不可删', async () => {
    seed([rec({ id: 'et_4', name: '技术债' })]);
    assert.equal(listTypes(scope).find((t) => t.id === 'et_4')!.builtin, true);
    await assert.rejects(
      () => deleteType(scope, 'et_4'),
      (err: { code?: string }) => err.code === 'TYPE_BUILTIN',
    );
  });

  it('④ id 被不同名类型占用 → 改分配新 id，两者并存；被占方仍可删', async () => {
    seed([rec({ id: 'et_4', name: '线上事故' })]);

    const types = listTypes(scope);
    const incident = types.find((t) => t.name === '线上事故')!;
    const debt = types.find((t) => t.name === '技术债')!;

    assert.equal(incident.id, 'et_4', '原占位类型不得被顶替');
    assert.equal(incident.builtin, false);
    assert.notEqual(debt.id, 'et_4', '内置应改分配新 id');
    assert.match(debt.id, /^et_\d+$/);

    // 关键：固定 id 名单已移除，占用 et_4 的自定义类型必须还能删
    await deleteType(scope, 'et_4');
    assert.equal(listTypes(scope).some((t) => t.id === 'et_4'), false);
  });

  it('⑤ 读路径不写盘', () => {
    seed([rec({ id: 'et_1', name: 'bug 排查' })]);
    const before = fs.readFileSync(typesFile(scope), 'utf-8');
    listTypes(scope);
    listTypes(scope);
    assert.equal(fs.readFileSync(typesFile(scope), 'utf-8'), before, '补齐必须纯内存，不得落盘');
  });

  it('⑥ 转正：下一次写操作把 builtin:true 落盘', async () => {
    seed([rec({ id: 'et_4', name: '技术债' })]);
    const raw = JSON.parse(fs.readFileSync(typesFile(scope), 'utf-8')) as { types: EventTypeRecord[] };
    assert.equal(raw.types.find((t) => t.name === '技术债')!.builtin, false, '前置：盘上仍是自建');

    const debt = listTypes(scope).find((t) => t.name === '技术债')!;
    await updateType(scope, debt.id, { revision: debt.revision, description: '转正验证' });

    const after = JSON.parse(fs.readFileSync(typesFile(scope), 'utf-8')) as { types: EventTypeRecord[] };
    assert.equal(after.types.find((t) => t.name === '技术债')!.builtin, true, '写操作应把认领结果落盘');
  });
});
