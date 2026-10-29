/**
 * S-03：页面同步可用性纯函数。
 * 运行：npx jiti test/datasource-policy.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeSyncAvailability, DATASOURCE_PAGE_SYNC_MIN_INTERVAL_MS } from '../src/lib/datasource-policy.js';

const now = 1_800_000_000_000;

describe('computeSyncAvailability', () => {
  it('active 优先，返回 active 且无冷却时间', () => {
    const result = computeSyncAvailability({
      type: 'directory',
      lastSync: { at: now, state: 'ok' },
      active: true,
      now,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'active');
    assert.equal(result.nextAvailableAt, null);
    assert.equal(result.retryAfterSec, null);
  });

  it('git 数据源不做 30 分钟冷却', () => {
    const result = computeSyncAvailability({
      type: 'git',
      lastSync: { at: now, state: 'ok' },
      active: false,
      now,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, null);
  });

  it('directory 无同步记录时允许', () => {
    const result = computeSyncAvailability({ type: 'directory', lastSync: null, active: false, now });
    assert.equal(result.allowed, true);
  });

  it('directory partial 不启动冷却（允许重试）', () => {
    const result = computeSyncAvailability({
      type: 'directory',
      lastSync: { at: now, state: 'partial' },
      active: false,
      now,
    });
    assert.equal(result.allowed, true);
  });

  it('directory ok 且不足 30 分钟 → 冷却，返回 nextAvailableAt/retryAfterSec', () => {
    const at = now - 10 * 60 * 1000;
    const result = computeSyncAvailability({
      type: 'directory',
      lastSync: { at, state: 'ok' },
      active: false,
      now,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'cooldown');
    assert.equal(result.nextAvailableAt, at + DATASOURCE_PAGE_SYNC_MIN_INTERVAL_MS);
    assert.equal(result.retryAfterSec, 20 * 60);
  });

  it('directory ok 且超过 30 分钟 → 允许', () => {
    const result = computeSyncAvailability({
      type: 'directory',
      lastSync: { at: now - 31 * 60 * 1000, state: 'ok' },
      active: false,
      now,
    });
    assert.equal(result.allowed, true);
  });

  it('冷却剩余秒数向上取整', () => {
    const result = computeSyncAvailability({
      type: 'directory',
      lastSync: { at: now - 29 * 60 * 1000 - 500, state: 'ok' },
      active: false,
      now,
    });
    assert.equal(result.allowed, false);
    // 剩余 60s - 500ms → ceil = 60
    assert.equal(result.retryAfterSec, 60);
  });
});
