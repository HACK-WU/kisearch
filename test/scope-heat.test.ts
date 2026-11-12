/**
 * test/scope-heat.test.ts
 *
 * REQ-20261112-001 S-02 回归：scope 冷热分档。
 *   ① 0 调用的 scope 一律 `unused` 且**不参与相对分档**（否则 162 个里会算出 49 个「热」）；
 *   ② 全 unused 时不调用分区算法、不抛错；
 *   ③ 有调用的按相对分位分出 hot / warm / cold（3 / 4 / 3，10 个候选）；
 *   ④ 时钟回拨（lastUsedAt 在未来）不产生 Infinity / NaN；
 *   ⑤ `makeEmptyScopeUsage` 的 coveredDays 用全局 since 算，未满窗口时如实反映。
 *
 * 运行：npx jiti test/scope-heat.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHeat, makeEmptyScopeUsage } from '../src/lib/scope-heat.js';

function dayOffset(offset: number): string {
  const d = new Date(Date.now() - offset * 86_400_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

test('① 0 调用的 scope 标 unused，且不占分区席位', () => {
  const now = Date.now();
  const entries = [
    { scope: 'hot-a', read: 100, write: 5, lastUsedAt: now },
    { scope: 'zero-1', read: 0, write: 0, lastUsedAt: 0 },
    { scope: 'zero-2', read: 0, write: 0, lastUsedAt: 0 },
  ];
  const heat = computeHeat(entries, now);
  assert.equal(heat.get('zero-1'), 'unused');
  assert.equal(heat.get('zero-2'), 'unused');
  // 唯一有调用的进热区（hotPercent 按「有调用的池子」算，不是按全部 3 个）
  assert.equal(heat.get('hot-a'), 'hot');
});

test('② 全 unused 时不进入分区算法，全标 unused', () => {
  const heat = computeHeat([
    { scope: 'a', read: 0, write: 0, lastUsedAt: 0 },
    { scope: 'b', read: 0, write: 0, lastUsedAt: 0 },
  ], Date.now());
  assert.deepEqual([...heat.values()], ['unused', 'unused']);
});

test('③ 10 个有调用 → 3 热 / 4 温 / 3 冷（相对分位，不因 0 调用被稀释）', () => {
  const now = Date.now();
  const entries = Array.from({ length: 10 }, (_, i) => ({
    scope: `s${i}`,
    read: 100 - i * 10,
    write: 0,
    lastUsedAt: now, // 同一时间，排除衰减干扰
  }));
  const heat = computeHeat(entries, now);
  const counts = { hot: 0, warm: 0, cold: 0, unused: 0 };
  for (const value of heat.values()) counts[value] += 1;
  assert.equal(counts.unused, 0, '都有调用，不应出现 unused');
  assert.equal(counts.hot, 3, 'hotPercent 0.3 × 10 = 3');
  assert.equal(counts.warm, 4, '热区外候选池 7 × 0.5 向上取整 = 4');
  assert.equal(counts.cold, 3);
  // 调用量最高的必须进热区
  assert.equal(heat.get('s0'), 'hot');
  // 调用量最低的必须进冷区
  assert.equal(heat.get('s9'), 'cold');
});

test('④ 时钟回拨（lastUsedAt 在未来）不产生 Infinity / NaN', () => {
  const now = Date.now();
  const future = now + 24 * 3_600_000;
  const heat = computeHeat([
    { scope: 'future', read: 10, write: 0, lastUsedAt: future },
    { scope: 'normal', read: 5, write: 0, lastUsedAt: now },
  ], now);
  for (const value of heat.values()) {
    assert.ok(['hot', 'warm', 'cold', 'unused'].includes(value), `档位应是合法值，实际 ${value}`);
  }
});

test('⑤ makeEmptyScopeUsage：coveredDays 用全局 since 算，不超过窗口', () => {
  const now = Date.now();
  const sinceThreeDaysAgo = dayOffset(3);
  const usage = makeEmptyScopeUsage({ since: sinceThreeDaysAgo, updatedAt: new Date(now).toISOString() }, now);

  assert.equal(usage.d7.read, 0);
  assert.equal(usage.d7.heat, 'unused');
  assert.equal(usage.d7.coveredDays, 4, '3 天前至今 = 4 天，未满 7 天如实反映');
  assert.equal(usage.d30.coveredDays, 4, '同样不超过已统计天数');
  assert.equal(usage.since, sinceThreeDaysAgo);
});

test('⑤b makeEmptyScopeUsage：统计已满窗口时 coveredDays 等于窗口天数', () => {
  const now = Date.now();
  const usage = makeEmptyScopeUsage({ since: dayOffset(200), updatedAt: new Date(now).toISOString() }, now);
  assert.equal(usage.d7.coveredDays, 7);
  assert.equal(usage.d30.coveredDays, 30);
  assert.equal(usage.d90.coveredDays, 90);
});
