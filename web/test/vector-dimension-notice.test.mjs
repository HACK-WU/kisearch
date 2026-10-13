/**
 * 向量维度告警 banner 可忽略规则单测（lib/vectorDimensionNotice.ts）
 *
 * 锁住四条不变量：
 *   1) 展示口径不变：只有 mismatch（**且有 persisted**）与 unknown / 请求失败才提示；
 *      mismatch 缺 persisted、compatible、无数据都不提示（与改动前的渲染条件一致）；
 *   2) 忽略生效：指纹相同 ⇒ 不再显示；
 *   3) 状态变化即重新提示：state / 维度值 / scope / 降级原因 / 请求错误任一变化 ⇒ 指纹变化 ⇒ 显示
 *      （避免"忽略了就永远看不到真实故障"）；
 *   4) 忽略写入失败（localStorage 不可用）不抛异常。
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
const {
  dimensionNoticeKind,
  dimensionNoticeFingerprint,
  shouldShowDimensionNotice,
  readDimensionDismissedFingerprint,
  writeDimensionDismissedFingerprint,
  VECTOR_DIMENSION_DISMISS_KEY,
} = await vite.ssrLoadModule('/src/lib/vectorDimensionNotice.ts');
after(async () => vite.close());

const mismatch = { scope: 'kisearch', state: 'mismatch', persisted: 768, configured: 1024 };
const unknown = { scope: 'kisearch', state: 'unknown', configured: 1024 };

describe('展示口径（与改动前一致）', () => {
  it('mismatch + 有 persisted → 提示；缺 persisted → 不提示', () => {
    assert.equal(dimensionNoticeKind(mismatch), 'mismatch');
    assert.equal(dimensionNoticeKind({ scope: 'kisearch', state: 'mismatch', configured: 1024 }), null);
  });

  it('unknown / 请求失败 → 提示；compatible / 无数据 → 不提示', () => {
    assert.equal(dimensionNoticeKind(unknown), 'unknown');
    assert.equal(dimensionNoticeKind({ scope: 'kisearch', hasError: true }), 'unknown');
    assert.equal(dimensionNoticeKind({ scope: 'kisearch', state: 'compatible', persisted: 1024, configured: 1024 }), null);
    assert.equal(dimensionNoticeKind({ scope: 'kisearch' }), null);
  });
});

describe('忽略：指纹相同则不再显示', () => {
  it('从未忽略（null）时按状态正常显示', () => {
    assert.equal(shouldShowDimensionNotice(mismatch, null), true);
    assert.equal(shouldShowDimensionNotice(unknown, null), true);
  });

  it('忽略 mismatch 后不再显示同一状态', () => {
    assert.equal(shouldShowDimensionNotice(mismatch, dimensionNoticeFingerprint(mismatch)), false);
  });

  it('忽略 unknown 后不再显示同一状态', () => {
    assert.equal(shouldShowDimensionNotice(unknown, dimensionNoticeFingerprint(unknown)), false);
  });

  it('状态变化即重新提示：维度值 / state / scope / 降级原因 / 请求错误', () => {
    const dismissed = dimensionNoticeFingerprint(unknown);
    assert.equal(shouldShowDimensionNotice({ ...unknown, degradedReason: 'timeout' }, dismissed), true);
    assert.equal(shouldShowDimensionNotice({ ...unknown, hasError: true }, dismissed), true);
    assert.equal(shouldShowDimensionNotice({ ...unknown, scope: 'other' }, dismissed), true);
    assert.equal(shouldShowDimensionNotice({ ...unknown, configured: 512 }, dismissed), true);
    const dismissedMismatch = dimensionNoticeFingerprint(mismatch);
    assert.equal(shouldShowDimensionNotice({ ...mismatch, persisted: 512 }, dismissedMismatch), true);
    assert.equal(shouldShowDimensionNotice(unknown, dismissedMismatch), true);
  });

  it('无提示状态不受忽略影响（本身就是 null）', () => {
    assert.equal(shouldShowDimensionNotice({ scope: 'kisearch', state: 'compatible' }, 'anything'), false);
  });
});

describe('localStorage 读写（Node 环境无 localStorage）', () => {
  it('读取失败返回 null；写入失败不抛异常', () => {
    assert.equal(readDimensionDismissedFingerprint(), null);
    assert.doesNotThrow(() => writeDimensionDismissedFingerprint('x'));
    assert.equal(VECTOR_DIMENSION_DISMISS_KEY, 'ki.vectorDimensionNoticeDismissed');
  });
});
