/**
 * 共享托管 clone：路径推导与引用计数（不依赖向量引擎/网络）。
 * 运行：npx jiti test/datasource-shared-clone.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import { countManagedRepoRefs, findReusableManagedClone } from '../src/lib/datasource.js';
import { managedCloneDirForRepo, managedCloneDirOf } from '../src/lib/datasource-clone.js';

let root: string;
let dataDir: string;
let cloneRoot: string;
let configPath: string;
let savedConfigPath: string | undefined;
let savedCloneRoot: string | undefined;

function record(scope: string, repoRoot: string, managed = true, remoteUrl = 'https://example.com/repo.git', remoteBranch = 'main'): Record<string, unknown> {
  return {
    version: 2,
    scope,
    type: 'git',
    dir: path.join(repoRoot, 'docs'),
    git: {
      repoRoot,
      relativeRoot: 'docs',
      branch: remoteBranch,
      remoteUrl,
      managed,
      remoteBranch,
    },
    group: null,
    conflictMode: 'incremental',
    conflictSuffix: '_{n}',
    vector: false,
    chunkSize: null,
    chunkOverlap: null,
    createdAt: 0,
    updatedAt: 0,
    lastSync: null,
  };
}

function writeScope(scope: string, data: Record<string, unknown>): void {
  const dir = path.join(dataDir, scope);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'datasource.json'), JSON.stringify(data));
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-shared-'));
  dataDir = path.join(root, 'kb');
  cloneRoot = path.join(root, 'datasources');
  configPath = path.join(root, 'config.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir,
    vectorDir: path.join(root, 'vector'),
    backupDir: path.join(root, 'backup'),
    scopeMode: 'default',
    scopes: {},
  }), 'utf8');
  savedConfigPath = process.env.KI_CONFIG_PATH;
  savedCloneRoot = process.env.KI_DATASOURCE_CLONE_ROOT;
  process.env.KI_CONFIG_PATH = configPath;
  process.env.KI_DATASOURCE_CLONE_ROOT = cloneRoot;
  resetConfigCache();
});

after(() => {
  if (savedConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = savedConfigPath;
  if (savedCloneRoot === undefined) delete process.env.KI_DATASOURCE_CLONE_ROOT;
  else process.env.KI_DATASOURCE_CLONE_ROOT = savedCloneRoot;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('共享托管 clone', () => {
  it('repoRoot 属于其他 scope 时，managedCloneDirOf 仍指向实际 clone 目录', () => {
    const repoRoot = path.join(cloneRoot, 'owner', 'repo');
    const shared = record('other', repoRoot);
    assert.equal(managedCloneDirForRepo(repoRoot), path.join(cloneRoot, 'owner'));
    assert.equal(managedCloneDirOf(shared as never), path.join(cloneRoot, 'owner'));
    assert.equal(managedCloneDirForRepo(path.join(cloneRoot, 'owner', 'nested', 'repo')), null);
    assert.equal(managedCloneDirForRepo(path.join(root, 'outside', 'repo')), null);
  });

  it('引用计数覆盖多个 managed scope，忽略非 managed 记录', () => {
    const repoRoot = path.join(cloneRoot, 'owner', 'repo');
    writeScope('owner', record('owner', repoRoot));
    writeScope('shared-a', record('shared-a', repoRoot));
    writeScope('plain', record('plain', repoRoot, false));

    assert.equal(countManagedRepoRefs(repoRoot, loadConfig()), 2);
    assert.equal(countManagedRepoRefs(repoRoot, loadConfig(), 'owner'), 1);
    assert.equal(countManagedRepoRefs(repoRoot, loadConfig(), 'shared-a'), 1);
    assert.equal(countManagedRepoRefs(path.join(cloneRoot, 'none', 'repo'), loadConfig()), 0);
  });

  it('复用判据：URL 归一 + 远端分支一致 + 只认受控托管布局', () => {
    const repoRoot = path.join(cloneRoot, 'reuse-1', 'repo');
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    writeScope('reuse-1', record('reuse-1', repoRoot, true, 'https://example.com/reuse1.git'));

    assert.equal(findReusableManagedClone(loadConfig(), 'https://example.com/reuse1', 'main')?.repoRoot, repoRoot);
    assert.equal(findReusableManagedClone(loadConfig(), 'https://example.com/reuse1.git', 'dev'), null);

    // repoRoot 不在 clone 根布局内（记录可被手工编辑）⇒ 不得复用，否则 purge/引用计数失效
    const outsideRoot = path.join(root, 'outside-repo');
    fs.mkdirSync(path.join(outsideRoot, 'docs'), { recursive: true });
    writeScope('outside', record('outside', outsideRoot, true, 'https://example.com/outside.git'));
    assert.equal(findReusableManagedClone(loadConfig(), 'https://example.com/outside.git', 'main'), null);

    // 同一 URL 已存在多个不同分支的副本且未指定分支 ⇒ 不猜默认分支
    const mainRoot = path.join(cloneRoot, 'ambig-a', 'repo');
    const devRoot = path.join(cloneRoot, 'ambig-b', 'repo');
    fs.mkdirSync(path.join(mainRoot, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(devRoot, 'docs'), { recursive: true });
    writeScope('ambig-a', record('ambig-a', mainRoot, true, 'https://example.com/ambig.git', 'main'));
    writeScope('ambig-b', record('ambig-b', devRoot, true, 'https://example.com/ambig.git', 'dev'));
    assert.equal(findReusableManagedClone(loadConfig(), 'https://example.com/ambig.git', null), null);
    assert.equal(findReusableManagedClone(loadConfig(), 'https://example.com/ambig.git', 'dev')?.repoRoot, devRoot);
  });
});
