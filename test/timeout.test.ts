/**
 * test/timeout.test.ts
 *
 * `withTimeoutFallback`（R8 辅助读超时降级）回归：
 *   ① 正常完成：不触发 fallback，`timedOut=false`；
 *   ② 超时：返回 fallback 且 `timedOut=true`，**不抛错**；
 *   ③ fallback 惰性求值：未超时不得被调用；
 *   ④ 真实错误照旧上抛（不被降级掩盖 —— N9）；
 *   ⑤ 超时后底层 promise 再失败，不得产生 unhandledRejection；
 *   ⑥ fallback 自身抛错时上抛（fail-loud，不静默吞掉）。
 *
 * 运行：npx jiti test/timeout.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { withTimeoutFallback } from '../src/lib/timeout.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 保活句柄：被测工具的超时定时器刻意 `unref()`（常驻服务里不应吊住进程退出），
 * 于是"永不 settle 的 promise + 已 unref 的定时器"会让事件循环空转 → 测试进程
 * 提前退出、后续用例不会执行（首轮实测即此现象：只跑了 1 个用例）。
 */
const keepAlive = setInterval(() => { /* 仅保活 */ }, 1_000);
after(() => clearInterval(keepAlive));

test('① 正常完成：不触发 fallback，timedOut=false', async () => {
  const r = await withTimeoutFallback(Promise.resolve('ok'), () => 'fallback', 100);
  assert.equal(r.value, 'ok');
  assert.equal(r.timedOut, false);
});

test('② 超时：返回 fallback 且 timedOut=true（不抛错）', async () => {
  const never = new Promise<string>(() => { /* 永不 settle */ });
  const r = await withTimeoutFallback(never, () => 'fallback', 50);
  assert.equal(r.value, 'fallback');
  assert.equal(r.timedOut, true);
  assert.ok(r.waitedMs >= 50, `waitedMs 应 ≥ 超时阈值，实际 ${r.waitedMs}`);
});

test('③ fallback 惰性求值：未超时时不得被调用', async () => {
  let called = 0;
  const r = await withTimeoutFallback(Promise.resolve('fast'), () => { called += 1; return 'fallback'; }, 200);
  assert.equal(r.value, 'fast');
  assert.equal(called, 0, 'fallback 不应在未超时时求值');
});

test('④ 真实错误照旧上抛（不得被降级掩盖）', async () => {
  await assert.rejects(
    () => withTimeoutFallback(Promise.reject(new Error('engine boom')), () => 'fallback', 200),
    /engine boom/,
  );
});

test('⑤ 超时后底层 promise 再失败，不产生 unhandledRejection', async () => {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { seen.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    let failWork: ((err: Error) => void) | undefined;
    const work = new Promise<string>((_, reject) => { failWork = reject; });
    const pending = withTimeoutFallback(work, () => 'fallback', 50);

    await sleep(80);                     // 先让其超时
    failWork!(new Error('late failure')); // 再让底层失败（此时已无等待者）
    const r = await pending;
    assert.equal(r.timedOut, true);
    assert.equal(r.value, 'fallback');

    await sleep(80);                     // 给 unhandledRejection 一个触发窗口
    assert.deepEqual(seen, [], `不应出现 unhandledRejection，实际捕获 ${seen.length} 条`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('⑥ fallback 自身抛错时上抛（fail-loud，不静默吞掉）', async () => {
  const never = new Promise<string>(() => { /* 永不 settle */ });
  await assert.rejects(
    () => withTimeoutFallback(never, () => { throw new Error('fallback broken'); }, 30),
    /fallback broken/,
  );
});
