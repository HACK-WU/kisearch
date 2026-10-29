/**
 * 浏览页结果态 / 阅读态判定单测（REQ-20261018-001）
 *
 * 锁住四条不变量：
 *   1) 结果列表可见 = 有检索词 **且** 未被「在页内打开」隐藏；
 *   2) 页内打开后（结果隐藏 + 有文档）主区必须是 reading，而不是 results / empty；
 *   3) 检索条件一变（show-results）立即回到结果列表 —— 这是没有显式返回入口时的唯一回退路径；
 *   4) 抽屉与页内两种形态互斥：open-drawer 会同时取消结果隐藏，close-drawer 只切形态。
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
  browseViewReducer,
  deriveBrowseMode,
  initialBrowseView,
  resultsVisible,
} = await vite.ssrLoadModule('/src/lib/browseReadMode.ts');
after(async () => vite.close());

describe('resultsVisible', () => {
  it('有检索词且未隐藏 → 结果可见', () => {
    assert.equal(resultsVisible(true, false), true);
  });

  it('页内打开隐藏结果 → 不可见（即使检索词还在）', () => {
    assert.equal(resultsVisible(true, true), false);
  });

  it('没有检索词时结果态不存在（hidden 无意义）', () => {
    assert.equal(resultsVisible(false, false), false);
    assert.equal(resultsVisible(false, true), false);
  });
});

describe('deriveBrowseMode', () => {
  it('检索中、结果未隐藏、有文档 → results（正文让位）', () => {
    assert.equal(deriveBrowseMode({ isSearching: true, resultsHidden: false, hasViewing: true }), 'results');
  });

  it('检索中、结果未隐藏、无文档 → results（直接渲染结果）', () => {
    assert.equal(deriveBrowseMode({ isSearching: true, resultsHidden: false, hasViewing: false }), 'results');
  });

  it('页内打开（检索中 + 结果隐藏 + 有文档）→ reading（本次核心）', () => {
    assert.equal(deriveBrowseMode({ isSearching: true, resultsHidden: true, hasViewing: true }), 'reading');
  });

  it('页内打开后关闭文档 → 结果复位，不应停在 empty', () => {
    // 关闭文档会派发 show-results；这里验证复位后的形态
    assert.equal(deriveBrowseMode({ isSearching: true, resultsHidden: false, hasViewing: false }), 'results');
  });

  it('未检索、有文档 → reading（原有树阅读态）', () => {
    assert.equal(deriveBrowseMode({ isSearching: false, resultsHidden: false, hasViewing: true }), 'reading');
  });

  it('未检索、无文档 → empty（原有空态）', () => {
    assert.equal(deriveBrowseMode({ isSearching: false, resultsHidden: false, hasViewing: false }), 'empty');
  });
});

describe('browseViewReducer', () => {
  it('初始态：结果可见、内联', () => {
    assert.deepEqual(initialBrowseView, { resultsHidden: false, viewMode: 'inline' });
  });

  it('结果行默认点击 → 抽屉 + 结果保持可见', () => {
    const next = browseViewReducer(initialBrowseView, { type: 'open-drawer' });
    assert.deepEqual(next, { resultsHidden: false, viewMode: 'drawer' });
  });

  it('页内打开 → 隐藏结果 + 内联（与抽屉互斥）', () => {
    const drawer = browseViewReducer(initialBrowseView, { type: 'open-drawer' });
    const inline = browseViewReducer(drawer, { type: 'open-inline' });
    const hidden = browseViewReducer(inline, { type: 'hide-results' });
    assert.deepEqual(hidden, { resultsHidden: true, viewMode: 'inline' });
    assert.equal(deriveBrowseMode({ isSearching: true, ...hidden, hasViewing: true }), 'reading');
  });

  it('检索条件变化 → 结果复位（唯一回退路径）', () => {
    const reading = { resultsHidden: true, viewMode: 'inline' };
    const next = browseViewReducer(reading, { type: 'show-results' });
    assert.deepEqual(next, { resultsHidden: false, viewMode: 'inline' });
    assert.equal(deriveBrowseMode({ isSearching: true, ...next, hasViewing: true }), 'results');
  });

  it('关闭抽屉只切形态，保留结果可见性与文档', () => {
    const drawer = { resultsHidden: false, viewMode: 'drawer' };
    const next = browseViewReducer(drawer, { type: 'close-drawer' });
    assert.deepEqual(next, { resultsHidden: false, viewMode: 'inline' });
    assert.equal(deriveBrowseMode({ isSearching: true, ...next, hasViewing: true }), 'results');
  });

  it('无变化时返回同一引用（避免多余渲染）', () => {
    const state = { resultsHidden: false, viewMode: 'inline' };
    assert.equal(browseViewReducer(state, { type: 'open-inline' }), state);
    assert.equal(browseViewReducer(state, { type: 'show-results' }), state);
    assert.equal(browseViewReducer(state, { type: 'close-drawer' }), state);
  });

  it('完整回路：抽屉 → 页内打开 → 改检索词回到结果', () => {
    let state = initialBrowseView;
    state = browseViewReducer(state, { type: 'open-drawer' });
    state = browseViewReducer(state, { type: 'open-inline' });
    state = browseViewReducer(state, { type: 'hide-results' });
    assert.equal(deriveBrowseMode({ isSearching: true, ...state, hasViewing: true }), 'reading');
    state = browseViewReducer(state, { type: 'show-results' });
    assert.equal(deriveBrowseMode({ isSearching: true, ...state, hasViewing: true }), 'results');
  });
});
