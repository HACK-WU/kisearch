/**
 * S-05：托管 clone 的同步语义（隔离 config + 本地 bare remote，FTS-only 不触网）。
 *
 * 核心不变量：托管副本每次同步 = fetch → reset --hard origin/<branch> → clean -fdx，
 * 导入前必须是远端镜像（本地未提交改动被丢弃、未跟踪 md 不进入导入）。
 * 本地 Git 源（managed=false）走 ff-only，本文件不覆盖（见 datasource-sync-incremental）。
 *
 * 运行：npx jiti test/datasource-sync-managed.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import { addRemoteDataSource, readDataSource, syncDataSource } from '../src/lib/datasource.js';
import { closeFtsEngine } from '../src/lib/fts-client.js';

let root: string;
let configPath: string;
let scope: string;
let work: string;
let remote: string;
let publisher: string;
let repoRoot: string;
let savedConfigPath: string | undefined;
let savedCloneRoot: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
}

function gitRaw(args: string[], cwd = root): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
}

function configureRepo(dir: string): void {
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-managed-'));
  scope = `ds-managed-${process.pid}`;
  configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir: path.join(root, 'kb'),
    vectorDir: path.join(root, 'vector'),
    backupDir: path.join(root, 'backup'),
    scopeMode: 'default',
    scopes: { [scope]: {} },
  }), 'utf8');
  savedConfigPath = process.env.KI_CONFIG_PATH;
  savedCloneRoot = process.env.KI_DATASOURCE_CLONE_ROOT;
  process.env.KI_CONFIG_PATH = configPath;
  process.env.KI_DATASOURCE_CLONE_ROOT = path.join(root, 'datasources');
  resetConfigCache();

  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'a.md'), '# a\n');
  git(seed, 'init', '-q', '-b', 'main');
  configureRepo(seed);
  commitAll(seed, 'init');

  remote = path.join(root, 'remote.git');
  gitRaw(['clone', '--bare', '-q', seed, remote]);
  work = path.join(root, 'work');
  publisher = path.join(root, 'publisher');
  gitRaw(['clone', '-q', remote, work]);
  gitRaw(['clone', '-q', remote, publisher]);
  configureRepo(work);
  configureRepo(publisher);
});

after(async () => {
  await closeFtsEngine();
  if (savedConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = savedConfigPath;
  if (savedCloneRoot === undefined) delete process.env.KI_DATASOURCE_CLONE_ROOT;
  else process.env.KI_DATASOURCE_CLONE_ROOT = savedCloneRoot;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('托管 clone 同步', () => {
  it('clone + 登记 + 首次全量', async () => {
    const added = await addRemoteDataSource({
      scope,
      url: `file://${remote}`,
      config: loadConfig(),
      allowFileUrl: true,
      vector: false,
    });
    assert.equal(added.ok, true, added.ok ? '' : added.error);
    if (!added.ok) return;
    assert.equal(added.record.git?.managed, true);
    assert.equal(added.record.git?.remoteBranch, 'main');
    repoRoot = added.clone.repoRoot;

    const first = await syncDataSource({ scope, config: loadConfig() });
    assert.equal(first.ok, true);
    if (!first.ok || first.dryRun) return;
    assert.equal(first.summary.mode, 'full');
    assert.equal(first.summary.state, 'ok');
  });

  it('增量同步前 reset --hard + clean -fdx：本地改动被丢弃、未跟踪 md 不进入导入', async () => {
    // 托管副本里制造「脏」状态：修改 tracked + 新增 untracked md（都不应被导入）
    fs.writeFileSync(path.join(repoRoot, 'a.md'), '# local dirty\n');
    fs.writeFileSync(path.join(repoRoot, 'stray.md'), '# stray\n');

    // 远端新增 b.md（唯一真实变更）
    fs.writeFileSync(path.join(publisher, 'b.md'), '# b\n');
    commitAll(publisher, 'add b');
    git(publisher, 'push', '-q', 'origin', 'main');

    const result = await syncDataSource({ scope, config: loadConfig() });
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;
    assert.equal(result.summary.mode, 'incremental');
    assert.equal(result.summary.state, 'ok');
    assert.equal(result.summary.git?.changedCount, 1, '只有远端 b.md 进入变更集');
    assert.equal(result.summary.files?.changed, 1);

    // 托管副本已回到远端镜像：stray 被 clean、本地改动被 reset、工作区干净
    assert.equal(fs.existsSync(path.join(repoRoot, 'stray.md')), false, '未跟踪文件应被 clean -fdx 删除');
    assert.equal(fs.readFileSync(path.join(repoRoot, 'a.md'), 'utf8'), '# a\n', '本地改动应被 reset --hard 丢弃');
    assert.equal(git(repoRoot, 'status', '--porcelain').trim(), '', '托管副本工作区应为干净镜像');
    assert.equal(fs.existsSync(path.join(repoRoot, 'b.md')), true);

    // 登记仍为托管，commit 水位推进
    const read = readDataSource(scope);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.record.git?.managed, true);
    assert.equal(read.record.lastSync?.git?.update, 'updated');
    assert.equal(read.record.lastSync?.git?.changedCount, 1);
  });
});
