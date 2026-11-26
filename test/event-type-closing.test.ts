/**
 * event-type-closing.test.ts —— 末位阶段统一「已关闭」（2026-11-26 用户需求）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/event-type-closing.test.ts
 *
 * 这块的口径一旦回退，症状是**静默**的（不报错，只在检索结果里显形）：
 *   ① 内置四类末位名统一，原末位降为仅全文（事件未关闭时不该被语义召回）
 *   ② 自建类型创建时自动补末位（用户给 / 不给 / 给在中间 / 给两条，都要收敛到同一形状）
 *   ③ 追加阶段自动插到末位之前（否则新阶段顶掉收口入口，该类型再也收不了口）
 *   ④ 末位改名 / 停用 / 删除一律拒绝
 *   ⑤ 迁移：补类型 + 吸附存量已收口事件，但**不动 `closedAt`**（不二次收口）
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { listTypes, createType, updateType } from '../src/lib/events/type-service.js';
import { migrateClosingStage } from '../src/lib/events/migrate-closing-stage.js';
import { writeTypesDoc, writeEvent, readAllEvents } from '../src/lib/events/store.js';
import { readStageLogs } from '../src/lib/events/stage-log.js';
import { getKbDir } from '../src/lib/scope.js';
import { TERMINAL_STAGE_NAME } from '../src/lib/events/types.js';
import type { EventRecord, EventTypeRecord } from '../src/lib/events/types.js';

const scBuiltin = `evt-closing-builtin-${Date.now()}`;
const scRule = `evt-closing-rule-${Date.now()}`;
const scMigrate = `evt-closing-migrate-${Date.now()}`;
for (const s of [scBuiltin, scRule, scMigrate]) registerTestScope(s);
after(() => cleanupTestConfig());

function typesFile(scope: string): string {
  return path.join(getKbDir(scope), '.events', '_types.json');
}

function rec(over: Partial<EventTypeRecord> & { id: string; name: string }): EventTypeRecord {
  const now = Date.now();
  return {
    scope: scMigrate,
    builtin: false,
    stages: [
      { key: 'st_1', name: '分析中', visibility: 'hidden' },
      { key: 'st_2', name: '优化中', visibility: 'fts-only' },
      { key: 'st_3', name: '已完成', visibility: 'full' },
    ],
    terminalAction: 'keep',
    fallbackDays: 90,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function eventRec(over: Partial<EventRecord> & { id: string; typeId: string }): EventRecord {
  const now = Date.now();
  return {
    shortId: 1,
    scope: scMigrate,
    title: '样例事件',
    stageKey: 'st_3',
    stageIndex: 2,
    closedAt: now,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('① 内置类型的末位', () => {
  it('四类末位都是「已关闭」，被顶下末位的原阶段降为仅全文', () => {
    const types = listTypes(scBuiltin);
    assert.deepEqual(types.map((t) => t.name), ['bug 排查', '性能优化', '需求实现', '技术债']);
    for (const type of types) {
      assert.equal(type.stages[type.stages.length - 1].name, TERMINAL_STAGE_NAME, `「${type.name}」末位不是已关闭`);
      assert.equal(type.stages[type.stages.length - 1].visibility, 'full');
    }
    assert.deepEqual(
      types[1].stages.map((s) => s.name),
      ['分析中', '优化中', '已验证', '已完成', '已关闭'],
      '业务节点「已完成」保留，收口交给末位',
    );
    assert.equal(types[1].stages[3].visibility, 'fts-only', '原末位必须降档：未关闭的事件不该被语义召回');
  });
});

describe('② 创建类型自动补末位', () => {
  it('不传阶段 → 末位自动补', async () => {
    const t = await createType(scRule, { name: '不传阶段' });
    assert.equal(t.stages[t.stages.length - 1].name, TERMINAL_STAGE_NAME);
    assert.equal(t.stages.length, 2);
  });

  it('传的中间阶段不含「已关闭」→ 自动追加', async () => {
    const t = await createType(scRule, {
      name: '不含末位',
      stages: [
        { name: '发现', visibility: 'hidden' },
        { name: '处置', visibility: 'fts-only' },
      ],
    });
    assert.deepEqual(t.stages.map((s) => s.name), ['发现', '处置', TERMINAL_STAGE_NAME]);
    assert.equal(t.stages[2].key, 'st_3');
  });

  it('「已关闭」写在中间 → 移到末位，key 保留', async () => {
    const t = await createType(scRule, {
      name: '写错位置',
      stages: [
        { name: '发现', visibility: 'hidden' },
        { name: TERMINAL_STAGE_NAME, visibility: 'full' },
        { name: '复盘', visibility: 'fts-only' },
      ],
    });
    assert.deepEqual(t.stages.map((s) => s.name), ['发现', '复盘', TERMINAL_STAGE_NAME]);
    assert.equal(t.stages[2].key, 'st_2', '已有阶段换位置不改 key（事件位置存的是 key）');
  });

  it('写了两条「已关闭」→ 只留一条', async () => {
    const t = await createType(scRule, {
      name: '重复末位',
      stages: [
        { name: TERMINAL_STAGE_NAME, visibility: 'full' },
        { name: '中间', visibility: 'hidden' },
        { name: TERMINAL_STAGE_NAME, visibility: 'fts-only' },
      ],
    });
    assert.equal(t.stages.filter((s) => s.name === TERMINAL_STAGE_NAME).length, 1);
    assert.equal(t.stages[t.stages.length - 1].name, TERMINAL_STAGE_NAME);
  });
});

describe('③ 更新类型：追加落位与末位锁定', () => {
  it('追加阶段插到「已关闭」之前', async () => {
    const t = await createType(scRule, {
      name: '追加落位',
      stages: [
        { name: '一', visibility: 'hidden' },
        { name: '二', visibility: 'fts-only' },
      ],
    });
    const stages = t.stages.map((s) => ({ key: s.key, name: s.name, visibility: s.visibility }));
    stages.push({ name: '三', visibility: 'fts-only' });

    const next = await updateType(scRule, t.id, { revision: t.revision, stages });
    assert.deepEqual(next.stages.map((s) => s.name), ['一', '二', '三', TERMINAL_STAGE_NAME]);
  });

  it('末位改名 → TERMINAL_STAGE_REQUIRED', async () => {
    const t = await createType(scRule, {
      name: '末位改名',
      stages: [{ name: '一', visibility: 'hidden' }],
    });
    const stages = t.stages.map((s, i) => ({
      key: s.key,
      name: i === t.stages.length - 1 ? '完成' : s.name,
      visibility: s.visibility,
    }));
    await assert.rejects(
      () => updateType(scRule, t.id, { revision: t.revision, stages }),
      (err: { code?: string; details?: { expected?: string } }) =>
        err.code === 'TERMINAL_STAGE_REQUIRED' && err.details?.expected === TERMINAL_STAGE_NAME,
    );
  });

  it('末位停用 → TERMINAL_STAGE_CANNOT_DISABLE', async () => {
    const t = await createType(scRule, {
      name: '末位停用',
      stages: [{ name: '一', visibility: 'hidden' }],
    });
    const stages = t.stages.map((s, i) => ({
      key: s.key,
      name: s.name,
      visibility: s.visibility,
      ...(i === t.stages.length - 1 ? { disabled: true } : {}),
    }));
    await assert.rejects(
      () => updateType(scRule, t.id, { revision: t.revision, stages }),
      (err: { code?: string }) => err.code === 'TERMINAL_STAGE_CANNOT_DISABLE',
    );
  });

  it('删掉末位 → STAGE_DELETE_FORBIDDEN', async () => {
    const t = await createType(scRule, {
      name: '删末位',
      stages: [{ name: '一', visibility: 'hidden' }],
    });
    const stages = t.stages.slice(0, -1).map((s) => ({ key: s.key, name: s.name, visibility: s.visibility }));
    await assert.rejects(
      () => updateType(scRule, t.id, { revision: t.revision, stages }),
      (err: { code?: string }) => err.code === 'STAGE_DELETE_FORBIDDEN',
    );
  });
});

describe('④ 存量迁移', () => {
  it('补末位 + 降原末位档位 + 吸附已收口事件（不动 closedAt）', async () => {
    const type = rec({ id: 'et_1', name: '性能优化' });
    writeTypesDoc(scMigrate, { version: 1, revision: 1, types: [type] });
    const closedAt = 1_700_000_000_000;
    const updatedAt = 1_700_000_000_001;
    writeEvent(scMigrate, eventRec({ id: 'evt_a', typeId: 'et_1', stageKey: 'st_3', stageIndex: 2, closedAt, updatedAt }));
    // 未收口事件停在中途阶段：不该被吸附
    writeEvent(scMigrate, eventRec({ id: 'evt_b', typeId: 'et_1', stageKey: 'st_2', stageIndex: 1, shortId: 2, closedAt: null }));

    const res = await migrateClosingStage(scMigrate);
    assert.equal(res.types.changed.length, 1);
    assert.deepEqual(res.types.changed[0].after, ['分析中', '优化中', '已完成', TERMINAL_STAGE_NAME]);
    assert.equal(res.events.changed.length, 1, '只有已收口那条要吸附');
    assert.equal(res.events.changed[0].id, 'evt_a');
    assert.ok(res.backupPath && fs.existsSync(res.backupPath), '写盘前必须留备份');

    const after = readAllEvents(scMigrate);
    const a = after.find((e) => e.id === 'evt_a')!;
    const b = after.find((e) => e.id === 'evt_b')!;
    assert.equal(a.stageKey, 'st_4', '已收口事件吸附到末位');
    assert.equal(a.stageIndex, 3);
    assert.equal(a.closedAt, closedAt, '收口时间必须原样保留（吸附不是二次收口）');
    assert.equal(a.updatedAt, updatedAt, 'updatedAt 不得刷新：否则历史事件会集体跳到列表最前并点亮红点');
    assert.equal(a.revision, 2);
    assert.equal(b.stageKey, 'st_2', '未收口事件不动');

    const logs = readStageLogs(scMigrate, 'evt_a');
    assert.match(String(logs[logs.length - 1]?.note), /不触发终态动作/);

    const stages = listTypes(scMigrate).find((t) => t.name === '性能优化')!.stages;
    assert.deepEqual(stages.map((s) => s.visibility), ['hidden', 'fts-only', 'fts-only', 'full']);
  });

  it('原末位是 hidden 时，新末位继承该档位（不把收口文档重新放进检索）', async () => {
    const other = `evt-closing-hidden-${Date.now()}`;
    registerTestScope(other);
    writeTypesDoc(other, {
      version: 1,
      revision: 1,
      types: [{
        ...rec({ id: 'et_9', name: '私密终态' }),
        scope: other,
        stages: [
          { key: 'st_1', name: '进行中', visibility: 'hidden' },
          { key: 'st_2', name: '已归档', visibility: 'hidden' },
        ],
      }],
    });

    await migrateClosingStage(other);
    const stages = listTypes(other).find((t) => t.name === '私密终态')!.stages;
    assert.deepEqual(stages.map((s) => s.name), ['进行中', '已归档', TERMINAL_STAGE_NAME]);
    assert.equal(stages[2].visibility, 'hidden', '迁移不得把用户设成 hidden 的终态提升为可检索');
    assert.equal(stages[1].visibility, 'hidden', '非 full 的原末位既不降档也不提升');
  });

  it('幂等：再跑一次全部 skipped', async () => {
    const res = await migrateClosingStage(scMigrate);
    assert.equal(res.types.changed.length, 0);
    assert.equal(res.events.changed.length, 0);
    assert.equal(res.backupPath, undefined, '无变更时不该再产备份');
  });

  it('dry-run 不写盘', async () => {
    const other = `evt-closing-dry-${Date.now()}`;
    registerTestScope(other);
    const type = { ...rec({ id: 'et_9', name: '老类型' }), scope: other };
    writeTypesDoc(other, { version: 1, revision: 1, types: [type] });
    writeEvent(other, { ...eventRec({ id: 'evt_c', typeId: 'et_9' }), scope: other, closedAt: 1_700_000_000_000 });
    const before = fs.readFileSync(typesFile(other), 'utf-8');

    const res = await migrateClosingStage(other, { dryRun: true });
    assert.equal(res.types.changed.length, 1, 'dry-run 也要给预览');
    assert.equal(res.events.changed.length, 1);
    assert.equal(fs.readFileSync(typesFile(other), 'utf-8'), before, 'dry-run 不得改 _types.json');
    assert.equal(readAllEvents(other).find((e) => e.id === 'evt_c')!.stageKey, 'st_3', 'dry-run 不得改事件');
  });

  it('--skip-events：类型迁移了，事件不吸附', async () => {
    const other = `evt-closing-skip-${Date.now()}`;
    registerTestScope(other);
    writeTypesDoc(other, {
      version: 1,
      revision: 1,
      types: [{ ...rec({ id: 'et_9', name: '老类型' }), scope: other }],
    });
    writeEvent(other, { ...eventRec({ id: 'evt_d', typeId: 'et_9' }), scope: other, closedAt: 1_700_000_000_000 });

    const res = await migrateClosingStage(other, { skipEvents: true });
    assert.equal(res.types.changed.length, 1);
    assert.equal(res.events.changed.length, 0);
    assert.match(String(res.warning), /1 条已收口事件仍停在旧末位阶段/, '留下中间态必须给非阻断提示');
    assert.equal(readAllEvents(other).find((e) => e.id === 'evt_d')!.stageKey, 'st_3', '事件保持原位');
  });

  it('阶段键悬空的事件跳过并报出，不猜目标阶段', async () => {
    const other = `evt-closing-orphan-${Date.now()}`;
    registerTestScope(other);
    writeTypesDoc(other, {
      version: 1,
      revision: 1,
      types: [{ ...rec({ id: 'et_9', name: '老类型' }), scope: other }],
    });
    writeEvent(other, { ...eventRec({ id: 'evt_e', typeId: 'et_9', stageKey: 'st_99' }), scope: other });

    const res = await migrateClosingStage(other);
    assert.equal(res.events.changed.length, 0);
    assert.match(String(res.events.skipped[0]?.reason), /悬空/);
    assert.equal(readAllEvents(other).find((e) => e.id === 'evt_e')!.stageKey, 'st_99', '悬空事件不得被改');
  });
});
