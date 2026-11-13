/**
 * `ki_ask` 限流（REQ-20261113-001 · S-02 §8）
 *
 * 覆盖 5 条：
 *   ① 窗口内第 11 次 → `ASK_RATE_LIMITED` 且 `retryAfterSec` > 0
 *   ② 窗口滚动后恢复
 *   ③ 全局并发满 → `ASK_BUSY`（与频率超限区分，归因不能混）
 *   ④ **异常路径必释放**：释放后立即可再次准入（防并发计数泄漏）
 *   ⑤ 不同 scope 互不影响（一个库刷满不挤掉另一个库）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/ask-limiter.test.ts
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireAskSlot,
  releaseAskSlot,
  resetAskLimiterForTest,
  askInFlight,
} from '../../src/lib/chat/ask/ask-limiter.js';

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

it('① 窗口内第 11 次被拒（ASK_RATE_LIMITED），并给出 retryAfterSec', () => {
  resetAskLimiterForTest({ concurrentMax: 100 });
  try {
    for (let i = 0; i < 10; i += 1) {
      const d = acquireAskSlot('token-a', 'kb');
      assert.equal(d.ok, true, `第 ${i + 1} 次应放行`);
      releaseAskSlot();
    }
    const blocked = acquireAskSlot('token-a', 'kb');
    assert.equal(blocked.ok, false);
    assert.equal((blocked as { code: string }).code, 'ASK_RATE_LIMITED');
    assert.ok((blocked as { retryAfterSec: number }).retryAfterSec > 0);
    assert.equal(askInFlight(), 0, '被拒的调用不得占并发槽');
  } finally {
    resetAskLimiterForTest();
  }
});

it('② 窗口滚动后恢复放行', async () => {
  resetAskLimiterForTest({ concurrentMax: 100, rateMax: 1, windowMs: 60 });
  try {
    assert.equal(acquireAskSlot('token-b', 'kb').ok, true);
    releaseAskSlot();
    const blocked = acquireAskSlot('token-b', 'kb');
    assert.equal(blocked.ok, false);
    await sleep(90);
    const again = acquireAskSlot('token-b', 'kb');
    assert.equal(again.ok, true, '窗口滚动后应恢复');
    releaseAskSlot();
  } finally {
    resetAskLimiterForTest();
  }
});

it('③ 全局并发满 → ASK_BUSY（不是 RATE_LIMITED）', () => {
  resetAskLimiterForTest({ concurrentMax: 2 });
  try {
    assert.equal(acquireAskSlot('token-c', 'kb').ok, true);
    assert.equal(acquireAskSlot('token-c', 'kb').ok, true);
    const busy = acquireAskSlot('token-c', 'kb');
    assert.equal(busy.ok, false);
    assert.equal((busy as { code: string }).code, 'ASK_BUSY');
    assert.equal((busy as { retryAfterSec: number }).retryAfterSec, 5);
  } finally {
    resetAskLimiterForTest();
  }
});

it('④ 异常路径必释放：释放后立即可再准入（并发计数不泄漏）', () => {
  resetAskLimiterForTest({ concurrentMax: 1 });
  try {
    assert.equal(acquireAskSlot('token-d', 'kb').ok, true);
    assert.equal(askInFlight(), 1);
    // 模拟 runAsk 抛错：finally 里 release
    releaseAskSlot();
    assert.equal(askInFlight(), 0);
    const again = acquireAskSlot('token-d', 'kb');
    assert.equal(again.ok, true, '泄漏时这里会一直 ASK_BUSY');
    releaseAskSlot();
  } finally {
    resetAskLimiterForTest();
  }
});

it('⑤ 不同 scope 互不影响', () => {
  resetAskLimiterForTest({ concurrentMax: 100, rateMax: 1 });
  try {
    assert.equal(acquireAskSlot('token-e', 'kb-1').ok, true);
    releaseAskSlot();
    assert.equal(acquireAskSlot('token-e', 'kb-1').ok, false, 'kb-1 已用满');
    const other = acquireAskSlot('token-e', 'kb-2');
    assert.equal(other.ok, true, '另一个 scope 不应受影响');
    releaseAskSlot();
  } finally {
    resetAskLimiterForTest();
  }
});
