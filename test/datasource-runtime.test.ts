/**
 * 数据源运行态读取口径单测（src/lib/datasource-runtime.ts）
 *
 * 锁住的不变量：
 *   1) 只认 operation='datasource-sync' 的 queued/running（终态、其他操作一律忽略）；
 *   2) 同一 scope 同时存在排队与运行时**运行优先**（即使排队任务更新）；
 *   3) startedAt 缺失时给 null，不伪造时间；
 *   4) 多个 scope 互不影响；同状态重复记录只保留第一条（台账按 createdAt 倒序）。
 *
 * 运行：npx jiti test/datasource-runtime.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pickActiveDatasourceSync } from '../src/lib/datasource-runtime.js';

type Task = Parameters<typeof pickActiveDatasourceSync>[0][number];

function task(overrides: Partial<Task> & Pick<Task, 'scope' | 'state'>): Task {
  return { operation: 'datasource-sync', ...overrides } as Task;
}

describe('pickActiveDatasourceSync', () => {
  it('同 scope 排队与运行并存时运行优先（无论台账顺序）', () => {
    const queuedThenRunning = pickActiveDatasourceSync([
      task({ scope: 'demo', state: 'queued' }),
      task({ scope: 'demo', state: 'running', startedAt: 1792558471466 }),
    ]);
    assert.deepEqual(queuedThenRunning.get('demo'), { state: 'running', startedAt: 1792558471466 });

    // 反序：先看到 running，再看到更新的 queued —— 仍必须保留 running
    const runningThenQueued = pickActiveDatasourceSync([
      task({ scope: 'demo', state: 'running', startedAt: 1792558471466 }),
      task({ scope: 'demo', state: 'queued', startedAt: 1792558480000 }),
    ]);
    assert.deepEqual(runningThenQueued.get('demo'), { state: 'running', startedAt: 1792558471466 });
  });

  it('忽略非 datasource-sync 操作与终态记录', () => {
    const map = pickActiveDatasourceSync([
      task({ scope: 'a', state: 'running', operation: 'import' }),
      task({ scope: 'b', state: 'succeeded' }),
      task({ scope: 'c', state: 'failed' }),
      task({ scope: 'd', state: 'cancelled' }),
      task({ scope: 'e', state: 'unknown' }),
    ]);
    assert.equal(map.size, 0);
  });

  it('多 scope 独立，排队中 startedAt 为 null', () => {
    const map = pickActiveDatasourceSync([
      task({ scope: 'a', state: 'queued' }),
      task({ scope: 'b', state: 'running', startedAt: 123 }),
    ]);
    assert.deepEqual(map.get('a'), { state: 'queued', startedAt: null });
    assert.deepEqual(map.get('b'), { state: 'running', startedAt: 123 });
    assert.equal(map.size, 2);
  });

  it('同 scope 多条排队只保留一条，且排队中不携带 startedAt', () => {
    const map = pickActiveDatasourceSync([
      task({ scope: 'a', state: 'queued', startedAt: 200 }),
      task({ scope: 'a', state: 'queued', startedAt: 100 }),
    ]);
    assert.deepEqual(map.get('a'), { state: 'queued', startedAt: null });
  });
});
