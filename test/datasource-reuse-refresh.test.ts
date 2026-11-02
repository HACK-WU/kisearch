/**
 * 复用托管副本前必须先 fetch 对齐远端（2026-11-02 线上 Bug 回归）。
 *
 * 现象：Web「添加 Git 数据源」时填远端**刚新增**的子目录，报「子目录不存在」，
 * 而 GitHub 页面上明明有 —— 复用分支只 readdir 陈旧工作树，从不 fetch。
 * 运行：npx jiti test/datasource-reuse-refresh.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { KiConfig } from '../src/lib/config.js';
import { checkManagedSubdir } from '../src/lib/datasource-clone.js';
import { refreshManagedClone } from '../src/lib/datasource-git.js';

let root: string;
let work: string;
let bare: string;
let repoRoot: string;
let config: KiConfig;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
}

function commitAll(message: string): void {
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', message);
  git(work, 'push', '-q', bare, 'main');
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-refresh-'));
  work = path.join(root, 'work');
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(work, 'docs', 'a.md'), '# a\n');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'config', 'commit.gpgsign', 'false');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');

  bare = path.join(root, 'bare.git');
  execFileSync('git', ['clone', '-q', '--bare', work, bare], { encoding: 'utf8' });

  // 模拟托管副本：clone 后停在旧 commit（尚未同步）
  repoRoot = path.join(root, 'datasources', 'owner', 'repo');
  fs.mkdirSync(path.dirname(repoRoot), { recursive: true });
  execFileSync('git', ['clone', '-q', bare, repoRoot], { encoding: 'utf8' });

  config = { dataDir: path.join(root, 'kb'), scopes: {}, scopeMode: 'default' } as unknown as KiConfig;
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('refreshManagedClone（复用前 fetch 对齐远端）', () => {
  it('远端新增子目录：fetch 前判「不存在」，fetch 后可校验通过', async () => {
    fs.mkdirSync(path.join(work, 'agent-engineering'), { recursive: true });
    fs.writeFileSync(path.join(work, 'agent-engineering', 'lesson.md'), '# lesson\n');
    commitAll('add agent-engineering');

    // 陈旧副本：远端有、工作树没有 → 复现原 Bug
    assert.equal(fs.existsSync(path.join(repoRoot, 'agent-engineering')), false, '副本应停留在旧 commit');
    const before = checkManagedSubdir(repoRoot, 'agent-engineering', config, 'scope-a');
    assert.equal(before.ok, false);
    if (!before.ok) {
      assert.equal(before.code, 'INVALID_SUBDIR');
      assert.match(before.error, /子目录不存在/);
      assert.match(String(before.hint), /仓库顶层目录/);
      assert.doesNotMatch(String(before.hint), /agent-engineering/, '陈旧工作树看不到远端新增目录');
    }

    const refreshed = await refreshManagedClone(repoRoot, 'main');
    assert.equal(refreshed.fetched, true);
    assert.equal(refreshed.update, 'updated');
    assert.equal(refreshed.staleWarning, undefined);
    assert.equal(fs.existsSync(path.join(repoRoot, 'agent-engineering')), true);

    const after = checkManagedSubdir(repoRoot, 'agent-engineering', config, 'scope-a');
    assert.equal(after.ok, true, after.ok ? '' : after.error);
  });

  it('已是最新时 update=up-to-date，不重复报错', async () => {
    const refreshed = await refreshManagedClone(repoRoot, 'main');
    assert.equal(refreshed.fetched, true);
    assert.equal(refreshed.update, 'up-to-date');
    assert.equal(refreshed.staleWarning, undefined);
  });

  it('远端不可达：不抛错，返回 staleWarning，工作树仍可校验', async () => {
    const moved = `${bare}.moved`;
    fs.renameSync(bare, moved);
    try {
      const refreshed = await refreshManagedClone(repoRoot, 'main');
      assert.equal(refreshed.fetched, false);
      assert.match(String(refreshed.staleWarning), /未能从远端更新/);
      // 降级继续校验：本地已有的子目录不该因为 fetch 失败而添加不了
      const checked = checkManagedSubdir(repoRoot, 'docs', config, 'scope-a');
      assert.equal(checked.ok, true, checked.ok ? '' : checked.error);
    } finally {
      fs.renameSync(moved, bare);
    }
  });
});
