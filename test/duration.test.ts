/**
 * duration.test.ts —— 步骤耗时显示口径（2026-11-19 用户要求：>1s 用秒）
 *
 * 背景：预取跑了 39 秒，过程区右侧写的是 `19999ms` —— 没人愿意在脑子里做除法。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/duration.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatDurationMs } from '../web/src/lib/duration.js';

describe('formatDurationMs', () => {
  it('小于 1 秒保留毫秒（秒的小数位在这里没有信息量）', () => {
    assert.equal(formatDurationMs(0), '<1ms');
    assert.equal(formatDurationMs(-5), '<1ms');
    assert.equal(formatDurationMs(337), '337ms');
    assert.equal(formatDurationMs(999), '999ms');
  });

  it('1 秒及以上用秒，<10s 保留 1 位小数', () => {
    assert.equal(formatDurationMs(1000), '1s');
    assert.equal(formatDurationMs(1500), '1.5s');
    assert.equal(formatDurationMs(2511), '2.5s');
    assert.equal(formatDurationMs(9999), '10s');
  });

  it('10 秒及以上取整（40 秒档的 0.1s 只会让数字抖）', () => {
    assert.equal(formatDurationMs(19999), '20s');
    assert.equal(formatDurationMs(39023), '39s');
    assert.equal(formatDurationMs(600000), '600s');
  });
});
