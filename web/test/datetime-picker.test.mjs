/**
 * 自建日期时间选择器的纯逻辑单测（web/src/lib/datetimePicker.ts）
 *
 * 锁住的不变量：
 *   1) 解析要拦住「2026-02-30」「13 月」「25 时」这类看起来像日期其实不存在的值，
 *      解析失败返回 null 由调用方回退默认值 —— 不许静默进位成别的日子；
 *   2) 输出格式必须是 `YYYY-MM-DDTHH:mm`（datetime-local 不认别的写法）；
 *   3) 月历固定 42 格（6 行），周一开头；切换月份时面板高度不跳；
 *   4) 月份位移跨年正确，含负数；
 *   5) 「时 / 分」输入钳制：空串回退、超界夹边界、小数取整。
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
  WEEKDAY_LABELS,
  buildMonthGrid,
  clampInt,
  defaultFromNow,
  formatLocalDateTime,
  formatLocalDateTimeText,
  isSameDay,
  parseLocalDateTime,
  shiftMonth,
  withDay,
  withTime,
} = await vite.ssrLoadModule('/src/lib/datetimePicker.ts');

after(async () => { await vite.close(); });

describe('formatLocalDateTime', () => {
  it('补零到 16 位（datetime-local 的 value 只认这个）', () => {
    assert.equal(
      formatLocalDateTime({ year: 2026, month: 1, day: 2, hour: 3, minute: 4 }),
      '2026-01-02T03:04',
    );
    assert.equal(
      formatLocalDateTime({ year: 2026, month: 12, day: 31, hour: 23, minute: 59 }),
      '2026-12-31T23:59',
    );
  });

  it('给人看的文本用空格分隔', () => {
    assert.equal(
      formatLocalDateTimeText({ year: 2026, month: 10, day: 30, hour: 18, minute: 40 }),
      '2026-10-30 18:40',
    );
  });
});

describe('parseLocalDateTime', () => {
  it('标准格式原样解析', () => {
    assert.deepEqual(parseLocalDateTime('2026-10-30T18:40'), {
      year: 2026, month: 10, day: 30, hour: 18, minute: 40,
    });
  });

  it('容忍空格分隔、带秒、斜杠日期（手输与旧数据）', () => {
    for (const raw of ['2026-10-30 18:40', '2026-10-30T18:40:59', '2026/10/30 18:40']) {
      assert.deepEqual(parseLocalDateTime(raw), {
        year: 2026, month: 10, day: 30, hour: 18, minute: 40,
      }, raw);
    }
  });

  it('不存在或越界的值一律返回 null（不许静默进位）', () => {
    for (const raw of [
      '2026-02-30T10:00', // 2 月没有 30 号
      '2026-13-01T10:00', // 没有 13 月
      '2026-10-30T25:00', // 没有 25 点
      '2026-10-30T10:60', // 没有 60 分
      '', null, undefined, '不是日期',
    ]) {
      assert.equal(parseLocalDateTime(raw), null, String(raw));
    }
  });

  it('闰年 2 月 29 日能正常解析', () => {
    assert.deepEqual(parseLocalDateTime('2028-02-29T08:00'), {
      year: 2028, month: 2, day: 29, hour: 8, minute: 0,
    });
  });
});

describe('buildMonthGrid', () => {
  it('固定 42 格（6 行），避免切月时面板高度跳动', () => {
    for (const [y, m] of [[2026, 10], [2026, 2], [2027, 1], [2028, 2]]) {
      assert.equal(buildMonthGrid(y, m).length, 42, `${y}-${m}`);
    }
  });

  it('周一为一周起点：2026 年 10 月首格是 9/28（周一）', () => {
    const cells = buildMonthGrid(2026, 10);
    assert.deepEqual(
      { year: cells[0].year, month: cells[0].month, day: cells[0].day, inMonth: cells[0].inMonth },
      { year: 2026, month: 9, day: 28, inMonth: false },
    );
    assert.equal(WEEKDAY_LABELS.length, 7);
  });

  it('当月的天数都标 inMonth，补齐的上下月日期不标', () => {
    const cells = buildMonthGrid(2026, 10);
    const inMonth = cells.filter((c) => c.inMonth);
    assert.equal(inMonth.length, 31, '10 月有 31 天');
    assert.equal(inMonth[0].day, 1);
    assert.equal(inMonth[30].day, 31);
    // 10/1 是周四 → 前面补 3 天（9/28~9/30）
    assert.equal(cells.filter((c) => !c.inMonth && c.month === 9).length, 3);
  });

  it('2 月非闰年 28 天、闰年 29 天', () => {
    assert.equal(buildMonthGrid(2026, 2).filter((c) => c.inMonth).length, 28);
    assert.equal(buildMonthGrid(2028, 2).filter((c) => c.inMonth).length, 29);
  });

  it('12 月的补齐会跨到下一年 1 月', () => {
    const cells = buildMonthGrid(2026, 12);
    const next = cells.filter((c) => !c.inMonth && c.year === 2027);
    assert.ok(next.length > 0);
    assert.equal(next[0].month, 1);
  });
});

describe('shiftMonth', () => {
  it('跨年正向 / 反向都正确', () => {
    assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
    assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
    assert.deepEqual(shiftMonth(2026, 1, -13), { year: 2024, month: 12 });
    assert.deepEqual(shiftMonth(2026, 6, 0), { year: 2026, month: 6 });
  });
});

describe('withDay / withTime / isSameDay', () => {
  const base = { year: 2026, month: 10, day: 30, hour: 18, minute: 40 };

  it('换日期不动时分，换时分不动日期', () => {
    assert.deepEqual(withDay(base, 2027, 1, 5), { ...base, year: 2027, month: 1, day: 5 });
    assert.deepEqual(withTime(base, 7, 5), { ...base, hour: 7, minute: 5 });
  });

  it('isSameDay 只比日期，不比时分', () => {
    assert.equal(isSameDay(base, { ...base, hour: 0, minute: 0 }), true);
    assert.equal(isSameDay(base, { ...base, day: 31 }), false);
  });
});

describe('clampInt', () => {
  it('空串 / 非法 → fallback；超界夹到边界；小数取整', () => {
    assert.equal(clampInt('', 0, 23, 9), 9);
    assert.equal(clampInt('abc', 0, 23, 9), 9);
    assert.equal(clampInt('25', 0, 23, 9), 23);
    assert.equal(clampInt('-3', 0, 23, 9), 0);
    assert.equal(clampInt('7.8', 0, 23, 9), 7);
    assert.equal(clampInt(' 12 ', 0, 23, 9), 12);
  });
});

describe('defaultFromNow', () => {
  it('现在 + 30 分钟，秒归零', () => {
    const at = defaultFromNow(30, new Date('2026-10-30T10:55:42').getTime());
    assert.deepEqual(at, { year: 2026, month: 10, day: 30, hour: 11, minute: 25 });
  });

  it('跨天进位', () => {
    const at = defaultFromNow(30, new Date('2026-10-31T23:45:00').getTime());
    assert.deepEqual(at, { year: 2026, month: 11, day: 1, hour: 0, minute: 15 });
  });
});
