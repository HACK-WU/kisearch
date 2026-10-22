/**
 * S-05：Git URL / 子目录 / 分支名校验回归（不触网、不写盘）。
 * 运行：npx jiti test/datasource-clone-url.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isSafeRelativeSubdir, validateBranchName, validateGitUrl } from '../src/lib/datasource-clone.js';

describe('validateGitUrl', () => {
  it('放行 https / ssh / git+ssh / scp-like', () => {
    for (const url of [
      'https://github.com/org/repo.git',
      'https://user@github.com/org/repo.git',
      'ssh://git@github.com/org/repo.git',
      'ssh://git@github.com:2222/org/repo.git',
      'git+ssh://git@github.com/org/repo.git',
      'git@github.com:org/repo.git',
    ]) {
      const result = validateGitUrl(url);
      assert.equal(result.ok, true, `${url} 应放行`);
    }
  });

  it('拒绝空值 / 控制字符 / 以 - 开头 / 超长', () => {
    assert.equal(validateGitUrl('   ').ok, false);
    assert.equal(validateGitUrl('https://x/y\nrm -rf').ok, false);
    assert.equal(validateGitUrl('-uhttps://x/y').ok, false);
    assert.equal(validateGitUrl(`https://x/${'a'.repeat(2100)}`).ok, false);
  });

  it('拒绝明文 http / git / file（生产默认）', () => {
    for (const url of ['http://github.com/org/repo.git', 'git://github.com/org/repo.git']) {
      const result = validateGitUrl(url);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'GIT_SCHEME_UNSUPPORTED');
    }
    const file = validateGitUrl('file:///tmp/repo');
    assert.equal(file.ok, false);
    if (!file.ok) assert.equal(file.code, 'GIT_SCHEME_UNSUPPORTED');
  });

  it('allowFile 仅放开 file://', () => {
    const result = validateGitUrl('file:///tmp/a-repo', { allowFile: true });
    assert.equal(result.ok, true);
  });

  it('拒绝 ext:: / fd:: 等传输注入', () => {
    for (const url of ['ext::sh -c touch% /tmp/pwn', 'fd::3', 'transport::x']) {
      const result = validateGitUrl(url);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'GIT_SCHEME_UNSUPPORTED');
    }
  });

  it('拒绝 URL 内嵌密码（https 与 scp-like）', () => {
    const https = validateGitUrl('https://user:secret@github.com/org/repo.git');
    assert.equal(https.ok, false);
    if (!https.ok) assert.equal(https.code, 'GIT_URL_CREDENTIALS');
    const scp = validateGitUrl('user:secret@github.com:org/repo.git');
    assert.equal(scp.ok, false);
    if (!scp.ok) assert.equal(scp.code, 'GIT_URL_CREDENTIALS');
  });

  it('拒绝查询串里的凭据（token/access_token 等）', () => {
    for (const url of [
      'https://github.com/org/repo.git?access_token=secret',
      'https://github.com/org/repo.git?private_token=secret',
      'https://github.com/org/repo.git?token=secret&ref=main',
    ]) {
      const result = validateGitUrl(url);
      assert.equal(result.ok, false, url);
      if (!result.ok) assert.equal(result.code, 'GIT_URL_CREDENTIALS');
    }
    // 非敏感 query 不影响
    assert.equal(validateGitUrl('https://github.com/org/repo.git?tab=readme').ok, true);
  });

  it('拒绝非 URL 的裸路径', () => {
    const result = validateGitUrl('/root/some/repo');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'INVALID_GIT_URL');
  });
});

describe('isSafeRelativeSubdir', () => {
  it('空串与常规子目录放行', () => {
    for (const value of ['', 'docs', 'docs/guide', 'a-b/c_d']) {
      assert.equal(isSafeRelativeSubdir(value), true, value);
    }
  });

  it('拒绝绝对路径 / 穿越 / 反斜杠 / .git 段 / 空段', () => {
    for (const value of ['/abs', '../up', 'a/../b', 'a\\b', '.git', 'a/.git/b', 'a//b', './a', 'a/.']) {
      assert.equal(isSafeRelativeSubdir(value), false, value);
    }
  });
});

describe('validateBranchName', () => {
  it('接受常规分支名', async () => {
    for (const branch of ['main', 'feature/x', 'release-1.2']) {
      const result = await validateBranchName(branch);
      assert.equal(result.ok, true, branch);
    }
  });

  it('拒绝非法分支名', async () => {
    for (const branch of ['', '-bad', 'bad name', 'a..b', 'x.lock', 'a~b']) {
      const result = await validateBranchName(branch);
      assert.equal(result.ok, false, branch);
    }
  });
});
