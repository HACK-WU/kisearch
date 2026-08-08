/**
 * clean-hook-search.test.ts —— REQ-07 hook 管道 + REQ-09 原文召回（方案 D，批次 5）
 *
 * 契约：
 *   - runCleanHooks：成功管道 / 部分失败不阻断 / 超时 SIGKILL
 *   - cleanMarkdownText：清洗规则（批次 1 已覆盖，此处补 hook 交互）
 *
 * 运行：npx jiti test/clean-hook-search.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCleanHooks } from '../src/lib/clean.js';

describe('runCleanHooks — REQ-07 外部清洗钩子', () => {
  it('空 hooks → 原样返回', async () => {
    const r = await runCleanHooks('内容', []);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, '内容');
    assert.strictEqual(r.failedHooks.length, 0);
  });

  it('成功 hook（stdin→stdout 管道）', async () => {
    const r = await runCleanHooks('原始\n', ['node -e "process.stdin.pipe(process.stdout)"']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, '原始\n');
  });

  it('部分失败 → 跳过该 hook + 后续仍执行', async () => {
    const r = await runCleanHooks('x', ['node -e "process.exit(1)"', 'node -e "process.stdin.pipe(process.stdout)"']);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failedHooks.length, 1);
    assert.strictEqual(r.text, 'x'); // 失败 hook 保留上一状态，后续 hook 正常
  });

  it('超时 → SIGKILL 终止 + 记 failed', async () => {
    const t0 = Date.now();
    const r = await runCleanHooks('x', ['node -e "setTimeout(()=>{}, 12000)"']);
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failedHooks.length, 1);
    assert.ok(elapsed < 12000, `超时应提前终止（SIGKILL），实际 ${elapsed}ms`);
  });
});
