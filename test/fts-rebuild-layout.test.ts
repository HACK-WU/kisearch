/**
 * fts-rebuild-layout.test.ts —— FTS-only 重建的布局感知与 fail-loud（批次 2 审查 P1-3 回归）
 *
 * 回归背景：rebuildFtsOnlyScope 原实现把「读 relations 元数据失败」一律当成「空 scope」，
 * 返回 {indexed:0, errors:[]}。新布局下旧文件恒为 .bak，于是**任一 分片损坏都会静默假成功**——
 * restore 尾部自动重建 FTS 的链路会报告成功但 FTS-only 文档全部无法检索（旧实现是 fail-loud）。
 *
 * 本测试只覆盖"读元数据"阶段（无候选文档时不会拉起 zvec 引擎，故无需 embedding）。
 * 运行：npx jiti test/fts-rebuild-layout.test.ts
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-fts-rebuild-'));
const configPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir: path.join(tmpDir, 'kb'),
  vectorDir: path.join(tmpDir, 'vector'),
  backupDir: path.join(tmpDir, 'backup'),
  scopes: {},
}), 'utf-8');
process.env.KI_CONFIG_PATH = configPath;

let gc: typeof import('../src/lib/group-cache.js');
let ftsRebuild: typeof import('../src/lib/fts-rebuild.js');
let configLib: typeof import('../src/lib/config.js');

before(async () => {
  configLib = await import('../src/lib/config.js');
  gc = await import('../src/lib/group-cache.js');
  ftsRebuild = await import('../src/lib/fts-rebuild.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  configLib.resetConfigCache();
});

const rel = (id: string, text: string) => ({ id, text, score: 1, useCount: 0, lastUsedTime: 0 });

describe('rebuildFtsOnlyScope 布局感知（P1-3）', () => {
  it('新布局 + 分片损坏 → 返回结构化错误，绝不静默假成功', async () => {
    const scope = 'fts-corrupt-shard';
    gc.writeGroupCache(scope, 'g1', {
      version: 1, scope, hot_relations: [rel('r1', 'doc1')] as never, keywords: [], updatedAt: null,
    });
    // 损坏分片：缺 hot_relations 数组（readGroupCache 会抛错）
    fs.writeFileSync(gc.getGroupCachePath(scope, 'g1'), JSON.stringify({ version: 1, scope, keywords: [] }), 'utf-8');

    const result = await ftsRebuild.rebuildFtsOnlyScope(scope);
    assert.equal(result.indexed, 0);
    assert.ok(result.errors.length > 0, '读取失败必须进入 errors（原实现返回空 errors 假成功）');
    assert.match(result.errors[0].error, /读取 relations 元数据失败/);
  });

  it('新布局空库（manifest 存在、0 组）→ 正常返回 0 且无错误', async () => {
    const scope = 'fts-empty-sharded';
    // 旧布局空 groups 经迁移 → manifest 就位、无任何分片
    const kbDir = path.join(tmpDir, 'kb', scope);
    fs.mkdirSync(kbDir, { recursive: true });
    fs.writeFileSync(path.join(kbDir, 'relations-cache.json'), JSON.stringify({
      version: 1, scope, partition_config: {}, groups: {}, updatedAt: null,
    }), 'utf-8');
    gc.migrateLegacyRelationsCache(scope);
    assert.ok(gc.hasShardedLayout(scope));

    const result = await ftsRebuild.rebuildFtsOnlyScope(scope);
    assert.equal(result.indexed, 0);
    assert.deepEqual(result.errors, [], '空库不是错误');
  });

  it('两布局皆无（未初始化 scope）→ 正常返回 0 且无错误（与旧语义一致）', async () => {
    const result = await ftsRebuild.rebuildFtsOnlyScope('fts-nothing');
    assert.equal(result.indexed, 0);
    assert.deepEqual(result.errors, []);
  });

  it('旧布局损坏 → 同样不静默（返回结构化错误）', async () => {
    const scope = 'fts-corrupt-legacy';
    const kbDir = path.join(tmpDir, 'kb', scope);
    fs.mkdirSync(kbDir, { recursive: true });
    fs.writeFileSync(path.join(kbDir, 'relations-cache.json'), '{ this is not json', 'utf-8');

    const result = await ftsRebuild.rebuildFtsOnlyScope(scope);
    assert.equal(result.indexed, 0);
    assert.ok(result.errors.length > 0, '损坏必须可见，不得当作空 scope');
  });
});
