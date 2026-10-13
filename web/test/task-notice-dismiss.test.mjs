/**
 * 顶栏任务徽标「需关注任务」消解规则单测（lib/taskNotice.ts）
 *
 * 锁住四条不变量：
 *   1) 自动消除：同 scope + 同 operation 之后有更晚的 succeeded ⇒ 旧的失败 / 部分完成都不再提示
 *      （严格更晚才算覆盖；同时间戳或更早的成功不覆盖）；
 *   2) 手动忽略：忽略时间戳之前的记录不再提示，其后的新记录重新亮起；
 *   3) 部分完成与失败**各自独立**的忽略时间戳（忽略一类不影响另一类）；
 *   4) 作用域隔离：不同 scope / 不同 operation 不互相消除；非终态（running/queued）不入组。
 *
 * 回归锚点：修复前 `partial` 既无手动忽略也不参与自动消除，会在 1 小时 TTL 内一直挂在顶栏。
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
const { visibleTaskNotices } = await vite.ssrLoadModule('/src/lib/taskNotice.ts');
after(async () => vite.close());

const NONE = { failedAt: 0, partialAt: 0 };

/** 造一条任务记录，只覆盖关心的字段 */
const task = (over = {}) => ({
  scope: 'ai-docs',
  operation: 'import',
  state: 'failed',
  finishedAt: 2_000,
  ...over,
});

const count = (tasks, dismissal = NONE) => {
  const { failed, partial } = visibleTaskNotices(tasks, dismissal);
  return { failed: failed.length, partial: partial.length };
};

describe('自动消除：更晚的成功覆盖旧提示', () => {
  it('失败被同 scope + 同 operation 的后续成功覆盖 → 不提示', () => {
    assert.deepEqual(count([
      task({ state: 'failed', finishedAt: 1_000 }),
      task({ state: 'succeeded', finishedAt: 2_000 }),
    ]), { failed: 0, partial: 0 });
  });

  it('部分完成同样被后续成功覆盖（本次新增）', () => {
    assert.deepEqual(count([
      task({ state: 'partial', finishedAt: 1_000 }),
      task({ state: 'succeeded', finishedAt: 2_000 }),
    ]), { failed: 0, partial: 0 });
  });

  it('成功早于或同时于失败 → 仍提示（只有严格更晚才算覆盖）', () => {
    assert.deepEqual(count([
      task({ state: 'succeeded', finishedAt: 1_000 }),
      task({ state: 'failed', finishedAt: 1_000 }),
    ]), { failed: 1, partial: 0 });
  });

  it('作用域隔离：别的 scope / 别的 operation 的成功不消除本条', () => {
    assert.deepEqual(count([
      task({ scope: 'other', state: 'succeeded', finishedAt: 9_000 }),
      task({ scope: 'ai-docs', operation: 'rebuild-vector', state: 'succeeded', finishedAt: 9_000 }),
      task({ scope: 'ai-docs', operation: 'import', state: 'partial', finishedAt: 1_000 }),
    ]), { failed: 0, partial: 1 });
  });

  it('unknown（心跳过期）与 failed 同档提示', () => {
    assert.deepEqual(count([task({ state: 'unknown' })]), { failed: 1, partial: 0 });
  });

  it('非终态（running / queued / cancelled / succeeded）不入组', () => {
    assert.deepEqual(count([
      task({ state: 'running' }),
      task({ state: 'queued' }),
      task({ state: 'cancelled' }),
      task({ state: 'succeeded' }),
    ]), { failed: 0, partial: 0 });
  });
});

describe('崩溃类任务（从未 finish，只有 updatedAt/心跳）走同一口径', () => {
  const crashed = (over = {}) => task({ state: 'unknown', finishedAt: undefined, updatedAt: 2_000, ...over });

  it('无 finishedAt 时按 updatedAt 判定 → 进入失败组（修复前 (finishedAt ?? 0) 恒为 0，这类任务永远不提示）', () => {
    assert.deepEqual(count([crashed()]), { failed: 1, partial: 0 });
  });

  it('同样可被手动忽略：忽略时间戳晚于 updatedAt 即隐藏', () => {
    assert.deepEqual(count([crashed()], { failedAt: 1_000, partialAt: 0 }), { failed: 1, partial: 0 });
    assert.deepEqual(count([crashed()], { failedAt: 2_000, partialAt: 0 }), { failed: 0, partial: 0 });
  });

  it('同样可被后续成功覆盖（成功时间晚于心跳时间）', () => {
    assert.deepEqual(count([
      crashed({ updatedAt: 1_000 }),
      task({ state: 'succeeded', finishedAt: 2_000 }),
    ]), { failed: 0, partial: 0 });
  });
});

describe('手动忽略：时间戳之前的记录不再提示', () => {
  it('失败早于忽略时间戳 → 不提示；其后的新失败重新亮起', () => {
    const tasks = [task({ id: 'old', finishedAt: 1_000 }), task({ id: 'new', finishedAt: 3_000 })];
    assert.deepEqual(count(tasks, { failedAt: 2_000, partialAt: 0 }), { failed: 1, partial: 0 });
    assert.deepEqual(count(tasks, { failedAt: 3_000, partialAt: 0 }), { failed: 0, partial: 0 });
  });

  it('部分完成早于忽略时间戳 → 不提示（本次新增）', () => {
    const tasks = [task({ state: 'partial', finishedAt: 1_000 })];
    assert.deepEqual(count(tasks, { failedAt: 0, partialAt: 500 }), { failed: 0, partial: 1 });
    assert.deepEqual(count(tasks, { failedAt: 0, partialAt: 2_000 }), { failed: 0, partial: 0 });
  });

  it('两类忽略时间戳互相独立：忽略部分完成不影响失败提示', () => {
    const tasks = [task({ state: 'failed', finishedAt: 1_000 }), task({ state: 'partial', finishedAt: 1_000 })];
    assert.deepEqual(count(tasks, { failedAt: 0, partialAt: 5_000 }), { failed: 1, partial: 0 });
    assert.deepEqual(count(tasks, { failedAt: 5_000, partialAt: 0 }), { failed: 0, partial: 1 });
    assert.deepEqual(count(tasks, { failedAt: 5_000, partialAt: 5_000 }), { failed: 0, partial: 0 });
  });

  it('忽略只作用于时间戳之前的记录：更晚的新提示（任意 scope）仍会亮起', () => {
    // 注：lib 只认时间戳，不按 scope 分桶 —— 徽章展示的是全部 scope 的任务，
    // 忽略时间戳因此也是全局的（按 scope 存会让"切 scope 后提示又冒出来"）。
    assert.deepEqual(count(
      [task({ scope: 'kisearch', state: 'partial', finishedAt: 9_000 })],
      { failedAt: 5_000, partialAt: 5_000 },
    ), { failed: 0, partial: 1 });
  });
});
