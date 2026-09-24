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
});
