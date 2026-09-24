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
const { buildGroupTree, firstGroupWithDocuments, isGroupSelectable } = await vite.ssrLoadModule('/src/lib/groupTree.ts');
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
});
