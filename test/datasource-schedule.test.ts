/**
 * S-01/S-02：定时计划纯函数。
 * 运行：npx jiti test/datasource-schedule.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeNextRun,
  defaultDataSourceSchedule,
  describeSchedule,
  normalizeDataSourceSchedule,
  parseAtLocal,
  scheduleListSummary,
  toScheduleView,
  validateScheduleInput,
} from '../src/lib/datasource-schedule.js';

function localAt(y: number, mo: number, d: number, h: number, mi: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`;
}

const NOW = new Date(2026, 9, 29, 10, 0, 0, 0).getTime(); // 2026-10-29 10:00 local

describe('normalizeDataSourceSchedule', () => {
  it('缺省返回关闭 + 24 小时', () => {
    const s = normalizeDataSourceSchedule(undefined);
    assert.equal(s.enabled, false);
    assert.equal(s.mode, 'interval');
    assert.equal(s.intervalValue, 24);
    assert.equal(s.intervalUnit, 'hour');
    assert.equal(s.revision, 0);
  });

  it('非法但 enabled 的计划降级为关闭并留原因', () => {
    const s = normalizeDataSourceSchedule({ enabled: true, mode: 'interval', intervalValue: 0, intervalUnit: 'minute' });
    assert.equal(s.enabled, false);
    assert.equal(s.lastSkipReason, 'invalid-schedule');
  });

  it('合法计划保留并清洗运行态', () => {
    const s = normalizeDataSourceSchedule({
      enabled: true,
      mode: 'interval',
      intervalValue: '30',
      intervalUnit: 'minute',
      revision: 3,
      consecutiveFailures: -1,
      lastAutoAt: 'x',
    });
    assert.equal(s.enabled, false); // 字符串数值非法 → 降级
    const ok = normalizeDataSourceSchedule({
      enabled: true,
      mode: 'interval',
      intervalValue: 30,
      intervalUnit: 'minute',
      revision: 3,
      consecutiveFailures: 2,
      lastAutoAt: 123,
    });
    assert.equal(ok.enabled, true);
    assert.equal(ok.revision, 3);
    assert.equal(ok.consecutiveFailures, 2);
    assert.equal(ok.lastAutoAt, 123);
  });
});

describe('parseAtLocal', () => {
  it('合法本地时间', () => {
    assert.equal(parseAtLocal('2026-10-29T09:30'), new Date(2026, 9, 29, 9, 30).getTime());
  });
  it('非法日期 / 格式返回 null', () => {
    assert.equal(parseAtLocal('2026-02-30T09:00'), null);
    assert.equal(parseAtLocal('2026-10-29 09:30'), null);
    assert.equal(parseAtLocal(null), null);
  });
});

describe('validateScheduleInput', () => {
  const base = {
    enabled: true,
    mode: 'interval' as const,
    intervalValue: 30,
    intervalUnit: 'minute' as const,
    at: null,
    repeat: null,
  };

  it('合法周期', () => {
    assert.equal(validateScheduleInput({ ...base }).ok, true);
  });
  it('关闭态允许空值', () => {
    assert.equal(validateScheduleInput({ enabled: false, mode: 'interval' }).ok, true);
  });
  it('间隔 0 / 缺单位 → 400', () => {
    const zero = validateScheduleInput({ ...base, intervalValue: 0 });
    assert.equal(zero.ok, false);
    if (!zero.ok) assert.equal(zero.code, 'SCHEDULE_INVALID_INTERVAL');
    const noUnit = validateScheduleInput({ ...base, intervalUnit: null });
    assert.equal(noUnit.ok, false);
  });
  it('间隔超过 365 天 → 400', () => {
    const tooLarge = validateScheduleInput({ ...base, intervalValue: 400, intervalUnit: 'day' });
    assert.equal(tooLarge.ok, false);
    if (!tooLarge.ok) assert.equal(tooLarge.code, 'SCHEDULE_INTERVAL_TOO_LARGE');
  });
  it('指定时间必须合法且选择重复方式', () => {
    const missing = validateScheduleInput({ enabled: true, mode: 'at', at: null, repeat: 'once' });
    assert.equal(missing.ok, false);
    const bad = validateScheduleInput({ enabled: true, mode: 'at', at: '2026-02-30T09:00', repeat: 'once' });
    assert.equal(bad.ok, false);
    const ok = validateScheduleInput({ enabled: true, mode: 'at', at: '2026-11-01T09:00', repeat: 'daily' });
    assert.equal(ok.ok, true);
  });
});

describe('computeNextRun · interval', () => {
  const schedule = { ...defaultDataSourceSchedule(), enabled: true, mode: 'interval' as const, intervalValue: 30, intervalUnit: 'minute' as const };

  it('有启用锚点、从未同步 → 锚点 + interval，不立即跑（首次开启等满一个周期）', () => {
    const r = computeNextRun({ schedule: { ...schedule, enabledAt: NOW }, lastSyncAt: null, now: NOW });
    assert.equal(r.nextRunAt, NOW + 30 * 60_000);
    assert.equal(r.due, false);
  });

  it('★ 无任何基准（锚点字段出现前的旧记录 / 从旧快照恢复）→ 视为已到期，补跑一次（决策 D1-A）', () => {
    const r = computeNextRun({ schedule, lastSyncAt: null, now: NOW });
    assert.equal(r.due, true, '旧记录不能落入"永远不 due"的坑');
    assert.equal(r.nextRunAt, NOW);
    // 跑完 lastAutoAt 落定后回到正常节奏
    const afterRun = computeNextRun({ schedule: { ...schedule, lastAutoAt: NOW }, lastSyncAt: null, now: NOW });
    assert.equal(afterRun.due, false);
    assert.equal(afterRun.nextRunAt, NOW + 30 * 60_000);
  });

  it('上次完成已超过间隔 → 到期补跑', () => {
    const r = computeNextRun({ schedule, lastSyncAt: NOW - 40 * 60_000, now: NOW });
    assert.equal(r.nextRunAt, NOW - 10 * 60_000);
    assert.equal(r.due, true);
  });

  it('上次完成未到间隔 → 等下一次', () => {
    const r = computeNextRun({ schedule, lastSyncAt: NOW - 10 * 60_000, now: NOW });
    assert.equal(r.nextRunAt, NOW + 20 * 60_000);
    assert.equal(r.due, false);
  });

  it('关闭态无下次', () => {
    const r = computeNextRun({ schedule: { ...schedule, enabled: false }, lastSyncAt: NOW, now: NOW });
    assert.equal(r.nextRunAt, null);
  });

  it('★ 从未同步过：有启用锚点时到点必须 due（否则定时永不触发）', () => {
    const anchored = { ...schedule, enabledAt: NOW };
    // 读多少次都一样：不能被 now 推着走
    for (const offset of [0, 1, 29]) {
      const r = computeNextRun({ schedule: anchored, lastSyncAt: null, now: NOW + offset * 60_000 });
      assert.equal(r.nextRunAt, NOW + 30 * 60_000, `offset=${offset}min 的下次时间被 now 推走了`);
      assert.equal(r.due, false);
    }
    const atDue = computeNextRun({ schedule: anchored, lastSyncAt: null, now: NOW + 30 * 60_000 });
    assert.equal(atDue.due, true);
    assert.equal(atDue.nextRunAt, NOW + 30 * 60_000, '到期后仍指向同一个槽位，供补跑使用');
  });

  it('lastSync / lastAutoAt 优先于启用锚点（锚点只兜底）', () => {
    const mixed = { ...schedule, enabledAt: NOW - 90 * 60_000, lastAutoAt: NOW - 10 * 60_000 };
    const r = computeNextRun({ schedule: mixed, lastSyncAt: NOW - 5 * 60_000, now: NOW });
    assert.equal(r.nextRunAt, NOW + 25 * 60_000, '应从更近的 lastSync.at 起算');
    assert.equal(r.due, false);
  });
});

describe('computeNextRun · at', () => {
  it('仅一次：未来未到期，过去到期，已执行则无下次', () => {
    const future = { ...defaultDataSourceSchedule(), enabled: true, mode: 'at' as const, at: localAt(2026, 10, 30, 9, 0), repeat: 'once' as const };
    assert.equal(computeNextRun({ schedule: future, lastSyncAt: null, now: NOW }).due, false);
    const past = { ...future, at: localAt(2026, 10, 28, 9, 0) };
    assert.equal(computeNextRun({ schedule: past, lastSyncAt: null, now: NOW }).due, true);
    const done = { ...past, lastAutoFor: parseAtLocal(past.at) };
    assert.equal(computeNextRun({ schedule: done, lastSyncAt: null, now: NOW }).nextRunAt, null);
  });

  it('每天：今天未到点 → 今天；已过点且未执行 → 立即补跑；已执行 → 明天', () => {
    const daily = { ...defaultDataSourceSchedule(), enabled: true, mode: 'at' as const, at: localAt(2026, 10, 1, 9, 0), repeat: 'daily' as const };
    const before = new Date(2026, 9, 29, 8, 0).getTime();
    assert.equal(computeNextRun({ schedule: daily, lastSyncAt: null, now: before }).nextRunAt, new Date(2026, 9, 29, 9, 0).getTime());
    const after = computeNextRun({ schedule: daily, lastSyncAt: null, now: NOW });
    assert.equal(after.due, true);
    assert.equal(after.occurrence, new Date(2026, 9, 29, 9, 0).getTime());
    const done = computeNextRun({ schedule: { ...daily, lastAutoFor: new Date(2026, 9, 29, 9, 0).getTime() }, lastSyncAt: null, now: NOW });
    assert.equal(done.due, false);
    assert.equal(done.nextRunAt, new Date(2026, 9, 30, 9, 0).getTime());
  });

  it('每天：从未来日期开始', () => {
    const daily = { ...defaultDataSourceSchedule(), enabled: true, mode: 'at' as const, at: localAt(2026, 11, 1, 9, 0), repeat: 'daily' as const };
    assert.equal(computeNextRun({ schedule: daily, lastSyncAt: null, now: NOW }).nextRunAt, parseAtLocal(daily.at));
  });
});

describe('toScheduleView / describeSchedule', () => {
  it('附带 nextRunAt', () => {
    const schedule = { ...defaultDataSourceSchedule(), enabled: true, mode: 'interval' as const, intervalValue: 30, intervalUnit: 'minute' as const };
    const view = toScheduleView(schedule, { at: NOW - 10 * 60_000 }, NOW);
    assert.equal(view.nextRunAt, NOW + 20 * 60_000);
  });
  it('描述稳定', () => {
    assert.equal(describeSchedule(defaultDataSourceSchedule()), '关闭');
    assert.equal(describeSchedule({
      ...defaultDataSourceSchedule(), enabled: true, mode: 'interval', intervalValue: 2, intervalUnit: 'hour',
    }), '每 2 小时');
    assert.equal(describeSchedule({
      ...defaultDataSourceSchedule(), enabled: true, mode: 'at', at: '2026-11-01T09:00', repeat: 'daily',
    }), '2026-11-01T09:00 · 每天');
  });
});

describe('scheduleListSummary（`datasource list` 只读脚注）', () => {
  const base = { ...defaultDataSourceSchedule(), enabled: true };
  const summarize = (schedule: typeof base, lastSyncAt: number | null = null) =>
    scheduleListSummary({ schedule, lastSyncAt, now: NOW });

  it('关闭的计划不进脚注', () => {
    const summary = summarize({ ...base, enabled: false });
    assert.equal(summary.enabled, false);
    assert.equal(summary.text, '关闭');
  });

  it('周期：模式 + 同日下次只给时分（脚注一行放得下）', () => {
    const summary = summarize({ ...base, mode: 'interval', intervalValue: 30, intervalUnit: 'minute' },
      new Date(2026, 9, 29, 9, 50).getTime());
    assert.deepEqual(summary, { enabled: true, warn: false, text: '每30分钟 · 下次 10:20' });
  });

  it('已有启用锚点：下次时间稳定，不随读取时刻滑移', () => {
    const schedule = {
      ...base, mode: 'interval' as const, intervalValue: 30, intervalUnit: 'minute' as const,
      enabledAt: NOW - 10 * 60_000,
    };
    const first = scheduleListSummary({ schedule, lastSyncAt: null, now: NOW });
    const later = scheduleListSummary({ schedule, lastSyncAt: null, now: NOW + 5 * 60_000 });
    assert.equal(first.text, '每30分钟 · 下次 10:20');
    assert.equal(later.text, '每30分钟 · 下次 10:20', '两次读取必须给出同一个下次时间');
  });

  it('周期：跨自然日给出 MM-DD', () => {
    const summary = summarize({ ...base, mode: 'interval', intervalValue: 2, intervalUnit: 'day' },
      new Date(2026, 9, 29, 9, 0).getTime());
    assert.equal(summary.text, '每2天 · 下次 10-31 09:00');
  });

  it('已到期显示「待补跑」而不是过去的时刻', () => {
    const summary = summarize({ ...base, mode: 'interval', intervalValue: 30, intervalUnit: 'minute' },
      new Date(2026, 9, 29, 8, 0).getTime());
    assert.equal(summary.text, '每30分钟 · 待补跑');
  });

  it('有锚点、从未同步：从锚点起算一个周期（与 computeNextRun 同口径）', () => {
    const summary = summarize({ ...base, mode: 'interval', intervalValue: 1, intervalUnit: 'hour', enabledAt: NOW });
    assert.equal(summary.text, '每1小时 · 下次 11:00');
  });

  it('无锚点的旧记录：标「待补跑」而不是给一个会滑动的"下次"（决策 D1-A）', () => {
    const summary = summarize({ ...base, mode: 'interval', intervalValue: 1, intervalUnit: 'hour' });
    assert.equal(summary.text, '每1小时 · 待补跑');
  });

  it('每天：给出固定时刻 + 下次', () => {
    const summary = summarize({ ...base, mode: 'at', at: localAt(2026, 10, 20, 9, 0), repeat: 'daily' });
    assert.equal(summary.text, '每天 09:00 · 待补跑');
  });

  it('仅一次：未执行给时刻，被取消后仍启用时给「已执行」', () => {
    assert.equal(
      summarize({ ...base, mode: 'at', at: localAt(2026, 11, 1, 9, 30), repeat: 'once' }).text,
      '仅一次 2026-11-01 09:30', // 不用 at 原文（带 T），与表格/页面时间口径一致
    );
    assert.equal(
      summarize({
        ...base, mode: 'at', at: localAt(2026, 11, 1, 9, 30), repeat: 'once',
        lastAutoFor: parseAtLocal(localAt(2026, 11, 1, 9, 30)), lastAutoState: 'cancelled',
      }).text,
      '仅一次 · 已执行',
    );
  });

  it('连续失败 ≥3：标 warn 并写出次数（不阻断下个周期）', () => {
    const summary = summarize({ ...base, mode: 'interval', intervalValue: 30, intervalUnit: 'minute', consecutiveFailures: 3 },
      new Date(2026, 9, 29, 9, 50).getTime());
    assert.equal(summary.warn, true);
    assert.equal(summary.text, '每30分钟 · 下次 10:20 · 连续失败 3 次');
    assert.equal(summarize({ ...base, consecutiveFailures: 2 }).warn, false);
  });
});
