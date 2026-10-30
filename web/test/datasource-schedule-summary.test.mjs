/**
 * 总览「定时同步」卡口径单测（2026-10-30）
 *
 * 锁住的不变量：
 *  - 主值 = 已开启定时的**数据源数**（sources 行，`schedule.enabled === true`）
 *  - `missing` / `corrupt` 不计入（只进 tooltip）；旧 daemon 不下发 schedule ⇒ `—`，不得显示 0
 *  - 副行只显示一条：调度器停用 > 连续失败(>=3) > 下次运行 > 无待执行 > 未开启
 *
 * 运行：cd web && npm run test
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
const { summarizeSchedules, scheduleSummaryView, SCHEDULE_FAILURE_WARN } =
  await vite.ssrLoadModule('/src/lib/datasourceSchedule.ts');
after(async () => vite.close());

/** 2026-10-30 12:00（本地时区）——「下次」文案按同一 now 断言，避免跨天抖动 */
const NOW = new Date(2026, 9, 30, 12, 0, 0).getTime();
const AT_1441 = new Date(2026, 9, 30, 14, 41, 0).getTime();

const schedule = (over = {}) => ({
  enabled: true,
  mode: 'interval',
  intervalValue: 24,
  intervalUnit: 'hour',
  at: null,
  repeat: null,
  revision: 0,
  consecutiveFailures: 0,
  lastAutoAt: null,
  lastAutoFor: null,
  lastAutoState: null,
  lastSkipReason: null,
  lastSkipAt: null,
  nextRunAt: AT_1441,
  ...over,
});

const list = (sources, extra = {}) => ({
  ok: true,
  total: sources.length,
  sources,
  missing: [],
  ...extra,
});

const view = (input) => scheduleSummaryView(summarizeSchedules(input), NOW);

describe('summarizeSchedules', () => {
  it('未加载：ready=false，主值「—」、无副行', () => {
    const s = summarizeSchedules(undefined);
    assert.equal(s.ready, false);
    assert.equal(s.known, false);
    assert.deepEqual(
      { value: view(undefined).value, sub: view(undefined).sub },
      { value: '—', sub: '' },
    );
  });

  it('首屏读取失败：主值「—」+ 副行「数据源读取失败」，不得退化成 0', () => {
    const s = summarizeSchedules(undefined, { error: 'HTTP 500' });
    assert.equal(s.ready, false);
    assert.equal(s.error, 'HTTP 500');
    const v = scheduleSummaryView(s, NOW);
    assert.equal(v.value, '—');
    assert.equal(v.sub, '数据源读取失败');
    assert.equal(v.tone, 'warn');
    assert.match(v.title, /HTTP 500/);
  });

  it('旧 daemon 不下发 schedule：known=false，显示「—」而不是 0', () => {
    const input = list([{ scope: 'a' }, { scope: 'b' }]);
    const s = summarizeSchedules(input);
    assert.equal(s.known, false);
    const v = view(input);
    assert.equal(v.value, '—');
    assert.equal(v.sub, '未上报定时计划');
    assert.equal(v.tone, 'muted');
  });

  it('空列表：0 是准确值，不当作未知', () => {
    const v = view(list([]));
    assert.equal(v.value, '0');
    assert.equal(v.sub, '未开启定时同步');
  });

  it('主值只数 enabled 的数据源；正常态不显示副行（不展示下次运行时间）', () => {
    const input = list([
      { scope: 'a', schedule: schedule({ nextRunAt: AT_1441 }) },
      { scope: 'b', schedule: schedule({ nextRunAt: AT_1441 + 3_600_000 }) },
      { scope: 'c', schedule: schedule({ enabled: false, nextRunAt: null }) },
      { scope: 'd' },
    ]);
    const s = summarizeSchedules(input);
    assert.equal(s.enabled, 2);
    assert.equal(s.pending, true);
    const v = view(input);
    assert.equal(v.value, '2');
    assert.equal(v.sub, '');
    assert.equal(v.tone, 'muted');
    assert.match(v.title, /已开启定时同步的数据源 2 个，共 4 个/);
    assert.doesNotMatch(v.title, /下次/);
  });

  it(`连续失败达到阈值（>=${SCHEDULE_FAILURE_WARN}）才告警`, () => {
    const warnAt = schedule({ consecutiveFailures: SCHEDULE_FAILURE_WARN });
    const below = schedule({ consecutiveFailures: SCHEDULE_FAILURE_WARN - 1 });
    assert.equal(view(list([{ scope: 'a', schedule: warnAt }])).sub, '1 个连续失败');
    assert.equal(view(list([{ scope: 'a', schedule: warnAt }])).tone, 'warn');
    assert.equal(view(list([{ scope: 'a', schedule: below }])).sub, '');
    assert.equal(view(list([{ scope: 'a', schedule: below }])).tone, 'muted');
  });

  it('调度器停用优先于其它副行；无启用计划时不误报停用', () => {
    const disabled = list(
      [{ scope: 'a', schedule: schedule({ consecutiveFailures: 5 }) }],
      { schedulerDisabled: true },
    );
    const v = view(disabled);
    assert.equal(v.value, '1');
    assert.equal(v.sub, '调度器已停用');
    assert.equal(v.tone, 'warn');
    assert.match(v.title, /定时调度器已被服务端停用/);

    const none = view(list([{ scope: 'a', schedule: schedule({ enabled: false, nextRunAt: null }) }], {
      schedulerDisabled: true,
    }));
    assert.equal(none.value, '0');
    assert.equal(none.sub, '未开启定时同步');
    assert.equal(none.tone, 'muted');
  });

  it('enabled 但无待执行（仅一次已执行完）→「无待执行计划」', () => {
    const input = list([
      { scope: 'a', schedule: schedule({ mode: 'at', repeat: 'once', nextRunAt: null, lastAutoFor: AT_1441 }) },
    ]);
    const v = view(input);
    assert.equal(v.value, '1');
    assert.equal(v.sub, '无待执行计划');
    assert.equal(v.tone, 'muted');
  });

  it('missing / corrupt 不计入主值，只在 tooltip 说明', () => {
    const input = list([{ scope: 'a', schedule: schedule() }], {
      missing: [{ scope: 'gone', reason: 'not-found', schedule: schedule() }],
      corrupt: [{ scope: 'bad', reason: 'corrupt' }],
    });
    const s = summarizeSchedules(input);
    assert.equal(s.enabled, 1);
    assert.equal(s.total, 1);
    assert.equal(s.excluded, 2);
    assert.match(view(input).title, /不含缺失\/损坏数据源 2 个/);
  });
});
