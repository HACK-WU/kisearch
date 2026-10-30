/**
 * S-01：定时计划保存（校验 / 乐观锁 / 写锁 / 运行态）。
 * 运行：npx jiti test/datasource-schedule-save.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import {
  addDataSource,
  applyScheduleRunResult,
  readDataSource,
  resetScheduleFailures,
  saveDataSourceSchedule,
} from '../src/lib/datasource.js';
import { withScopeWriteLock } from '../src/lib/scope-write-lock.js';

let root: string;
let configPath: string;
let savedConfigPath: string | undefined;
const scope = `ds-sched-${process.pid}`;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-sched-save-'));
  const dataDir = path.join(root, 'kb');
  configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir,
    vectorDir: path.join(root, 'vector'),
    backupDir: path.join(root, 'backup'),
    scopeMode: 'default',
    scopes: { [scope]: {} },
  }), 'utf8');
  savedConfigPath = process.env.KI_CONFIG_PATH;
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();

  const source = path.join(root, 'source');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'a.md'), '# a\n');
  const added = await addDataSource({ scope, dir: source, config: loadConfig() });
  assert.equal(added.ok, true);
});

after(() => {
  if (savedConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = savedConfigPath;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('saveDataSourceSchedule', () => {
  it('合法周期保存并落盘', async () => {
    const res = await saveDataSourceSchedule({
      scope,
      config: loadConfig(),
      schedule: {
        enabled: true,
        mode: 'interval',
        intervalValue: 30,
        intervalUnit: 'minute',
        at: null,
        repeat: null,
      },
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.record.schedule.enabled, true);
    assert.equal(res.record.schedule.revision, 1);
    const read = readDataSource(scope);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.record.schedule.intervalValue, 30);
  });

  it('关闭后保留上次填写值', async () => {
    const res = await saveDataSourceSchedule({
      scope,
      config: loadConfig(),
      schedule: {
        enabled: false,
        mode: 'interval',
        intervalValue: 30,
        intervalUnit: 'minute',
        at: null,
        repeat: null,
        baseRevision: 1,
      },
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.record.schedule.enabled, false);
    assert.equal(res.record.schedule.intervalValue, 30);
    assert.equal(res.record.schedule.revision, 2);
  });

  it('baseRevision 失配 → SCHEDULE_STALE', async () => {
    const res = await saveDataSourceSchedule({
      scope,
      config: loadConfig(),
      schedule: {
        enabled: true,
        mode: 'interval',
        intervalValue: 60,
        intervalUnit: 'minute',
        at: null,
        repeat: null,
        baseRevision: 1,
      },
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'SCHEDULE_STALE');
  });

  it('非法间隔 → 400 语义，不落盘', async () => {
    const before = readDataSource(scope);
    assert.equal(before.ok, true);
    if (!before.ok) return;
    const res = await saveDataSourceSchedule({
      scope,
      config: loadConfig(),
      schedule: {
        enabled: true,
        mode: 'interval',
        intervalValue: 0,
        intervalUnit: 'minute',
        at: null,
        repeat: null,
      },
    });
    assert.equal(res.ok, false);
    const after = readDataSource(scope);
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.equal(after.record.schedule.revision, before.record.schedule.revision);
  });

  it('写锁被占 → SCOPE_OPERATION_BUSY', async () => {
    let release: (() => void) | null = null;
    const held = withScopeWriteLock(scope, 'test-hold', () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const res = await saveDataSourceSchedule({
      scope,
      config: loadConfig(),
      schedule: {
        enabled: true,
        mode: 'interval',
        intervalValue: 15,
        intervalUnit: 'minute',
        at: null,
        repeat: null,
      },
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, 'SCOPE_OPERATION_BUSY');
    (release as (() => void) | null)?.();
    await held;
  });

  it('运行结果写回：失败 +1、成功清零、仅一次完成自动关闭', async () => {
    // 先设一个合法周期
    const saved = await saveDataSourceSchedule({
      scope,
      config: loadConfig(),
      schedule: { enabled: true, mode: 'interval', intervalValue: 30, intervalUnit: 'minute', at: null, repeat: null },
    });
    assert.equal(saved.ok, true);
    applyScheduleRunResult(scope, { outcome: 'failed', slot: null, at: Date.now() });
    let read = readDataSource(scope);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.record.schedule.consecutiveFailures, 1);
    assert.equal(read.record.schedule.lastAutoState, 'failed');

    await resetScheduleFailures(scope);
    read = readDataSource(scope);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.record.schedule.consecutiveFailures, 0);

    // 仅一次完成 → enabled=false，保留 lastAuto*
    const at = '2026-11-01T09:00';
    const once = await saveDataSourceSchedule({
      scope,
      config: loadConfig(),
      schedule: { enabled: true, mode: 'at', at, repeat: 'once', intervalValue: null, intervalUnit: null },
    });
    assert.equal(once.ok, true);
    applyScheduleRunResult(scope, {
      outcome: 'succeeded',
      slot: new Date(2026, 10, 1, 9, 0).getTime(),
      at: Date.now(),
    });
    read = readDataSource(scope);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.record.schedule.enabled, false);
    assert.equal(read.record.schedule.lastAutoState, 'ok');
  });

  it('★ 启用锚点：开启时写入、改间隔不重置、关闭清空（否则周期永不触发）', async () => {
    const save = (schedule: Record<string, unknown>) => saveDataSourceSchedule({
      scope, config: loadConfig(), schedule: { at: null, repeat: null, ...schedule },
    });

    // 关闭态：锚点为空
    const off = readDataSource(scope);
    assert.equal(off.ok, true);
    if (!off.ok) return;
    assert.equal(off.record.schedule.enabled, false);
    assert.equal(off.record.schedule.enabledAt, null);

    // 首次开启 → 写入锚点
    const opened = await save({ enabled: true, mode: 'interval', intervalValue: 30, intervalUnit: 'minute' });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    const anchor = opened.record.schedule.enabledAt;
    assert.equal(typeof anchor, 'number');
    assert.ok((anchor as number) > 0);

    // 改间隔（仍启用）→ 锚点不动，否则每次保存都把周期起点推后
    const tweaked = await save({ enabled: true, mode: 'interval', intervalValue: 5, intervalUnit: 'minute' });
    assert.equal(tweaked.ok, true);
    if (!tweaked.ok) return;
    assert.equal(tweaked.record.schedule.enabledAt, anchor);
    assert.equal(tweaked.record.schedule.intervalValue, 5);

    // 关闭 → 清空；再开 → 新锚点
    const closed = await save({ enabled: false, mode: 'interval', intervalValue: 5, intervalUnit: 'minute' });
    assert.equal(closed.ok, true);
    if (!closed.ok) return;
    assert.equal(closed.record.schedule.enabledAt, null);
    const reopened = await save({ enabled: true, mode: 'interval', intervalValue: 5, intervalUnit: 'minute' });
    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    assert.equal(typeof reopened.record.schedule.enabledAt, 'number');
  });
});
