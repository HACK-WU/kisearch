/**
 * import-retry.test.ts —— R2：只重试未完成子集（REQ-20261009-001）
 *
 * 契约：
 *   1. 部分成功导入会把未完成清单持久化到 `<scope>/.ki-import-incomplete.json`；
 *   2. 带 `onlyRelPaths` 重试时**只处理名单内文件**——已完成文件不读原文、不重算 embedding；
 *   3. 重试幂等：不产生 `_1` 副本、已完成文件的 `memoryId` 不变；
 *   4. 全部完成后清单被清空（无待重试项）；
 *   5. 名单里的文件已不存在 → `retryFilter.missing` 如实记账；全部不存在 → fail-loud。
 *
 * 运行：npx jiti test/import-retry.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { getKbDir } from '../src/lib/scope.js';
import { readAllGroupCaches } from '../src/lib/group-cache.js';
import { readImportIncomplete, getImportIncompletePath } from '../src/lib/import-retry.js';

const vectorClient = await import('../src/lib/vector-client.js');
const batchVectorize = await import('../src/lib/batch-vectorize.js');
const pathVectorize = await import('../src/lib/path-vectorize.js');
const { handleDirectImport } = await import('../src/lib/import.js');

type Entry = { path: string };
let vectorizeMode: 'stop' | 'success' = 'stop';
let vectorizePathCalls: string[][] = [];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-retry-'));

(vectorClient as any).vectorDelete = async (params: { ids: string[] }) =>
  vectorClient.normalizeVectorDeleteResult(params.ids, { ok: params.ids.length, failed: 0, errors: [] });
(vectorClient as any).vectorDeleteScope = async () => {
  throw new Error('不得调用 Scope 级向量清空接口');
};
(vectorClient as any).vectorBulkStore = async (params: { scope: string; entries: { text: string; tags?: string }[] }) => ({
  results: params.entries.map((entry, index) => ({
    index,
    success: true,
    memoryId: entry.tags === 'ki-relation' || entry.tags === 'ki-path'
      ? vectorClient.generateDocId(entry.text, params.scope, entry.tags)
      : `mock-${params.scope}-${index}`,
  })),
});
(batchVectorize as any).bulkVectorize = async (entries: Entry[]) => {
  vectorizePathCalls.push(entries.map((entry) => entry.path));
  const ok = new Map<string, string>();
  if (vectorizeMode === 'stop') {
    // 只让首个文件成功，其余报错并带系统性停止（模拟 embedding 中途不可用）
    if (entries[0]) ok.set(entries[0].path, 'ok-first-id');
    return {
      ok,
      errors: entries.slice(1).map((entry) => ({ path: entry.path, error: 'mock provider down' })),
      notProcessed: Math.max(0, entries.length - 2),
      stopReason: { kind: 'provider-unavailable', code: 'HTTP_503', phase: 'embedding', reason: 'mock provider down' },
    };
  }
  for (const [index, entry] of entries.entries()) ok.set(entry.path, `retry-id-${index}-${entry.path}`);
  return { ok, errors: [] };
};
(pathVectorize as any).bulkStorePaths = async (entries: { text: string; scope: string; tag: string }[]) => ({
  ok: new Map(entries.map((entry) => [entry.text, vectorClient.generateDocId(entry.text, entry.scope, entry.tag)])),
  errors: [],
});

function mkSource(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'src-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

function relationsOf(scope: string, group: string): { text: string; memoryIds?: string[] }[] {
  return (readAllGroupCaches(scope).get(group)?.hot_relations ?? []) as { text: string; memoryIds?: string[] }[];
}

after(() => {
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('R2：只重试未完成子集', () => {
  it('部分成功 → 清单落盘 → 重试只处理未完成文件（不重算已完成、无 _1 副本、清单清空）', async () => {
    const scope = `retry-${Date.now()}`;
    registerTestScope(scope);
    try {
      const src = mkSource({
        'a.md': '# a\n\na 会成功',
        'b.md': '# b\n\nb 未完成',
        'c.md': '# c\n\nc 未完成',
      });

      // ── 第一次：部分成功 ──
      vectorizeMode = 'stop';
      vectorizePathCalls = [];
      const first = await handleDirectImport({ scope, sourceDir: src, group: 'G', vector: true });
      assert.equal(first.partial, true);
      assert.deepEqual(first.stats.files, { total: 3, completed: 1, incomplete: 2, scanned: 3, skipped: 0, unchanged: 0 });
      assert.deepEqual(first.incomplete.map((i) => i.path).sort(), ['b.md', 'c.md']);

      const record = readImportIncomplete(scope);
      assert.ok(record, '部分成功后必须落盘未完成清单');
      assert.equal(fs.existsSync(getImportIncompletePath(scope)), true);
      assert.deepEqual(record!.items.map((i) => i.path).sort(), ['b.md', 'c.md']);
      assert.equal(record!.params.vector, true, '清单记录原批次参数（供重试沿用）');
      assert.equal(record!.sourceDir, src);
      const completedIdBefore = relationsOf(scope, 'G').find((r) => r.text === 'a')?.memoryIds?.[0];
      assert.ok(completedIdBefore, '已完成文件必须有向量 id');

      // ── 第二次：只重试未完成子集 ──
      vectorizeMode = 'success';
      vectorizePathCalls = [];
      const retry = await handleDirectImport({
        scope,
        sourceDir: src,
        group: 'G',
        vector: true,
        onlyRelPaths: record!.items.map((i) => i.path),
      });

      // ① 只处理名单内文件（文件级分母 = 2，不是 3）
      assert.deepEqual(retry.stats.files, { total: 2, completed: 2, incomplete: 0, scanned: 2, skipped: 0, unchanged: 0 });
      assert.equal(retry.partial, false);
      assert.deepEqual(retry.retryFilter, { requested: 2, matched: 2, missing: [] });

      // ② 已完成文件**没有**被重新向量化（只发了 b/c 的 chunk）
      const vectorizedPaths = vectorizePathCalls.flat();
      assert.equal(vectorizedPaths.length > 0, true);
      assert.equal(vectorizedPaths.some((p) => p.startsWith('a.md')), false, 'a.md 不得被重算 embedding');
      assert.deepEqual([...new Set(vectorizedPaths.map((p) => p.split('#')[0]))].sort(), ['b.md', 'c.md']);

      // ③ 幂等：无 `_1` 副本；a 的 memoryId 不变；b/c 已提交
      const rels = relationsOf(scope, 'G');
      assert.deepEqual(rels.map((r) => r.text).sort(), ['a', 'b', 'c']);
      assert.equal(rels.some((r) => r.text.includes('_1')), false, '重试不得产生 _1 后缀副本');
      assert.deepEqual(rels.find((r) => r.text === 'a')?.memoryIds, [completedIdBefore], '已完成文件 memoryId 不变');
      assert.equal((rels.find((r) => r.text === 'b')?.memoryIds ?? []).length > 0, true, '重试成功的文件可检索');

      // ④ 清单清空
      assert.equal(readImportIncomplete(scope), null, '全部完成后清单必须清空');
    } finally {
      const kb = getKbDir(scope);
      if (fs.existsSync(kb)) fs.rmSync(kb, { recursive: true, force: true });
    }
  });

  it('清单里的文件已不存在：如实记入 retryFilter.missing；全部不存在则 fail-loud', async () => {
    const scope = `retry-missing-${Date.now()}`;
    registerTestScope(scope);
    try {
      const src = mkSource({ 'a.md': '# a\n\n正文', 'b.md': '# b\n\n正文' });
      vectorizeMode = 'success';
      await handleDirectImport({ scope, sourceDir: src, group: 'G', vector: true });

      // 部分命中：a.md 被删掉，只重试 a.md + b.md
      fs.rmSync(path.join(src, 'a.md'));
      const partialHit = await handleDirectImport({
        scope, sourceDir: src, group: 'G', vector: true, onlyRelPaths: ['a.md', 'b.md'],
      });
      assert.deepEqual(partialHit.retryFilter, { requested: 2, matched: 1, missing: ['a.md'] });
      assert.deepEqual(partialHit.stats.files, { total: 1, completed: 1, incomplete: 0, scanned: 1, skipped: 0, unchanged: 0 });

      // 全部不存在 → fail-loud（不静默当成"无事可做"）
      await assert.rejects(
        () => handleDirectImport({ scope, sourceDir: src, group: 'G', vector: true, onlyRelPaths: ['ghost.md'] }),
        /均不存在/,
      );
    } finally {
      const kb = getKbDir(scope);
      if (fs.existsSync(kb)) fs.rmSync(kb, { recursive: true, force: true });
    }
  });
});
