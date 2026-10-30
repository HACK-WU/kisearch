/**
 * S-02：调度器按需定时器 / 到期触发 / 并发保护。
 * 运行：npx jiti test/datasource-scheduler.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DataSourceScheduler, type DataSourceSchedulerDeps } from '../src/lib/datasource-scheduler.js';
import { defaultDataSourceSchedule } from '../src/lib/datasource-schedule.js';
import type { DataSourceRecord } from '../src/lib/datasource-types.js';
import type { ScheduledRunInput, ScheduledRunResult } from '../src/lib/datasource-scheduled-run.js';

const NOW = new Date(2026, 9, 29, 10, 0).getTime();

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
  unref(): void;
}

function makeRecord(
  scope: string,
  schedule: DataSourceRecord['schedule'],
  lastSyncAt: number | null,
): { scope: string; record: DataSourceRecord } {
  return {
    scope,
    record: {
      version: 2,
      scope,
      type: 'directory',
      dir: '/tmp/source',
      group: null,
      conflictMode: 'incremental',
      conflictSuffix: '_{n}',
      vector: true,
      chunkSize: null,
      chunkOverlap: null,
      createdAt: 0,
      updatedAt: 0,
      schedule,
      lastSync: lastSyncAt === null ? null : ({ at: lastSyncAt } as DataSourceRecord['lastSync']),
    },
  };
}

function harness(initialRecords: { scope: string; record: DataSourceRecord }[], opts: {
  disabled?: boolean;
  runResult?: ScheduledRunResult;
} = {}) {
  let clock = NOW;
  let records = initialRecords;
  const timers: FakeTimer[] = [];
  const runs: ScheduledRunInput[] = [];
  const deps: DataSourceSchedulerDeps = {
    now: () => clock,
    readRecords: () => records,
    runSync: async (input) => {
      runs.push(input);
      // 模拟同步完成：推进 lastSync.at
      records = records.map((item) => item.scope === input.scope
        ? {
          ...item,
          record: { ...item.record, lastSync: { at: clock } as DataSourceRecord['lastSync'] },
        }
        : item);
      return opts.runResult ?? { outcome: 'succeeded', durationMs: 1 };
    },
    setTimer: (fn, ms) => {
      const timer: FakeTimer = { fn, ms, cleared: false, unref: () => undefined };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as FakeTimer).cleared = true;
    },
    random: () => 0,
    disabled: () => opts.disabled === true,
  };
  const scheduler = new DataSourceScheduler(deps);
  return { scheduler, timers, runs, setNow: (next: number) => { clock = next; }, setRecords: (next: typeof records) => { records = next; } };
}

function fire(scheduler: DataSourceScheduler): Promise<void> {
  return (scheduler as unknown as { fire(): Promise<void> }).fire();
}

describe('DataSourceScheduler', () => {
  it('0 个启用计划 → 不建 timer', () => {
    const h = harness([makeRecord('a', { ...defaultDataSourceSchedule(), enabled: false }, null)]);
    h.scheduler.start();
    assert.equal(h.scheduler.getState().armed, false);
    assert.equal(h.timers.length, 0);
    h.scheduler.stop();
  });

  it('一个到期计划 → arm 0ms 并触发一次', async () => {
    const schedule = {
      ...defaultDataSourceSchedule(),
      enabled: true,
      mode: 'interval' as const,
      intervalValue: 30,
      intervalUnit: 'minute' as const,
    };
    const h = harness([makeRecord('a', schedule, NOW - 40 * 60_000)]);
    h.scheduler.start();
    assert.equal(h.scheduler.getState().armed, true);
    assert.equal(h.timers[0]?.ms, 0);
    await fire(h.scheduler);
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0]?.scope, 'a');
    // 运行后 lastSync 推进，下一次为 30 分钟后
    assert.equal(h.scheduler.getState().nextRunAt, NOW + 30 * 60_000);
    h.scheduler.stop();
  });

  it('仅一次已完成 → 无下次、不建 timer', () => {
    const at = '2026-10-27T09:00';
    const atMs = new Date(2026, 9, 27, 9, 0).getTime();
    const schedule = {
      ...defaultDataSourceSchedule(),
      enabled: true,
      mode: 'at' as const,
      at,
      repeat: 'once' as const,
      lastAutoFor: atMs,
    };
    const h = harness([makeRecord('a', schedule, null)]);
    h.scheduler.start();
    assert.equal(h.scheduler.getState().armed, false);
    assert.equal(h.scheduler.getState().nextRunAt, null);
    h.scheduler.stop();
  });

  it('运行中再次 fire 不并发执行', async () => {
    const schedule = {
      ...defaultDataSourceSchedule(),
      enabled: true,
      mode: 'interval' as const,
      intervalValue: 30,
      intervalUnit: 'minute' as const,
    };
    let resolveRun: (() => void) | null = null;
    const h = harness([makeRecord('a', schedule, NOW - 40 * 60_000)]);
    // 用一个挂起的 run 替换
    (h as unknown as { scheduler: DataSourceScheduler }).scheduler = new DataSourceScheduler({
      now: () => NOW,
      readRecords: () => [makeRecord('a', schedule, NOW - 40 * 60_000)],
      runSync: () => new Promise<ScheduledRunResult>((resolve) => { resolveRun = () => resolve({ outcome: 'succeeded' }); }),
      setTimer: () => ({ unref: () => undefined } as unknown as ReturnType<typeof setTimeout>),
      clearTimer: () => undefined,
      random: () => 0,
      disabled: () => false,
    });
    h.scheduler.start();
    const first = fire(h.scheduler);
    await new Promise((r) => setTimeout(r, 0));
    await fire(h.scheduler);
    assert.ok(resolveRun, '第一次运行应已进入 runSync');
    (resolveRun as () => void)();
    await first;
    h.scheduler.stop();
  });

  it('KI_DISABLE_DATASOURCE_SCHEDULER=1 → 不启动', () => {
    const h = harness([], { disabled: true });
    h.scheduler.start();
    assert.equal(h.scheduler.getState().started, false);
    assert.equal(h.scheduler.getState().disabled, true);
    assert.equal(h.timers.length, 0);
  });
});
