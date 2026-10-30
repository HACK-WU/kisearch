/**
 * S-05：托管 clone 端到端回归（本地 bare 仓库 + 临时 HOME，不触网、不碰真实 ~/.ki）。
 * 运行：npx jiti test/datasource-clone.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { useTempHomeAt, type TempHome } from './isolate-home.js';
import type { KiConfig } from '../src/lib/config.js';
import type { CloneManagedInput, CloneResult } from '../src/lib/datasource-clone.js';

type CloneModule = typeof import('../src/lib/datasource-clone.js');
let clone: CloneModule;

let tmpHome: string;
let root: string;
let bare: string;
let emptyBare: string;
let symBare: string;
let config: KiConfig;
let tempHome: TempHome;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
}

function cloneInput(scope: string, extra: Partial<CloneManagedInput> = {}): CloneManagedInput {
  return { scope, url: `file://${bare}`, config, allowFileUrl: true, ...extra };
}

function repoDirOf(scope: string): string {
  return path.join(tmpHome, '.ki', 'datasources', scope, 'repo');
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-clone-'));
  tmpHome = path.join(root, 'home');
  fs.mkdirSync(tmpHome, { recursive: true });
  // 仓库常量在模块加载时读取 homedir ⇒ 先挂临时家目录（HOME + USERPROFILE）再动态 import
  tempHome = useTempHomeAt(tmpHome);
  clone = await import('../src/lib/datasource-clone.js');

  const work = path.join(root, 'work');
  fs.mkdirSync(path.join(work, 'docs', 'guide'), { recursive: true });
  fs.writeFileSync(path.join(work, 'README.md'), '# root\n');
  fs.writeFileSync(path.join(work, 'docs', 'a.md'), '# a\n');
  fs.writeFileSync(path.join(work, 'docs', 'guide', 'b.md'), '# b\n');
  fs.writeFileSync(path.join(work, 'docs', 'note.txt'), 'not importable\n');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'config', 'commit.gpgsign', 'false');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'checkout', '-q', '-b', 'feature/x');
  fs.writeFileSync(path.join(work, 'docs', 'feature.md'), '# feature\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'feature');
  git(work, 'checkout', '-q', 'main');
  git(work, 'tag', 'v1.0');

  bare = path.join(root, 'bare.git');
  execFileSync('git', ['clone', '-q', '--bare', work, bare], { encoding: 'utf8' });

  // 空仓库（没有任何可导入文件）
  const emptyWork = path.join(root, 'empty');
  fs.mkdirSync(emptyWork, { recursive: true });
  fs.writeFileSync(path.join(emptyWork, 'note.txt'), 'x');
  git(emptyWork, 'init', '-q', '-b', 'main');
  git(emptyWork, 'config', 'user.email', 'test@example.com');
  git(emptyWork, 'config', 'user.name', 'Test');
  git(emptyWork, 'config', 'commit.gpgsign', 'false');
  git(emptyWork, 'add', '.');
  git(emptyWork, 'commit', '-q', '-m', 'init');
  emptyBare = path.join(root, 'empty.git');
  execFileSync('git', ['clone', '-q', '--bare', emptyWork, emptyBare], { encoding: 'utf8' });

  // 子目录 symlink 指向仓库外（仓库内容可控）：不得把宿主机目录当导入源
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.md'), '# secret\n');
  const symWork = path.join(root, 'sym-work');
  fs.mkdirSync(symWork, { recursive: true });
  fs.symlinkSync(outside, path.join(symWork, 'docs'), 'dir');
  git(symWork, 'init', '-q', '-b', 'main');
  git(symWork, 'config', 'user.email', 'test@example.com');
  git(symWork, 'config', 'user.name', 'Test');
  git(symWork, 'config', 'commit.gpgsign', 'false');
  git(symWork, 'add', '.');
  git(symWork, 'commit', '-q', '-m', 'symlink docs');
  symBare = path.join(root, 'sym.git');
  execFileSync('git', ['clone', '-q', '--bare', symWork, symBare], { encoding: 'utf8' });

  config = {
    dataDir: path.join(root, 'kb'),
    scopes: {},
    scopeMode: 'default',
  } as unknown as KiConfig;
});

after(() => {
  tempHome.restore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cloneManagedRepo', () => {
  it('clone 成功：托管目录、子目录、分支与 HEAD 均正确', async () => {
    const result = await clone.cloneManagedRepo(cloneInput('clone-ok', { subdir: 'docs' }));
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.equal(result.value.repoRoot, repoDirOf('clone-ok'));
    assert.equal(result.value.dir, path.join(repoDirOf('clone-ok'), 'docs'));
    assert.equal(result.value.branch, 'main');
    assert.match(result.value.headCommit ?? '', /^[0-9a-f]{40}$/);
    assert.equal(fs.existsSync(path.join(result.value.repoRoot, '.git')), true);
    assert.equal(fs.readFileSync(path.join(result.value.dir, 'a.md'), 'utf8'), '# a\n');
    // 仓库级文件也应克隆下来（子目录只是导入根）
    assert.equal(fs.existsSync(path.join(result.value.repoRoot, 'README.md')), true);
  });

  it('指定分支 clone', async () => {
    const result = await clone.cloneManagedRepo(cloneInput('clone-branch', { branch: 'feature/x', subdir: 'docs' }));
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    if (!result.ok) return;
    assert.equal(result.value.branch, 'feature/x');
    assert.equal(fs.existsSync(path.join(result.value.dir, 'feature.md')), true);
  });

  it('同一 scope 重复 clone 拒绝（CLONE_TARGET_EXISTS）', async () => {
    const result = await clone.cloneManagedRepo(cloneInput('clone-ok'));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'CLONE_TARGET_EXISTS');
  });

  it('--branch 传 tag → INVALID_BRANCH（不生成 detached 托管副本）', async () => {
    const result = await clone.cloneManagedRepo(cloneInput('clone-tag-branch', { branch: 'v1.0' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'INVALID_BRANCH');
    assert.equal(fs.existsSync(repoDirOf('clone-tag-branch')), false);
  });

  it('分支不存在 → GIT_BRANCH_NOT_FOUND 且不残留临时目录', async () => {
    const result = await clone.cloneManagedRepo(cloneInput('clone-bad-branch', { branch: 'no/such' }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'GIT_BRANCH_NOT_FOUND');
    const scopeDir = path.join(tmpHome, '.ki', 'datasources', 'clone-bad-branch');
    const leftovers = fs.existsSync(scopeDir) ? fs.readdirSync(scopeDir) : [];
    assert.deepEqual(leftovers, []);
  });

  it('仓库不存在 → GIT_REPO_NOT_FOUND', async () => {
    const result = await clone.cloneManagedRepo(cloneInput('clone-missing', { url: `file://${path.join(root, 'nope.git')}` }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'GIT_REPO_NOT_FOUND');
  });

  it('子目录不存在 → INVALID_SUBDIR；子目录无可导入文件 → SOURCE_EMPTY', async () => {
    const missing = await clone.cloneManagedRepo(cloneInput('clone-no-subdir', { subdir: 'not-here' }));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'INVALID_SUBDIR');

    const empty = await clone.cloneManagedRepo(cloneInput('clone-empty-subdir', { subdir: 'docs/empty-dir' }));
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, 'INVALID_SUBDIR');

    const emptyRepo = await clone.cloneManagedRepo({
      scope: 'clone-empty-repo', url: `file://${emptyBare}`, config, allowFileUrl: true,
    });
    assert.equal(emptyRepo.ok, false);
    if (!emptyRepo.ok) assert.equal(emptyRepo.code, 'SOURCE_EMPTY');
  });

  it('非法子目录在 clone 前拒绝（INVALID_SUBDIR，零写盘）', async () => {
    for (const subdir of ['../escape', '/abs', '.git', 'a/../b']) {
      const result = await clone.cloneManagedRepo(cloneInput('clone-bad-subdir', { subdir }));
      assert.equal(result.ok, false, subdir);
      if (!result.ok) assert.equal(result.code, 'INVALID_SUBDIR');
    }
    assert.equal(fs.existsSync(path.join(tmpHome, '.ki', 'datasources', 'clone-bad-subdir', 'repo')), false);
  });

  it('子目录是 symlink 且越出仓库 → INVALID_SUBDIR（不把宿主机目录当导入源）', async () => {
    const result = await clone.cloneManagedRepo(cloneInput('clone-symlink-subdir', {
      url: `file://${symBare}`, subdir: 'docs',
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'INVALID_SUBDIR');
    assert.equal(fs.existsSync(repoDirOf('clone-symlink-subdir')), false);
  });

  it('生产路径（allowFile=false）拒绝 file://', async () => {
    const result = await clone.cloneManagedRepo({
      scope: 'clone-no-file', url: `file://${bare}`, config,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'GIT_SCHEME_UNSUPPORTED');
  });

  it('clone 目录位于 dataDir 内时拒绝（CLONE_DIR_INSIDE_DATA_DIR）', async () => {
    // dataDir 覆盖到 HOME ⇒ 托管根 tmpHome/.ki/datasources/<scope> 落在其内部
    const badConfig = { ...config, dataDir: tmpHome } as unknown as KiConfig;
    const result = await clone.cloneManagedRepo({
      scope: 'clone-inside-data', url: `file://${bare}`, config: badConfig, allowFileUrl: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'CLONE_DIR_INSIDE_DATA_DIR');
    assert.equal(fs.existsSync(path.join(tmpHome, '.ki', 'datasources', 'clone-inside-data', 'repo')), false);
  });

  it('清理过期临时目录（>1h）但保留新目录', async () => {
    const scopeDir = path.join(tmpHome, '.ki', 'datasources', 'clone-stale');
    fs.mkdirSync(scopeDir, { recursive: true });
    const oldTmp = path.join(scopeDir, '.tmp-repo-old');
    const newTmp = path.join(scopeDir, '.tmp-repo-new');
    fs.mkdirSync(oldTmp);
    fs.mkdirSync(newTmp);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);
    const result = await clone.cloneManagedRepo(cloneInput('clone-stale'));
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    assert.equal(fs.existsSync(oldTmp), false);
    assert.equal(fs.existsSync(newTmp), true);
  });
});

describe('managedCloneDirOf / purgeManagedCloneDir', () => {
  it('非托管记录返回 null；托管记录推导出 scope 目录', () => {
    const base = {
      scope: 'scope-a', version: 2, type: 'git', dir: '/tmp/x', group: null,
      conflictMode: 'incremental', conflictSuffix: '_1', vector: true,
      chunkSize: null, chunkOverlap: null, createdAt: 0, updatedAt: 0,
    } as const;
    const notManaged = clone.managedCloneDirOf({ ...base, git: { managed: false, repoRoot: '/x', relativeRoot: '' } } as never);
    assert.equal(notManaged, null);
    const mismatched = clone.managedCloneDirOf({
      ...base, git: { managed: true, repoRoot: '/elsewhere/repo', relativeRoot: '' },
    } as never);
    assert.equal(mismatched, null);
    const managed = clone.managedCloneDirOf({
      ...base, git: { managed: true, repoRoot: repoDirOf('scope-a'), relativeRoot: '' },
    } as never);
    assert.equal(managed, path.join(tmpHome, '.ki', 'datasources', 'scope-a'));
  });

  it('purge 只删托管根内目录，拒绝外部路径与符号链接', async () => {
    const okDir = path.join(tmpHome, '.ki', 'datasources', 'purge-ok');
    fs.mkdirSync(path.join(okDir, 'repo'), { recursive: true });
    const removed = await clone.purgeManagedCloneDir(okDir);
    assert.deepEqual(removed, { removed: true });
    assert.equal(fs.existsSync(okDir), false);

    const outside = await clone.purgeManagedCloneDir(path.join(root, 'work'));
    assert.equal(outside.removed, false);
    assert.equal(fs.existsSync(path.join(root, 'work')), true);

    const linkScope = path.join(tmpHome, '.ki', 'datasources', 'purge-link');
    fs.mkdirSync(linkScope, { recursive: true });
    const link = path.join(linkScope, 'link');
    fs.symlinkSync(path.join(root, 'work'), link, 'dir');
    const linked = await clone.purgeManagedCloneDir(link);
    assert.equal(linked.removed, false);
    assert.equal(fs.existsSync(path.join(root, 'work')), true);

    const missing = await clone.purgeManagedCloneDir(path.join(tmpHome, '.ki', 'datasources', 'purge-none'));
    assert.deepEqual(missing, { removed: false });
  });
});
