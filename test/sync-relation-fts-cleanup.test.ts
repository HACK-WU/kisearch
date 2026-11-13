/**
 * sync-relation-fts-cleanup.test.ts —— FTS-only → dense 切换后的旧全文索引清理
 *
 * 对应 REQ-20261113-002（R1/R2/R3/R4/R5/R6）。缺陷原状：`--no-vector` 写过的文档改用 dense
 * 写入时，`ftsIds` 原样留在元数据里，而 `fts` 记录存的是**旧版本正文** ⇒ `--mode fulltext`
 * 会返回一份当前 KB 里已不存在的文本。
 *
 * 覆盖：
 *   - 单条：清爽清理（含 memoryIds 不被回滚 —— `vectorWriteBack` 自读自写 cache 的坑）
 *   - 单条：dense 未成功 ⇒ **不清**旧 FTS（顺序硬约束，否则内容两套索引同时消失）
 *   - 单条：清理部分失败 / 抛错 ⇒ 保留失败 ID + `ftsIndexComplete=false` + 返回体透出
 *   - 单条：NOT_FOUND（deleted=0, failed=0）⇒ 幂等成功，元数据照样清空
 *   - 单条：反向 `--no-vector` 不回归
 *   - 批量：逐条清理、先写向量后删的顺序、dense 不可用时保留、单条失败不中断整批
 *
 * Mock 策略：先 import vector-client / fts-client 模块再 patch 导出函数（ESM live binding），
 * 与 sync-relation-bulk-vector.test.ts 一致，全程离线。
 *
 * 运行：npx jiti --test test/sync-relation-fts-cleanup.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

let vectorClientModule: typeof import('../src/lib/vector-client.js');
let ftsClientModule: typeof import('../src/lib/fts-client.js');
let syncModule: typeof import('../src/sync-relation.js');
let storeModule: typeof import('../src/lib/store.js');
let scopeModule: typeof import('../src/lib/scope.js');
let gcModule: typeof import('../src/lib/group-cache.js');

// ─── Mock 状态 ───

let mockAvailable = true;
/** 向量写入调用顺序与 FTS 删除顺序合并记录，用于断言「先写后清」 */
let events: string[] = [];
/** 'ok' = 全成功；'throw' = 抛错；否则为「失败 ID 集合」（NOT_FOUND 由 'ok' 覆盖） */
let mockFtsDeleteOutcome: 'ok' | 'throw' | { failIds: string[] } = 'ok';
let mockFtsDeleteCalls: string[][] = [];
let mockVectorDeleteCalls: { ids: string[] }[] = [];

const GROUP = 'cleanup';
const RELATION = '目标文档';

async function loadModulesWithMock() {
  vectorClientModule = await import('../src/lib/vector-client.js');

  (vectorClientModule as any).ensureVectorAvailable = async () =>
    mockAvailable ? { available: true } : { available: false, reason: 'mock: 向量不可用' };

  (vectorClientModule as any).vectorBulkStore = async (params: any) => {
    events.push('vectorStore');
    const results = params.entries.map((_: unknown, i: number) => ({ index: i, memoryId: `mock_${i}`, success: true }));
    return { total: results.length, succeeded: results.length, failed: 0, results };
  };

  (vectorClientModule as any).vectorDelete = async (params: any) => {
    mockVectorDeleteCalls.push({ ids: [...params.ids] });
    return vectorClientModule.normalizeVectorDeleteResult(params.ids, { ok: params.ids.length, failed: 0, errors: [] });
  };

  ftsClientModule = await import('../src/lib/fts-client.js');
  (ftsClientModule as any).ftsBulkStore = async (entries: { scope: string; group: string; relation: string; tag?: string; text: string }[]) => ({
    ids: entries.map((entry) => ftsClientModule.getFtsDocId(entry)),
    failed: 0,
  });
  (ftsClientModule as any).ftsDeleteByIds = async (params: { scope: string; ids: string[] }) => {
    events.push('ftsDelete');
    mockFtsDeleteCalls.push([...params.ids]);
    if (mockFtsDeleteOutcome === 'throw') throw new Error('mock: FTS 删除失败');
    if (mockFtsDeleteOutcome === 'ok') {
      // NOT_FOUND 语义：引擎对不存在的 ID 不报失败，只剩 deleted/failed 计数
      return { deleted: params.ids.length, failed: 0, failedIds: [] };
    }
    const failedIds = params.ids.filter((id) => mockFtsDeleteOutcome.failIds.includes(id));
    return { deleted: params.ids.length - failedIds.length, failed: failedIds.length, failedIds };
  };
  (ftsClientModule as any).closeFtsEngine = async () => {};

  syncModule = await import('../src/sync-relation.js');
  storeModule = await import('../src/lib/store.js');
  scopeModule = await import('../src/lib/scope.js');
  gcModule = await import('../src/lib/group-cache.js');
}

/** 布局感知读该组元数据（写路径会惰性迁移，不能直读旧文件） */
function readRelation(scope: string, patch?: (rel: any) => void): any {
  const group = (gcModule.loadGroupCache(scope, GROUP) as any) ?? { hot_relations: [], keywords: [] };
  const rel = group.hot_relations.find((item: any) => item.text === RELATION);
  if (rel && patch) patch(rel);
  return rel;
}

function seedRelation(scope: string): void {
  const cachePath = scopeModule.getRelationsCachePath(scope);
  const cache: any = storeModule.readJson(cachePath)!;
  cache.groups[GROUP] = {
    hot_relations: [{
      id: 'rel_001',
      text: RELATION,
      score: 0.5,
      useCount: 1,
      lastUsedTime: Date.now(),
      isImported: false,
      memoryIds: [],
      ftsIds: ['old-fts-a'],
      ftsLocators: [{ ftsId: 'old-fts-a', startLine: 1, endLine: 1 }],
      ftsIndexComplete: true,
    }],
    keywords: [],
  };
  storeModule.writeJson(cachePath, cache);
}

function makeScope(tag: string): string {
  const scope = `fts-cleanup-${tag}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  registerTestScope(scope);
  storeModule.initScope(scope);
  return scope;
}

function dropScope(scope: string): void {
  const kbDir = scopeModule.getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
}

before(async () => {
  await loadModulesWithMock();
});

after(() => {
  cleanupTestConfig();
});

describe('单条 sync-relation：FTS-only → dense 的旧全文索引清理', () => {
  it('dense 成功后清理旧 FTS，且不把 vectorWriteBack 回写的 memoryIds 冲掉', async () => {
    const scope = makeScope('ok');
    try {
      seedRelation(scope);
      mockAvailable = true;
      mockFtsDeleteOutcome = 'ok';
      mockFtsDeleteCalls = [];
      events = [];

      const result = await syncModule.executeSyncRelation({
        scope, group: GROUP, relation: RELATION, moduleInfo: '全新版本的正文内容',
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;

      const rel = readRelation(scope);
      assert.ok(rel, '同步后 relation 应仍在');
      assert.equal(rel.ftsIds, undefined, '旧全文索引 ID 必须清空（否则 fulltext 继续命中旧内容）');
      assert.equal(rel.ftsLocators, undefined, '定位元数据随 ID 一并清空');
      assert.equal(rel.ftsIndexComplete, undefined, '完整度标记随 ID 一并移除');
      assert.deepEqual(rel.memoryIds, ['mock_1'], 'dense 侧 memoryIds 必须保留（不得被旧 in-memory cache 回滚）');
      assert.equal(rel.memoryId, 'mock_1');

      // 返回体可读：清掉了几条
      assert.equal(result.ftsRemoved, 1);
      assert.equal(result.ftsCleanupFailed, undefined);
      assert.deepEqual(mockFtsDeleteCalls, [['old-fts-a']]);

      // 顺序硬约束：先写向量，再删旧全文索引
      assert.ok(events.indexOf('vectorStore') >= 0 && events.indexOf('ftsDelete') > events.indexOf('vectorStore'),
        `必须是「先写 dense 后删 FTS」，实际顺序：${events.join(' → ')}`);
    } finally {
      dropScope(scope);
    }
  });

  it('dense 写入失败时保留旧 FTS，并透出未清理原因', async () => {
    const scope = makeScope('densefail');
    try {
      seedRelation(scope);
      mockAvailable = false;
      mockFtsDeleteCalls = [];

      const result = await syncModule.executeSyncRelation({
        scope, group: GROUP, relation: RELATION, moduleInfo: '更新后的正文',
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.vectorStored, false);

      const rel = readRelation(scope);
      assert.deepEqual(rel.ftsIds, ['old-fts-a'], 'dense 未成功时不得清理旧 FTS（否则两套索引同时不存在）');
      assert.deepEqual(rel.ftsLocators, [{ ftsId: 'old-fts-a', startLine: 1, endLine: 1 }]);
      assert.equal(rel.ftsIndexComplete, false, 'local KB 已更新而 FTS 是旧内容 ⇒ 必须标未完成');

      assert.equal(mockFtsDeleteCalls.length, 0, '不应发起删除');
      assert.equal(result.ftsRemoved, undefined);
      assert.match(String(result.ftsCleanupReason), /dense 写入未成功/);
    } finally {
      mockAvailable = true;
      dropScope(scope);
    }
  });

  it('清理部分失败：只保留失败 ID 并透出失败条数', async () => {
    const scope = makeScope('partial');
    try {
      seedRelation(scope);
      // 预置两条旧 FTS ID，只让其中一条删失败
      const cachePath = scopeModule.getRelationsCachePath(scope);
      const cache: any = storeModule.readJson(cachePath)!;
      const rel = cache.groups[GROUP].hot_relations[0];
      rel.ftsIds = ['old-fts-a', 'old-fts-b'];
      rel.ftsLocators = [
        { ftsId: 'old-fts-a', startLine: 1, endLine: 1 },
        { ftsId: 'old-fts-b', startLine: 2, endLine: 2 },
      ];
      storeModule.writeJson(cachePath, cache);

      mockAvailable = true;
      mockFtsDeleteOutcome = { failIds: ['old-fts-b'] };

      const result = await syncModule.executeSyncRelation({
        scope, group: GROUP, relation: RELATION, moduleInfo: '全新正文',
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;

      const updated = readRelation(scope);
      assert.deepEqual(updated.ftsIds, ['old-fts-b'], '失败 ID 必须保留以便重试，不得假装干净');
      assert.deepEqual(updated.ftsLocators, [{ ftsId: 'old-fts-b', startLine: 2, endLine: 2 }], '只保留失败 ID 对应的定位');
      assert.equal(updated.ftsIndexComplete, false);
      assert.equal(result.ftsRemoved, 1);
      assert.equal(result.ftsCleanupFailed, 1);
      assert.match(String(result.ftsCleanupReason), /清理失败 1 条/);
    } finally {
      mockFtsDeleteOutcome = 'ok';
      dropScope(scope);
    }
  });

  it('清理抛错：ID 全部保留并透出失败条数', async () => {
    const scope = makeScope('throw');
    try {
      seedRelation(scope);
      mockAvailable = true;
      mockFtsDeleteOutcome = 'throw';

      const result = await syncModule.executeSyncRelation({
        scope, group: GROUP, relation: RELATION, moduleInfo: '全新正文',
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;

      const rel = readRelation(scope);
      assert.deepEqual(rel.ftsIds, ['old-fts-a'], '抛错时不得丢失 ID 定位');
      assert.equal(result.ftsCleanupFailed, 1);
      assert.match(String(result.ftsCleanupReason), /旧全文索引清理失败/);
    } finally {
      mockFtsDeleteOutcome = 'ok';
      dropScope(scope);
    }
  });

  it('旧记录本就不存在（NOT_FOUND，deleted=0）：幂等成功，元数据照样清空', async () => {
    const scope = makeScope('notfound');
    try {
      seedRelation(scope);
      mockAvailable = true;
      mockFtsDeleteOutcome = 'ok';

      const result = await syncModule.executeSyncRelation({
        scope, group: GROUP, relation: RELATION, moduleInfo: '全新正文',
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      const rel = readRelation(scope);
      assert.equal(rel.ftsIds, undefined, 'NOT_FOUND 属幂等成功，元数据不应残留');
      assert.equal(result.ftsCleanupFailed, undefined);
      assert.equal(result.ftsRemoved, 1);
    } finally {
      dropScope(scope);
    }
  });

  it('反向 dense → FTS-only 不回归：旧 dense 被清、ftsIds 为新值', async () => {
    const scope = makeScope('reverse');
    try {
      seedRelation(scope);
      // 先变成 dense 文档
      mockAvailable = true;
      await syncModule.executeSyncRelation({ scope, group: GROUP, relation: RELATION, moduleInfo: '第一版正文' });
      mockVectorDeleteCalls = [];

      // 再切回 FTS-only
      const result = await syncModule.executeSyncRelation({
        scope, group: GROUP, relation: RELATION, moduleInfo: '第二版正文', vector: false,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.fullTextStored, true);

      const rel = readRelation(scope);
      assert.deepEqual(rel.memoryIds, [], '旧 dense 向量必须清空（与本次新增清理方向相反，行为不变）');
      assert.equal(rel.ftsIndexComplete, true);
      assert.equal(rel.ftsIds.length, 1);
      assert.notDeepEqual(rel.ftsIds, ['old-fts-a'], 'ftsId 含 text，换内容后必为新 ID');
    } finally {
      dropScope(scope);
    }
  });
});

describe('批量 sync-relation：FTS-only → dense 的旧全文索引清理', () => {
  it('批量成功后逐条清理，先写向量后删 FTS', async () => {
    const scope = makeScope('bulk-ok');
    try {
      seedRelation(scope);
      mockAvailable = true;
      mockFtsDeleteOutcome = 'ok';
      mockFtsDeleteCalls = [];
      events = [];

      const result = await syncModule.executeBulkSyncRelation({
        scope,
        vector: true,
        items: [{ group: GROUP, relation: RELATION, module_info: '批量写入的全新正文' }],
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;

      const rel = readRelation(scope);
      assert.equal(rel.ftsIds, undefined, '批量路径同样必须清空旧 FTS ID');
      assert.equal(rel.ftsLocators, undefined);
      assert.equal(rel.ftsIndexComplete, undefined);
      assert.ok(rel.memoryIds.length > 0, 'dense memoryIds 应已回写');

      assert.equal(result.results[0].ftsRemoved, 1);
      assert.deepEqual(mockFtsDeleteCalls, [['old-fts-a']]);
      assert.ok(events.indexOf('ftsDelete') > events.indexOf('vectorStore'),
        `必须是「先写 dense 后删 FTS」，实际顺序：${events.join(' → ')}`);
    } finally {
      dropScope(scope);
    }
  });

  it('批量内 dense 不可用：保留旧 FTS，逐条无 ftsRemoved', async () => {
    const scope = makeScope('bulk-densefail');
    try {
      seedRelation(scope);
      mockAvailable = false;
      mockFtsDeleteCalls = [];

      const result = await syncModule.executeBulkSyncRelation({
        scope,
        vector: true,
        items: [{ group: GROUP, relation: RELATION, module_info: '更新后正文' }],
      });

      assert.equal(result.ok, false);
      assert.equal(result.stopReason?.code, 'VECTOR_UNAVAILABLE');

      const rel = readRelation(scope);
      assert.deepEqual(rel.ftsIds, ['old-fts-a'], 'dense 未成功时保留旧 FTS');
      assert.equal(rel.ftsIndexComplete, false);
      assert.equal(mockFtsDeleteCalls.length, 0);
    } finally {
      mockAvailable = true;
      dropScope(scope);
    }
  });

  it('批量内清理失败：逐条透出且不中断整批', async () => {
    const scope = makeScope('bulk-partial');
    try {
      seedRelation(scope);
      // 追加一条无 FTS 的新文档，验证批次其余条目不受影响
      mockAvailable = true;
      mockFtsDeleteOutcome = { failIds: ['old-fts-a'] };

      const result = await syncModule.executeBulkSyncRelation({
        scope,
        vector: true,
        items: [
          { group: GROUP, relation: RELATION, module_info: '旧文档新正文' },
          { group: GROUP, relation: '另一篇', module_info: '全新文档正文' },
        ],
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.failed, 0, '清理失败不应让整批判失败');

      const first = result.results.find((item) => item.relation === RELATION)!;
      assert.equal(first.ftsRemoved, undefined);
      assert.equal(first.ftsCleanupFailed, 1);
      assert.match(String(first.ftsCleanupReason), /清理失败 1 条/);
      assert.equal(first.vectorStored, true, '向量写入本身仍是成功的');

      const second = result.results.find((item) => item.relation === '另一篇')!;
      assert.equal(second.ftsCleanupFailed, undefined, '无旧 FTS 的条目不应出现清理字段');

      const rel = readRelation(scope);
      assert.deepEqual(rel.ftsIds, ['old-fts-a'], '失败 ID 保留等待重试');
    } finally {
      mockFtsDeleteOutcome = 'ok';
      dropScope(scope);
    }
  });
});
