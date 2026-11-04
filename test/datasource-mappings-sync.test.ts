/**
 * 多映射同步端到端（REQ-20261104-002 / 工作项 16）
 *
 * 走**真实链路**（真 git 仓库 + 真实导入 + FTS-only 不触网），验证四件单测覆盖不到的事：
 *  1. 两条映射各自把文档落进自己的 Group，未映射目录**不入库**（R2 / A3）；
 *  2. `seenRels` 落盘是**分桶键**（`subdir/rel`），不是裸 rel（护栏 #2）；
 *  3. 增量只在变化的那个子目录里跑（另一条映射无变更）；
 *  4. **删除候选的 token 与重算结果一致** —— 否则页面「删除」永远 403（护栏 #2 的可删性）。
 *
 * 运行：npx jiti test/datasource-mappings-sync.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import { addDataSource, readDataSource, syncDataSource, updateDataSourceConfig } from '../src/lib/datasource.js';
import { planDatasourcePrune } from '../src/lib/datasource-prune.js';
import { readAllGroupCaches } from '../src/lib/group-cache.js';
import { closeFtsEngine } from '../src/lib/fts-client.js';
import { closeEngine } from '../src/lib/vector-client.js';

let root: string;
let dataDir: string;
let configPath: string;
let scope: string;
let repo: string;
let savedConfigPath: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
}

function commitAll(message: string): void {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

async function sync(full = false): ReturnType<typeof syncDataSource> {
  return syncDataSource({ scope, full, config: loadConfig() });
}

function record() {
  const read = readDataSource(scope);
  assert.equal(read.ok, true);
  if (!read.ok) throw new Error(read.error);
  return read.record;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-mapsync-'));
  dataDir = path.join(root, 'kb');
  configPath = path.join(root, 'config.json');
  scope = `ds-mapsync-${process.pid}`;
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
  fs.mkdirSync(path.join(repo, 'docs', 'other'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'guide', 'g.md'), '# guide\n');
  fs.writeFileSync(path.join(repo, 'docs', 'api', 'a.md'), '# api\n');
  fs.writeFileSync(path.join(repo, 'docs', 'other', 'o.md'), '# other\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  commitAll('init');
});

after(async () => {
  await closeFtsEngine();
  await closeEngine();
  if (savedConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = savedConfigPath;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('多映射同步（真实链路）', () => {
  it('首次全量：两条映射各自落 Group，未映射目录不入库，基线分桶落盘', async () => {
    const added = await addDataSource({
      scope,
      dir: path.join(repo, 'docs', 'guide'),
      type: 'git',
      gitInfo: {
        repoRoot: fs.realpathSync(repo),
        relativeRoot: 'docs/guide',
        branch: 'main',
        remoteUrl: null,
        managed: false,
        remoteBranch: null,
      },
      mappings: [
        { subdir: 'docs/guide', group: '指南' },
        { subdir: 'docs/api', group: 'API 文档' },
      ],
      vector: false,
      config: loadConfig(),
    });
    assert.equal(added.ok, true);
    if (!added.ok) return;

    const result = await sync(true);
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;
    assert.equal(result.summary.state, 'ok');
    // 只扫被映射的两个子目录
    assert.equal(result.summary.files.scanned, 2);
    assert.deepEqual([...result.summary.groups].sort(), ['API 文档', '指南'].sort());

    // 基线是分桶键（护栏 #2）
    assert.deepEqual(record().lastSync?.seenRels, ['docs/api/a.md', 'docs/guide/g.md']);
    // 兼容位跟随首条映射
    assert.equal(record().group, '指南');
    assert.equal(record().git?.relativeRoot, 'docs/guide');
    assert.deepEqual(record().lastSync?.params.mappings, [
      { subdir: 'docs/guide', group: '指南' },
      { subdir: 'docs/api', group: 'API 文档' },
    ]);

    // 真的落进了各自的 Group（读 relations-cache），且未映射目录没进来
    const groups = readAllGroupCaches(scope);
    const names = [...groups.keys()];
    assert.ok(names.includes('指南'), `实际分组：${names.join(', ')}`);
    assert.ok(names.includes('API 文档'), `实际分组：${names.join(', ')}`);
    const relationsOf = (group: string): string[] =>
      (groups.get(group)?.hot_relations ?? []).map((item) => item.text);
    assert.deepEqual(relationsOf('指南'), ['g']);
    assert.deepEqual(relationsOf('API 文档'), ['a']);
    assert.ok(!names.some((name) => name.includes('other')), `未映射目录不该入库：${names.join(', ')}`);
  });

  it('dry-run：只读（不改 lastSync、不动工作树），汇总两条映射的计划数', async () => {
    const before = record().lastSync?.at;
    const beforeCommit = fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8');
    const dry = await syncDataSource({ scope, full: true, dryRun: true, config: loadConfig() });
    assert.equal(dry.ok, true);
    if (!dry.ok || dry.dryRun !== true) return;
    assert.equal(dry.plannedFiles, 2);
    assert.equal(dry.mode, 'full');
    // 只读语义：快照未变、仓库 HEAD 未变
    assert.equal(record().lastSync?.at, before);
    assert.equal(fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8'), beforeCommit);
  });

  it('增量：只改一个子目录时，另一条映射没有变更', async () => {
    fs.writeFileSync(path.join(repo, 'docs', 'api', 'b.md'), '# api b\n');
    commitAll('add api/b');

    const result = await sync();
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;
    assert.equal(result.summary.state, 'ok');
    assert.equal(result.summary.mode, 'incremental');
    // 只有 docs/api 这一条有变更
    assert.equal(result.summary.files.changed, 1);
    assert.deepEqual(record().lastSync?.seenRels, ['docs/api/a.md', 'docs/api/b.md', 'docs/guide/g.md']);
  });

  it('删除文件后候选与重算 token 一致（否则页面删除永远 403）', async () => {
    fs.rmSync(path.join(repo, 'docs', 'api', 'b.md'));
    commitAll('drop api/b');

    const result = await sync();
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;

    const pending = record().lastSync?.pendingDelete;
    assert.equal(pending?.total, 1);
    assert.equal(pending?.items[0]?.relation, 'b');
    assert.ok(pending?.token, '有候选就必须有 token');

    const replan = planDatasourcePrune({ scope, config: loadConfig() });
    assert.equal(replan.ok, true);
    if (!replan.ok) return;
    assert.equal(replan.plan.total, 1);
    assert.equal(replan.plan.token, pending?.token, '重算 token 必须与落盘 token 相同');
  });

  it('编辑删掉一条映射后再同步：不崩、只剩一条映射生效', async () => {
    const updated = await updateDataSourceConfig({
      scope,
      patch: { mappings: [{ subdir: 'docs/api', group: 'API 文档' }] },
      config: loadConfig(),
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) return;

    const result = await sync(true);
    assert.equal(result.ok, true);
    if (!result.ok || result.dryRun) return;
    assert.equal(result.summary.state, 'ok');
    assert.equal(record().mappings.length, 1);
    assert.deepEqual(record().mappings, [{ subdir: 'docs/api', group: 'API 文档' }]);
    // 只剩 API 文档这一条映射被扫描
    assert.equal(result.summary.groups.length, 1);
    assert.equal(result.summary.groups[0], 'API 文档');
  });
});
