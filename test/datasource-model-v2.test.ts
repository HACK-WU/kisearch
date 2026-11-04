/**
 * S-01：DataSourceRecord v2 / v1 兼容 / 类型探测 / 写锁 / 异步 add-remove。
 * 运行：npx jiti test/datasource-model-v2.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import { addDataSource, readDataSource, removeDataSource } from '../src/lib/datasource.js';

let root: string;
let dataDir: string;
let configPath: string;
let repo: string;
let plain: string;
let savedConfigPath: string | undefined;
let gitScope: string;
let plainScope: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-model-'));
  dataDir = path.join(root, 'kb');
  configPath = path.join(root, 'config.json');
  gitScope = `ds-git-${process.pid}`;
  plainScope = `ds-plain-${process.pid}`;
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir,
    vectorDir: path.join(root, 'vector'),
    backupDir: path.join(root, 'backup'),
    scopeMode: 'default',
    scopes: { [gitScope]: {}, [plainScope]: {}, legacy: {} },
  }), 'utf8');

  savedConfigPath = process.env.KI_CONFIG_PATH;
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();

  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'a.md'), '# a\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  // 测试机全局可能开启 commit.gpgsign；CI/无 tty 下会失败
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');

  plain = path.join(root, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'x.md'), '# x\n');
});

after(() => {
  if (savedConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = savedConfigPath;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('DataSourceRecord v3（含 v1/v2 → v3 迁移）', () => {
  it('git 源写入 v3 记录并持久化 type/git + 单条映射', async () => {
    const config = loadConfig();
    const result = await addDataSource({ scope: gitScope, dir: repo, config });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.version, 3);
    assert.equal(result.record.type, 'git');
    assert.equal(result.record.git?.repoRoot, fs.realpathSync(repo));
    assert.equal(result.record.git?.relativeRoot, '');
    assert.equal(result.record.git?.managed, false);
    assert.equal(result.record.git?.remoteBranch, null);
    // 未指定映射 ⇒ 一条根映射（与 v2 语义等价，REQ-20261104-002 R1）
    assert.deepEqual(result.record.mappings, [{ subdir: '', group: null }]);

    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, gitScope, 'datasource.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(raw.version, 3);
    assert.equal(raw.type, 'git');
    assert.deepEqual(raw.mappings, [{ subdir: '', group: null }]);
    assert.equal((raw.git as Record<string, unknown>).repoRoot, fs.realpathSync(repo));
  });

  it('普通目录自动探测回退为 directory 并给出 warning', async () => {
    const result = await addDataSource({ scope: plainScope, dir: plain, config: loadConfig() });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.type, 'directory');
    assert.equal(result.record.git, undefined);
    assert.ok((result.warnings ?? []).some((item) => item.includes('未识别为 Git 仓库')));
  });

  it('显式 --type git 在非仓库目录上 fail-loud', async () => {
    const result = await addDataSource({ scope: plainScope, dir: plain, type: 'git', config: loadConfig() });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'NOT_A_GIT_REPO');
  });

  it('v1 记录可读并按 directory 归一为 v2', () => {
    const legacyDir = path.join(dataDir, 'legacy');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'datasource.json'), JSON.stringify({
      version: 1,
      scope: 'legacy',
      dir: plain,
      group: null,
      conflictMode: 'incremental',
      conflictSuffix: '_{n}',
      vector: true,
      chunkSize: null,
      chunkOverlap: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastSync: null,
    }), 'utf8');
    const read = readDataSource('legacy');
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.record.version, 3);
    assert.equal(read.record.type, 'directory');
    // v1 记录没有 git.relativeRoot ⇒ 一条根映射（不静默丢配置）
    assert.deepEqual(read.record.mappings, [{ subdir: '', group: null }]);
  });

  it('v2 记录（单子目录 + 单 group）读取后迁移为 1 条等价映射', () => {
    const dir = path.join(dataDir, 'v2multi');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'datasource.json'), JSON.stringify({
      version: 2,
      scope: 'v2multi',
      type: 'git',
      dir: path.join(plain, 'docs'),
      git: { repoRoot: plain, relativeRoot: 'docs', branch: 'main', remoteUrl: null, managed: true, remoteBranch: null },
      group: '文档',
      conflictMode: 'incremental',
      conflictSuffix: '_{n}',
      vector: true,
      chunkSize: null,
      chunkOverlap: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastSync: null,
    }), 'utf8');
    const read = readDataSource('v2multi');
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.record.version, 3);
    assert.deepEqual(read.record.mappings, [{ subdir: 'docs', group: '文档' }]);
    // 兼容位与首条一致
    assert.equal(read.record.group, '文档');
    assert.equal(read.record.git?.relativeRoot, 'docs');
  });

  it('remove 只删登记并返回 managedCloneDir=null', async () => {
    const result = await removeDataSource(gitScope, loadConfig());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.removed, true);
    assert.equal(result.managedCloneDir, null);
    assert.equal(fs.existsSync(path.join(dataDir, gitScope, 'datasource.json')), false);
  });
});
