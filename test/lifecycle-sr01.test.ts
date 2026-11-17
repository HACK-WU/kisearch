/**
 * lifecycle-sr01.test.ts —— S-01 分类字段与写入链路（B1 门禁）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/lifecycle-sr01.test.ts
 *
 * 覆盖需求 A1 / A3 与 S-01 的四类语义：
 *   新建缺省 / group 默认 / 覆盖保持 / 数据源锁 / 事件绑定校验。
 * 不起 daemon、不调 embedding：全部纯函数级。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { precheckLifecycle, applyLifecyclePlan } from '../src/lib/relation-lifecycle.js';
import { DEFAULT_TRASH_SETTINGS, BUILTIN_PRESETS, validatePresetKind } from '../src/lib/governance-store.js';
import type { GovernanceConfig } from '../src/lib/governance-store.js';
import type { EventRecord } from '../src/lib/events/types.js';
import type { Relation } from '../src/lib/scoring.js';

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;

function gov(overrides: Partial<GovernanceConfig> = {}): GovernanceConfig {
  return {
    version: 1,
    scope: 'test',
    lifecyclePresets: [...BUILTIN_PRESETS],
    groupDefaults: {},
    trash: { ...DEFAULT_TRASH_SETTINGS },
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function rel(partial: Partial<Relation> = {}): Relation {
  return {
    id: 'rel_001',
    text: 'doc',
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
    ...partial,
  };
}

function event(partial: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'evt_test_1',
    shortId: 3,
    scope: 'test',
    title: '登录页白屏',
    typeId: 'et_1',
    stageKey: 'st_2',
    stageIndex: 1,
    closedAt: null,
    revision: 1,
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW,
    ...partial,
  };
}

function base(extra: Partial<Parameters<typeof precheckLifecycle>[0]> = {}) {
  return {
    scope: 'test',
    group: '错误库/Web前端界面',
    relation: 'doc',
    locked: false,
    now: NOW,
    events: [] as EventRecord[],
    governance: gov(),
    ...extra,
  };
}

describe('① 新建缺省', () => {
  it('未传 + 无 group 默认 → wiki / fallback-wiki', () => {
    const r = precheckLifecycle(base());
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.summary.lifecycle, 'wiki');
    assert.equal(r.ok && r.summary.source, 'fallback-wiki');
    assert.deepEqual(r.ok && r.plan, { action: 'clear' });
  });

  it('未传 + group 默认 temp(30) → temp / group-default', () => {
    const r = precheckLifecycle(base({
      governance: gov({ groupDefaults: { '错误库/Web前端界面': { kind: 'temp', ttlDays: 30 } } }),
    }));
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.summary.lifecycle, 'temp');
    assert.equal(r.ok && r.summary.source, 'group-default');
    assert.equal(r.ok && r.summary.ttlDays, 30);
    assert.equal(r.ok && r.summary.expiresAt, NOW + 30 * DAY);
  });

  it('未传 + group 默认 wiki → wiki / group-default', () => {
    const r = precheckLifecycle(base({
      governance: gov({ groupDefaults: { '错误库/Web前端界面': { kind: 'wiki' } } }),
    }));
    assert.equal(r.ok && r.summary.source, 'group-default');
    assert.equal(r.ok && r.summary.lifecycle, 'wiki');
  });
});

describe('② 覆盖保持原值', () => {
  it('覆盖未传 → keep，回显原分类', () => {
    const r = precheckLifecycle(base({
      existing: rel({ lifecycle: 'temp', expiresAt: NOW + 5 * DAY, ttlDays: 30 }),
      governance: gov({ groupDefaults: { '错误库/Web前端界面': { kind: 'wiki' } } }),
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.plan, { action: 'keep' });
    assert.equal(r.ok && r.summary.lifecycle, 'temp');
    assert.equal(r.ok && r.summary.source, 'preserved');
    assert.equal(r.ok && r.summary.expiresAt, NOW + 5 * DAY);
  });

  it('覆盖 + 显式 wiki → clear（不是 keep）', () => {
    const r = precheckLifecycle(base({
      existing: rel({ lifecycle: 'event', eventId: 'evt_old' }),
      lifecycle: 'wiki',
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.plan, { action: 'clear' });
  });
});

describe('③ 显式分类', () => {
  it('显式 temp → 换算 expiresAt 并记录 ttlDays', () => {
    const r = precheckLifecycle(base({ lifecycle: 'temp', ttlDays: 7 }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.plan, { action: 'temp', ttlDays: 7, expiresAt: NOW + 7 * DAY });
  });

  it('显式 temp 缺 ttl → TTL_REQUIRED', () => {
    const r = precheckLifecycle(base({ lifecycle: 'temp' }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'TTL_REQUIRED');
  });

  it('显式 wiki 带 ttl → 冲突', () => {
    const r = precheckLifecycle(base({ lifecycle: 'wiki', ttlDays: 7 }));
    assert.equal(r.ok === false && r.code, 'LIFECYCLE_ARG_CONFLICT');
  });
});

describe('④ 数据源文档锁', () => {
  it('显式改分类 → DATASOURCE_LIFECYCLE_LOCKED', () => {
    const r = precheckLifecycle(base({
      locked: true,
      existing: rel({ isImported: true }),
      lifecycle: 'temp',
      ttlDays: 7,
    }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'DATASOURCE_LIFECYCLE_LOCKED');
  });

  it('未传 → 允许（保持原值）', () => {
    const r = precheckLifecycle(base({ locked: true, existing: rel({ isImported: true }) }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.plan, { action: 'keep' });
  });
});

describe('⑤ 事件绑定', () => {
  it('事件不存在 → EVENT_NOT_FOUND + 可用列表', () => {
    const r = precheckLifecycle(base({ lifecycle: 'event', eventId: '#99', events: [event()] }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'EVENT_NOT_FOUND');
    const available = (r.ok === false && (r.details?.available as Array<{ shortId: number }>)) || [];
    assert.equal(available.length, 1);
    assert.equal(available[0].shortId, 3);
  });

  it('事件已收口 → EVENT_CLOSED', () => {
    const r = precheckLifecycle(base({
      lifecycle: 'event',
      eventId: 'evt_test_1',
      events: [event({ closedAt: NOW - DAY })],
    }));
    assert.equal(r.ok === false && r.code, 'EVENT_CLOSED');
  });

  it('未收口 → 绑定成功，支持 #3 写法', () => {
    const r = precheckLifecycle(base({ lifecycle: 'event', eventId: '#3', events: [event()] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.plan, {
      action: 'event',
      eventId: 'evt_test_1',
      event: { id: 'evt_test_1', shortId: 3, title: '登录页白屏' },
    });
    assert.equal(r.ok && r.summary.lifecycle, 'event');
  });
});

describe('⑥ applyLifecyclePlan 落字段', () => {
  it('clear 清空四个字段', () => {
    const target = rel({ lifecycle: 'event', eventId: 'evt_x', expiresAt: 1, ttlDays: 3 });
    applyLifecyclePlan(target, { action: 'clear' });
    assert.equal(target.lifecycle, undefined);
    assert.equal(target.expiresAt, undefined);
    assert.equal(target.eventId, undefined);
    assert.equal(target.ttlDays, undefined);
  });

  it('temp 只写三个字段并清 eventId', () => {
    const target = rel({ lifecycle: 'event', eventId: 'evt_x' });
    applyLifecyclePlan(target, { action: 'temp', ttlDays: 30, expiresAt: NOW + 30 * DAY });
    assert.equal(target.lifecycle, 'temp');
    assert.equal(target.ttlDays, 30);
    assert.equal(target.expiresAt, NOW + 30 * DAY);
    assert.equal(target.eventId, undefined);
  });

  it('event 写 eventId 并清期限字段', () => {
    const target = rel({ lifecycle: 'temp', expiresAt: 1, ttlDays: 7 });
    applyLifecyclePlan(target, { action: 'event', eventId: 'evt_y', event: { id: 'evt_y', shortId: 1, title: 't' } });
    assert.equal(target.lifecycle, 'event');
    assert.equal(target.eventId, 'evt_y');
    assert.equal(target.expiresAt, undefined);
    assert.equal(target.ttlDays, undefined);
  });

  it('keep 不动任何字段', () => {
    const target = rel({ lifecycle: 'temp', expiresAt: 9, ttlDays: 3 });
    applyLifecyclePlan(target, { action: 'keep' });
    assert.deepEqual(
      { l: target.lifecycle, e: target.expiresAt, t: target.ttlDays },
      { l: 'temp', e: 9, t: 3 },
    );
  });
});

describe('⑦ 防线源码断言（防后续被删）', () => {
  const root = process.cwd();

  it('导入链路的 upsertRelation 覆盖时**保留**生命周期字段（REQ-20261116-006 反转旧 R4）', () => {
    const src = fs.readFileSync(path.join(root, 'src/lib/import.ts'), 'utf8');
    const start = src.indexOf('function upsertRelation');
    assert.ok(start > 0, 'upsertRelation 不存在');
    const body = src.slice(start, start + 3000);

    // 数据源覆盖分支必须走「保留 + 成组自洽校验」的 helper，而不是无条件清空
    const branchStart = body.indexOf('} else if (datasource) {');
    assert.ok(branchStart >= 0, '未找到 datasource 覆盖分支');
    const branchEnd = body.indexOf('\n  }', branchStart);
    const branch = body.slice(branchStart, branchEnd > 0 ? branchEnd : undefined);
    assert.ok(branch.includes('preserveLifecycleOnOverwrite('), '覆盖分支必须调用保留 helper');
    assert.ok(!branch.includes('delete rel.'), '覆盖分支不得再无条件删除分类字段');

    /**
     * 旧防线是「四处 delete 必须在 upsertRelation 里」；2026-11-17 需求反转后
     * 清理动作**只允许**出现在 helper 的「降级 wiki」路径：全文件 `delete rel.lifecycle`
     * 有且只有一处，且位于 helper 内部 —— 两处以上说明有人又在别处静默清分类。
     */
    const deletes = [...src.matchAll(/delete rel\.lifecycle/g)];
    assert.equal(deletes.length, 1, `delete rel.lifecycle 只应出现在降级路径，实际 ${deletes.length} 处`);
    const helperStart = src.indexOf('function preserveLifecycleOnOverwrite');
    assert.ok(helperStart > 0, '降级路径的 helper 不得被删（否则不自洽数据无人处理）');
    assert.ok(deletes[0].index! > helperStart, 'delete rel.lifecycle 必须在 helper 内部');
  });

  it('MCP 写入工具暴露了三个分类参数', () => {
    const single = fs.readFileSync(path.join(root, 'src/lib/mcp-tools/sync-relation.ts'), 'utf8');
    assert.match(single, /lifecycle:/);
    assert.match(single, /ttl_days:/);
    assert.match(single, /event:/);

    const bulk = fs.readFileSync(path.join(root, 'src/lib/mcp-tools/bulk-sync-relation.ts'), 'utf8');
    assert.match(bulk, /lifecycle:/);
    assert.match(bulk, /ttl_days:/);
  });

  it('单条与批量都走同一个 precheck（禁止各自实现）', () => {
    const src = fs.readFileSync(path.join(root, 'src/sync-relation.ts'), 'utf8');
    const hits = [...src.matchAll(/precheckLifecycle\(/g)].length;
    assert.equal(hits, 2, `应有两处调用（单条 + 批量），实际 ${hits}`);
  });
});

describe('⑧ 预设档位校验（契约面）', () => {
  it('只允许 wiki / temp，event 被拒（不能落盘为预设）', () => {
    assert.equal(validatePresetKind('wiki').ok, true);
    assert.equal(validatePresetKind('temp').ok, true);
    const bad = validatePresetKind('event');
    assert.equal(bad.ok, false);
    assert.match(bad.ok === false ? bad.message : '', /wiki \/ temp/);
  });
});
