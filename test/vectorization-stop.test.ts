import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-vector-stop-'));
const scope = `vector-stop-${Date.now()}`;
const configPath = path.join(tempDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir: path.join(tempDir, 'kb'),
  vectorDir: path.join(tempDir, 'vector'),
  backupDir: path.join(tempDir, 'backup'),
  scopeMode: 'default',
  scopes: { [scope]: {} },
  embedding: { provider: 'mock', model: 'mock', dimension: 2 },
}));
process.env.KI_CONFIG_PATH = configPath;

test('批量关系同步发现向量服务不可用后停止向量阶段并保留已写 KB', async () => {
  const { resetConfigCache } = await import('../src/lib/config.js');
  resetConfigCache();
  const { initScope, readJson } = await import('../src/lib/store.js');
  const { getLocalKbDir } = await import('../src/lib/scope.js');
  const vectorClient = await import('../src/lib/vector-client.js');
  const originalEnsure = vectorClient.ensureVectorAvailable;
  const originalAssert = vectorClient.assertVectorDimensionCompatible;
  const originalBulk = vectorClient.vectorBulkStore;
  let availabilityChecks = 0;
  let bulkCalls = 0;

  try {
    initScope(scope);
    (vectorClient as any).ensureVectorAvailable = async () => {
      availabilityChecks++;
      return { available: false, reason: 'embedding endpoint unavailable' };
    };
    (vectorClient as any).assertVectorDimensionCompatible = async () => undefined;
    (vectorClient as any).vectorBulkStore = async () => {
      bulkCalls++;
      throw new Error('must not start embedding when preflight is unavailable');
    };

    const { executeBulkSyncRelation } = await import('../src/sync-relation.js');
    const result = await executeBulkSyncRelation({
      scope,
      vector: true,
      items: [
        { group: '向量止损', relation: '第一条', module_info: '# 第一条\n\n内容' },
        { group: '向量止损', relation: '第二条', module_info: '# 第二条\n\n内容' },
      ],
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stopReason?.code, 'VECTOR_UNAVAILABLE');
      assert.equal(result.vectorStored, false);
      assert.match(result.error, /embedding endpoint unavailable/);
    }
    assert.equal(availabilityChecks, 1, '整批只做一次可用性判断');
    assert.equal(bulkCalls, 0, '不可用时不得启动向量批次');
    const kb = readJson<Record<string, string>>(getLocalKbDir(scope, '向量止损'))!;
    assert.equal(kb['第一条'], '# 第一条\n\n内容');
    assert.equal(kb['第二条'], '# 第二条\n\n内容');
  } finally {
    (vectorClient as any).ensureVectorAvailable = originalEnsure;
    (vectorClient as any).assertVectorDimensionCompatible = originalAssert;
    (vectorClient as any).vectorBulkStore = originalBulk;
    const { getKbDir } = await import('../src/lib/scope.js');
    fs.rmSync(getKbDir(scope), { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.KI_CONFIG_PATH;
    const { resetConfigCache } = await import('../src/lib/config.js');
    resetConfigCache();
  }
});

test('路径向量遇到系统故障后不启动后续 scope，并计入未处理条目', async () => {
  const pathVectorize = await import('../src/lib/path-vectorize.js');
  const vectorClient = await import('../src/lib/vector-client.js');
  const originalBulk = vectorClient.vectorBulkStore;
  let calls = 0;
  try {
    (vectorClient as any).vectorBulkStore = async ({ entries }: { entries: unknown[] }) => {
      calls++;
      assert.equal(entries.length, 2);
      return {
        total: 2,
        totalItems: 2,
        attempted: 2,
        succeeded: 1,
        failed: 1,
        notProcessed: 0,
        results: [
          { index: 0, success: true, memoryId: 'path-written' },
          { index: 1, success: false, error: 'collection unavailable' },
        ],
        stopReason: {
          kind: 'collection-unwritable',
          code: 'ZVEC_WRITE_ERROR',
          phase: 'persist',
          reason: 'collection unavailable',
        },
      };
    };

    const result = await pathVectorize.bulkStorePaths([
      { text: 'first', tag: 'ki-path', scope: 'scope-a' },
      { text: 'second', tag: 'ki-relation', scope: 'scope-a' },
      { text: 'third', tag: 'ki-path', scope: 'scope-b' },
    ]);

    assert.equal(calls, 1, '系统性故障后不应写入后续 scope');
    assert.equal(result.ok.size, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.notProcessed, 1, '后续 scope 的条目也应计为未处理');
  } finally {
    (vectorClient as any).vectorBulkStore = originalBulk;
  }
});
