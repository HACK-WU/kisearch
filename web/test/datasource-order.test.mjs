/**
 * 数据源列表「冻结行序」单测（web/src/lib/datasourceOrder.ts）
 *
 * 锁住的不变量（2026-10-30 D 方案）：
 *   1) 后端重排（同步完成把该行沉底）不得影响已冻结顺序；
 *   2) 新出现的 scope 追加到末尾，不插到中间；
 *   3) 消失的 scope 被剔除，剩余行相对顺序不变；
 *   4) 序列清空（刷新页面）时回落到后端顺序；
 *   5) 顺序无变化时返回原引用，避免多余 re-render。
 *
 * 运行：cd web && npm test
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
const { mergeRowOrder, applyRowOrder } = await vite.ssrLoadModule('/src/lib/datasourceOrder.ts');

after(async () => { await vite.close(); });

const rows = (...scopes) => scopes.map((scope) => ({ scope }));

describe('mergeRowOrder', () => {
  it('首次调用直接采用后端顺序', () => {
    assert.deepEqual([...mergeRowOrder([], ['a', 'b', 'c'])], ['a', 'b', 'c']);
  });

  it('后端重排时保持已冻结顺序（同步完成沉底不生效）', () => {
    const frozen = ['a', 'b', 'c'];
    assert.deepEqual([...mergeRowOrder(frozen, ['b', 'c', 'a'])], ['a', 'b', 'c']);
  });

  it('顺序无变化时返回原引用', () => {
    const frozen = ['a', 'b'];
    assert.equal(mergeRowOrder(frozen, ['a', 'b']), frozen);
  });

  it('新 scope 追加到末尾', () => {
    assert.deepEqual([...mergeRowOrder(['a', 'b'], ['a', 'b', 'z'])], ['a', 'b', 'z']);
  });

  it('被移除的 scope 剔除，其余相对顺序不变', () => {
    assert.deepEqual([...mergeRowOrder(['a', 'b', 'c'], ['c', 'a'])], ['a', 'c']);
  });

  it('移除后重新登记的同名 scope 追加到末尾', () => {
    assert.deepEqual([...mergeRowOrder(['a', 'c'], ['a', 'c', 'b'])], ['a', 'c', 'b']);
  });
});

describe('applyRowOrder', () => {
  it('按冻结序列取行', () => {
    const out = applyRowOrder(['c', 'a', 'b'], rows('a', 'b', 'c'));
    assert.deepEqual(out.map((r) => r.scope), ['c', 'a', 'b']);
  });

  it('序列为空时保持后端顺序', () => {
    const out = applyRowOrder([], rows('a', 'b'));
    assert.deepEqual(out.map((r) => r.scope), ['a', 'b']);
  });

  it('序列里没有的行追加在末尾（避免先按后端序闪一帧）', () => {
    const out = applyRowOrder(['b', 'a'], rows('a', 'b', 'new'));
    assert.deepEqual(out.map((r) => r.scope), ['b', 'a', 'new']);
  });

  it('序列里已不存在于数据中的 scope 被跳过', () => {
    const out = applyRowOrder(['ghost', 'a'], rows('a', 'b'));
    assert.deepEqual(out.map((r) => r.scope), ['a', 'b']);
  });

  it('冻结序列 + 分页切片：12 行两页不丢行', () => {
    const all = rows(...Array.from({ length: 12 }, (_, i) => `ds-${String(i + 1).padStart(2, '0')}`));
    const order = all.map((r) => r.scope);
    const rotated = [...all.slice(1), all[0]];      // 后端把首行沉底
    const frozen = applyRowOrder(mergeRowOrder(order, rotated.map((r) => r.scope)), rotated);
    const page1 = frozen.slice(0, 10).map((r) => r.scope);
    const page2 = frozen.slice(10).map((r) => r.scope);
    assert.deepEqual(page1, order.slice(0, 10));
    assert.equal(new Set([...page1, ...page2]).size, 12);
  });
});
