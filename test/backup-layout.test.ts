/**
 * backup-layout.test.ts —— 备份门禁的布局感知（批次 2 审查 P0-2 回归）
 *
 * 覆盖：
 *   1) 新布局 scope（.relations/manifest.json + 分片）可备份，且快照真的打包了分片布局
 *   2) 旧布局 scope（relations-cache.json）仍可备份（兼容）
 *   3) 两布局皆无 → fail-loud「尚未初始化」（不得静默产出空快照）
 *
 * 背景：原实现只检查 `relations-cache.json` 存在性，惰性迁移把它改名 `.bak` 后，
 * 新布局 scope 的 ki backup / daemon backup / Web 备份全部误报未初始化。
 *
 * 隔离：KI_CONFIG_PATH + 临时 dataDir/backupDir（不触真实数据）。
 * 运行：npx jiti test/backup-layout.test.ts
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backup-layout-'));
const configPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir: path.join(tmpDir, 'kb'),
  vectorDir: path.join(tmpDir, 'vector'),
  backupDir: path.join(tmpDir, 'backup'),
  scopes: {},
}), 'utf-8');
process.env.KI_CONFIG_PATH = configPath;

let gc: typeof import('../src/lib/group-cache.js');
let backupLib: typeof import('../src/lib/backup.js');
let configLib: typeof import('../src/lib/config.js');

before(async () => {
  configLib = await import('../src/lib/config.js');
  gc = await import('../src/lib/group-cache.js');
  backupLib = await import('../src/lib/backup.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  configLib.resetConfigCache();
});

const rel = (id: string, text: string) => ({ id, text, score: 1, useCount: 0, lastUsedTime: 0 });

/** 旧布局种子：直接写 scope 级单文件 */
function seedLegacy(scope: string, groups: Record<string, { hot_relations: unknown[] }>): void {
  const kbDir = path.join(tmpDir, 'kb', scope);
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(
    path.join(kbDir, 'relations-cache.json'),
    JSON.stringify({ version: 1, scope, partition_config: {}, groups, updatedAt: null }),
    'utf-8',
  );
}

describe('executeBackup 门禁布局感知（P0-2）', () => {
  it('新布局 scope（分片 + manifest）可备份，快照内含 .relations 分片与 manifest', () => {
    const scope = 'new-layout';
    gc.writeGroupCache(scope, 'g1', {
      version: 1, scope, hot_relations: [rel('r1', 'doc1')] as never, keywords: [], updatedAt: null,
    });
    assert.ok(gc.hasShardedLayout(scope), '前置：新布局已就位');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'kb', scope, 'relations-cache.json')), '前置：无旧单文件');

    const result = backupLib.executeBackup({ scope });
    assert.equal(result.ok, true);
    assert.ok(result.snapshotPath && fs.existsSync(result.snapshotPath), '快照文件已生成');

    const listing = execFileSync('tar', ['-tzf', result.snapshotPath!], { encoding: 'utf-8' });
    assert.ok(listing.includes('.relations/manifest.json'), `快照应包含 manifest：\n${listing}`);
    assert.ok(listing.includes('.relations/g1/cache.json'), `快照应包含组 分片：\n${listing}`);
  });

  it('迁移后的 scope（旧文件已改名 .bak）同样可备份', () => {
    const scope = 'migrated';
    seedLegacy(scope, { g1: { hot_relations: [rel('r1', 'doc1')] } });
    const migrated = gc.migrateLegacyRelationsCache(scope);
    assert.equal(migrated, 1);
    assert.ok(fs.existsSync(path.join(tmpDir, 'kb', scope, 'relations-cache.json.bak')), '旧文件已改名 .bak');

    const result = backupLib.executeBackup({ scope });
    assert.equal(result.ok, true, '迁移后必须仍可备份（原实现此处报"尚未初始化"）');
  });

  it('旧布局 scope 兼容：仍可备份（行为不变）', () => {
    const scope = 'legacy';
    seedLegacy(scope, { g1: { hot_relations: [rel('r1', 'doc1')] } });
    const result = backupLib.executeBackup({ scope });
    assert.equal(result.ok, true);
  });

  it('两布局皆无 → fail-loud，不产出空快照', () => {
    const scope = 'empty';
    fs.mkdirSync(path.join(tmpDir, 'kb', scope), { recursive: true });
    assert.throws(
      () => backupLib.executeBackup({ scope }),
      /尚未初始化/,
      '未初始化必须报错（静默产出空快照会让用户误以为已备份）',
    );
  });
});
