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
import { getLocalKbDir, getRelationsCachePath } from '../src/lib/scope.js';
import { generateDocId } from '../src/lib/vector-client.js';

const vectorClient = await import('../src/lib/vector-client.js');
const batchVectorize = await import('../src/lib/batch-vectorize.js');
const pathVectorize = await import('../src/lib/path-vectorize.js');

type VectorDeleteCall = { scope: string; ids: string[] };
type VectorBulkEntry = { text: string; tags?: string; group?: string };

let vectorizeMode: 'success' | 'fail' | 'partial' = 'success';
let vectorizeCalls: { paths: string[]; sequence: number }[] = [];
let vectorDeleteCalls: VectorDeleteCall[] = [];
let vectorEvents: string[] = [];
let vectorizeSequence = 0;
let pathStoreCalls = 0;

// 这些 patch 在 import 模块加载前完成，隔离真实 embedding / zvec，只验证导入编排契约。
(vectorClient as any).vectorDelete = async (params: { scope: string; ids: string[] }) => {
  vectorDeleteCalls.push({ scope: params.scope, ids: [...params.ids] });
  vectorEvents.push(`delete:${params.ids.join(',')}`);
  return { deleted: params.ids.length, errors: [] };
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

const { handleDirectImport } = await import('../src/lib/import.js');

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
  vectorEvents = [];
  vectorizeSequence = 0;
  pathStoreCalls = 0;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function newScope(label: string): string {
  const scope = `import-vec-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  registerTestScope(scope);
  return scope;
}

describe('import 增量向量更新', () => {
  before(() => {
    resetMocks();
  });

  after(() => {
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
