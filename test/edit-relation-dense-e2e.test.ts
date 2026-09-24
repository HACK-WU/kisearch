import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

it('真实 dense 链路：finish 前保留旧向量，完成后仅保留最终正文向量', async () => {
  fs.mkdirSync(path.resolve('temp'), { recursive: true });
  const root = fs.mkdtempSync(path.resolve('temp', 'ki-edit-dense-real-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: body.input.map((_, index) =>
      ({ index, embedding: [0.1, 0.2, 0.3, 0.4] })) }), { status: 200 });
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    dataDir: path.join(root, 'kb'), vectorDir: path.join(root, 'vector'), backupDir: path.join(root, 'backup'),
    scopes: {}, embedding: { provider: 'siliconflow', baseURL: 'https://local-embedding.test/v1',
      model: 'local-test', dimension: 4, apiKey: 'local-test-key' },
  }));
  process.env.KI_CONFIG_PATH = path.join(root, 'config.json');
  const scope = 'edit_real_dense';
  let vectorClient: typeof import('../src/lib/vector-client.js') | undefined;
  try {
    const store = await import('../src/lib/store.js');
    const paths = await import('../src/lib/scope.js');
    const vector = await import('../src/lib/vector-client.js');
    vectorClient = vector;
    const draftModule = await import('../src/lib/relation-edit-draft.js');
    const edit = await import('../src/edit-relation.js');
    const oldText = 'old amber body';
    const newText = 'final cobalt body';
    store.ensureScopeDir(scope);
    const groupIndex = store.readGroupIndex(scope)!;
    groupIndex.groups.Docs = {};
    store.writeJson(paths.getGroupIndexPath(scope), groupIndex as unknown as Record<string, unknown>);
    const oldId = (await vector.vectorStore({ scope, text: oldText, tags: 'ki-search' })).docId;
    const cache = store.readJson<any>(paths.getRelationsCachePath(scope))!;
    cache.groups.Docs = { hot_relations: [{ id: 'rel_001', text: 'Example', score: 0, useCount: 0,
      lastUsedTime: null, isImported: false, memoryId: oldId, memoryIds: [oldId] }], keywords: [] };
    store.writeJson(paths.getRelationsCachePath(scope), cache);
    store.writeJson(paths.getLocalKbDir(scope, 'Docs'), { Example: oldText });
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'Example',
      expectedRevision: draftModule.contentRevision(oldText),
      edits: [{ start_line: 1, end_line: 1, new_text: newText }] });
    assert.equal(created.ok, true);
    assert.equal((await vector.vectorFetchDocs([oldId])).length, 1);
    assert.equal((await vector.vectorFetchDocs([vector.generateDocId(newText, scope, 'ki-search')])).length, 0);
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'real-dense-1' });
    let final: Record<string, any> | undefined;
    for (let i = 0; i < 250; i++) {
      final = await edit.executeEditRelationLocal({ action: 'view', scope, editId: created.editId as string });
      if (final.status === 'published' || final.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(final?.status, 'published', final?.error);
    assert.equal((await vector.vectorFetchDocs([oldId])).length, 0);
    assert.equal((await vector.vectorFetchDocs([vector.generateDocId(newText, scope, 'ki-search')])).length, 1);
    assert.equal(store.readJson<Record<string, string>>(paths.getLocalKbDir(scope, 'Docs'))?.Example, newText);
  } finally {
    if (vectorClient) await vectorClient.closeEngine(scope);
    globalThis.fetch = originalFetch;
  }
});
