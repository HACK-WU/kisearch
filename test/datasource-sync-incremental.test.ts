/**
 * S-02：Git 增量同步端到端（隔离 config + 真实 git remote，FTS-only 不触网）。
 * 运行：npx jiti test/datasource-sync-incremental.test.ts
 *
 * 覆盖：首次全量 / 自动更新+增量 / 新增 tracked / untracked 不参与增量 /
 * --full 包含 untracked / 删除进候选 / SOURCE_EMPTY 自愈 / 无变化 / dry-run 零写入。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import {
  addDataSource,
  readDataSource,
  resolveDataSourceSyncState,
  syncDataSource,
} from '../src/lib/datasource.js';
import { closeFtsEngine } from '../src/lib/fts-client.js';
import { closeEngine } from '../src/lib/vector-client.js';

let root: string;
let dataDir: string;
let configPath: string;
let scope: string;
let work: string;
let publisher: string;
let savedConfigPath: string | undefined;

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

function push(dir: string): void {
  git(dir, 'push', '-q', 'origin', 'main');
}

async function sync(full = false, dryRun = false): ReturnType<typeof syncDataSource> {
  return syncDataSource({ scope, full, dryRun, config: loadConfig() });
}

function lastSync() {
  const read = readDataSource(scope);
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error(read.error);
  return read.record.lastSync;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-sync-'));
  dataDir = path.join(root, 'kb');
  configPath = path.join(root, 'config.json');
  scope = `ds-sync-${process.pid}`;
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir,
    vectorDir: path.join(root, 'vector'),
    backupDir: path.join(root, 'backup'),
    scopeMode: 'default',
    scopes: { [scope]: {} },
  }), 'utf8');
  savedConfigPath = process.env.KI_CONFIG_PATH;
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();

  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'a.md'), '# a\n');
  git(seed, 'init', '-q', '-b', 'main');
  configureRepo(seed);
  commitAll(seed, 'init');

  const remote = path.join(root, 'remote.git');
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
  await closeEngine();
  if (savedConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = savedConfigPath;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Git 增量同步', () => {
  it('首次全量同步记录 commit 水位', async () => {
    const added = await addDataSource({ scope, dir: work, vector: false, config: loadConfig() });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.equal(added.record.type, 'git');
    assert.equal(added.record.git?.managed, false);

    const result = await sync();
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;
    assert.equal(result.summary.mode, 'full');
    assert.equal(result.summary.state, 'ok');
    assert.equal(result.summary.git?.changedCount, 1);
    assert.equal(result.summary.git?.fullScanned, 1);
    assert.match(result.summary.git?.commit ?? '', /^[0-9a-f]{40}$/);
  });

  it('远端更新 + tracked 修改走增量', async () => {
    fs.writeFileSync(path.join(publisher, 'a.md'), '# a v2\n');
    commitAll(publisher, 'update a');
    push(publisher);

    const before = lastSync();
    const result = await sync();
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;
    assert.equal(result.summary.mode, 'incremental');
    assert.equal(result.summary.state, 'ok');
    assert.equal(result.summary.git?.update, 'updated');
    assert.equal(result.summary.git?.changedCount, 1);
    assert.notEqual(result.summary.git?.commit, before?.git?.commit);
    assert.match(fs.readFileSync(path.join(work, 'a.md'), 'utf8'), /a v2/);
  });

  it('新增 tracked 文件只处理变更', async () => {
    fs.writeFileSync(path.join(publisher, 'b.md'), '# b\n');
    commitAll(publisher, 'add b');
    push(publisher);

    const result = await sync();
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;
    assert.equal(result.summary.mode, 'incremental');
    assert.equal(result.summary.git?.changedCount, 1);
    assert.equal(result.summary.git?.fullScanned, 2);
    assert.equal(result.summary.state, 'ok');
  });

  it('untracked 不进入增量，但给出计数警告', async () => {
    fs.writeFileSync(path.join(work, 'c.md'), '# c\n');
    const result = await sync();
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;
    assert.equal(result.summary.mode, 'incremental');
    assert.equal(result.summary.git?.changedCount, 0);
    assert.equal(result.summary.git?.untrackedMarkdown, 1);
    assert.equal(result.summary.files?.fullScanned, 3);
    assert.equal(result.summary.files?.changed, 0);
    assert.ok(result.summary.warnings.some((item) => item.code === 'GIT_UNTRACKED_SKIPPED'));
  });

  it('--full 包含 untracked', async () => {
    const result = await sync(true);
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;
    assert.equal(result.summary.mode, 'full');
    assert.equal(result.summary.git?.changedCount, 3);
    assert.equal(result.summary.git?.fullScanned, 3);
    assert.equal(result.summary.state, 'ok');
  });

  it('删除 tracked 文件进入待删候选（与变更同批，验证 pruneSubsetFullScan）', async () => {
    // 同一批同时有 M a + D b：onlyRelPaths=[a]，候选必须仍能算出 b
    fs.writeFileSync(path.join(publisher, 'a.md'), '# a v3\n');
    fs.rmSync(path.join(publisher, 'b.md'));
    commitAll(publisher, 'update a, delete b');
    push(publisher);

    const result = await sync();
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;
    assert.equal(result.summary.mode, 'incremental');
    assert.equal(result.summary.git?.changedCount, 1);
    assert.equal(result.summary.files?.changed, 1);
    assert.equal(result.summary.pendingDelete?.total, 1);
    assert.ok(result.summary.pendingDelete?.items.some((item) => item.sourcePath === 'b.md'));
  });

  it('SOURCE_EMPTY 在远端恢复后可自愈（校验顺序）', async () => {
    // 先移除未跟踪 c，让 work 在远端删除 a 后真正为空
    fs.rmSync(path.join(work, 'c.md'), { force: true });
    fs.rmSync(path.join(publisher, 'a.md'));
    commitAll(publisher, 'delete a');
    push(publisher);

    const failed = await sync();
    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.equal(failed.code, 'SOURCE_EMPTY');
    const afterFail = lastSync();
    assert.equal(afterFail?.state, 'failed');
    const watermark = afterFail?.git?.commit;
    assert.ok(watermark);

    fs.writeFileSync(path.join(publisher, 'd.md'), '# d\n');
    commitAll(publisher, 'add d');
    push(publisher);

    const recovered = await sync();
    assert.equal(recovered.ok, true);
    if (!recovered.ok || recovered.dryRun) return;
    assert.equal(recovered.summary.state, 'ok');
    assert.notEqual(recovered.summary.git?.commit, watermark);
    assert.equal(recovered.summary.git?.changedCount, 1);
    assert.ok(fs.existsSync(path.join(work, 'd.md')));
  });

  it('无变化同步不导入、不推进文件变更', async () => {
    const before = lastSync();
    const result = await sync();
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;
    assert.equal(result.summary.mode, 'incremental');
    assert.equal(result.summary.git?.changedCount, 0);
    assert.equal(result.summary.files?.scanned, 0);
    assert.equal(result.summary.files?.fullScanned, 1);
    assert.equal(result.summary.git?.commit, before?.git?.commit);
  });

  it('dry-run 零写入', async () => {
    const file = path.join(dataDir, scope, 'datasource.json');
    const before = fs.readFileSync(file, 'utf8');
    const result = await sync(false, true);
    assert.equal(result.ok, true);
    if (!result.ok || !result.dryRun) return;
    assert.equal(result.mode, 'incremental');
    assert.equal(result.changedFiles, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

describe('resolveDataSourceSyncState', () => {
  it('stats.errors > 0 视为 partial（commit 不推进）', () => {
    assert.equal(resolveDataSourceSyncState({ cancelled: false, partial: false, stats: { errors: 1 } }), 'partial');
  });

  it('cancelled / partial / ok 三态', () => {
    assert.equal(resolveDataSourceSyncState({ cancelled: true, partial: false, stats: { errors: 0 } }), 'cancelled');
    assert.equal(resolveDataSourceSyncState({ cancelled: false, partial: true, stats: { errors: 0 } }), 'partial');
    assert.equal(resolveDataSourceSyncState({ cancelled: false, partial: false, stats: { errors: 0 } }), 'ok');
  });
});
