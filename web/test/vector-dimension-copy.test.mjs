/**
 * 向量维度降级文案单测（R8 二期，REQ-20261009-003）
 *
 * 锁住三条不变量：
 *   1) 降级 ≠ 故障：`degraded` 文案必须与"暂无法确认"区分（N9：未知 vs 故障）；
 *   2) 诚实性：无 `persisted` 时**不得**把当前配置维度冒充"上次结果"
 *      （快照缺失/过期/unknown 时 `readVectorDimensionSnapshot` 只返回 `configured`）；
 *   3) 健壮性：`waitedMs` 非有限数（缺字段/换版后端）不得渲染 "NaNs"。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, it } from 'node:test';
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
const { dimensionStatusDetail, DEGRADED_TITLE, UNKNOWN_TITLE } =
  await vite.ssrLoadModule('/src/lib/vectorDimensionCopy.ts');
after(async () => vite.close());

it('无 degraded：沿用既有口径（status.error 或 缺省话术）', () => {
  assert.equal(dimensionStatusDetail({ status: { error: '维度探测失败：xxx' } }), '维度探测失败：xxx');
  assert.equal(dimensionStatusDetail({ status: {} }), '维度快照缺失或已过期');
  assert.equal(dimensionStatusDetail({}), '维度快照缺失或已过期');
});

it('降级 + persisted：显示上次结果与检查时刻', () => {
  const copy = dimensionStatusDetail({
    degraded: { reason: 'timeout', waitedMs: 5000 },
    status: { persisted: 1024, configured: 1024, checkedAt: Date.UTC(2026, 9, 10, 3, 20) },
  });
  assert.match(copy, /引擎未在 5s 内响应/);
  assert.match(copy, /显示上次结果：1024 维/);
  assert.match(copy, /检查于/);
});

it('降级 + 无 persisted：不得把当前配置冒充"上次结果"', () => {
  const copy = dimensionStatusDetail({
    degraded: { reason: 'timeout', waitedMs: 5000 },
    status: { configured: 1024 }, // 快照缺失/过期时只有 configured
  });
  assert.ok(!copy.includes('显示上次结果'), `不得出现"上次结果"：${copy}`);
  assert.match(copy, /本次未取到维度快照/);
  assert.match(copy, /当前配置 1024 维/);
});

it('降级 + waitedMs 非有限数：兜底话术，不渲染 NaN', () => {
  const copy = dimensionStatusDetail({ degraded: { reason: 'timeout' }, status: { persisted: 768 } });
  assert.ok(!copy.includes('NaN'), copy);
  assert.match(copy, /引擎未在预期时间内响应/);
  assert.match(copy, /显示上次结果：768 维/);
});

it('降级 + checkedAt 为 0（损坏快照）：不显示 1970 时刻', () => {
  const copy = dimensionStatusDetail({
    degraded: { reason: 'timeout', waitedMs: 5000 },
    status: { persisted: 768, checkedAt: 0 },
  });
  assert.ok(!copy.includes('检查于'), `checkedAt=0 不得展示时刻：${copy}`);
  assert.match(copy, /显示上次结果：768 维/);
});

it('标题区分：降级与未确认文案不同', () => {
  assert.notEqual(DEGRADED_TITLE, UNKNOWN_TITLE);
  assert.ok(DEGRADED_TITLE.includes('未完成'), DEGRADED_TITLE);
});
