import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const tempRoot = path.resolve('temp');
fs.mkdirSync(tempRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tempRoot, 'ki-edit-fts-real-'));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  dataDir: path.join(root, 'kb'),
  vectorDir: path.join(root, 'vector'),
  backupDir: path.join(root, 'backup'),
  scopes: {},
}), 'utf8');
process.env.KI_CONFIG_PATH = path.join(root, 'config.json');

it('真实 FTS-only 链路：草稿不可见，finish 后新正文可检索且旧 ID 删除', async () => {
  const scope = 'edit_real_fts';
  const group = 'Docs';
  const relation = 'Example';
  const oldText = 'oldamberkeyword appears in the original relation';
  const newText = 'newcobaltkeyword appears in the final relation';
  const store = await import('../src/lib/store.js');
  const paths = await import('../src/lib/scope.js');
  const fts = await import('../src/lib/fts-client.js');
  const draftModule = await import('../src/lib/relation-edit-draft.js');
  const edit = await import('../src/edit-relation.js');
  const search = await import('../src/search.js');
  store.ensureScopeDir(scope);
  const groupIndex = store.readGroupIndex(scope)!;
  groupIndex.groups[group] = {};
  store.writeJson(paths.getGroupIndexPath(scope), groupIndex as unknown as Record<string, unknown>);
  const oldEntry = { scope, group, relation, tag: 'ki-search', text: oldText };
  const oldId = fts.getFtsDocId(oldEntry);
  const stored = await fts.ftsBulkStore([oldEntry]);
  assert.deepEqual(stored.ids, [oldId]);
  const cache = store.readJson<any>(paths.getRelationsCachePath(scope))!;
  cache.groups[group] = { hot_relations: [{
    id: 'rel_001', text: relation, score: 0, useCount: 0, lastUsedTime: null,
    isImported: false, ftsIds: [oldId], ftsIndexComplete: true,
  }], keywords: [] };
  store.writeJson(paths.getRelationsCachePath(scope), cache);
  store.writeJson(paths.getLocalKbDir(scope, group), { [relation]: oldText });
  try {
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group, relation,
      expectedRevision: draftModule.contentRevision(oldText),
      edits: [{ start_line: 1, end_line: 1, new_text: newText }] });
    assert.equal(created.ok, true);
    assert.equal((await fts.ftsSearch({ scope, query: 'newcobaltkeyword' })).length, 0);
    assert.ok((await fts.ftsSearch({ scope, query: 'oldamberkeyword' })).length > 0);
    // 模拟 finish 写入新 FTS 后中断：底层可见，但 ki_search 不可提前召回草稿。
    const staged = draftModule.loadDraft(scope, created.editId as string);
    const newEntry = { scope, group, relation, tag: 'ki-search', text: newText };
    staged.newFtsIds = [fts.getFtsDocId(newEntry)];
    staged.status = 'failed';
    draftModule.saveDraft(staged);
    await fts.ftsBulkStore([newEntry]);
    assert.ok((await fts.ftsSearch({ scope, query: 'newcobaltkeyword' })).length > 0);
    const hidden = await search.executeSearch({ scope, query: 'newcobaltkeyword', mode: 'fulltext' });
    assert.equal(hidden.ok, true);
    if (hidden.ok) assert.equal(hidden.results.length, 0);
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'real-fts-1' });
    let final: Record<string, any> | undefined;
    for (let i = 0; i < 200; i++) {
      final = await edit.executeEditRelationLocal({ action: 'view', scope, editId: created.editId as string });
      if (final.status === 'published' || final.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(final?.status, 'published', final?.error);
    assert.ok((await fts.ftsSearch({ scope, query: 'newcobaltkeyword' })).length > 0);
    assert.equal((await fts.ftsSearch({ scope, query: 'oldamberkeyword' })).length, 0);
    assert.equal(store.readJson<Record<string, string>>(paths.getLocalKbDir(scope, group))?.[relation], newText);
  } finally {
    await fts.closeFtsEngine(scope);
  }
});
