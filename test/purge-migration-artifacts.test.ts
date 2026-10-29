/**
 * purge-migration-artifacts.test.ts —— scope 删除时清理迁移产物（批次 2 审查 P1-1 回归）
 *
 * 回归背景：分片布局下缓存备份是**目录**（rebuild-vector 把 <scope>/.relations/ 整目录
 * rename 到 `<migration-backups>/<scope>-<id>.relations-cache.json`），而 purge 原实现用
 * 非递归 rmSync 删它 → ERR_FS_EISDIR → `ki scope delete --yes` 在"已删 KB/配置/向量"
 * 之后报失败并留下残留（残留又会让同名 scope 重建被误判为迁移中断）。
 *
 * 隔离：KI_CONFIG_PATH + 临时 vectorDir/dataDir。
 * 运行：npx jiti test/purge-migration-artifacts.test.ts
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-purge-mig-'));
const configPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir: path.join(tmpDir, 'kb'),
  vectorDir: path.join(tmpDir, 'vector'),
  backupDir: path.join(tmpDir, 'backup'),
  scopes: {},
}), 'utf-8');
process.env.KI_CONFIG_PATH = configPath;

let sc: typeof import('../src/lib/scope-collection.js');
let configLib: typeof import('../src/lib/config.js');

const MIGRATION_ID = '11111111-1111-4111-8111-111111111111';

before(async () => {
  configLib = await import('../src/lib/config.js');
  sc = await import('../src/lib/scope-collection.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  configLib.resetConfigCache();
  fs.rmSync(path.join(tmpDir, 'vector'), { recursive: true, force: true });
});

describe('purgeVectorMigrationArtifacts（P1-1）', () => {
  it('分片备份是目录时也能清理（非递归 rmSync 会抛 ERR_FS_EISDIR）', () => {
    const scope = 'purge-sharded';
    const config = configLib.loadConfig();
    const paths = sc.getVectorMigrationPaths(config, scope, MIGRATION_ID);

    fs.mkdirSync(paths.backupPath, { recursive: true });
    // 分片布局的缓存备份：整目录（含 manifest 与组 分片）
    fs.mkdirSync(paths.cacheBackupPath, { recursive: true });
    fs.writeFileSync(path.join(paths.cacheBackupPath, 'manifest.json'), '{"revision":1}', 'utf-8');
    fs.mkdirSync(path.join(paths.cacheBackupPath, 'g1'), { recursive: true });
    fs.writeFileSync(path.join(paths.cacheBackupPath, 'g1', 'cache.json'), '{}', 'utf-8');
    fs.mkdirSync(path.dirname(paths.markerPath), { recursive: true });
    fs.writeFileSync(paths.markerPath, '{"migrationId":"x"}', 'utf-8');
    fs.mkdirSync(paths.stageRoot, { recursive: true });

    assert.doesNotThrow(() => sc.purgeVectorMigrationArtifacts(config, scope));
    assert.equal(fs.existsSync(paths.backupPath), false, '旧集合备份已删');
    assert.equal(fs.existsSync(paths.cacheBackupPath), false, '分片缓存备份目录已删');
    assert.equal(fs.existsSync(paths.markerPath), false, '事务标记已删');
    assert.equal(fs.existsSync(paths.stageRoot), false, '暂存目录已删');
  });

  it('旧布局的缓存备份是文件时同样清理（行为不变）', () => {
    const scope = 'purge-legacy';
    const config = configLib.loadConfig();
    const paths = sc.getVectorMigrationPaths(config, scope, MIGRATION_ID);

    fs.mkdirSync(paths.backupPath, { recursive: true });
    fs.mkdirSync(path.dirname(paths.cacheBackupPath), { recursive: true });
    fs.writeFileSync(paths.cacheBackupPath, '{"groups":{}}', 'utf-8');

    assert.doesNotThrow(() => sc.purgeVectorMigrationArtifacts(config, scope));
    assert.equal(fs.existsSync(paths.backupPath), false);
    assert.equal(fs.existsSync(paths.cacheBackupPath), false);
  });

  it('无产物时幂等 no-op（不抛错）', () => {
    const scope = 'purge-empty';
    const config = configLib.loadConfig();
    assert.doesNotThrow(() => sc.purgeVectorMigrationArtifacts(config, scope));
  });
});
