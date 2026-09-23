/**
 * import-vector-rebuild.test.ts —— 导入增量向量更新契约验证
 *
 * 契约：
 *   - 不再调用 Scope 级全量删除；
 *   - 更新同一 sourcePath 时，新向量写入成功后才删除受影响旧向量；
 *   - 同 Scope 的无关文档向量不被删除；
 *   - 全部新向量写入失败时，旧 KB 与旧 relation 保持不变；
 *   - --no-vector 不触碰向量层。
 *
 * 运行：npx jiti test/import-vector-rebuild.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { getKbDir, getLocalKbDir, getRelationsCachePath } from '../src/lib/scope.js';
import { generateDocId } from '../src/lib/vector-client.js';
import { isFtsOnlyIndexedRelation } from '../src/lib/scoring.js';

const vectorClient = await import('../src/lib/vector-client.js');
const batchVectorize = await import('../src/lib/batch-vectorize.js');
const pathVectorize = await import('../src/lib/path-vectorize.js');
const ftsClient = await import('../src/lib/fts-client.js');

type VectorDeleteCall = { scope: string; ids: string[] };
type VectorBulkEntry = { text: string; tags?: string; group?: string };

let vectorizeMode: 'success' | 'fail' | 'partial' = 'success';
let vectorizeCalls: { paths: string[]; sequence: number }[] = [];
let vectorDeleteCalls: VectorDeleteCall[] = [];
let vectorDeleteFailureIds = new Set<string>();
let vectorEvents: string[] = [];
let vectorizeSequence = 0;
let pathStoreCalls = 0;
let ftsWriteMode: 'success' | 'partial' = 'success';
let ftsDeleteFailureIds = new Set<string>();
let ftsDeleteCalls: string[][] = [];

// 这些 patch 在 import 模块加载前完成，隔离真实 embedding / zvec，只验证导入编排契约。
(vectorClient as any).vectorDelete = async (params: { scope: string; ids: string[] }) => {
  vectorDeleteCalls.push({ scope: params.scope, ids: [...params.ids] });
  vectorEvents.push(`delete:${params.ids.join(',')}`);
  const errors = params.ids.filter((id) => vectorDeleteFailureIds.has(id)).map((id) => ({ id, code: 'ZVEC_WRITE_ERROR', reason: 'mock delete failure' }));
  return { deleted: params.ids.length - errors.length, errors };
};
(vectorClient as any).vectorDeleteScope = async () => {
  throw new Error('不得调用已废弃的 Scope 级向量清空接口');
};
(vectorClient as any).vectorCountScope = async () => {
  throw new Error('不得通过 Scope 向量数量决定局部导入删除范围');
};
(vectorClient as any).vectorBulkStore = async (params: { scope: string; entries: VectorBulkEntry[] }) => {
  const results = params.entries.map((entry, index) => {
    const memoryId = entry.tags === 'ki-relation' || entry.tags === 'ki-path'
      ? generateDocId(entry.text, params.scope, entry.tags)
      : `mock-${entry.tags ?? 'untagged'}-${params.scope}-${index}`;
    return { index, success: true, memoryId };
  });
  return { results };
};
(batchVectorize as any).bulkVectorize = async (entries: { path: string }[]) => {
  const sequence = ++vectorizeSequence;
  vectorizeCalls.push({ paths: entries.map((entry) => entry.path), sequence });
  vectorEvents.push(`write:${sequence}`);
  if (vectorizeMode === 'fail') {
    return {
      ok: new Map<string, string>(),
      errors: entries.map((entry) => ({ path: entry.path, error: 'mock embedding failure' })),
    };
  }
  const ok = new Map<string, string>();
  const errors: { path: string; error: string }[] = [];
  for (const [index, entry] of entries.entries()) {
    if (vectorizeMode === 'partial' && entry.path.includes('bad.md#2')) {
      errors.push({ path: entry.path, error: 'mock partial embedding failure' });
      continue;
    }
    const shared = entry.path.includes('good.md') || entry.path.includes('bad.md#1');
    ok.set(entry.path, shared ? 'shared-content-id' : `content-${sequence}-${index}-${entry.path}`);
  }
  return { ok, errors };
};
(pathVectorize as any).bulkStorePaths = async (entries: { text: string }[]) => {
  pathStoreCalls += entries.length;
  return {
    ok: new Map(entries.map((entry) => [entry.text, `path-${entry.text}`])),
    errors: [],
  };
};

(ftsClient as any).ftsBulkStore = async (entries: { scope: string; group: string; relation: string; tag?: string; text: string }[]) => {
  const ids = entries.map((entry) => ftsClient.getFtsDocId(entry));
  return { ids: ftsWriteMode === 'partial' ? ids.slice(0, Math.max(0, ids.length - 1)) : ids, failed: ftsWriteMode === 'partial' ? 1 : 0 };
};
(ftsClient as any).ftsDeleteByIds = async (params: { scope: string; ids: string[] }) => {
  ftsDeleteCalls.push([...params.ids]);
  const failedIds = params.ids.filter((id) => ftsDeleteFailureIds.has(id));
  return { deleted: params.ids.length - failedIds.length, failed: failedIds.length, failedIds };
};

const { handleDirectImport } = await import('../src/lib/import.js');
const { rebuildFtsOnlyScope } = await import('../src/lib/fts-rebuild.js');
const testScopes = new Set<string>();

function mkSource(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-vr-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function resetMocks(): void {
  vectorizeMode = 'success';
  vectorizeCalls = [];
  vectorDeleteCalls = [];
  vectorDeleteFailureIds = new Set();
  vectorEvents = [];
  vectorizeSequence = 0;
  pathStoreCalls = 0;
  ftsWriteMode = 'success';
  ftsDeleteFailureIds = new Set();
  ftsDeleteCalls = [];
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function newScope(label: string): string {
  const scope = `import-vec-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  registerTestScope(scope);
  testScopes.add(scope);
  return scope;
}

describe('import 增量向量更新', () => {
  before(() => {
    resetMocks();
  });

  after(() => {
    for (const scope of testScopes) {
      const kbDir = getKbDir(scope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
    cleanupTestConfig();
  });

  it('更新同一 sourcePath：先写新向量，再只删除受影响旧向量', async () => {
    const scope = newScope('update');
    const unrelated = mkSource({ 'other.md': '# 无关文档\n\n无关内容。' });
    const original = mkSource({ 'target.md': '# 目标文档\n\n旧内容。' });
    const updated = mkSource({ 'target.md': '# 目标文档\n\n新内容。' });

    const unrelatedResult = await handleDirectImport({ scope, sourceDir: unrelated, group: 'TestWiki', vector: true });
    const originalResult = await handleDirectImport({ scope, sourceDir: original, group: 'TestWiki', vector: true });
    const oldOtherId = `content-${vectorizeCalls[0].sequence}-0-other.md#1`;
    const oldTargetId = `content-${vectorizeCalls[1].sequence}-0-target.md#1`;
    assert.equal(unrelatedResult.ok, true);
    assert.equal(originalResult.ok, true);

    vectorEvents = [];
    const updatedResult = await handleDirectImport({ scope, sourceDir: updated, group: 'TestWiki', vector: true });

    assert.equal(updatedResult.ok, true);
    assert.equal(vectorEvents.findIndex((event) => event.startsWith('write:')), 0, '必须先写入新向量');
    assert.ok(vectorEvents.some((event) => event.includes(oldTargetId)), '必须删除目标文档旧向量');
    assert.ok(!vectorEvents.some((event) => event.includes(oldOtherId)), '不得删除无关文档向量');
    assert.equal(pathStoreCalls > 0, true, '应写入受影响文档的辅助路径向量');
    assert.equal(vectorDeleteCalls.some((call) => call.ids.includes(oldOtherId)), false);

    fs.rmSync(unrelated, { recursive: true, force: true });
    fs.rmSync(original, { recursive: true, force: true });
    fs.rmSync(updated, { recursive: true, force: true });
  });

  it('全部新向量写入失败：旧 KB、旧 relation 与旧向量保持可用', async () => {
    const scope = newScope('rollback');
    const original = mkSource({ 'same.md': '# 原文\n\n旧版本。' });
    const updated = mkSource({ 'same.md': '# 原文\n\n新版本。' });

    const first = await handleDirectImport({ scope, sourceDir: original, group: 'TestWiki', vector: true });
    const oldRelationCache = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; memoryIds?: string[] }[] }> }>(getRelationsCachePath(scope));
    const oldRelation = oldRelationCache.groups.TestWiki.hot_relations.find((relation) => relation.text === 'same');
    assert.ok(oldRelation?.memoryIds?.length);
    const oldLocalText = readJsonFile<Record<string, string>>(getLocalKbDir(scope, 'TestWiki')).same;
    const oldDeleteCount = vectorDeleteCalls.length;

    vectorizeMode = 'fail';
    await assert.rejects(
      () => handleDirectImport({ scope, sourceDir: updated, group: 'TestWiki', vector: true }),
      /均未完成向量化/,
    );

    const afterCache = readJsonFile<typeof oldRelationCache>(getRelationsCachePath(scope));
    const afterRelation = afterCache.groups.TestWiki.hot_relations.find((relation) => relation.text === 'same');
    assert.deepEqual(afterRelation?.memoryIds, oldRelation?.memoryIds);
    assert.equal(readJsonFile<Record<string, string>>(getLocalKbDir(scope, 'TestWiki')).same, oldLocalText);
    assert.equal(vectorDeleteCalls.length, oldDeleteCount, '失败保护阶段不得删除旧向量');
    assert.equal(first.stats.vectorized > 0, true);

    fs.rmSync(original, { recursive: true, force: true });
    fs.rmSync(updated, { recursive: true, force: true });
  });

  it('部分失败且新 docId 被多个文件共享：回滚失败文件时不删除成功文件仍使用的 ID', async () => {
    const scope = newScope('shared-id');
    const src = mkSource({
      'bad.md': `${'A'.repeat(900)}${'B'.repeat(1000)}`,
      'good.md': 'A'.repeat(900),
    });
    vectorizeMode = 'partial';

    const result = await handleDirectImport({ scope, sourceDir: src, group: 'TestWiki', vector: true });

    assert.equal(result.ok, true);
    assert.equal(result.stats.skipped, 1);
    assert.equal(result.stats.vectorized, 1);
    assert.equal(vectorDeleteCalls.some((call) => call.ids.includes('shared-content-id')), false);
    fs.rmSync(src, { recursive: true, force: true });
  });

  it('--no-vector 不触碰向量层', async () => {
    const scope = newScope('no-vector');
    const src = mkSource({ 'kb-only.md': '# 纯 KB 文档\n\n不写向量。' });
    const beforeWrites = vectorizeCalls.length;
    const beforeDeletes = vectorDeleteCalls.length;

    const result = await handleDirectImport({ scope, sourceDir: src, group: 'TestWiki', vector: false });

    assert.equal(result.ok, true);
    assert.equal(vectorizeCalls.length, beforeWrites);
    assert.equal(vectorDeleteCalls.length, beforeDeletes);
    fs.rmSync(src, { recursive: true, force: true });
  });

  it('从 FTS-only 覆盖切换到 dense 后清除 FTS-only 状态', async () => {
    const scope = newScope('fts-to-dense');
    const src = mkSource({ 'switch.md': '# 切换文档\n\n先全文索引，再写入 dense。' });
    const ftsImport = await handleDirectImport({ scope, sourceDir: src, group: 'TestWiki', vector: false });
    assert.equal(ftsImport.ok, true);
    const before = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; ftsIds?: string[]; ftsIndexComplete?: boolean }[] }> }>(getRelationsCachePath(scope));
    const beforeRelation = before.groups.TestWiki.hot_relations.find((relation) => relation.text === 'switch');
    assert.equal(beforeRelation?.ftsIndexComplete, true);
    assert.ok(beforeRelation?.ftsIds?.length);
    const priorFtsIds = [...beforeRelation!.ftsIds!];
    ftsDeleteCalls = [];

    const denseImport = await handleDirectImport({ scope, sourceDir: src, group: 'TestWiki', vector: true });
    assert.equal(denseImport.ok, true);
    const after = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; memoryIds?: string[]; ftsIds?: string[]; ftsIndexComplete?: boolean }[] }> }>(getRelationsCachePath(scope));
    const afterRelation = after.groups.TestWiki.hot_relations.find((relation) => relation.text === 'switch');
    assert.ok(afterRelation?.memoryIds?.length);
    assert.deepEqual(afterRelation?.ftsIds, [], 'dense 切换后旧 FTS-only ID 应清空');
    assert.equal(afterRelation?.ftsIndexComplete, undefined, 'dense relation 不保留 FTS-only 完整状态');
    assert.ok(ftsDeleteCalls.some((ids) => priorFtsIds.every((id) => ids.includes(id))), '切换 dense 时应删除旧 FTS 文档');

    const { closeFtsEngine } = await import('../src/lib/fts-client.js');
    await closeFtsEngine(scope);
    fs.rmSync(src, { recursive: true, force: true });
  });

  it('从 dense 覆盖切换到 FTS-only 后删除旧 dense 内容与路径向量', async () => {
    const scope = newScope('dense-to-fts');
    const original = mkSource({ 'switch.md': '# 切换文档\n\n旧 dense 正文。' });
    const updated = mkSource({ 'switch.md': '# 切换文档\n\n新 FTS 正文。' });
    const denseImport = await handleDirectImport({ scope, sourceDir: original, group: 'TestWiki', vector: true });
    assert.equal(denseImport.ok, true);
    const before = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; memoryIds?: string[] }[] }> }>(getRelationsCachePath(scope));
    const oldIds = [...before.groups.TestWiki.hot_relations.find((relation) => relation.text === 'switch')!.memoryIds!];
    vectorDeleteCalls = [];

    const ftsImport = await handleDirectImport({ scope, sourceDir: updated, group: 'TestWiki', vector: false });
    assert.equal(ftsImport.ok, true);
    assert.ok(vectorDeleteCalls.some((call) => oldIds.every((id) => call.ids.includes(id))), 'FTS 完整写入后应清理旧 dense 内容 ID');
    const after = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; memoryId?: string; memoryIds?: string[]; ftsIds?: string[]; ftsIndexComplete?: boolean }[] }> }>(getRelationsCachePath(scope));
    const relation = after.groups.TestWiki.hot_relations.find((item) => item.text === 'switch');
    assert.deepEqual(relation?.memoryIds, []);
    assert.equal(relation?.memoryId, undefined);
    assert.ok(relation?.ftsIds?.length);
    assert.equal(relation?.ftsIndexComplete, true);
    fs.rmSync(original, { recursive: true, force: true });
    fs.rmSync(updated, { recursive: true, force: true });
  });

  it('dense 删除失败时保留旧 IDs，不能把混合索引误显示为 FTS-only', async () => {
    const scope = newScope('dense-to-fts-delete-fail');
    const original = mkSource({ 'switch.md': '# 切换文档\n\n旧 dense 正文。' });
    const updated = mkSource({ 'switch.md': '# 切换文档\n\n新 FTS 正文。' });
    await handleDirectImport({ scope, sourceDir: original, group: 'TestWiki', vector: true });
    const before = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; memoryIds?: string[] }[] }> }>(getRelationsCachePath(scope));
    const oldIds = [...before.groups.TestWiki.hot_relations.find((relation) => relation.text === 'switch')!.memoryIds!];
    vectorDeleteFailureIds = new Set(oldIds);

    const result = await handleDirectImport({ scope, sourceDir: updated, group: 'TestWiki', vector: false });
    assert.equal(result.ok, true);
    const after = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; memoryIds?: string[]; ftsIds?: string[]; ftsIndexComplete?: boolean }[] }> }>(getRelationsCachePath(scope));
    const relation = after.groups.TestWiki.hot_relations.find((item) => item.text === 'switch');
    assert.deepEqual(relation?.memoryIds, oldIds, '未删除的 dense IDs 必须保留以便后续清理');
    assert.equal(relation?.ftsIndexComplete, true, 'FTS 内容自身完整，但混合索引不应被状态 helper 误识别为 FTS-only');
    assert.equal(isFtsOnlyIndexedRelation(relation!), false);
    fs.rmSync(original, { recursive: true, force: true });
    fs.rmSync(updated, { recursive: true, force: true });
    vectorDeleteFailureIds = new Set();
  });

  it('旧 FTS ID 清理失败时保留失败 ID 并标记未完成', async () => {
    const scope = newScope('fts-delete-fail');
    const original = mkSource({ 'same.md': '# 文档\n\n旧 FTS 内容。' });
    const updated = mkSource({ 'same.md': '# 文档\n\n替换后的 FTS 内容。' });
    await handleDirectImport({ scope, sourceDir: original, group: 'TestWiki', vector: false });
    const before = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; ftsIds?: string[] }[] }> }>(getRelationsCachePath(scope));
    const oldIds = [...before.groups.TestWiki.hot_relations.find((relation) => relation.text === 'same')!.ftsIds!];
    ftsDeleteFailureIds = new Set(oldIds);

    const result = await handleDirectImport({ scope, sourceDir: updated, group: 'TestWiki', vector: false });
    assert.equal(result.ok, true);
    const after = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; ftsIds?: string[]; ftsIndexComplete?: boolean }[] }> }>(getRelationsCachePath(scope));
    const relation = after.groups.TestWiki.hot_relations.find((item) => item.text === 'same');
    assert.equal(relation?.ftsIndexComplete, false);
    assert.ok(oldIds.every((id) => relation?.ftsIds?.includes(id)), '删除失败的旧 FTS IDs 必须继续可追踪');
    assert.ok(relation?.ftsIds?.some((id) => !oldIds.includes(id)), '新 FTS IDs 也必须登记');
    fs.rmSync(original, { recursive: true, force: true });
    fs.rmSync(updated, { recursive: true, force: true });
    ftsDeleteFailureIds = new Set();
  });

  it('同批 FTS 部分写入不宣称完整，并保留已写入 ID', async () => {
    const scope = newScope('fts-partial-write');
    const src = mkSource({ 'partial.md': '# 部分写入\n\n正文。' });
    ftsWriteMode = 'partial';
    const result = await handleDirectImport({ scope, sourceDir: src, group: 'TestWiki', vector: false, tags: 'api' });
    assert.equal(result.ok, true);
    const cache = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; ftsIds?: string[]; ftsIndexComplete?: boolean }[] }> }>(getRelationsCachePath(scope));
    const relation = cache.groups.TestWiki.hot_relations.find((item) => item.text === 'partial');
    assert.equal(relation?.ftsIndexComplete, false);
    assert.equal(relation?.ftsIds?.length, 1, '部分写入成功的 ID 仍应登记，供后续清理/重建');
    ftsWriteMode = 'success';
    fs.rmSync(src, { recursive: true, force: true });
  });

  it('FTS 重建清理旧 ID 失败时保留残留 ID 与 incomplete 状态', async () => {
    const scope = newScope('rebuild-fts-delete-fail');
    const { initScope } = await import('../src/lib/store.js');
    try {
      initScope(scope);
      const cachePath = getRelationsCachePath(scope);
      const cache = readJsonFile<any>(cachePath);
      cache.groups.TestWiki = {
        hot_relations: [{
          id: 'rel_rebuild_fts',
          text: 'rebuild-me',
          score: 0,
          useCount: 0,
          lastUsedTime: null,
          isImported: true,
          memoryIds: [],
          ftsIds: ['old-rebuild-fts-id'],
          ftsIndexComplete: true,
        }],
        keywords: [],
      };
      fs.writeFileSync(cachePath, JSON.stringify(cache));
      const localKbPath = getLocalKbDir(scope, 'TestWiki');
      fs.mkdirSync(path.dirname(localKbPath), { recursive: true });
      fs.writeFileSync(localKbPath, JSON.stringify({ 'rebuild-me': 'Rebuilt FTS source text.' }));
      ftsDeleteFailureIds = new Set(['old-rebuild-fts-id']);

      const result = await rebuildFtsOnlyScope(scope, 'TestWiki');
      assert.equal(result.errors.length, 1);
      const updated = readJsonFile<any>(cachePath).groups.TestWiki.hot_relations[0];
      assert.equal(updated.ftsIndexComplete, false);
      assert.ok(updated.ftsIds.includes('old-rebuild-fts-id'));
      assert.ok(updated.ftsIds.some((id: string) => id !== 'old-rebuild-fts-id'));
    } finally {
      ftsDeleteFailureIds = new Set();
      const { getKbDir } = await import('../src/lib/scope.js');
      const kbDir = getKbDir(scope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });

  it('扫描开始后立即取消时不改变未覆盖文档的原文与旧 FTS 状态', async () => {
    const scope = newScope('cancel-before-write');
    const original = mkSource({ 'same.md': '# 原文\n\n旧内容。' });
    const updated = mkSource({ 'same.md': '# 新原文\n\n新内容。' });
    await handleDirectImport({ scope, sourceDir: original, group: 'TestWiki', vector: false });
    const abort = new AbortController();

    await assert.rejects(
      () => handleDirectImport({
        scope,
        sourceDir: updated,
        group: 'TestWiki',
        vector: false,
        abortSignal: abort.signal,
        onProgress: (progress) => {
          if (progress.phase === 'scan' && progress.done === 0) abort.abort();
        },
      }),
      /导入已取消/,
    );
    const after = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; ftsIndexComplete?: boolean }[] }> }>(getRelationsCachePath(scope));
    assert.equal(after.groups.TestWiki.hot_relations.find((item) => item.text === 'same')?.ftsIndexComplete, true);
    assert.match(readJsonFile<Record<string, string>>(getLocalKbDir(scope, 'TestWiki')).same, /旧内容/);
    fs.rmSync(original, { recursive: true, force: true });
    fs.rmSync(updated, { recursive: true, force: true });
  });

  it('dense 覆盖失败并回滚原文时恢复旧 FTS 完整状态', async () => {
    const scope = newScope('fts-dense-rollback');
    const src = mkSource({ 'rollback.md': '# 原文\n\n旧 FTS 正文' });
    const original = await handleDirectImport({ scope, sourceDir: src, group: 'TestWiki', vector: false });
    assert.equal(original.ok, true);
    const before = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; ftsIds?: string[]; ftsIndexComplete?: boolean }[] }> }>(getRelationsCachePath(scope));
    const beforeRelation = before.groups.TestWiki.hot_relations.find((relation) => relation.text === 'rollback');
    assert.equal(beforeRelation?.ftsIndexComplete, true);
    const beforeLocalText = readJsonFile<Record<string, string>>(getLocalKbDir(scope, 'TestWiki')).rollback;

    try {
      vectorizeMode = 'fail';
      await assert.rejects(
        () => handleDirectImport({ scope, sourceDir: src, group: 'TestWiki', vector: true }),
        /均未完成向量化/,
      );
      const after = readJsonFile<{ groups: Record<string, { hot_relations: { text: string; ftsIds?: string[]; ftsIndexComplete?: boolean }[] }> }>(getRelationsCachePath(scope));
      const afterRelation = after.groups.TestWiki.hot_relations.find((relation) => relation.text === 'rollback');
      assert.equal(afterRelation?.ftsIndexComplete, true);
      assert.deepEqual(afterRelation?.ftsIds, beforeRelation?.ftsIds, '回滚时旧 FTS IDs 必须不变');
      assert.equal(readJsonFile<Record<string, string>>(getLocalKbDir(scope, 'TestWiki')).rollback, beforeLocalText, '回滚时 local KB 原文必须恢复');
    } finally {
      const { closeFtsEngine } = await import('../src/lib/fts-client.js');
      await closeFtsEngine(scope);
      vectorizeMode = 'success';
      fs.rmSync(src, { recursive: true, force: true });
    }
  });

  it('导入进度回调报告 scan/vectorize/persist 三个阶段', async () => {
    const scope = newScope('progress');
    const src = mkSource({ 'progress.md': '# 进度文档\n\n用于验证阶段进度。' });
    const progress: { phase: string; done: number; total: number }[] = [];

    const result = await handleDirectImport({
      scope,
      sourceDir: src,
      group: 'TestWiki',
      vector: false,
      onProgress: (value) => progress.push(value),
    });

    assert.equal(result.ok, true);
    assert.deepEqual([...new Set(progress.map((value) => value.phase))], ['scan', 'vectorize', 'persist']);
    assert.deepEqual(progress.at(-1), { phase: 'persist', done: 1, total: 1 });
    fs.rmSync(src, { recursive: true, force: true });
  });
});
