/**
 * 数据源定时计划的展示/校验辅助单测（web/src/lib/datasourceSchedule.ts）
 *
 * 锁住的不变量：
 *   1) 徽标只在 enabled 时出现；连续失败 ≥3 才降级成「定时⚠」（与后端 consecutiveFailures 同口径）；
 *   2) 列表第二行必须同时给出「下次时间」与「模式」，已过期要显示「即将补跑」而不是过去的时刻；
 *   3) 仅一次模式已执行 → 「已执行」，不再画一个已经过去的下次时间；
 *   4) 客户端校验与服务端同界：≥1 分钟（正整数）、≤365 天；关闭态不校验（允许保留半填状态）；
 *   5) 提交体按 mode 互斥：interval 不下发 at/repeat，at 不下发 interval；baseRevision 仅在显式传入时出现
 *      （缺省不下发 = 兼容旧页面，不触发 409）；
 *   6) 切到「指定时间」要自动填 now+30min（秒归零、跨天跨月正确）；切回「周期」要把这个自动值撤掉，
 *      否则「点一下模式再点回来」会平白变成待保存；已有计划自带的时间一律不覆盖。
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const {
  UNIT_LABEL,
  SYNC_STATE_LABEL,
  formFromSchedule,
  defaultScheduleAt,
  switchScheduleMode,
  describeSchedule,
  formatDateTime,
  scheduleBadge,
  scheduleNextLine,
  validateScheduleForm,
  toScheduleInput,
  isSameForm,
} = await vite.ssrLoadModule('/src/lib/datasourceSchedule.ts');

after(async () => { await vite.close(); });

/** 固定「今天 10:00」的本地时间，避免 formatShortTime 的跨日分支让断言随运行时刻漂移 */
const todayAt = (hour, minute) => {
  const base = new Date();
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0).getTime();
};
const NOW = todayAt(10, 0);
const MIN = 60_000;

function schedule(overrides = {}) {
  return {
    enabled: true,
    mode: 'interval',
    intervalValue: 30,
    intervalUnit: 'minute',
    at: null,
    repeat: null,
    revision: 3,
    consecutiveFailures: 0,
    lastAutoAt: null,
    lastAutoFor: null,
    lastAutoState: null,
    lastSkipReason: null,
    lastSkipAt: null,
    nextRunAt: NOW + 5 * MIN,
    ...overrides,
  };
}

describe('formFromSchedule', () => {
  it('无计划时给出默认表单：关闭 + 周期 24 小时', () => {
    for (const input of [undefined, null]) {
      const form = formFromSchedule(input);
      assert.deepEqual(form, {
        enabled: false, mode: 'interval', intervalValue: '24', intervalUnit: 'hour', at: '', repeat: 'once',
      });
    }
  });

  it('周期计划：数值转字符串（null → 空串，交给必填校验暴露）', () => {
    assert.equal(formFromSchedule(schedule()).intervalValue, '30');
    assert.equal(formFromSchedule(schedule({ intervalValue: null })).intervalValue, '');
  });

  it('指定时间计划：保留 at 原文与 repeat', () => {
    const form = formFromSchedule(schedule({ mode: 'at', at: '2026-11-01T09:30', repeat: 'daily' }));
    assert.equal(form.mode, 'at');
    assert.equal(form.at, '2026-11-01T09:30');
    assert.equal(form.repeat, 'daily');
  });
});

describe('describeSchedule', () => {
  it('未配置 / 已关闭统一显示「关闭」', () => {
    assert.equal(describeSchedule(undefined), '关闭');
    assert.equal(describeSchedule(null), '关闭');
    assert.equal(describeSchedule(schedule({ enabled: false })), '关闭');
  });

  it('周期模式带上用户填的数值与单位', () => {
    assert.equal(describeSchedule(schedule()), '每 30 分钟');
    assert.equal(describeSchedule(schedule({ intervalValue: 2, intervalUnit: 'hour' })), '每 2 小时');
    assert.equal(describeSchedule(schedule({ intervalValue: 7, intervalUnit: 'day' })), '每 7 天');
  });

  it('指定时间模式区分仅一次 / 每天', () => {
    assert.equal(
      describeSchedule(schedule({ mode: 'at', at: '2026-11-01T09:30', repeat: 'once' })),
      '2026-11-01 09:30 · 仅一次',
    );
    assert.equal(
      describeSchedule(schedule({ mode: 'at', at: '2026-11-01T09:30', repeat: 'daily' })),
      '2026-11-01 09:30 · 每天',
    );
  });

  it('单位文案表与服务端 describeSchedule 的用词一致', () => {
    assert.deepEqual(UNIT_LABEL, { minute: '分钟', hour: '小时', day: '天' });
  });
});

describe('scheduleBadge', () => {
  it('未开启不出徽标', () => {
    assert.equal(scheduleBadge(undefined), null);
    assert.equal(scheduleBadge(schedule({ enabled: false, consecutiveFailures: 9 })), null);
  });

  it('失败 3 次才降级为「定时⚠」，第 4 次仍是 warning（不阻断）', () => {
    assert.equal(scheduleBadge(schedule({ consecutiveFailures: 2 })), '定时');
    assert.equal(scheduleBadge(schedule({ consecutiveFailures: 3 })), '定时⚠');
    assert.equal(scheduleBadge(schedule({ consecutiveFailures: 4 })), '定时⚠');
  });
});

describe('scheduleNextLine（下次同步列：主值 / 副行两段）', () => {
  /** title 不参与下表：它承载列宽里放不下的完整信息，逐条断言会在改文案时噪声过大 */
  const twoLines = (view) => ({ value: view.value, sub: view.sub, tone: view.tone });

  it('未上报（旧 daemon 不下发 schedule）与未开启不是同一件事', () => {
    assert.deepEqual(twoLines(scheduleNextLine(undefined, NOW)), { value: '—', sub: '未上报', tone: 'muted' });
    assert.deepEqual(twoLines(scheduleNextLine(null, NOW)), { value: '—', sub: '未上报', tone: 'muted' });
    assert.deepEqual(
      twoLines(scheduleNextLine(schedule({ enabled: false }), NOW)),
      { value: '—', sub: '未开启定时', tone: 'muted' },
    );
  });

  it('empty 由数据层给出：无待执行的主值才能在渲染层转弱色', () => {
    for (const input of [undefined, null, schedule({ enabled: false }), schedule({ nextRunAt: null })]) {
      assert.equal(scheduleNextLine(input, NOW).empty, true);
    }
    assert.equal(scheduleNextLine(schedule(), NOW).empty, false);
    assert.equal(scheduleNextLine(schedule({ nextRunAt: NOW - MIN }), NOW).empty, false);
  });

  it('周期模式：主值只给时分，周期下沉副行（不在主值里拼长句）', () => {
    assert.deepEqual(twoLines(scheduleNextLine(schedule(), NOW)), {
      value: '10:05', sub: '每 30 分钟', tone: 'muted',
    });
  });

  it('周期模式已到期：主值「即将补跑」，tone=warn（不显示过去的时刻）', () => {
    assert.deepEqual(
      twoLines(scheduleNextLine(schedule({ nextRunAt: NOW - MIN }), NOW)),
      { value: '即将补跑', sub: '每 30 分钟', tone: 'warn' },
    );
  });

  it('连续失败 ≥3：副行改报失败次数（看得见），周期退到 title', () => {
    const line = scheduleNextLine(schedule({ consecutiveFailures: 3 }), NOW);
    assert.equal(line.value, '10:05');
    assert.equal(line.sub, '连续失败 3 次');
    assert.equal(line.tone, 'warn');
    // 周期不能让位给告警后彻底消失
    assert.match(line.title, /每 30 分钟/);
  });

  it('即将补跑 + 连续失败：副行只报失败次数，周期仍在 title', () => {
    const line = scheduleNextLine(schedule({ nextRunAt: NOW - MIN, consecutiveFailures: 5 }), NOW);
    assert.equal(line.value, '即将补跑');
    assert.equal(line.sub, '连续失败 5 次');
    assert.equal(line.tone, 'warn');
    assert.match(line.title, /每 30 分钟/);
  });

  it('仅一次已执行：不再追加「仍会尝试」（已经结束了，别暗示还会重试）', () => {
    const line = scheduleNextLine(schedule({
      mode: 'at',
      at: '2026-11-01T09:30',
      repeat: 'once',
      consecutiveFailures: 4,
      lastAutoFor: 1,
      lastAutoState: 'failed',
      nextRunAt: null,
    }), NOW);
    assert.equal(line.value, '—');
    assert.equal(line.sub, '已执行 · 仅一次');
    assert.doesNotMatch(line.title, /仍会尝试/);
  });

  it('仅一次：已执行过就显示「已执行」，不再画过去的下次时间', () => {
    const line = scheduleNextLine(schedule({
      mode: 'at',
      at: '2026-11-01T09:30',
      repeat: 'once',
      lastAutoFor: 1,
      lastAutoState: 'ok',
      nextRunAt: null,
    }), NOW);
    assert.equal(line.value, '—');
    assert.equal(line.sub, '已执行 · 仅一次');
    assert.equal(line.tone, 'muted');
  });

  it('仅一次：未执行且时间未到 → 完整日期；已过期 → 即将补跑', () => {
    const future = todayAt(23, 59) + 24 * 60 * MIN;
    const upcoming = scheduleNextLine(schedule({
      mode: 'at', at: '2026-11-01T09:30', repeat: 'once', nextRunAt: future,
    }), NOW);
    assert.equal(upcoming.value, formatDateTime(future));
    assert.equal(upcoming.sub, '仅一次');

    const overdue = scheduleNextLine(schedule({
      mode: 'at', at: '2026-11-01T09:30', repeat: 'once', nextRunAt: NOW - MIN,
    }), NOW);
    assert.equal(overdue.value, '即将补跑');
    assert.equal(overdue.sub, '仅一次');
    assert.equal(overdue.tone, 'warn');
    // 原定时刻不能丢：主值换成「即将补跑」后，只有 title 还留着它
    assert.match(overdue.title, new RegExp(formatDateTime(NOW - MIN)));
  });

  it('每天重复：主值给完整时刻，副行标「每天」', () => {
    const next = NOW + 24 * 60 * MIN;
    const line = scheduleNextLine(schedule({
      mode: 'at', at: '2026-11-01T09:30', repeat: 'daily', nextRunAt: next,
    }), NOW);
    assert.equal(line.value, formatDateTime(next));
    assert.equal(line.sub, '每天');
    assert.equal(line.tone, 'muted');
  });

  it('nextRunAt 为 null（无下次）不渲染 "null"，主值回 —', () => {
    const line = scheduleNextLine(schedule({ nextRunAt: null }), NOW);
    assert.equal(line.value, '—');
    assert.equal(line.sub, '每 30 分钟');
  });

  it('formatDateTime 对空值与非法值统一回 —（页面不留空白单元格）', () => {
    assert.equal(formatDateTime(null), '—');
    assert.equal(formatDateTime(''), '—');
    assert.equal(formatDateTime('not-a-date'), '—');
    assert.equal(formatDateTime('2026-11-01T09:30'), '2026-11-01 09:30');
  });
});

describe('validateScheduleForm', () => {
  const base = { enabled: true, mode: 'interval', intervalValue: '30', intervalUnit: 'minute', at: '', repeat: 'once' };

  it('关闭态不校验（允许保留半填值）', () => {
    assert.deepEqual(
      validateScheduleForm({ ...base, enabled: false, intervalValue: 'abc', at: 'bogus' }),
      { ok: true },
    );
  });

  it('周期：必须是正整数，最小 1 分钟', () => {
    assert.equal(validateScheduleForm({ ...base, intervalValue: '' }).field, 'interval');
    assert.equal(validateScheduleForm({ ...base, intervalValue: '1.5' }).field, 'interval');
    assert.equal(validateScheduleForm({ ...base, intervalValue: '-1' }).field, 'interval');
    assert.equal(validateScheduleForm({ ...base, intervalValue: '0' }).ok, false);
    assert.deepEqual(validateScheduleForm({ ...base, intervalValue: '1' }), { ok: true });
  });

  it('周期：超过 365 天被拦（与服务端 MAX_INTERVAL_MINUTES 同界）', () => {
    assert.equal(validateScheduleForm({ ...base, intervalValue: '365', intervalUnit: 'day' }).ok, true);
    assert.equal(validateScheduleForm({ ...base, intervalValue: '366', intervalUnit: 'day' }).ok, false);
    assert.equal(validateScheduleForm({ ...base, intervalValue: '525601', intervalUnit: 'minute' }).ok, false);
  });

  it('指定时间：必填且可解析', () => {
    const atMode = { ...base, mode: 'at', at: '' };
    assert.equal(validateScheduleForm(atMode).field, 'at');
    assert.equal(validateScheduleForm({ ...atMode, at: 'nope' }).field, 'at');
    assert.deepEqual(validateScheduleForm({ ...atMode, at: '2026-11-01T09:30' }), { ok: true });
  });
});

describe('toScheduleInput', () => {
  it('周期模式不下发 at/repeat（避免后端把旧指定时间当成半配的定时）', () => {
    const input = toScheduleInput({
      enabled: true, mode: 'interval', intervalValue: ' 12 ', intervalUnit: 'hour', at: '2026-11-01T09:30', repeat: 'daily',
    });
    assert.deepEqual(input, {
      enabled: true, mode: 'interval', intervalValue: 12, intervalUnit: 'hour', at: null, repeat: null,
    });
  });

  it('指定时间模式不下发 interval', () => {
    assert.deepEqual(
      toScheduleInput({
        enabled: true, mode: 'at', intervalValue: '12', intervalUnit: 'hour', at: '2026-11-01T09:30', repeat: 'once',
      }),
      { enabled: true, mode: 'at', intervalValue: null, intervalUnit: null, at: '2026-11-01T09:30', repeat: 'once' },
    );
  });

  it('intervalValue 为空串时下发 null（JS Number("") 是 0，必须显式挡）', () => {
    assert.equal(
      toScheduleInput({ enabled: true, mode: 'interval', intervalValue: '', intervalUnit: 'hour', at: '', repeat: 'once' }).intervalValue,
      null,
    );
  });

  it('baseRevision 仅在显式传入时出现（缺省不下发 = 不触发 409）', () => {
    const form = { enabled: false, mode: 'interval', intervalValue: '1', intervalUnit: 'hour', at: '', repeat: 'once' };
    assert.equal('baseRevision' in toScheduleInput(form), false);
    assert.equal(toScheduleInput(form, 0).baseRevision, 0);
    assert.equal(toScheduleInput(form, 7).baseRevision, 7);
  });
});

describe('isSameForm', () => {
  const a = { enabled: true, mode: 'interval', intervalValue: '30', intervalUnit: 'minute', at: '', repeat: 'once' };

  it('相同（数值两侧空白不算改动）', () => {
    assert.equal(isSameForm(a, { ...a, intervalValue: ' 30 ' }), true);
  });

  it('任一字段变化都要判定为脏（决定关闭弹窗时是否提示未保存）', () => {
    for (const patch of [
      { enabled: false }, { mode: 'at' }, { intervalValue: '31' }, { intervalUnit: 'hour' }, { at: '2026-11-01T09:30' }, { repeat: 'daily' },
    ]) {
      assert.equal(isSameForm(a, { ...a, ...patch }), false, JSON.stringify(patch));
    }
  });
});

describe('defaultScheduleAt', () => {
  it('现在 + 30 分钟，秒归零（datetime-local 只认到分钟）', () => {
    assert.equal(defaultScheduleAt(new Date('2026-10-30T10:55:42').getTime()), '2026-10-30T11:25');
  });

  it('跨小时 / 跨天 / 跨月 / 跨年都要正确进位', () => {
    assert.equal(defaultScheduleAt(new Date('2026-10-30T23:40:00').getTime()), '2026-10-31T00:10');
    assert.equal(defaultScheduleAt(new Date('2026-10-31T23:40:00').getTime()), '2026-11-01T00:10');
    assert.equal(defaultScheduleAt(new Date('2026-12-31T23:45:00').getTime()), '2027-01-01T00:15');
    assert.equal(defaultScheduleAt(new Date('2026-01-31T23:45:00').getTime()), '2026-02-01T00:15');
  });

  it('个位数的月/日/时/分补零（否则 datetime-local 收到非法值直接显示空白）', () => {
    assert.equal(defaultScheduleAt(new Date('2026-01-02T03:04:00').getTime()), '2026-01-02T03:34');
  });
});

describe('switchScheduleMode', () => {
  const NOW = new Date('2026-10-30T10:55:00').getTime();
  const intervalForm = { enabled: true, mode: 'interval', intervalValue: '24', intervalUnit: 'hour', at: '', repeat: 'once' };
  const AUTO = '2026-10-30T11:25';

  it('切到指定时间且原本为空 → 填 now+30min，并记下这是自动值', () => {
    const r = switchScheduleMode(intervalForm, 'at', { nowMs: NOW });
    assert.deepEqual(r.patch, { mode: 'at', at: AUTO });
    assert.equal(r.autoAt, AUTO);
  });

  it('已有时间（编辑已有计划）→ 原样保留，且不算自动值', () => {
    const r = switchScheduleMode({ ...intervalForm, at: '2026-11-01T09:30' }, 'at', { nowMs: NOW });
    assert.deepEqual(r.patch, { mode: 'at' });
    assert.equal(r.autoAt, null);
  });

  it('切回周期且时间仍是自动值 → 一并清空（否则点一下模式就变成待保存）', () => {
    const r = switchScheduleMode({ ...intervalForm, mode: 'at', at: AUTO }, 'interval', { autoAt: AUTO });
    assert.deepEqual(r.patch, { mode: 'interval', at: '' });
    assert.equal(r.autoAt, null);
  });

  it('切回周期但用户已改过时间 → 保留用户填的值', () => {
    const r = switchScheduleMode(
      { ...intervalForm, mode: 'at', at: '2026-11-05T08:00' },
      'interval',
      { autoAt: AUTO },
    );
    assert.deepEqual(r.patch, { mode: 'interval' });
    assert.equal(r.autoAt, AUTO);
  });

  it('从没自动填过时切回周期 → 不动 at', () => {
    const r = switchScheduleMode({ ...intervalForm, mode: 'at', at: '' }, 'interval', {});
    assert.deepEqual(r.patch, { mode: 'interval' });
    assert.equal(r.autoAt, null);
  });
});

describe('SYNC_STATE_LABEL', () => {
  it('后端四种同步状态都有中文（别再把 ok 直出到界面）', () => {
    assert.deepEqual(SYNC_STATE_LABEL, {
      ok: '成功', partial: '部分成功', failed: '失败', cancelled: '已取消',
    });
  });
});
