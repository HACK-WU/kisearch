/**
 * 多映射的**写入口**集成测试（REQ-20261104-002：R1 / R4 / R5 / R9）
 *
 * 覆盖三件纯单测覆盖不到的事：
 *  1. 带 `mappings` 登记后，记录里 `dir` / `group` / `git.relativeRoot` 三个兼容位跟随**首条**；
 *  2. **CLI 写入口（不传 mappings）遇到多映射记录必须拒绝**，且不写坏已有的 N 条（护栏 #4 / R9）；
 *  3. 编辑（`updateDataSourceConfig`）可整体替换映射，且落点变了就作废旧候选（token 不能跨落点复用）。
 *
 * 运行：npx jiti test/datasource-mappings-write.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import { addDataSource, readDataSource, updateDataSourceConfig } from '../src/lib/datasource.js';

let root: string;
let dataDir: string;
let configPath: string;
let repo: string;
let scope: string;
let savedConfigPath: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-mappings-'));
  dataDir = path.join(root, 'kb');
  configPath = path.join(root, 'config.json');
  scope = `ds-map-${process.pid}`;
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

  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'docs', 'guide'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs', 'api'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'guide', 'g.md'), '# g\n');
  fs.writeFileSync(path.join(repo, 'docs', 'api', 'a.md'), '# a\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
});

after(() => {
  if (savedConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = savedConfigPath;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

const gitInfo = (): { repoRoot: string; relativeRoot: string; branch: string | null; remoteUrl: string | null; managed: boolean; remoteBranch: string | null } => ({
  repoRoot: fs.realpathSync(repo),
  relativeRoot: 'docs/guide',
  branch: 'main',
  remoteUrl: null,
  managed: false,
  remoteBranch: null,
});

describe('多映射写入口', () => {
  it('登记 2 条映射：落盘保留全部映射，三个兼容位跟随首条', async () => {
    const result = await addDataSource({
      scope,
      dir: path.join(repo, 'docs', 'guide'),
      type: 'git',
      gitInfo: gitInfo(),
      mappings: [
        { subdir: 'docs/guide', group: '指南' },
        { subdir: 'docs/api', group: 'API 文档' },
      ],
      config: loadConfig(),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.record.mappings, [
      { subdir: 'docs/guide', group: '指南' },
      { subdir: 'docs/api', group: 'API 文档' },
    ]);
    assert.equal(result.record.group, '指南');
    assert.equal(result.record.git?.relativeRoot, 'docs/guide');
    assert.equal(result.record.version, 3);
  });

  it('CLI 写入口（不传 mappings）遇多映射记录：拒绝且不写坏已有映射（护栏 #4 / R9）', async () => {
    const before = readDataSource(scope);
    assert.equal(before.ok, true);
    if (!before.ok) return;

    const result = await addDataSource({
      scope,
      dir: path.join(repo, 'docs', 'guide'),
      type: 'git',
      gitInfo: gitInfo(),
      group: '指南',
      force: true,
      config: loadConfig(),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'MULTI_MAPPING_UNSUPPORTED');

    // 关键：报错后原记录必须是**原样 2 条**
    const after = readDataSource(scope);
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.equal(after.record.mappings.length, 2);
  });

  it('编辑可整体替换映射，并作废旧候选（token 不能跨落点复用）', async () => {
    // 先塞一个假的旧候选，验证落点变更会作废它
    const read = readDataSource(scope);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const { writeDataSource } = await import('../src/lib/datasource.js');
    writeDataSource(scope, {
      ...read.record,
      lastSync: {
        at: Date.now(),
        durationMs: 1,
        state: 'ok',
        params: {
          group: '指南',
          conflictMode: read.record.conflictMode,
          vector: read.record.vector,
          chunkSize: null,
          chunkOverlap: null,
          mode: 'full',
        },
        result: {
          files: {
            scanned: 0, fullScanned: 0, changed: 0, completed: 0,
            unchanged: 0, skipped: 0, incomplete: 0, duplicatesSkipped: 0,
          },
          vectorized: 0,
          fullTextIndexed: 0,
          groups: [],
          conflicts: [],
          failures: [],
        },
        seenRels: [],
        // 预置 commit 水位：改映射后必须被丢掉，否则新增子目录只 diff「上次 commit 之后」的变更，
        // 它历史上已有的文件永远导不进来（P0）
        git: {
          commit: 'deadbeef',
          runCommit: 'deadbeef',
          shortCommit: 'deadbee',
          subject: 'seed',
          authorTime: null,
          changedCount: 0,
          fullScanned: 0,
          untrackedMarkdown: 0,
          update: 'up-to-date',
          fetch: 'ok',
        },
        pendingDelete: {
          computedAt: 1,
          total: 1,
          overLimit: false,
          truncated: false,
          items: [{ group: '指南', relation: 'gone' }],
          candidateSourcePaths: ['gone.md'],
          untouchedGroups: [],
          unableCount: 0,
          eligibleCount: 1,
          stale: false,
          staleReason: null,
          blocked: null,
          token: 'tk-old',
        },
      },
    });

    const updated = await updateDataSourceConfig({
      scope,
      patch: { mappings: [{ subdir: 'docs', group: '文档' }] },
      config: loadConfig(),
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.ok(updated.changed.includes('mappings'));
    assert.deepEqual(updated.record.mappings, [{ subdir: 'docs', group: '文档' }]);
    // 兼容位跟随新的首条
    assert.equal(updated.record.group, '文档');
    assert.equal(updated.record.git?.relativeRoot, 'docs');
    assert.equal(updated.record.dir, path.join(fs.realpathSync(repo), 'docs'));
    // 旧候选作废
    assert.equal(updated.record.lastSync?.pendingDelete.total, 0);
    assert.equal(updated.record.lastSync?.pendingDelete.token, undefined);
    assert.equal(updated.record.lastSync?.pendingDelete.stale, true);
    // commit 水位必须一并丢掉（下次退回全量）——否则新映射的历史文件永远不会被导入
    assert.equal(updated.record.lastSync?.git, undefined);
  });

  it('登记时传空 mappings 数组：报 MAPPING_EMPTY，不静默变成一条根映射', async () => {
    const result = await addDataSource({
      scope: `ds-map-empty-${process.pid}`,
      dir: path.join(repo, 'docs', 'guide'),
      type: 'git',
      gitInfo: gitInfo(),
      mappings: [],
      config: loadConfig(),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'MAPPING_EMPTY');
  });

  it('编辑校验：互相包含 / 空数组 / 超上限都被拒，且不落盘', async () => {
    const before = readDataSource(scope);
    assert.equal(before.ok, true);
    if (!before.ok) return;

    const overlap = await updateDataSourceConfig({
      scope,
      patch: { mappings: [{ subdir: 'docs', group: 'a' }, { subdir: 'docs/guide', group: 'b' }] },
      config: loadConfig(),
    });
    assert.equal(overlap.ok, false);
    if (overlap.ok) return;
    assert.equal(overlap.code, 'MAPPING_OVERLAP');

    const empty = await updateDataSourceConfig({
      scope,
      patch: { mappings: [] },
      config: loadConfig(),
    });
    assert.equal(empty.ok, false);
    if (empty.ok) return;
    assert.equal(empty.code, 'MAPPING_EMPTY');

    const tooMany = await updateDataSourceConfig({
      scope,
      patch: { mappings: Array.from({ length: 21 }, (_, i) => ({ subdir: `d${i}`, group: null })) },
      config: loadConfig(),
    });
    assert.equal(tooMany.ok, false);
    if (tooMany.ok) return;
    assert.equal(tooMany.code, 'MAPPING_LIMIT');

    const after = readDataSource(scope);
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.deepEqual(after.record.mappings, before.record.mappings);
  });
});
