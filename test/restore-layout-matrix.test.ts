/**
 * restore-layout-matrix.test.ts —— backup/restore × 分片布局矩阵（批次 2 工作项 6，护栏 #8）
 *
 * restore 是"用旧数据覆盖新布局"的唯一入口。本文件锁定：
 *   - B1：新布局快照 → restore → 分片数据与快照一致 + 缓存失效广播（W7）
 *   - B2：旧布局快照 → restore（新代码）→ 双读兼容读到旧数据 → 首次写惰性迁移收敛守恒
 *
 * 运行：npx jiti test/restore-layout-matrix.test.ts
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetConfigCache, loadConfig, getScopeDataDir } from '../src/lib/config.js';
import {
  writeGroupCacheBatch,
  writeGroupCache,
  readAllGroupCaches,
  hasShardedLayout,
  getRelationsRoot,
  loadCacheShape,
  onScopeRelationsInvalidated,
} from '../src/lib/group-cache.js';
import { getRelationsCachePath, getKbDir } from '../src/lib/scope.js';
import { backupScopeSnapshot } from '../src/lib/backup.js';
import { restoreSnapshotLocal } from '../src/lib/restore-snapshot.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-layout-'));

function setupConfig(scopes: string[]): { dataDir: string; backupDir: string } {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'cfg-'));
  const dataDir = path.join(dir, 'kb');
  const backupDir = path.join(dir, 'backup');
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(
    configPath,
    [
      `dataDir: ${dataDir}`,
      `vectorDir: ${path.join(dir, 'vector')}`,
      `backupDir: ${backupDir}`,
      'scopeMode: default',
      'scopes:',
      ...scopes.map((s) => `  ${s}: {}`),
      '',
    ].join('\n'),
    'utf-8',
  );
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();
  return { dataDir, backupDir };
}

const rel = (text: string, extra: Record<string, unknown> = {}) => ({
  id: `r-${text}`, text, score: 1, useCount: 0, lastUsedTime: null, ...extra,
}) as never;

describe('backup/restore × 分片布局矩阵（批次 2，护栏 #8）', () => {
  afterEach(() => {
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
  });

  it('B1：新布局快照 → restore → 分片数据一致 + 缓存失效广播', async () => {
    const { backupDir } = setupConfig(['b1']);
    const scope = 'b1';
    fs.mkdirSync(getKbDir(scope), { recursive: true });

    // 快照前状态：新布局 2 组
    writeGroupCacheBatch(scope, new Map([
      ['g1', { version: 1, scope, hot_relations: [rel('甲', { memoryIds: ['m-1'] }), rel('乙', { ftsIds: ['f-1'], ftsIndexComplete: true })], keywords: [] }],
      ['g2', { version: 1, scope, hot_relations: [rel('丙', { memoryIds: ['m-3'] })], keywords: [] }],
    ]));

    const config = loadConfig();
    const snapshotPath = backupScopeSnapshot(backupDir, scope, getScopeDataDir(config, scope));
    assert.ok(fs.existsSync(snapshotPath));

    // 快照后改动：覆盖一组 + 新增一组（restore 应把它们全部回退）
    writeGroupCache(scope, 'g1', {
      version: 1, scope, hot_relations: [rel('甲-改')], keywords: [], updatedAt: null,
    });
    writeGroupCache(scope, 'g3', {
      version: 1, scope, hot_relations: [rel('丁-新')], keywords: [], updatedAt: null,
    });

    // W7：注册失效广播监听（restore 覆盖后必须广播）
    const invalidated: string[] = [];
    onScopeRelationsInvalidated((s) => { if (s === scope) invalidated.push(s); });

    const result = await restoreSnapshotLocal(scope, { backupDir });
    assert.equal(result.ok, true);

    // 数据一致性：回到快照时的 2 组 3 条
    const after = readAllGroupCaches(scope);
    assert.deepEqual([...after.keys()].sort(), ['g1', 'g2'], '快照后的新增组 g3 必须被覆盖回退');
    assert.deepEqual(after.get('g1')!.hot_relations.map((r) => r.text), ['甲', '乙']);
    assert.deepEqual(after.get('g2')!.hot_relations.map((r) => r.text), ['丙']);

    // 缓存失效广播（W7）：restore 后必须通知（不等下次身份戳兜底）
    assert.ok(invalidated.includes(scope), 'restore 完成后必须广播 scope 缓存失效');
  });

  it('B2：旧布局快照 → restore（新代码）双读兼容 → 首次写惰性迁移收敛守恒', async () => {
    const { backupDir } = setupConfig(['b2']);
    const scope = 'b2';
    fs.mkdirSync(getKbDir(scope), { recursive: true });

    // 快照前状态：旧布局单文件（2 组 3 条，含前缀脏键 —— 迁移时清洗）
    const legacyPath = getRelationsCachePath(scope);
    const legacyGroups = {
      '项目根/旧组': { hot_relations: [rel('旧甲', { memoryIds: ['m-old-1'] }), rel('旧乙')], keywords: [] },
      '保留组': { hot_relations: [rel('旧丙', { ftsIds: ['f-old'], ftsIndexComplete: true })], keywords: [] },
    };
    fs.writeFileSync(legacyPath, JSON.stringify({
      version: 1, scope, partition_config: {}, groups: legacyGroups, updatedAt: null,
    }));

    const config = loadConfig();
    const snapshotPath = backupScopeSnapshot(backupDir, scope, getScopeDataDir(config, scope));
    assert.ok(fs.existsSync(snapshotPath));

    // 快照后：迁移到新布局 + 加新数据
    const { migrateLegacyRelationsCache } = await import('../src/lib/group-cache.js');
    migrateLegacyRelationsCache(scope);
    writeGroupCache(scope, '新组', { version: 1, scope, hot_relations: [rel('新丁')], keywords: [], updatedAt: null });
    assert.ok(hasShardedLayout(scope));

    // restore 旧布局快照：解压快照 → restore 尾部 rebuildFtsOnlyScope（快照含 FTS-only
    // 文档：'旧丙'）走 R4 迁移后的写路径 → 惰性迁移立即发生（比"首次用户写"更早）。
    const result = await restoreSnapshotLocal(scope, { backupDir });
    assert.equal(result.ok, true);

    // 数据守恒（无论迁移发生在 restore 尾部 rebuild 还是后续写，总量与内容一致）：
    // 快照原始 3 条回归；快照后新增的"新组"必须消失（不复活）
    const afterRestore = readAllGroupCaches(scope);
    const allTexts = [...afterRestore.values()].flatMap((g) => g.hot_relations.map((r) => r.text)).sort();
    const shardDetail = JSON.stringify([...afterRestore.entries()].map(([k, v]) => [k, v.hot_relations.map((x) => x.text)]));
    assert.deepEqual(allTexts, ['旧丙', '旧甲', '旧乙'].sort(),
      `restore 后数据必须等于快照内容（新增组不复活）；分片实况=${shardDetail}；旧文件=${fs.existsSync(getRelationsCachePath(scope))}`);

    // FTS-only 触发重建链路后必然已迁移（或已通过双读正常读到）——再触发一次写，
    // 确保收敛路径完整（幂等：已迁移时该写只是单组写）
    writeGroupCache(scope, '再一组', { version: 1, scope, hot_relations: [rel('收尾')], keywords: [], updatedAt: null });
    assert.ok(hasShardedLayout(scope), '收敛后必须为新布局');
    assert.ok(fs.existsSync(`${legacyPath}.bak`), '旧文件必须改名 .bak 保留（可回退）');

    const converged = readAllGroupCaches(scope);
    // 第二轮审查 P0：迁移**不再**剥 `项目根/` 前缀（键原样 = 树路径 = local-kb 目录）；
    // 快照后新增的"新组"不在旧快照中，不得复活
    assert.deepEqual([...converged.keys()].sort(), ['再一组', '保留组', '项目根/旧组'].sort(),
      '键原样保留；快照后新增的"新组"不在旧快照中，不得复活');
    assert.deepEqual(converged.get('项目根/旧组')!.hot_relations.map((r) => r.text), ['旧甲', '旧乙']);
    assert.deepEqual(converged.get('保留组')!.hot_relations.map((r) => r.text), ['旧丙']);

    // loadCacheShape 双读形状一致
    const shape = loadCacheShape(scope);
    assert.equal(Object.keys(shape.groups).length, 3);

    // 分片目录与旧 .bak 并存（回退材料完整）
    assert.ok(fs.existsSync(getRelationsRoot(scope)));
  });

  it('B2b：旧布局快照 + 无 FTS-only 文档 → restore 后保持旧布局（双读兼容），首次写才迁移', async () => {
    const { backupDir } = setupConfig(['b2b']);
    const scope = 'b2b';
    fs.mkdirSync(getKbDir(scope), { recursive: true });

    // 快照：旧布局且无 FTS-only（不触发 restore 尾部 rebuild 的写路径）——dense 型
    const legacyPath = getRelationsCachePath(scope);
    fs.writeFileSync(legacyPath, JSON.stringify({
      version: 1, scope, partition_config: {}, updatedAt: null,
      groups: {
        '项目根/组A': { hot_relations: [rel('甲', { memoryIds: ['m-a'] })], keywords: [] },
        '组B': { hot_relations: [rel('乙', { memoryIds: ['m-b'] })], keywords: [] },
      },
    }));
    const config = loadConfig();
    backupScopeSnapshot(backupDir, scope, getScopeDataDir(config, scope));

    // 快照后演进为新布局
    const { migrateLegacyRelationsCache } = await import('../src/lib/group-cache.js');
    migrateLegacyRelationsCache(scope);
    assert.ok(hasShardedLayout(scope));

    const result = await restoreSnapshotLocal(scope, { backupDir });
    assert.equal(result.ok, true);

    // 无 FTS-only → rebuild 不触发写 → 旧布局保持（分片目录被移开，旧文件回来）
    assert.ok(!hasShardedLayout(scope), '无写触达时 restore 后应保持快照的旧布局');
    assert.ok(fs.existsSync(legacyPath));

    // 双读兼容：原样读旧文件（不清洗前缀键——兼容读铁律）
    const afterRestore = readAllGroupCaches(scope);
    assert.deepEqual([...afterRestore.keys()].sort(), ['组B', '项目根/组A'].sort(), '旧布局读原样键');

    // 首次写触发惰性迁移：守恒（键原样，不剥前缀）
    writeGroupCache(scope, '组C', { version: 1, scope, hot_relations: [rel('丙')], keywords: [], updatedAt: null });
    assert.ok(hasShardedLayout(scope));
    assert.ok(fs.existsSync(`${legacyPath}.bak`));
    const converged = readAllGroupCaches(scope);
    assert.deepEqual([...converged.keys()].sort(), ['组B', '组C', '项目根/组A'].sort(), '迁移后键集合守恒（原样）');
  });
});
