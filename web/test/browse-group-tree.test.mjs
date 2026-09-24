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
  buildGroupTree,
  countDocs,
  findGroupNode,
  firstGroupWithDocuments,
  isGroupSelectable,
  revealGroupPath,
  toggleNodeOpen,
  withAllOpen,
  withDefaultOpen,
} = await vite.ssrLoadModule('/src/lib/groupTree.ts');
after(async () => vite.close());

describe('document-bearing parent Groups', () => {
  const groups = [
    { name: 'langchain', count: 9 },
    { name: 'langchain/stages/lessons', count: 3 },
  ];

  it('keeps a sole root with its own documents visible in both trees', () => {
    const roots = buildGroupTree(groups);
    assert.equal(roots[0]?.path, 'langchain');
    assert.equal(roots[0]?.count, 9);
    assert.equal(firstGroupWithDocuments(roots), 'langchain');
    assert.equal(isGroupSelectable(roots[0]), true);
  });

  it('still promotes a sole empty directory and selects its first document-bearing child', () => {
    const roots = buildGroupTree([{ name: 'langchain/stages/lessons', count: 3 }]);
    assert.equal(roots[0]?.path, 'langchain/stages');
    assert.equal(roots[0]?.count, 0);
    assert.equal(isGroupSelectable(roots[0]), false);
    assert.equal(isGroupSelectable(roots[0], true), true);
    assert.equal(firstGroupWithDocuments(roots), 'langchain/stages/lessons');
  });

  it('selects the current root documents even when old nested imports remain', () => {
    const roots = buildGroupTree([
      { name: 'langchain', count: 9 },
      { name: 'langchain/langchain', count: 8 },
      { name: 'langchain/langchain/stages/lessons', count: 3 },
      { name: 'playground/kb', count: 5 },
    ]);
    assert.equal(roots[0]?.path, 'langchain');
    assert.equal(roots[0]?.count, 9);
    assert.equal(firstGroupWithDocuments(roots), 'langchain');
    assert.equal(isGroupSelectable(roots[0]), true);
    assert.equal(roots[0]?.children[0]?.path, 'langchain/langchain');
  });

  it('handles empty input and an all-count-zero tree', () => {
    assert.deepEqual(buildGroupTree([]), []);
    assert.equal(firstGroupWithDocuments(buildGroupTree([{ name: 'a/b', count: 0 }])), '');
    assert.equal(isGroupSelectable({ name: 'x', path: 'x', count: 0, children: [], open: false }), true);
  });
});

describe('group tree state operations are pure', () => {
  // 与真实数据一致：根有自身文档，且深层存在旧导入留下的嵌套路径
  const groups = [
    { name: 'langchain', count: 9 },
    { name: 'langchain/langchain/stages/lessons', count: 3 },
  ];
  const lessonsPath = 'langchain/langchain/stages/lessons';

  it('toggles a node without mutating the tree it was given', () => {
    const tree = buildGroupTree(groups);
    const snapshot = JSON.stringify(tree);

    const opened = toggleNodeOpen(tree, 'langchain');
    assert.notEqual(opened, tree);
    assert.equal(opened[0].open, true);
    assert.equal(JSON.stringify(tree), snapshot, '入参树不得被改写');
    assert.equal(toggleNodeOpen(opened, 'langchain')[0].open, false, '两次切换回到原状态');
    assert.equal(JSON.stringify(tree), snapshot, '重复调用仍不得改写入参树');
  });

  it('returns the same reference when nothing changes', () => {
    const tree = buildGroupTree(groups);
    assert.equal(toggleNodeOpen(tree, 'missing/group'), tree);
    assert.equal(withAllOpen(tree, false), tree);
    assert.equal(revealGroupPath(tree, ''), tree);
  });

  it('opens only one level by default and can open/collapse all', () => {
    const tree = withDefaultOpen(buildGroupTree(groups));
    assert.equal(tree[0].open, true);
    assert.equal(tree[0].children[0].open, false);

    const opened = withAllOpen(tree, true);
    assert.equal(opened[0].open, true);
    assert.equal(opened[0].children[0].open, true);
    assert.equal(opened[0].children[0].children[0].open, true);
    assert.equal(withAllOpen(opened, true), opened, '已全部展开时不应产生新树');

    const collapsed = withAllOpen(opened, false);
    assert.equal(collapsed[0].open, false);
    assert.equal(collapsed[0].children[0].open, false);
  });

  it('reveals ancestors of the selection without opening the selection itself', () => {
    const tree = withDefaultOpen(buildGroupTree(groups));
    const revealed = revealGroupPath(tree, lessonsPath);

    assert.notEqual(revealed, tree);
    const root = revealed[0];
    const nested = root.children[0];
    const stages = nested.children[0];
    assert.equal(root.open, true);
    assert.equal(nested.open, true, '祖先链必须逐级展开');
    assert.equal(stages.open, true);
    assert.equal(stages.children[0].open, false, '目标自身不展开');
    assert.equal(revealGroupPath(revealed, lessonsPath), revealed, '已可见时返回原引用（幂等）');
  });

  it('counts a group with its subgroups and finds nodes by path', () => {
    const tree = buildGroupTree(groups);
    assert.equal(countDocs(tree[0]), 12);
    assert.equal(countDocs(tree[0].children[0]), 3);
    assert.equal(countDocs(tree[0].children[0].children[0].children[0]), 3);
    assert.equal(findGroupNode(tree, lessonsPath)?.count, 3);
    assert.equal(findGroupNode(tree, 'langchain/langchain')?.count, 0);
    assert.equal(findGroupNode(tree, 'missing'), null);
  });
});
