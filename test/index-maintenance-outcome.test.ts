/**
 * index-maintenance-outcome.test.ts —— 导入收尾「整理结果 → 任务 phase」收敛口径
 *
 * 锁定一条不变量：**任何情形都必须收敛**（optimized / available），
 * 绝不允许返回 `indexing` —— 否则前端顶栏会一直挂「索引整理中 · 文档已可用」且没有消除入口，
 * 直到任务记录 1h TTL 到期（用户反馈的"提示一直存在"形态之一）。
 *
 * 三种情形：
 *   1. 命中本 scope 且整理成功 → optimized
 *   2. 命中本 scope 但整理失败/降级 → available + 失败线索
 *   3. last 缺失（等待超时未落定）/ 属其他 scope → available + 通用重试线索（本次新增的兜底）
 *
 * 运行：npx jiti test/index-maintenance-outcome.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIndexMaintenanceOutcome, type IndexMaintenanceLast } from '../src/lib/index-maintenance.js';

const SCOPE = 'ai-docs';

const last = (over: Partial<IndexMaintenanceLast> = {}): IndexMaintenanceLast => ({
  scope: SCOPE,
  at: 1_000,
  ok: true,
  wallMs: 2_500,
  pid: 123,
  ...over,
});

describe('整理结果 → 任务 phase 收敛', () => {
  it('整理成功 → optimized，且不给 recoveryHint', () => {
    const outcome = resolveIndexMaintenanceOutcome(SCOPE, last());
    assert.equal(outcome.phase, 'optimized');
    assert.equal(outcome.recoveryHint, undefined);
  });

  it('整理失败/降级 → available + 带降级原因与重试命令的线索', () => {
    const outcome = resolveIndexMaintenanceOutcome(SCOPE, last({ ok: false, degraded: 'timeout', reason: '超过 600s' }));
    assert.equal(outcome.phase, 'available');
    assert.match(outcome.recoveryHint ?? '', /timeout/);
    assert.match(outcome.recoveryHint ?? '', /ki index-optimize -s ai-docs/);
  });

  it('降级原因缺失 → 线索回退为 error（不渲染 undefined）', () => {
    const outcome = resolveIndexMaintenanceOutcome(SCOPE, last({ ok: false }));
    assert.equal(outcome.phase, 'available');
    assert.match(outcome.recoveryHint ?? '', /error/);
    assert.doesNotMatch(outcome.recoveryHint ?? '', /undefined/);
  });

  it('★ 等待超时（last 缺失）→ 仍收敛为 available，不再停在 indexing', () => {
    const outcome = resolveIndexMaintenanceOutcome(SCOPE, undefined);
    assert.equal(outcome.phase, 'available');
    assert.match(outcome.recoveryHint ?? '', /未在等待窗口内落定/);
    assert.match(outcome.recoveryHint ?? '', /ki index-optimize -s ai-docs/);
  });

  it('★ last 属其他 scope（本次整理结果未知）→ 同样收敛为 available', () => {
    const outcome = resolveIndexMaintenanceOutcome(SCOPE, last({ scope: 'other-scope', ok: true }));
    assert.equal(outcome.phase, 'available');
    assert.match(outcome.recoveryHint ?? '', /未在等待窗口内落定/);
  });

  it('所有情形都不得返回 indexing', () => {
    const cases: Array<IndexMaintenanceLast | undefined> = [
      undefined,
      last(),
      last({ ok: false, degraded: 'timeout' }),
      last({ ok: false, degraded: 'unavailable' }),
      last({ ok: false, degraded: 'error' }),
      last({ scope: 'other' }),
      last({ scope: 'other', ok: false }),
    ];
    for (const item of cases) {
      const phase = resolveIndexMaintenanceOutcome(SCOPE, item).phase;
      assert.ok(phase === 'optimized' || phase === 'available', `非法收敛值：${phase}`);
    }
  });
});
