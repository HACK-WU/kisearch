/**
 * restore.ts 确认流程与备份目录测试
 *
 * 覆盖：
 *   - 列出备份：输出 backupDir + locations + available（默认目录 / --backup-dir 覆盖）
 *   - 破坏性还原确认（NEG-11，非交互式）：
 *       * 未加 --yes → 仅展示总览并以 CONFIRMATION_REQUIRED 退出，不改动数据
 *       * 加 --yes → 真正还原，数据被覆盖
 *   - --backup-dir 仅控制「从哪读」：安全网快照始终落默认 backupDir，覆盖目录零写入
 *   - --from-results 未加 --yes 同样以 CONFIRMATION_REQUIRED 退出，不改动数据
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const SCRIPT_PATH = path.resolve(import.meta.dirname, '..', 'src', 'restore.ts');

const tempDirs: string[] = [];
let counter = 0;

after(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-restore-test-'));
  tempDirs.push(dir);
  return dir;
}

function listSnapshots(snapDir: string): string[] {
  if (!fs.existsSync(snapDir)) return [];
  return fs.readdirSync(snapDir).filter((f) => f.endsWith('.tar.gz'));
}

/**
 * 搭建一个隔离的 restore 场景：
 *   - kb/<scope>/old.txt（现有数据）
 *   - <backupDir>/<scope>/snapshots/snapshot.<ts>.tar.gz（含 new.txt 的可还原快照）
 * @param backupInCustom true 时把可还原快照放进 custom 备份目录，默认目录留空
 */
function setupScope(opts: { backupInCustom?: boolean } = {}): {
  configPath: string;
  scope: string;
  kbDir: string;
  scopeDataDir: string;
  defBackupDir: string;
  customBackupDir: string;
} {
  const root = makeTempRoot();
  const scope = `restore-test-${Date.now()}-${++counter}`;

  const kbDir = path.join(root, 'kb');
  const defBackupDir = path.join(root, 'backups');
  const customBackupDir = path.join(root, 'custom-backups');
  const scopeDataDir = path.join(kbDir, scope);

  // 现有数据
  fs.mkdirSync(scopeDataDir, { recursive: true });
  fs.writeFileSync(path.join(scopeDataDir, 'old.txt'), 'OLD');

  // 构建含 new.txt 的可还原快照
  const stageDir = path.join(root, 'stage');
  fs.mkdirSync(path.join(stageDir, scope), { recursive: true });
  fs.writeFileSync(path.join(stageDir, scope, 'new.txt'), 'NEW');

  const snapshotHostDir = opts.backupInCustom ? customBackupDir : defBackupDir;
  const snapDir = path.join(snapshotHostDir, scope, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  execFileSync('tar', [
    '-czf',
    path.join(snapDir, 'snapshot.20260618-021614.tar.gz'),
    '-C',
    stageDir,
    scope,
  ]);

  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      dataDir: kbDir,
      vectorDir: path.join(root, 'vector'),
      backupDir: defBackupDir,
      scopes: { [scope]: {} },
    })
  );

  return { configPath, scope, kbDir, scopeDataDir, defBackupDir, customBackupDir };
}

function runRestore(configPath: string, args: string[]): any {
  try {
    const stdout = execFileSync('npx', ['jiti', SCRIPT_PATH, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, KI_CONFIG_PATH: configPath, NODE_NO_WARNINGS: '1' },
    });
    return JSON.parse(stdout);
  } catch (err: any) {
    // 未加 --yes 时以 exit(1) 退出，JSON 仍写在 stdout
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        /* ignore */
      }
    }
    return { ok: false, error: err.message };
  }
}

describe('restore 列出备份', () => {
  it('输出 backupDir、locations 与 available', () => {
    const { configPath, scope, defBackupDir } = setupScope();
    const result = runRestore(configPath, [scope]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'restore_list');
    assert.strictEqual(result.scope, scope);
    assert.strictEqual(result.backupDir, defBackupDir);
    assert.strictEqual(
      result.locations.snapshots,
      path.join(defBackupDir, scope, 'snapshots')
    );
    assert.strictEqual(
      result.locations.aiResults,
      path.join(defBackupDir, scope, 'ai-results')
    );
    assert.strictEqual(result.available.snapshots.length, 1);
  });

  it('--backup-dir 覆盖时 backupDir/locations 指向自定义目录', () => {
    const { configPath, scope, customBackupDir } = setupScope({ backupInCustom: true });
    const result = runRestore(configPath, [scope, '--backup-dir', customBackupDir]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.backupDir, customBackupDir);
    assert.strictEqual(
      result.locations.snapshots,
      path.join(customBackupDir, scope, 'snapshots')
    );
    // 快照放在 custom 目录，故这里应能列出 1 个
    assert.strictEqual(result.available.snapshots.length, 1);
  });
});

describe('restore --from-snapshot 确认流程（非交互）', () => {
  it('未加 --yes 时以 CONFIRMATION_REQUIRED 退出且不改动数据', () => {
    const { configPath, scope, scopeDataDir } = setupScope();
    const result = runRestore(configPath, [scope, '--from-snapshot']);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'CONFIRMATION_REQUIRED');
    // 数据保持原样
    assert.ok(fs.existsSync(path.join(scopeDataDir, 'old.txt')));
    assert.ok(!fs.existsSync(path.join(scopeDataDir, 'new.txt')));
  });

  it('加 --yes 时真正还原并覆盖数据，安全网快照落默认目录', () => {
    const { configPath, scope, scopeDataDir, defBackupDir } = setupScope();
    const snapDir = path.join(defBackupDir, scope, 'snapshots');
    assert.strictEqual(listSnapshots(snapDir).length, 1); // 仅原始快照

    const result = runRestore(configPath, [scope, '--from-snapshot', '--yes']);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'restore_snapshot');
    // 数据已被覆盖
    assert.ok(fs.existsSync(path.join(scopeDataDir, 'new.txt')));
    assert.ok(!fs.existsSync(path.join(scopeDataDir, 'old.txt')));
    // 新增 1 个安全网快照
    assert.strictEqual(listSnapshots(snapDir).length, 2);
  });
});

describe('restore --backup-dir 只控制读取来源', () => {
  it('从自定义目录还原，安全网快照写默认目录，自定义目录零新增', () => {
    const { configPath, scope, scopeDataDir, defBackupDir, customBackupDir } = setupScope({
      backupInCustom: true,
    });
    const customSnapDir = path.join(customBackupDir, scope, 'snapshots');
    const defSnapDir = path.join(defBackupDir, scope, 'snapshots');

    assert.strictEqual(listSnapshots(customSnapDir).length, 1); // 原始快照在自定义目录
    assert.strictEqual(listSnapshots(defSnapDir).length, 0); // 默认目录初始为空

    const result = runRestore(configPath, [
      scope,
      '--from-snapshot',
      '--backup-dir',
      customBackupDir,
      '--yes',
    ]);

    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(scopeDataDir, 'new.txt')));
    // 自定义目录零新增（仍是原始的 1 个）
    assert.strictEqual(listSnapshots(customSnapDir).length, 1);
    // 安全网快照落在默认目录
    assert.strictEqual(listSnapshots(defSnapDir).length, 1);
  });
});

describe('restore --from-results 确认流程（非交互）', () => {
  it('未加 --yes 时以 CONFIRMATION_REQUIRED 退出且不改动数据', () => {
    const { configPath, scope, scopeDataDir, defBackupDir } = setupScope();

    // 放一个通过 meta 校验的全量 ai-results 文件（重放前即被确认闸门拦截）
    const aiDir = path.join(defBackupDir, scope, 'ai-results');
    fs.mkdirSync(aiDir, { recursive: true });
    fs.writeFileSync(
      path.join(aiDir, 'ai-results.20260618-021614.full.json'),
      JSON.stringify({
        meta: { sourceDir: '/tmp/src', rootName: 'wiki' },
        relations: [],
      })
    );

    const result = runRestore(configPath, [scope, '--from-results']);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'CONFIRMATION_REQUIRED');
    // 数据保持原样
    assert.ok(fs.existsSync(path.join(scopeDataDir, 'old.txt')));
  });
});
