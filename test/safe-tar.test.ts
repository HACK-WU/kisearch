import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { extractScopeSnapshot } from '../src/lib/safe-tar.js';
import { backupScopeSnapshot } from '../src/lib/backup.js';
import { restoreSnapshotLocal } from '../src/lib/restore-snapshot.js';
import { getKbDir } from '../src/lib/scope.js';
import { registerTestScope, testConfigPath } from './test-config.js';

test('restore 快照解压拒绝 scope 外部符号链接', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-safe-tar-'));
  const source = path.join(root, 'source');
  const archive = path.join(root, 'snapshot.tar.gz');
  const destination = path.join(root, 'destination');
  const scopeDir = path.join(source, 'scope-a');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(scopeDir, 'index.json'), '{}');
  fs.symlinkSync(outside, path.join(scopeDir, 'escape'), 'dir');
  execFileSync('tar', ['-czf', archive, '-C', source, 'scope-a']);

  assert.throws(
    () => extractScopeSnapshot(archive, path.join(destination, 'scope-a')),
    /链接条目/,
  );
  assert.equal(fs.existsSync(path.join(destination, 'scope-a')), false);
});

test('快照排除编辑草稿目录，且还原后草稿不会被复活', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-draft-snapshot-'));
  const draftA = '11111111-2222-4333-8444-555555555555.json';
  const draftB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json';

  // ① 备份侧：scope 目录里的 .relation-edits 不进 tar
  const backupScope = 'snapshot-draft-backup';
  const source = path.join(root, 'source');
  const scopeDir = path.join(source, backupScope);
  fs.mkdirSync(path.join(scopeDir, '.relation-edits'), { recursive: true });
  fs.writeFileSync(path.join(scopeDir, 'index.json'), JSON.stringify({ R: 'body' }));
  fs.writeFileSync(path.join(scopeDir, '.relation-edits', draftA), '{}');
  const snapshot = backupScopeSnapshot(path.join(root, 'backup'), backupScope, scopeDir);
  const listing = execFileSync('tar', ['-tzf', snapshot], { encoding: 'utf8' });
  assert.match(listing, /index\.json/);
  assert.doesNotMatch(listing, /relation-edits/, '草稿是中间态，不应进入快照');

  // ② 还原侧：历史快照（含草稿）还原后草稿目录被清空
  const scope = `snapshot-draft-restore-${Date.now()}`;
  registerTestScope(scope);
  const config = JSON.parse(fs.readFileSync(testConfigPath, 'utf8'));
  config.scopes[scope].kbDir = path.join(root, 'kb-root');
  fs.writeFileSync(testConfigPath, JSON.stringify(config), 'utf8');
  const scopeDataDir = getKbDir(scope);
  fs.mkdirSync(path.join(scopeDataDir, '.relation-edits'), { recursive: true });
  fs.writeFileSync(path.join(scopeDataDir, 'index.json'), JSON.stringify({ R: 'old' }));
  fs.writeFileSync(path.join(scopeDataDir, '.relation-edits', draftA), '{}');

  const stage = path.join(root, 'stage');
  fs.mkdirSync(path.join(stage, scope, '.relation-edits'), { recursive: true });
  fs.writeFileSync(path.join(stage, scope, 'index.json'), JSON.stringify({ R: 'restored' }));
  fs.writeFileSync(path.join(stage, scope, '.relation-edits', draftB), '{}');
  const legacySnapshot = path.join(root, 'legacy.tar.gz');
  execFileSync('tar', ['-czf', legacySnapshot, '-C', stage, scope]);

  const restored = await restoreSnapshotLocal(scope, { snapshotFile: legacySnapshot });
  assert.equal(restored.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(scopeDataDir, 'index.json'), 'utf8')).R, 'restored');
  assert.equal(fs.existsSync(path.join(scopeDataDir, '.relation-edits')), false,
    '还原后必须清空草稿目录，避免复活与还原后正文不匹配的草稿');
});
