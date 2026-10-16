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
const { dimensionStatusDetail, DEGRADED_TITLE, UNKNOWN_TITLE, dimensionBadge, embeddingIdentityTitle } =
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

// ─── REQ-20261016-002：总览「向量维度」面板角标 ───────────────────────────────

it('角标·一致：仅 state=compatible 且有 persisted 时断言一致', () => {
  const b = dimensionBadge({ state: 'compatible', persisted: 1024, scope: 'k8s' });
  assert.equal(b.text, '集合一致');
  assert.equal(b.tone, 'ok');
  assert.match(b.title, /1024 维/);
});

it('角标·不符：显示集合实际维度并给出重建指引（含 scope）', () => {
  const b = dimensionBadge({ state: 'mismatch', persisted: 4096, scope: 'k8s' });
  assert.equal(b.text, '集合 4096 维');
  assert.equal(b.tone, 'warn');
  assert.match(b.title, /ki restore k8s --rebuild-vector --yes/);
});

it('角标·诚实性：mismatch 但无 persisted 时不得断言不符（降级为未确认）', () => {
  const b = dimensionBadge({ state: 'mismatch', scope: 'k8s' });
  assert.equal(b.text, '未确认');
  assert.equal(b.tone, 'off');
  assert.ok(!b.text.includes('维'), b.text);
});

it('角标·诚实性：state=compatible 但无 persisted 也不得断言一致', () => {
  const b = dimensionBadge({ state: 'compatible', scope: 'k8s' });
  assert.equal(b.text, '未确认');
  assert.equal(b.tone, 'off');
});

it('角标·未确认：state 缺失 / unknown / 请求失败 三种情况都给未确认', () => {
  for (const input of [{ scope: 'k8s' }, { state: 'unknown', scope: 'k8s' }, { state: 'unknown', hasError: true, scope: 'k8s' }]) {
    const b = dimensionBadge(input);
    assert.equal(b.text, '未确认', JSON.stringify(input));
    assert.equal(b.tone, 'off', JSON.stringify(input));
  }
  assert.match(dimensionBadge({ hasError: true }).title, /请求失败/);
  assert.match(dimensionBadge({}).title, /快照缺失或已过期/);
});

it('角标·scope 缺失：指引文案用占位符，不渲染 undefined', () => {
  const b = dimensionBadge({ state: 'mismatch', persisted: 4096 });
  assert.match(b.title, /ki restore <scope> --rebuild-vector/);
  assert.ok(!b.title.includes('undefined'), b.title);
});

// ─── REQ-20261016-002：模型名面板 title（D4②）───────────────────────────────

it('title·三者齐：模型名 + provider + baseURL，用 · 连接', () => {
  const t = embeddingIdentityTitle({
    model: 'qwen3.7-text-embedding-flash',
    provider: 'dashscope',
    baseURL: 'https://maas.example.com/compatible-mode/v1',
  });
  assert.equal(t, 'qwen3.7-text-embedding-flash · dashscope · https://maas.example.com/compatible-mode/v1');
});

it('title·仅模型名（旧 daemon）：仍给出全文，供省略号后查看', () => {
  assert.equal(embeddingIdentityTitle({ model: 'Qwen/Qwen3-Embedding-8B' }), 'Qwen/Qwen3-Embedding-8B');
});

it('title·全缺 / 空串：返回 undefined（不渲染空 title）', () => {
  assert.equal(embeddingIdentityTitle(undefined), undefined);
  assert.equal(embeddingIdentityTitle({}), undefined);
  assert.equal(embeddingIdentityTitle({ model: '', provider: '', baseURL: '' }), undefined);
});
