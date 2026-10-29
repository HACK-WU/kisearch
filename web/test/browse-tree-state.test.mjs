/**
 * 浏览页左树状态持久化单测
 *
 * 锁住四条不变量：
 *   1) 展开态可无损往返：collectOpenPaths → applyOpenPaths 得到同一组展开节点；
 *   2) applyOpenPaths 是「集合即真相」：集合外的节点一律折叠，且无变更时返回原引用（React 跳过渲染）；
 *   3) localStorage 读取容错：无记录 / 损坏 JSON / 字段类型不对 → 默认值（不是「全部折叠」）；
 *      显式保存的空数组仍是有效状态（全部折叠），与「从未保存」(null) 语义不同；
 *   4) 展开路径写入前截断到上限，且按 scope 分桶互不干扰。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
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
const { applyOpenPaths, buildGroupTree, collectOpenPaths, withDefaultOpen } =
  await vite.ssrLoadModule('/src/lib/groupTree.ts');
const {
  MAX_OPEN_PATHS, browseTreeStateKey, defaultBrowseTreeState, readBrowseTreeState, treeStateFromTree,
  writeBrowseTreeState,
} = await vite.ssrLoadModule('/src/lib/browseTreeState.ts');
after(async () => vite.close());

/** 最小 localStorage 桩（Node 环境没有；被测模块运行时读全局） */
const store = new Map();
beforeEach(() => {
  store.clear();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
});

/** 三层知识库：a / a/x / a/x/m / b */
const groups = [
  { name: 'a', count: 1 },
  { name: 'a/x', count: 2 },
  { name: 'a/x/m', count: 3 },
  { name: 'b', count: 4 },
];

describe('collectOpenPaths / applyOpenPaths', () => {
  it('默认树（一级展开）往返后展开态不变', () => {
    const tree = withDefaultOpen(buildGroupTree(groups));
    const restored = applyOpenPaths(tree, collectOpenPaths(tree));
    assert.equal(restored, tree, '无变更时应返回原引用');
  });

  it('集合即真相：集合外的节点被折叠', () => {
    const tree = withDefaultOpen(buildGroupTree(groups));
    const restored = applyOpenPaths(tree, ['a', 'a/x/m']);
    const open = collectOpenPaths(restored).sort();
    assert.deepEqual(open, ['a', 'a/x/m']);
  });

  it('空集合 = 全部折叠（合法状态，不是 null 语义）', () => {
    const tree = withDefaultOpen(buildGroupTree(groups));
    assert.deepEqual(collectOpenPaths(applyOpenPaths(tree, [])), []);
  });

  it('忽略树中不存在的路径', () => {
    const tree = withDefaultOpen(buildGroupTree(groups));
    const restored = applyOpenPaths(tree, ['不存在/的组', 'a']);
    assert.deepEqual(collectOpenPaths(restored).sort(), ['a']);
  });

  it('收集顺序为先根后子（同层保持树序）', () => {
    const tree = withDefaultOpen(buildGroupTree(groups));
    assert.deepEqual(collectOpenPaths(applyOpenPaths(tree, ['a', 'a/x', 'a/x/m', 'b'])),
      ['a', 'a/x', 'a/x/m', 'b']);
  });
});

describe('readBrowseTreeState / writeBrowseTreeState', () => {
  it('无记录 → 默认值，且 openPaths 为 null（区别于空数组）', () => {
    const state = readBrowseTreeState('kisearch');
    assert.deepEqual(state, defaultBrowseTreeState());
    assert.equal(state.openPaths, null);
  });

  it('写入后可读回（含显式空数组 = 全部折叠）', () => {
    assert.equal(writeBrowseTreeState('kisearch', { collapsed: true, activeGroup: 'a/x', openPaths: [] }), true);
    assert.deepEqual(readBrowseTreeState('kisearch'), { collapsed: true, activeGroup: 'a/x', openPaths: [] });
  });

  it('损坏 JSON / 字段类型不对 → 逐字段回退默认，不让目录变全折叠', () => {
    localStorage.setItem(browseTreeStateKey('kisearch'), '{不是 JSON');
    assert.deepEqual(readBrowseTreeState('kisearch'), defaultBrowseTreeState());
    localStorage.setItem(browseTreeStateKey('kisearch'), JSON.stringify({ collapsed: 'yes', activeGroup: 7, openPaths: 'a' }));
    assert.deepEqual(readBrowseTreeState('kisearch'), defaultBrowseTreeState());
    localStorage.setItem(browseTreeStateKey('kisearch'), JSON.stringify({ openPaths: ['a', 3, null] }));
    assert.deepEqual(readBrowseTreeState('kisearch').openPaths, ['a']);
  });

  it('按 scope 分桶：两个 scope 互不干扰', () => {
    writeBrowseTreeState('scope-a', { collapsed: true, activeGroup: 'a', openPaths: ['a'] });
    writeBrowseTreeState('scope-b', { collapsed: false, activeGroup: 'b', openPaths: ['b'] });
    assert.equal(readBrowseTreeState('scope-a').collapsed, true);
    assert.equal(readBrowseTreeState('scope-b').collapsed, false);
    assert.deepEqual(readBrowseTreeState('scope-a').openPaths, ['a']);
  });

  it('localStorage 不可用时（隐私模式）读写都不抛异常', () => {
    globalThis.localStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    assert.deepEqual(readBrowseTreeState('kisearch'), defaultBrowseTreeState());
    assert.equal(writeBrowseTreeState('kisearch', defaultBrowseTreeState()), false);
  });
});

describe('treeStateFromTree', () => {
  it('从当前树收集展开路径，并带上布局与选中项', () => {
    const tree = applyOpenPaths(withDefaultOpen(buildGroupTree(groups)), ['a', 'a/x']);
    assert.deepEqual(treeStateFromTree(tree, true, 'a/x'),
      { collapsed: true, activeGroup: 'a/x', openPaths: ['a', 'a/x'] });
  });

  it('展开路径截断到上限（「展开全部」不会把 localStorage 撑爆）', () => {
    const many = Array.from({ length: MAX_OPEN_PATHS + 20 }, (_, i) => ({ name: `g${i}`, count: 1 }));
    const state = treeStateFromTree(withDefaultOpen(buildGroupTree(many)), false, 'g0');
    assert.equal(state.openPaths.length, MAX_OPEN_PATHS);
  });
});
