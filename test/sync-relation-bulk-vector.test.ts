/**
 * sync-relation-bulk-vector.test.ts —— executeBulkSyncRelation 向量化路径测试
 *
 * 覆盖阶段 2-3（mock 向量层，离线可测）：
 *   - 全成功：memoryId/memoryIds 回写、旧 tag 向量清理（stale）、顶层 vectorStored 语义
 *   - 部分失败：不删旧向量（数据守恒，避免「删旧丢新」）、逐条/顶层 vectorStored 语义
 *   - 同批重复 relation：后一条覆盖前一条，前一条不独立写向量（M1）
 *   - 向量服务不可用：KB 层不阻塞，逐条 vectorStored=false
 *   - hints 透出：Group 路径解析提示（自动补全 / 未匹配）
 *
 * Mock 策略：先 import vector-client 模块再 patch 导出函数，
 * 与 vector-cli-functions.test.ts 一致（ESM live binding 生效）。
 *
 * 运行：npx jiti --test test/sync-relation-bulk-vector.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

let vectorClientModule: typeof import('../src/lib/vector-client.js');
let syncModule: typeof import('../src/sync-relation.js');
let storeModule: typeof import('../src/lib/store.js');
let scopeModule: typeof import('../src/lib/scope.js');

// ─── Mock 状态 ───

type MockVecResult = {
  index: number;
  memoryId?: string;
  success: boolean;
  error?: string;
};

let mockAvailable = true;
/** 显式设置的批量结果；长度与 entries 不符时自动生成「全成功」默认结果 */
let mockBulkResults: MockVecResult[] = [];
let mockBulkCalls: { entries: { text: string; tags?: string; group?: string }[] }[] = [];
let mockDeleteCalls: { ids: string[] }[] = [];

async function loadModulesWithMock() {
  vectorClientModule = await import('../src/lib/vector-client.js');

  (vectorClientModule as any).ensureVectorAvailable = async () =>
    mockAvailable ? { available: true } : { available: false, reason: 'mock: 向量不可用' };

  (vectorClientModule as any).vectorBulkStore = async (params: any) => {
    mockBulkCalls.push(params);
    const n = params.entries.length;
    const results =
      mockBulkResults.length === n
        ? mockBulkResults
        : params.entries.map((_: unknown, i: number) => ({ index: i, memoryId: `mock_${i}`, success: true }));
    return {
      total: n,
      succeeded: results.filter((r: any) => r.success).length,
      failed: results.filter((r: any) => !r.success).length,
      results,
    };
  };

  (vectorClientModule as any).vectorDelete = async (params: any) => {
    mockDeleteCalls.push(params);
    return { deleted: params.ids.length, errors: [] };
  };

  syncModule = await import('../src/sync-relation.js');
  storeModule = await import('../src/lib/store.js');
  scopeModule = await import('../src/lib/scope.js');
}

/** 在指定 group 预置一个带旧向量的 relation（模拟「更新已有 relation」场景） */
function seedRelationWithOldVectors(
  scope: string,
  group: string,
  relation: string,
  oldIds: string[]
): void {
  const cachePath = scopeModule.getRelationsCachePath(scope);
  const cache: any = storeModule.readJson(cachePath)!;
  if (!cache.groups[group]) {
    cache.groups[group] = { hot_relations: [], keywords: [], max_hot_count: 50 };
  }
  cache.groups[group].hot_relations.push({
    id: 'rel_099',
    text: relation,
    score: 0.5,
    useCount: 1,
    lastUsedTime: Date.now(),
    isImported: false,
    memoryId: oldIds[0],
    memoryIds: oldIds,
  });
  storeModule.writeJson(cachePath, cache);
}

before(async () => {
  await loadModulesWithMock();
});

after(() => {
  cleanupTestConfig();
});

describe('executeBulkSyncRelation 向量化路径', () => {
  it('向量全成功：memoryId/memoryIds 回写 + 旧 tag 向量清理 + 顶层 vectorStored', async () => {
    const scope = `bulk-vec-ok-${Date.now()}`;
    registerTestScope(scope);
    storeModule.initScope(scope);
    try {
      seedRelationWithOldVectors(scope, '项目根/向量', '向量关系', ['old-search', 'old-api']);
      mockAvailable = true;
      mockBulkCalls = [];
      mockDeleteCalls = [];
      mockBulkResults = []; // 自动全成功

      const result = await syncModule.executeBulkSyncRelation({
        scope,
        vector: true,
        items: [
          { group: '项目根/向量', relation: '向量关系', module_info: '新内容', tags: 'api' },
        ],
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;

      // 顶层与逐条 vectorStored 全成功 = true
      assert.strictEqual(result.vectorStored, true);
      assert.strictEqual(result.results[0].vectorStored, true);

      // entries = [ki-relation, ki-search, api]（1 条 item + 1 自定义 tag）
      assert.strictEqual(mockBulkCalls.length, 1);
      assert.strictEqual(mockBulkCalls[0].entries.length, 3);
      assert.strictEqual(mockBulkCalls[0].entries[1].tags, 'ki-search');
      assert.strictEqual(mockBulkCalls[0].entries[2].tags, 'api');

      // 旧 tag 向量被一次聚合清理
      assert.strictEqual(mockDeleteCalls.length, 1);
      assert.deepStrictEqual(
        mockDeleteCalls[0].ids.slice().sort(),
        ['old-api', 'old-search']
      );

      // memoryId（ki-search 主条 = index 1）与 memoryIds（ki-search + api）回写
      const cache: any = storeModule.readJson(scopeModule.getRelationsCachePath(scope))!;
      const rel = cache.groups['项目根/向量'].hot_relations.find((r: any) => r.text === '向量关系');
      assert.ok(rel);
      assert.strictEqual(rel.memoryId, 'mock_1');
      assert.deepStrictEqual(rel.memoryIds, ['mock_1', 'mock_2']);
    } finally {
      const kbDir = scopeModule.getKbDir(scope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });

  it('部分失败：不删旧向量（数据守恒）+ 逐条 reason + 顶层 vectorStored=false', async () => {
    const scope = `bulk-vec-partial-${Date.now()}`;
    registerTestScope(scope);
    storeModule.initScope(scope);
    try {
      // 旧内容向量：module_info 变更后 docId 变化，若被删则内容丢失
      seedRelationWithOldVectors(scope, '项目根/向量', '向量关系', ['old-search']);
      mockAvailable = true;
      mockBulkCalls = [];
      mockDeleteCalls = [];
      // 3 entries = [ki-relation, ki-search, api]：api tag 失败
      mockBulkResults = [
        { index: 0, memoryId: 'r0', success: true },
        { index: 1, memoryId: 'c1', success: true },
        { index: 2, success: false, error: 'embed 失败' },
      ];

      const result = await syncModule.executeBulkSyncRelation({
        scope,
        vector: true,
        items: [
          { group: '项目根/向量', relation: '向量关系', module_info: '完全不同的新内容', tags: 'api' },
        ],
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;

      // 部分失败：不清理任何旧向量（保留 old-search，避免删旧丢新）
      assert.strictEqual(mockDeleteCalls.length, 0, '部分失败时不应清理旧向量');

      // 成功条目回写（ki-search 的 mock_1；api 失败不进 memoryIds）
      const cache: any = storeModule.readJson(scopeModule.getRelationsCachePath(scope))!;
      const rel = cache.groups['项目根/向量'].hot_relations.find((r: any) => r.text === '向量关系');
      assert.ok(rel);
      assert.strictEqual(rel.memoryId, 'c1');
      assert.deepStrictEqual(rel.memoryIds, ['c1']);

      // 逐条：主内容可召回（vectorStored=true）+ 附加 reason 透出部分失败
      assert.strictEqual(result.results[0].vectorStored, true);
      assert.match(result.results[0].vectorReason ?? '', /部分内容向量写入失败/);

      // 顶层：存在失败 → 非全量成功 → false
      assert.strictEqual(result.vectorStored, false);
    } finally {
      const kbDir = scopeModule.getKbDir(scope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });

  it('混合成功 + 部分失败：顶层 vectorStored=false（不被部分失败条目的 reason 误排除）', async () => {
    const scope = `bulk-vec-mixed-${Date.now()}`;
    registerTestScope(scope);
    storeModule.initScope(scope);
    try {
      mockAvailable = true;
      mockBulkCalls = [];
      mockDeleteCalls = [];
      // 5 entries = item0 [ki-relation(0), ki-search(1)] + item1 [ki-relation(2), ki-search(3), api(4)]
      // item0 全成功；item1 的 api（index 4）失败
      mockBulkResults = [
        { index: 0, memoryId: 'a-r0', success: true },
        { index: 1, memoryId: 'a-c1', success: true },
        { index: 2, memoryId: 'b-r0', success: true },
        { index: 3, memoryId: 'b-c1', success: true },
        { index: 4, success: false, error: 'embed 失败' },
      ];

      const result = await syncModule.executeBulkSyncRelation({
        scope,
        vector: true,
        items: [
          { group: '项目根/成功', relation: '成功关系', module_info: '成功内容' },
          { group: '项目根/部分', relation: '部分关系', module_info: '部分内容', tags: 'api' },
        ],
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;

      // item0 完全成功；item1 部分失败
      assert.strictEqual(result.results[0].vectorStored, true);
      assert.strictEqual(result.results[0].vectorReason, undefined);
      assert.strictEqual(result.results[1].vectorStored, true); // 主内容可召回
      assert.match(result.results[1].vectorReason ?? '', /部分内容向量写入失败/);

      // 关键：顶层必须为 false（存在部分失败），不能被 item1 的 vectorReason 误排除
      assert.strictEqual(result.vectorStored, false);
    } finally {
      const kbDir = scopeModule.getKbDir(scope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });

  it('同批重复 relation：只写后一条向量，前一条标记覆盖（M1）', async () => {
    const scope = `bulk-vec-dup-${Date.now()}`;
    registerTestScope(scope);
    storeModule.initScope(scope);
    try {
      mockAvailable = true;
      mockBulkCalls = [];
      mockDeleteCalls = [];
      mockBulkResults = []; // 自动全成功

      const result = await syncModule.executeBulkSyncRelation({
        scope,
        vector: true,
        items: [
          { group: '项目根/重复', relation: '同一关系', module_info: '内容A' },
          { group: '项目根/重复', relation: '同一关系', module_info: '内容B' },
        ],
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;

      // 只收集后一条的 entries（2 条 = ki-relation + ki-search），不含内容A
      assert.strictEqual(mockBulkCalls.length, 1);
      assert.strictEqual(mockBulkCalls[0].entries.length, 2);
      assert.ok(!mockBulkCalls[0].entries.some((e) => e.text === '内容A'), '前一条不应写向量');
      assert.ok(mockBulkCalls[0].entries.some((e) => e.text === '内容B'), '后一条应写向量');

      // 前一条标记未独立写向量，后一条正常
      assert.strictEqual(result.results[0].vectorStored, false);
      assert.match(result.results[0].vectorReason ?? '', /后续条目覆盖写入/);
      assert.strictEqual(result.results[1].vectorStored, true);

      // 顶层：覆盖条目由后一条兜底，整体全成功
      assert.strictEqual(result.vectorStored, true);

      // cache 中只保留一条（后一条的内容向量）
      const cache: any = storeModule.readJson(scopeModule.getRelationsCachePath(scope))!;
      const rels = cache.groups['项目根/重复'].hot_relations.filter((r: any) => r.text === '同一关系');
      assert.strictEqual(rels.length, 1);
      assert.strictEqual(rels[0].memoryId, 'mock_1');
      assert.deepStrictEqual(rels[0].memoryIds, ['mock_1']);
    } finally {
      const kbDir = scopeModule.getKbDir(scope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });

  it('向量服务不可用：KB 层不阻塞，逐条 vectorStored=false + 顶层 false', async () => {
    const scope = `bulk-vec-unavail-${Date.now()}`;
    registerTestScope(scope);
    storeModule.initScope(scope);
    try {
      mockAvailable = false;

      const result = await syncModule.executeBulkSyncRelation({
        scope,
        vector: true,
        items: [
          { group: '项目根/正常', relation: '正常关系', module_info: '# 内容\n\n正常。' },
        ],
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      assert.strictEqual(result.vectorStored, false);
      assert.strictEqual(result.results[0].vectorStored, false);
      assert.match(result.results[0].vectorReason ?? '', /向量不可用/);

      // KB 层仍写入（cache + 本地 KB）
      const cache: any = storeModule.readJson(scopeModule.getRelationsCachePath(scope))!;
      assert.ok(cache.groups['项目根/正常'], '向量不可用不应阻塞 KB 层');
      const kb = storeModule.readJson(scopeModule.getLocalKbDir(scope, '项目根/正常'));
      assert.ok(kb && kb['正常关系']);
    } finally {
      const kbDir = scopeModule.getKbDir(scope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });

  it('hints 透出：Group 路径解析提示（未匹配时自动补建但提示）', async () => {
    const scope = `bulk-vec-hint-${Date.now()}`;
    registerTestScope(scope);
    storeModule.initScope(scope);
    try {
      mockAvailable = false; // 只验证 KB 层 + hints

      const result = await syncModule.executeBulkSyncRelation({
        scope,
        vector: true,
        items: [
          { group: '不存在的顶层组', relation: '某关系', module_info: '# 内容\n\n说明。' },
        ],
      });

      assert.strictEqual(result.ok, true);
      if (!result.ok) return;
      assert.ok(Array.isArray(result.hints) && result.hints.length >= 1, '应透出路径解析提示');
      assert.match(result.hints![0], /未匹配到任何 Group|可用的顶层 Group|可用顶层 Group/);
    } finally {
      const kbDir = scopeModule.getKbDir(scope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });
});
