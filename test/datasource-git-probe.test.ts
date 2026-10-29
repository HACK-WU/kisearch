/**
 * S-01：probeGit / sanitizeRemoteUrl 回归。
 * 运行：npx jiti test/datasource-git-probe.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { probeGit, sanitizeRemoteUrl } from '../src/lib/datasource-git.js';

let root: string;
let repo: string;
let docs: string;
let link: string;
let notRepo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  });
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-git-probe-'));
  repo = path.join(root, 'repo');
  docs = path.join(repo, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'a.md'), '# a\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  // 测试机全局可能开启 commit.gpgsign；CI/无 tty 下会失败
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');

  link = path.join(root, 'docs-link');
  fs.symlinkSync(docs, link, 'dir');

  notRepo = path.join(root, 'plain');
  fs.mkdirSync(notRepo, { recursive: true });
  fs.writeFileSync(path.join(notRepo, 'x.md'), '# x\n');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('probeGit', () => {
  it('识别仓库根、分支与 HEAD', async () => {
    const result = await probeGit(repo);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.repoRoot, fs.realpathSync(repo));
    assert.equal(result.value.relativeRoot, '');
    assert.equal(result.value.branch, 'main');
    assert.match(result.value.headCommit ?? '', /^[0-9a-f]{40}$/);
  });

  it('识别仓库子目录的 relativeRoot', async () => {
    const result = await probeGit(docs);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.repoRoot, fs.realpathSync(repo));
    assert.equal(result.value.relativeRoot, 'docs');
  });

  it('symlink 指向仓库子目录时仍按真实路径计算 relativeRoot', async () => {
    const result = await probeGit(link);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.repoRoot, fs.realpathSync(repo));
    assert.equal(result.value.relativeRoot, 'docs');
  });

  it('非 Git 目录返回 NOT_A_GIT_REPO', async () => {
    const result = await probeGit(notRepo);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'NOT_A_GIT_REPO');
  });

  it('目录不存在时 fail-loud', async () => {
    const result = await probeGit(path.join(root, 'missing'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'NOT_A_GIT_REPO');
  });
});

describe('sanitizeRemoteUrl', () => {
  it('去掉 https 凭据', () => {
    assert.equal(sanitizeRemoteUrl('https://user:pass@example.com/o/r.git'), 'https://example.com/o/r.git');
  });

  it('保留无密码的 ssh user', () => {
    assert.equal(sanitizeRemoteUrl('ssh://git@example.com/o/r.git'), 'ssh://git@example.com/o/r.git');
  });

  it('保留 scp-like 形式', () => {
    assert.equal(sanitizeRemoteUrl('git@github.com:org/repo.git'), 'git@github.com:org/repo.git');
  });

  it('去掉 scp-like 中的 password', () => {
    assert.equal(sanitizeRemoteUrl('user:pass@host:repo.git'), 'user@host:repo.git');
  });

  it('空值返回 null', () => {
    assert.equal(sanitizeRemoteUrl('   '), null);
  });
});
