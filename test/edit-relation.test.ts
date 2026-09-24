import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const tempRoot = path.resolve('temp');
fs.mkdirSync(tempRoot, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(tempRoot, 'ki-edit-relation-'));
const configPath = path.join(testRoot, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir: path.join(testRoot, 'kb'),
  vectorDir: path.join(testRoot, 'vector'),
  backupDir: path.join(testRoot, 'backup'),
  scopes: {},
}), 'utf8');
process.env.KI_CONFIG_PATH = configPath;

let edit: typeof import('../src/edit-relation.js');
let draftModule: typeof import('../src/lib/relation-edit-draft.js');
let store: typeof import('../src/lib/store.js');
let scopePath: typeof import('../src/lib/scope.js');
let ftsClient: typeof import('../src/lib/fts-client.js');
let getModuleInfo: typeof import('../src/get-module-info.js');
let denseWrites: Array<{ entries: Array<{ text: string; tags?: string }> }> = [];
let denseDeletes: string[][] = [];
let ftsWrites: Array<Array<{ text: string; tag?: string }>> = [];
let ftsDeletes: string[][] = [];
let failDense = false;
let failedDenseDeletes = new Set<string>();
let preexistingDenseIds = new Set<string>();
let afterDenseWrite: (() => void) | undefined;
let wikiWrites: Array<{ scope: string; relation: string; content: string }> = [];

before(async () => {
  const vectorClient = await import('../src/lib/vector-client.js');
  (vectorClient as any).vectorFetchDocs = async (ids: string[]) => ids
    .filter((id) => preexistingDenseIds.has(id))
    .map((docId) => ({ docId, content: 'existing' }));
  (vectorClient as any).vectorBulkStore = async (params: { entries: Array<{ text: string; tags?: string }> }) => {
    denseWrites.push(params);
    afterDenseWrite?.();
    const results = params.entries.map((entry, index) => ({
      index,
      success: !failDense,
      memoryId: `mock-${index}`,
    }));
    return { total: results.length, totalItems: results.length,
      succeeded: results.filter((item) => item.success).length,
      failed: results.filter((item) => !item.success).length, results };
  };
  (vectorClient as any).vectorDelete = async (params: { ids: string[] }) => {
    denseDeletes.push([...params.ids]);
    const errors = params.ids.filter((id) => failedDenseDeletes.has(id))
      .map((id) => ({ id, code: 'WRITE_ERROR', reason: 'mock cleanup failure' }));
    return { deleted: params.ids.length - errors.length, errors };
  };
  ftsClient = await import('../src/lib/fts-client.js');
  (ftsClient as any).ftsBulkStore = async (entries: Array<{ text: string; tag?: string; scope: string; group: string; relation: string }>) => {
    ftsWrites.push(entries);
    return { ids: entries.map((entry) => ftsClient.getFtsDocId(entry)), failed: 0 };
  };
  (ftsClient as any).ftsDeleteByIds = async (params: { ids: string[] }) => {
    ftsDeletes.push([...params.ids]);
    return { deleted: params.ids.length, failed: 0, failedIds: [] };
  };
  const wikiSync = await import('../src/lib/wiki-sync.js');
  (wikiSync as any).writeBackToWiki = (scope: string, _group: string, relation: string, content: string) => {
    wikiWrites.push({ scope, relation, content });
    return { synced: true };
  };
  edit = await import('../src/edit-relation.js');
  draftModule = await import('../src/lib/relation-edit-draft.js');
  store = await import('../src/lib/store.js');
  scopePath = await import('../src/lib/scope.js');
  getModuleInfo = await import('../src/get-module-info.js');
});

function seed(scope: string, relation: string, content: string, mode: 'dense' | 'fts', extra?: { sourcePath?: string; tags?: string[] }): void {
  store.ensureScopeDir(scope);
  const group = 'Docs';
  const index = store.readGroupIndex(scope)!;
  index.groups[group] = {};
  store.writeJson(scopePath.getGroupIndexPath(scope), index as unknown as Record<string, unknown>);
  const cache = store.readJson<any>(scopePath.getRelationsCachePath(scope))!;
  cache.groups[group] = cache.groups[group] ?? { hot_relations: [], keywords: [] };
  const oldId = mode === 'fts'
    ? ftsClient.getFtsDocId({ scope, group, relation, text: content, tag: 'ki-search' })
    : `old-dense-${relation}`;
  cache.groups[group].hot_relations.push({
    id: `rel_${cache.groups[group].hot_relations.length + 1}`,
    text: relation, score: 0, useCount: 0, lastUsedTime: null, isImported: !!extra?.sourcePath,
    ...(mode === 'dense' ? { memoryId: oldId, memoryIds: [oldId] } : { ftsIds: [oldId], ftsIndexComplete: true }),
    ...(extra?.sourcePath ? { sourcePath: extra.sourcePath } : {}),
    ...(extra?.tags ? { tags: extra.tags } : {}),
  });
  store.writeJson(scopePath.getRelationsCachePath(scope), cache);
  const kb = store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, group)) ?? {};
  kb[relation] = content;
  store.writeJson(scopePath.getLocalKbDir(scope, group), kb);
}

async function waitForStatus(scope: string, editId: string, expected: 'published' | 'failed'): Promise<Record<string, any>> {
  for (let i = 0; i < 200; i++) {
    const result = await edit.executeEditRelationLocal({ action: 'view', scope, editId });
    if (result.status === expected) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待草稿 ${editId} 状态 ${expected} 超时`);
}

describe('ki_edit_relation', () => {
  it('MCP 与 daemon 均注册 edit-relation，工具说明引导大/小 Relation', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { registerEditRelationTool } = await import('../src/lib/mcp-tools/edit-relation.js');
    const { supportedOperations } = await import('../src/lib/daemon-dispatch.js');
    const server = new McpServer({ name: 'ki-edit-test', version: '0.0.0' });
    registerEditRelationTool(server);
    const tool = (server as any)._registeredTools.ki_edit_relation;
    assert.ok(tool);
    assert.match(tool.description, /大 Relation/);
    assert.match(tool.description, /小 Relation.*ki_sync_relation/);
    assert.ok(supportedOperations().includes('edit-relation'));
    seed('edit_mcp', 'ThroughMcp', 'first\nsecond', 'fts');
    const client = new Client({ name: 'ki-edit-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((item) => item.name === 'ki_edit_relation'));
      const edited = await client.callTool({ name: 'ki_edit_relation', arguments: {
        action: 'edit', scope: 'edit_mcp', group: 'Docs', relation: 'ThroughMcp',
        expected_revision: draftModule.contentRevision('first\nsecond'),
        edits: [{ start_line: 2, end_line: 2, new_text: 'changed' }],
      } });
      assert.equal(edited.isError, undefined);
      const result = JSON.parse((edited.content[0] as { text: string }).text);
      assert.equal(result.ok, true);
      assert.equal(result.editsApplied, 1);
      const cancelled = await client.callTool({ name: 'ki_edit_relation', arguments: {
        action: 'cancel', scope: 'edit_mcp', edit_id: result.editId,
      } });
      assert.equal(JSON.parse((cancelled.content[0] as { text: string }).text).status, 'cancelled');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('同批多区域按原快照定位、重叠与越界整次失败', () => {
    const original = 'a\nb\nc\nd\ne';
    const edited = draftModule.applyLineEdits(original, [
      { start_line: 2, end_line: 2, new_text: 'B\nB2' },
      { start_line: 4, end_line: 4, new_text: 'D' },
    ]);
    assert.equal(edited.content, 'a\nB\nB2\nc\nD\ne');
    assert.throws(() => draftModule.applyLineEdits(original, [
      { start_line: 2, end_line: 3, new_text: 'X' },
      { start_line: 3, end_line: 4, new_text: 'Y' },
    ]), /重叠/);
    assert.throws(() => draftModule.applyLineEdits(original, [
      { start_line: 6, end_line: 6, new_text: 'X' },
    ]), /越界/);
  });

  it('删除到文末保留单个结尾换行，多轮删尾不累积悬挂空行', () => {
    // 中间删除：保留上一行换行，下一行顶上。
    assert.equal(
      draftModule.applyLineEdits('a\nb\nc\nd', [{ start_line: 2, end_line: 2, new_text: '' }]).content,
      'a\nc\nd',
    );
    // 删除到文末（无尾换行）：截断到上一行并补单个换行，避免与上一行粘连。
    assert.equal(
      draftModule.applyLineEdits('a\nb\nc\nd', [{ start_line: 3, end_line: 4, new_text: '' }]).content,
      'a\nb\n',
    );
    // 删除到文末（有尾换行）：同样归一化为单个结尾换行。
    assert.equal(
      draftModule.applyLineEdits('a\nb\nc\n', [{ start_line: 2, end_line: 3, new_text: '' }]).content,
      'a\n',
    );
    // 多轮删尾：结果稳定，不逐轮累积空行。
    const first = draftModule.applyLineEdits('a\nb\nc\nd', [{ start_line: 4, end_line: 4, new_text: '' }]).content;
    const second = draftModule.applyLineEdits(first, [{ start_line: 3, end_line: 3, new_text: '' }]).content;
    assert.equal(second, 'a\nb\n');
    // 从首行删到文末会被"正文不能为空"拒绝。
    assert.throws(
      () => draftModule.applyLineEdits('only', [{ start_line: 1, end_line: 1, new_text: '' }]),
      /不能为空/,
    );
  });

  it('多轮草稿不写正式 KB/索引，finish 后 FTS-only 只写最终版本', async () => {
    const scope = 'edit_fts';
    seed(scope, 'A', 'one\ntwo\nthree\nfour', 'fts');
    const fetched = await getModuleInfo.executeGetModuleInfo({ scope, group: 'Docs', relation: 'A' });
    assert.equal(fetched.ok, true);
    if (!fetched.ok) return;
    assert.equal(fetched.revision, draftModule.contentRevision(fetched.content));
    const first = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'A',
      expectedRevision: fetched.revision, edits: [
        { start_line: 1, end_line: 1, new_text: 'ONE' },
        { start_line: 4, end_line: 4, new_text: 'FOUR' },
      ] });
    assert.equal(first.ok, true);
    const second = await edit.executeEditRelationLocal({ action: 'edit', scope, editId: first.editId as string,
      expectedRevision: first.revision as string,
      edits: [{ start_line: 2, end_line: 2, new_text: 'TWO' }] });
    assert.equal(second.ok, true);
    assert.equal(store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))?.A,
      'one\ntwo\nthree\nfour');
    assert.equal(denseWrites.length, 0);
    assert.equal(ftsWrites.length, 0);
    const stale = await edit.executeEditRelationLocal({ action: 'edit', scope, editId: first.editId as string,
      expectedRevision: first.revision as string, edits: [{ start_line: 3, end_line: 3, new_text: 'x' }] });
    assert.equal(stale.ok, false);
    const queued = await edit.executeEditRelationLocal({ action: 'finish', scope, editId: first.editId as string,
      expectedRevision: second.revision as string, requestId: 'finish-A' });
    assert.equal(queued.status, 'queued');
    const final = await waitForStatus(scope, first.editId as string, 'published');
    assert.equal(final.content, 'ONE\nTWO\nthree\nFOUR');
    assert.equal(ftsWrites.length, 1);
    assert.equal(ftsWrites[0][0].text, final.content);
    assert.equal(ftsDeletes.length, 1);
    assert.equal(store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))?.A, final.content);
  });

  it('dense 写入不完整保留旧正式版和旧 ID，同 request_id 可重试', async () => {
    const scope = 'edit_dense_retry';
    seed(scope, 'B', 'old\nbody', 'dense');
    const revision = draftModule.contentRevision('old\nbody');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'B',
      expectedRevision: revision, edits: [{ start_line: 2, end_line: 2, new_text: 'new body' }] });
    assert.equal(created.ok, true);
    failDense = true;
    const queued = await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'retry-B' });
    assert.equal(queued.status, 'queued');
    await waitForStatus(scope, created.editId as string, 'failed');
    assert.equal(store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))?.B, 'old\nbody');
    assert.equal(denseDeletes.length, 0);
    failDense = false;
    const retry = await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'retry-B' });
    assert.equal(retry.status, 'queued');
    await waitForStatus(scope, created.editId as string, 'published');
    assert.equal(store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))?.B, 'old\nnew body');
    assert.ok(denseDeletes.some((ids) => ids.includes('old-dense-B')));
  });

  it('导入的 FTS 文档保持 chunk、sourcePath 和 locator，不把全文压成单条', async () => {
    const scope = 'edit_imported_fts';
    const oldContent = `${'段落一 内容。'.repeat(100)}\n${'段落二 内容。'.repeat(100)}`;
    seed(scope, 'Imported', oldContent, 'fts', { sourcePath: 'wiki/Imported.md', tags: ['api'] });
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'Imported',
      expectedRevision: draftModule.contentRevision(oldContent),
      edits: [{ start_line: 2, end_line: 2, new_text: `${'更新 内容。'.repeat(100)}` }] });
    assert.equal(created.ok, true);
    const before = ftsWrites.length;
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'imported-fts' });
    await waitForStatus(scope, created.editId as string, 'published');
    assert.equal(ftsWrites.length, before + 1);
    assert.ok(ftsWrites.at(-1)!.length > 2, '多个 chunk 各有默认与 api 全文索引');
    const cache = store.readJson<any>(scopePath.getRelationsCachePath(scope))!;
    const rel = cache.groups.Docs.hot_relations.find((item: any) => item.text === 'Imported');
    assert.equal(rel.sourcePath, 'wiki/Imported.md');
    assert.deepEqual(rel.tags, ['api']);
    assert.ok(rel.ftsIds.length > 2);
    assert.ok(rel.ftsLocators.length > 0);
    assert.ok(rel.editChunkCount > 1);
  });

  it('导入的 dense 文档按 chunk 写新向量并保留 sourcePath 与标签', async () => {
    const scope = 'edit_imported_dense';
    const oldContent = `${'alpha '.repeat(180)}\n${'beta '.repeat(180)}`;
    seed(scope, 'Chunked', oldContent, 'dense', { sourcePath: 'Chunked.md', tags: ['api'] });
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'Chunked',
      expectedRevision: draftModule.contentRevision(oldContent),
      edits: [{ start_line: 2, end_line: 2, new_text: 'gamma '.repeat(180) }] });
    const before = denseWrites.length;
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'imported-dense' });
    await waitForStatus(scope, created.editId as string, 'published');
    assert.equal(denseWrites.length, before + 1);
    assert.ok(denseWrites.at(-1)!.entries.filter((item) => item.tags === 'ki-search').length > 1);
    assert.ok(denseWrites.at(-1)!.entries.some((item) => item.tags === 'api'));
    const cache = store.readJson<any>(scopePath.getRelationsCachePath(scope))!;
    const rel = cache.groups.Docs.hot_relations.find((item: any) => item.text === 'Chunked');
    assert.equal(rel.sourcePath, 'Chunked.md');
    assert.deepEqual(rel.tags, ['api']);
    assert.ok(rel.memoryIds.length > 2);
    assert.ok(rel.editChunkCount > 1);
  });

  it('FTS 已完整但残留旧 dense ID 时沿用 FTS 模式并清理残留', async () => {
    const scope = 'edit_fts_with_dense_residue';
    seed(scope, 'Mixed', 'old text', 'fts');
    const cache = store.readJson<any>(scopePath.getRelationsCachePath(scope))!;
    const rel = cache.groups.Docs.hot_relations[0];
    rel.memoryId = 'leftover-dense';
    rel.memoryIds = ['leftover-dense'];
    store.writeJson(scopePath.getRelationsCachePath(scope), cache);
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'Mixed',
      expectedRevision: draftModule.contentRevision('old text'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'new text' }] });
    const before = ftsWrites.length;
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'mixed-fts' });
    await waitForStatus(scope, created.editId as string, 'published');
    assert.equal(ftsWrites.length, before + 1);
    assert.ok(denseDeletes.some((ids) => ids.includes('leftover-dense')));
  });

  it('清理旧 ID 时保留其他 Relation 共用的向量', async () => {
    const scope = 'edit_shared_id';
    seed(scope, 'C', 'shared\nold', 'dense');
    seed(scope, 'D', 'another', 'dense');
    const cache = store.readJson<any>(scopePath.getRelationsCachePath(scope))!;
    cache.groups.Docs.hot_relations.find((item: any) => item.text === 'D').memoryIds = ['old-dense-C'];
    cache.groups.Docs.hot_relations.find((item: any) => item.text === 'D').memoryId = 'old-dense-C';
    store.writeJson(scopePath.getRelationsCachePath(scope), cache);
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'C',
      expectedRevision: draftModule.contentRevision('shared\nold'),
      edits: [{ start_line: 2, end_line: 2, new_text: 'new' }] });
    assert.equal(created.ok, true);
    const before = denseDeletes.length;
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'shared-C' });
    await waitForStatus(scope, created.editId as string, 'published');
    assert.ok(denseDeletes.slice(before).every((ids) => !ids.includes('old-dense-C')));
  });

  it('旧向量删除失败后保持已发布正文，同 request_id 重试只执行清理', async () => {
    const scope = 'edit_cleanup_retry';
    seed(scope, 'E', 'before', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'E',
      expectedRevision: draftModule.contentRevision('before'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'after' }] });
    assert.equal(created.ok, true);
    failedDenseDeletes = new Set(['old-dense-E']);
    const writesBefore = denseWrites.length;
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'cleanup-E' });
    const failed = await waitForStatus(scope, created.editId as string, 'failed');
    assert.match(failed.error ?? '', /mock cleanup failure/);
    assert.equal(store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))?.E, 'after');
    assert.ok(draftModule.hiddenEditIndexIds(scope).has('old-dense-E'));
    failedDenseDeletes = new Set();
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'cleanup-E' });
    await waitForStatus(scope, created.editId as string, 'published');
    assert.equal(denseWrites.length, writesBefore + 1, '清理重试不应再次 embedding');
  });

  it('清理失败后目标再次覆盖，重试不删当前 ID，也不把旧草稿写回 Wiki', async () => {
    const scope = 'edit_cleanup_after_sync';
    seed(scope, 'Overwritten', 'old body', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'Overwritten',
      expectedRevision: draftModule.contentRevision('old body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'edited body' }] });
    failedDenseDeletes = new Set(['old-dense-Overwritten']);
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'overwritten-cleanup' });
    await waitForStatus(scope, created.editId as string, 'failed');
    const kb = store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))!;
    kb.Overwritten = 'old body';
    store.writeJson(scopePath.getLocalKbDir(scope, 'Docs'), kb);
    const cache = store.readJson<any>(scopePath.getRelationsCachePath(scope))!;
    cache.groups.Docs.hot_relations[0].memoryIds = ['old-dense-Overwritten'];
    cache.groups.Docs.hot_relations[0].memoryId = 'old-dense-Overwritten';
    store.writeJson(scopePath.getRelationsCachePath(scope), cache);
    failedDenseDeletes = new Set();
    const deletedBefore = denseDeletes.length;
    const wikiBefore = wikiWrites.length;
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'overwritten-cleanup' });
    await waitForStatus(scope, created.editId as string, 'published');
    assert.ok(denseDeletes.slice(deletedBefore).flat().every((id) => id !== 'old-dense-Overwritten'));
    assert.equal(wikiWrites.length, wikiBefore);
    assert.equal(store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))?.Overwritten, 'old body');
  });

  it('正式正文被其他写入口修改后拒绝发布，未产生新索引', async () => {
    const scope = 'edit_conflict';
    seed(scope, 'F', 'first', 'fts');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'F',
      expectedRevision: draftModule.contentRevision('first'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'draft' }] });
    const kb = store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))!;
    kb.F = 'written elsewhere';
    store.writeJson(scopePath.getLocalKbDir(scope, 'Docs'), kb);
    const before = ftsWrites.length;
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'conflict-F' });
    const failed = await waitForStatus(scope, created.editId as string, 'failed');
    assert.match(failed.error ?? '', /已变化/);
    assert.equal(ftsWrites.length, before);
    // 确定性失败应标记 retryable=false，并拒绝再次 finish（避免按提示空转重试）。
    const viewed = await edit.executeEditRelationLocal({ action: 'view', scope, editId: created.editId as string });
    assert.equal(viewed.retryable, false);
    const retried = await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'conflict-F' });
    assert.equal(retried.ok, false);
    assert.match(String(retried.error), /不可重试/);
    const cancelled = await edit.executeEditRelationLocal({ action: 'cancel', scope, editId: created.editId as string });
    assert.equal(cancelled.status, 'cancelled');
  });

  it('索引写入期间 Relation 标签变化时拒绝发布旧计划', async () => {
    const scope = 'edit_metadata_conflict';
    seed(scope, 'TagChange', 'old body', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'TagChange',
      expectedRevision: draftModule.contentRevision('old body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'new body' }] });
    afterDenseWrite = () => {
      const cache = store.readJson<any>(scopePath.getRelationsCachePath(scope))!;
      cache.groups.Docs.hot_relations[0].tags = ['new-tag'];
      store.writeJson(scopePath.getRelationsCachePath(scope), cache);
      afterDenseWrite = undefined;
    };
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'metadata-conflict' });
    const failed = await waitForStatus(scope, created.editId as string, 'failed');
    assert.match(failed.error ?? '', /标签、来源或索引模式/);
    assert.equal(store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))?.TagChange, 'old body');
  });

  it('进程中断在 KB 与 cache 两次写入之间时恢复旧正文', async () => {
    const scope = 'edit_interrupted_publish';
    seed(scope, 'G', 'old body', 'fts');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'G',
      expectedRevision: draftModule.contentRevision('old body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'new body' }] });
    const draft = draftModule.loadDraft(scope, created.editId as string);
    draft.newFtsIds = ['staged-new-id'];
    draft.status = 'failed';
    draftModule.saveDraft(draft);
    const kb = store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))!;
    kb.G = 'new body';
    store.writeJson(scopePath.getLocalKbDir(scope, 'Docs'), kb);
    const { recoverInterruptedPublication } = await import('../src/lib/relation-edit-publish.js');
    assert.equal(recoverInterruptedPublication(draft), true);
    assert.equal(store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))?.G, 'old body');
  });

  it('进程中断在 cache 发布后、草稿确认前时重试只清理旧 ID', async () => {
    const scope = 'edit_cache_before_draft';
    seed(scope, 'Crash', 'old body', 'fts');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'Crash',
      expectedRevision: draftModule.contentRevision('old body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'new body' }] });
    const draft = draftModule.loadDraft(scope, created.editId as string);
    const newId = ftsClient.getFtsDocId({ scope, group: 'Docs', relation: 'Crash', tag: 'ki-search', text: 'new body' });
    const oldId = ftsClient.getFtsDocId({ scope, group: 'Docs', relation: 'Crash', tag: 'ki-search', text: 'old body' });
    draft.newFtsIds = [newId];
    draft.oldFtsIds = [oldId];
    draft.status = 'running';
    draftModule.saveDraft(draft);
    const kb = store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))!;
    kb.Crash = 'new body';
    store.writeJson(scopePath.getLocalKbDir(scope, 'Docs'), kb);
    const cache = store.readJson<any>(scopePath.getRelationsCachePath(scope))!;
    cache.groups.Docs.hot_relations[0].ftsIds = [newId];
    store.writeJson(scopePath.getRelationsCachePath(scope), cache);
    const interrupted = await edit.executeEditRelationLocal({ action: 'view', scope, editId: created.editId as string });
    assert.equal(interrupted.status, 'failed');
    assert.equal(draftModule.loadDraft(scope, created.editId as string).publishedRevision, created.revision);
    const cancelled = await edit.executeEditRelationLocal({ action: 'cancel', scope, editId: created.editId as string });
    assert.equal(cancelled.ok, false, '已发布 cache 的草稿不能取消并遗失清理清单');
    const writesBefore = ftsWrites.length;
    const deletedBefore = ftsDeletes.length;
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'crash-cache' });
    await waitForStatus(scope, created.editId as string, 'published');
    assert.equal(ftsWrites.length, writesBefore, '已发布的新 ID 不应再次写入');
    assert.ok(ftsDeletes.slice(deletedBefore).flat().includes(oldId));
  });

  it('失败草稿 cancel 清理本次新 ID，保留旧正式正文', async () => {
    const scope = 'edit_cancel_failed';
    seed(scope, 'H', 'old body', 'dense', { tags: ['api'] });
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'H',
      expectedRevision: draftModule.contentRevision('old body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'new body' }] });
    failDense = true;
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'cancel-H' });
    await waitForStatus(scope, created.editId as string, 'failed');
    failDense = false;
    const before = denseDeletes.length;
    const cancelled = await edit.executeEditRelationLocal({ action: 'cancel', scope, editId: created.editId as string });
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(denseDeletes.slice(before).flat().some((id) => id !== 'old-dense-H'));
    assert.ok(denseDeletes.slice(before).flat().every((id) => id !== 'old-dense-H'));
    assert.equal(store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))?.H, 'old body');
  });

  it('草稿写入前已有的向量不会被隐藏或在取消时误删', async () => {
    const scope = 'edit_preexisting_vector';
    seed(scope, 'I', 'old body', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'I',
      expectedRevision: draftModule.contentRevision('old body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'new body' }] });
    const { generateDocId } = await import('../src/lib/vector-client.js');
    const existingId = generateDocId('new body', scope, 'ki-search');
    preexistingDenseIds = new Set([existingId]);
    failDense = true;
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'existing-I' });
    await waitForStatus(scope, created.editId as string, 'failed');
    assert.equal(draftModule.hiddenEditIndexIds(scope).has(existingId), false);
    assert.ok(denseWrites.at(-1)!.entries.every((entry) => entry.text !== 'new body'));
    const queuedDraft = draftModule.loadDraft(scope, created.editId as string);
    const stagedId = queuedDraft.newDenseIds!.find((id) => id !== existingId)!;
    assert.equal(draftModule.hiddenEditIndexIds(scope).has(stagedId), true);
    queuedDraft.status = 'queued';
    draftModule.saveDraft(queuedDraft);
    assert.equal(draftModule.hiddenEditIndexIds(scope).has(stagedId), true, '重试排队期间也必须隐藏暂存 ID');
    queuedDraft.status = 'failed';
    draftModule.saveDraft(queuedDraft);
    const before = denseDeletes.length;
    const cancelled = await edit.executeEditRelationLocal({ action: 'cancel', scope, editId: created.editId as string });
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(denseDeletes.slice(before).flat().every((id) => id !== existingId));
    preexistingDenseIds = new Set();
    failDense = false;
  });

  it('正文已发布但登记为不可重试失败时，finish 仍可收口清理旧索引（不再与 cancel 互相拒绝）', async () => {
    const scope = 'edit_published_nonretryable';
    seed(scope, 'K', 'old body', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'K',
      expectedRevision: draftModule.contentRevision('old body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'edited body' }] });
    // 索引写入期间外部入口写入同一正文 → 确定性失败；草稿的新 ID 在写入前已登记。
    afterDenseWrite = () => {
      const kb = store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))!;
      kb.K = 'edited body';
      store.writeJson(scopePath.getLocalKbDir(scope, 'Docs'), kb);
      afterDenseWrite = undefined;
    };
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'published-K' });
    const failed = await waitForStatus(scope, created.editId as string, 'failed');
    assert.equal(failed.retryable, false);
    const draft = draftModule.loadDraft(scope, created.editId as string);
    assert.ok(draft.newDenseContentIds?.length);
    // 外部入口以同正文重写 → cache 指向草稿登记的新 ID → recognize 判定成立（正文已生效）
    const cache = store.readJson<any>(scopePath.getRelationsCachePath(scope))!;
    cache.groups.Docs.hot_relations[0].memoryIds = draft.newDenseContentIds;
    cache.groups.Docs.hot_relations[0].memoryId = draft.newDenseContentIds![0];
    store.writeJson(scopePath.getRelationsCachePath(scope), cache);

    const cancel = await edit.executeEditRelationLocal({ action: 'cancel', scope, editId: created.editId as string });
    assert.equal(cancel.ok, false);
    assert.match(String(cancel.error), /正文已经发布/);
    const viewed = await edit.executeEditRelationLocal({ action: 'view', scope, editId: created.editId as string });
    assert.equal(viewed.published, true, 'view 必须暴露"正文已生效"供调用方选择 finish');

    const before = denseDeletes.length;
    const retried = await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'published-K' });
    assert.equal(retried.ok, true, `已发布草稿必须能 finish 收口：${JSON.stringify(retried)}`);
    await waitForStatus(scope, created.editId as string, 'published');
    assert.ok(denseDeletes.slice(before).flat().includes('old-dense-K'), '必须完成旧索引清理');
    assert.equal(draftModule.hiddenEditIndexIds(scope).has('old-dense-K'), false);
  });

  it('chunk 超限属于确定性失败（retryable=false），且仍可取消收口', async () => {
    const scope = 'edit_chunk_limit';
    seed(scope, 'L', 'small body', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'L',
      expectedRevision: draftModule.contentRevision('small body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'x'.repeat(600_000) }] });
    assert.equal(created.ok, true);
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'chunk-limit' });
    const failed = await waitForStatus(scope, created.editId as string, 'failed');
    assert.match(failed.error ?? '', /chunk 数超过/);
    assert.equal(failed.retryable, false, '超限重跑必然再失败，必须标记为不可重试');
    const retried = await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'chunk-limit' });
    assert.equal(retried.ok, false);
    assert.match(String(retried.error), /不可重试/);
    const cancelled = await edit.executeEditRelationLocal({ action: 'cancel', scope, editId: created.editId as string });
    assert.equal(cancelled.status, 'cancelled');
  });

  it('relations-cache 被外部改写后隐藏集立即重算（缓存 key 含 cache 身份）', async () => {
    const scope = 'edit_hidden_cache';
    seed(scope, 'M', 'body', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'M',
      expectedRevision: draftModule.contentRevision('body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'edited body' }] });
    failDense = true;
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'hidden-M' });
    await waitForStatus(scope, created.editId as string, 'failed');
    failDense = false;
    const draft = draftModule.loadDraft(scope, created.editId as string);
    const stagedId = draft.newDenseContentIds![0];
    assert.equal(draftModule.hiddenEditIndexIds(scope).has(stagedId), true, '未发布的新 ID 必须被隐藏');
    // 外部入口（import/sync）以同正文重写 cache 并合法引用该 ID
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cache = store.readJson<any>(scopePath.getRelationsCachePath(scope))!;
    cache.groups.Docs.hot_relations[0].memoryIds = [stagedId];
    cache.groups.Docs.hot_relations[0].memoryId = stagedId;
    store.writeJson(scopePath.getRelationsCachePath(scope), cache);
    assert.equal(draftModule.hiddenEditIndexIds(scope).has(stagedId), false,
      'cache 已引用的 ID 必须立即解除隐藏（不能等草稿文件 mtime 变化）');
  });

  it('存在未结束草稿时拒绝删除该 Relation，取消后可正常删除', async () => {
    const scope = 'edit_delete_guard';
    seed(scope, 'N', 'body', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'N',
      expectedRevision: draftModule.contentRevision('body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'edited body' }] });
    const { executeDeleteRelation } = await import('../src/delete-relation.js');
    const blocked = await executeDeleteRelation({ scope, group: 'Docs', relation: 'N' });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.error, /未结束的编辑草稿/);
    assert.equal(store.readJson<Record<string, string>>(scopePath.getLocalKbDir(scope, 'Docs'))?.N, 'body',
      '被拒绝时不得删除任何数据');
    await edit.executeEditRelationLocal({ action: 'cancel', scope, editId: created.editId as string });
    const deleted = await executeDeleteRelation({ scope, group: 'Docs', relation: 'N' });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    if (deleted.ok) assert.equal(deleted.result.deleted, true);
  });

  it('终态草稿残留在活动目录时不阻断删除（在途仍阻断）', async () => {
    const scope = 'edit_delete_guard_terminal';
    seed(scope, 'O', 'body', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'O',
      expectedRevision: draftModule.contentRevision('body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'edited body' }] });
    const draft = draftModule.loadDraft(scope, created.editId as string);
    const { executeDeleteRelation } = await import('../src/delete-relation.js');

    const blocked = await executeDeleteRelation({ scope, group: 'Docs', relation: 'O' });
    assert.equal(blocked.ok, false, '在途（editing）草稿必须阻断删除');
    if (!blocked.ok) assert.match(blocked.error, /未结束的编辑草稿/);

    // 模拟“归档时 unlink 失败”的历史现场：活动目录里留一份终态副本
    const activePath = draftModule.draftPath(scope, draft.editId);
    draft.status = 'published';
    draft.publishedRevision = draft.revision;
    fs.writeFileSync(activePath, JSON.stringify(draft), 'utf8');
    assert.deepEqual(draftModule.activeDrafts(scope), [], '终态残留不得计为在途草稿');

    const deleted = await executeDeleteRelation({ scope, group: 'Docs', relation: 'O' });
    assert.equal(deleted.ok, true, `终态残留不应阻断删除：${JSON.stringify(deleted)}`);
  });

  it('归档超过保留上限时只裁剪 archive 内最旧条目并告警', async () => {
    const scope = 'edit_archive_retention';
    const keep = draftModule.ARCHIVED_DRAFT_RETENTION;
    const archiveDir = path.join(path.dirname(draftModule.draftPath(scope, '00000000-0000-4000-8000-000000000000')), 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const names: string[] = [];
    for (let i = 0; i <= keep; i += 1) {
      const name = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}.json`;
      const file = path.join(archiveDir, name);
      fs.writeFileSync(file, JSON.stringify({ editId: name.replace(/\.json$/, ''), scope, status: 'published' }), 'utf8');
      const t = new Date(Date.now() - (keep + 1 - i) * 1000); // i 越小越旧
      fs.utimesSync(file, t, t);
      names.push(name);
    }
    // 活动目录放一份哨兵草稿，验证裁剪不碰活动目录
    const sentinel = draftModule.createDraft({ scope, group: 'Docs', relation: 'Sentinel',
      baseRevision: 'r0', baseMetadataRevision: 'm0', baseContent: 'a', content: 'a' });
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return originalWrite(chunk as string, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      const archived = draftModule.createDraft({ scope, group: 'Docs', relation: 'Retention',
        baseRevision: 'r0', baseMetadataRevision: 'm0', baseContent: 'a', content: 'a' });
      archived.status = 'cancelled';
      draftModule.saveDraft(archived); // 归档 → 触发裁剪
    } finally {
      process.stderr.write = originalWrite;
    }

    const remaining = fs.readdirSync(archiveDir).sort();
    assert.equal(remaining.length, keep, '归档数量必须收敛到保留上限');
    assert.ok(!remaining.includes(names[0]), '最旧的归档必须被清理');
    assert.ok(remaining.includes(names[names.length - 1]), '最新的归档必须保留');
    assert.ok(fs.existsSync(draftModule.draftPath(scope, sentinel.editId)), '活动目录草稿不得被裁剪');
    assert.match(captured.join(''), /已清理最旧的 \d+ 条/, `必须显式告警：${captured.join('')}`);
  });

  it('daemon RPC 超时不得低于工具层超时（cancel 走 BULK）', async () => {
    const { editRelationRpcTimeoutMs } = await import('../src/edit-relation.js');
    const { TOOL_TIMEOUT } = await import('../src/lib/mcp-tools/util.js');
    assert.ok(editRelationRpcTimeoutMs('cancel') > TOOL_TIMEOUT.BULK,
      `cancel 的 RPC 超时必须严格大于工具层 ${TOOL_TIMEOUT.BULK}（等值会赛跑），当前 ${editRelationRpcTimeoutMs('cancel')}`);
    for (const action of ['edit', 'view', 'finish'] as const) {
      assert.ok(editRelationRpcTimeoutMs(action) > TOOL_TIMEOUT.WRITE,
        `${action} 的 RPC 超时必须严格大于工具层 ${TOOL_TIMEOUT.WRITE}`);
    }
  });

  it('归档时 unlink 失败不抛错：终态落在 archive 且显式告警', async () => {
    const scope = 'edit_archive_unlink_failure';
    seed(scope, 'P', 'body', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'P',
      expectedRevision: draftModule.contentRevision('body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'edited body' }] });
    const draft = draftModule.loadDraft(scope, created.editId as string);
    // 注入 unlink 失败：把活动路径换成同名目录（unlinkSync 对目录抛 EISDIR/EPERM）。
    // 注：目录形态下 readJson 会抛 EISDIR，故此处只断言“不抛错 + 终态入 archive + 告警 ”，
    // 不经过 loadDraft（活动路径不可读的回落属另一条路径）。
    const activePath = draftModule.draftPath(scope, draft.editId);
    fs.rmSync(activePath, { force: true });
    fs.mkdirSync(activePath);
    draft.status = 'cancelled';
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return originalWrite(chunk as string, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      draftModule.saveDraft(draft); // 旧实现在此抛错并导致调用方失败态覆盖终态
    } finally {
      process.stderr.write = originalWrite;
    }

    const archiveDir = path.join(path.dirname(activePath), 'archive');
    const archivedRaw = fs.readFileSync(path.join(archiveDir, `${draft.editId}.json`), 'utf8');
    assert.equal(JSON.parse(archivedRaw).status, 'cancelled', 'archive 必须是终态');
    assert.match(captured.join(''), /未能删除活动目录副本/);
    assert.deepEqual(draftModule.activeDrafts(scope), [], '残留不得被当作在途草稿');
  });

  it('另一进程发布窗口内的心跳租约阻止 view 回滚正文，过期后才恢复', async () => {
    const scope = 'edit_publish_lease';
    seed(scope, 'Q2', 'old body', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'Q2',
      expectedRevision: draftModule.contentRevision('old body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'edited body' }] });
    const draft = draftModule.loadDraft(scope, created.editId as string);
    // 构造“另一进程发布到一半”的现场：草稿仍在 running 且已登记暂存 ID、KB 已换、cache 未写
    draft.status = 'running';
    draft.newDenseIds = ['staged-lease-1'];
    draft.newDenseContentIds = ['staged-lease-1'];
    draft.oldDenseIds = ['old-dense-Q2'];
    draftModule.saveDraft(draft);
    const kbPath = scopePath.getLocalKbDir(scope, 'Docs');
    const kb = store.readJson<Record<string, string>>(kbPath)!;
    kb.Q2 = draft.content;
    store.writeJson(kbPath, kb);

    // ① 心跳在有效期内：view 必须按“发布中”处理，不得回滚、不得标 failed
    draftModule.beginPublishLease(scope, draft.editId);
    const viewing = await edit.executeEditRelationLocal({ action: 'view', scope, editId: draft.editId });
    assert.equal(viewing.status, 'running', '不得把跨进程发布中的草稿判成中断');
    assert.equal(viewing.publishInFlight, true);
    assert.equal(viewing.error, undefined);
    assert.equal(store.readJson<Record<string, string>>(kbPath)?.Q2, draft.content, 'KB 不得被回滚');

    // ② 心跳过期（发布方崩溃残留）：回到原有恢复逻辑——回滚正文并提示重试 finish
    const leasePath = draftModule.publishLeasePath(scope, draft.editId);
    const stale = new Date(Date.now() - draftModule.PUBLISH_LEASE_GRACE_MS - 5_000);
    fs.utimesSync(leasePath, stale, stale);
    assert.equal(draftModule.isPublishLeaseActive(scope, draft.editId), false);
    const recovered = await edit.executeEditRelationLocal({ action: 'view', scope, editId: draft.editId });
    assert.equal(recovered.status, 'failed');
    assert.match(String(recovered.error), /发布任务已中断/);
    assert.equal(store.readJson<Record<string, string>>(kbPath)?.Q2, 'old body', '过期后应回滚到 baseContent');
    draftModule.endPublishLease(scope, draft.editId);
  });

  it('发布正常结束后心跳被清除，且不会被当作草稿', async () => {
    const scope = 'edit_publish_lease_cleanup';
    seed(scope, 'Q3', 'old body', 'dense');
    const created = await edit.executeEditRelationLocal({ action: 'edit', scope, group: 'Docs', relation: 'Q3',
      expectedRevision: draftModule.contentRevision('old body'),
      edits: [{ start_line: 1, end_line: 1, new_text: 'edited body' }] });
    await edit.executeEditRelationLocal({ action: 'finish', scope, editId: created.editId as string,
      expectedRevision: created.revision as string, requestId: 'lease-Q3' });
    await waitForStatus(scope, created.editId as string, 'published');
    assert.equal(fs.existsSync(draftModule.publishLeasePath(scope, created.editId as string)), false,
      '发布结束必须清除心跳');
    assert.deepEqual(draftModule.activeDrafts(scope), [], '心跳文件不得被当作在途草稿');
  });

  it('混合态索引模式判定：完整 FTS 优先，完整性未知时按 dense', async () => {
    const { relationIndexMode } = await import('../src/lib/relation-edit-live.js');
    const { isFtsOnlyIndexedRelation } = await import('../src/lib/scoring.js');
    const mixed = {
      id: 'rel_x', text: 'R', score: 0, useCount: 0, lastUsedTime: null, isImported: false,
      memoryIds: ['dense-1'], ftsIds: ['fts-1'], ftsIndexComplete: true,
    };
    assert.equal(relationIndexMode(mixed), 'fts', '完整 FTS 索引优先（避免无 apiKey 的 scope 被逼做 embedding）');
    assert.equal(isFtsOnlyIndexedRelation(mixed), false, '展示口径按“已有向量”判（两侧差异见源码注释）');
    assert.equal(relationIndexMode({ ...mixed, ftsIndexComplete: undefined }), 'dense',
      'FTS 完整性未知且有 dense 时按 dense，避免把向量文档误降级成全文');
  });
});
