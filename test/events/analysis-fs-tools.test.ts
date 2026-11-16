/**
 * analysis-fs-tools.test.ts —— S-02 专属只读文件沙箱单测
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-fs-tools.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FS_READ_MAX_BYTES,
  createFsToolEntries,
  resolveSafePath,
  runFsFind,
  runFsGrep,
  runFsLs,
  runFsRead,
  validateTargetRootDir,
  verifyCandidateLocation,
  type FsSandboxContext,
} from '../../src/lib/events/analysis-fs-tools.js';
import { CHAT_MCP_TOOLS } from '../../src/lib/chat/mcp-tool-registry.js';
import { buildKiMcpServer } from '../../src/lib/mcp-server-factory.js';

let tmpRoot = '';
let repoDir = '';
let outsideFile = '';

function makeCtx(maxFiles = 8): FsSandboxContext {
  return {
    rawRoot: repoDir,
    realRoot: fs.realpathSync(repoDir),
    maxFiles,
    filesRead: new Set(),
  };
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-fs-sandbox-'));
  repoDir = path.join(tmpRoot, 'repo');
  outsideFile = path.join(tmpRoot, 'secret.txt');
  fs.writeFileSync(outsideFile, 'TOP_SECRET=12345\n', 'utf8');

  fs.mkdirSync(path.join(repoDir, 'src', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'src', 'auth', 'guard.ts'),
    [
      'export function checkAuth(user: { id: string } | null) {',
      '  if (!user) throw new Error("UNAUTHORIZED");',
      '  return user.id;',
      '}',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(repoDir, 'node_modules', 'pkg', 'ignored.ts'), 'const UNAUTHORIZED = 1;\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42, 0x43]));

  // 超 64 KB 大文件
  const bigLines = Array.from({ length: 1500 }, (_, i) => `const line_${i + 1} = "${'x'.repeat(60)}";`).join('\n');
  fs.writeFileSync(path.join(repoDir, 'src', 'big.ts'), bigLines, 'utf8');

  // 指向根外的符号链接 & 悬空符号链接
  fs.symlinkSync(outsideFile, path.join(repoDir, 'leak.txt'));
  fs.symlinkSync('/etc/nonexistent-link-target', path.join(repoDir, 'dangling-outside'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('S-02 专属只读文件沙箱', () => {
  it('① 绝对路径 / .. / \\0 / 根外 symlink（含悬空链接）一律返回 OUT_OF_ROOT', async () => {
    const realRoot = fs.realpathSync(repoDir);
    for (const bad of ['/etc/passwd', '../../etc/passwd', 'src/../../secret.txt', 'a\0b', 'leak.txt', 'dangling-outside']) {
      const r = await resolveSafePath(realRoot, bad);
      assert.equal(r.ok, false, `${bad} 应被拒绝`);
      assert.equal(r.ok === false && r.code, 'OUT_OF_ROOT', `${bad} 应返回 OUT_OF_ROOT`);
    }
    const readLeak = await runFsRead(makeCtx(), 'leak.txt');
    assert.equal(readLeak.ok, false);
    assert.equal(readLeak.ok === false && readLeak.code, 'OUT_OF_ROOT');
  });

  it('② validateTargetRootDir 拒绝系统路径与不存在目录', () => {
    assert.equal(validateTargetRootDir('/etc/passwd').ok, false);
    assert.equal(validateTargetRootDir('/proc').ok, false);
    assert.equal(validateTargetRootDir('relative/path').ok, false);
    assert.equal(validateTargetRootDir(repoDir).ok, true);
  });

  it('③ fs_ls / fs_find / fs_grep 跳过 node_modules 与二进制文件', async () => {
    const ctx = makeCtx();
    const ls = await runFsLs(ctx, '.');
    assert.equal(ls.ok, true);
    const names = (ls.ok && (ls.data.entries as Array<{ name: string }>).map((e) => e.name)) || [];
    assert.ok(names.includes('src'));
    assert.ok(!names.includes('node_modules'));

    const found = await runFsFind(ctx, 'guard.ts');
    assert.equal(found.ok, true);
    assert.deepEqual(found.ok && found.data.paths, ['src/auth/guard.ts']);

    const grep = await runFsGrep(ctx, 'UNAUTHORIZED');
    assert.equal(grep.ok, true);
    assert.equal(grep.ok && grep.data.count, 1, 'node_modules 里的命中必须跳过');
    assert.equal(grep.ok && grep.data.skippedBinary, 1, '应统计跳过的二进制文件');
  });

  it('④ fs_read 按行与 64KB 截断并受 maxFiles 预算约束', async () => {
    const ctx = makeCtx(1);
    const rBig = await runFsRead(ctx, 'src/big.ts', { offset: 1, limit: 200 });
    assert.equal(rBig.ok, true);
    assert.equal(rBig.ok && rBig.data.truncated, true);
    assert.ok(Buffer.byteLength(String(rBig.ok && rBig.data.content), 'utf8') <= FS_READ_MAX_BYTES + 64);

    // 同一文件可续读
    const rBig2 = await runFsRead(ctx, 'src/big.ts', { offset: 201, limit: 50 });
    assert.equal(rBig2.ok, true);

    // 新文件超出 maxFiles=1
    const rSecond = await runFsRead(ctx, 'src/auth/guard.ts');
    assert.equal(rSecond.ok, false);
    assert.equal(rSecond.ok === false && rSecond.code, 'FILE_BUDGET_EXCEEDED');

    // 二进制文件拒绝读取
    const rBin = await runFsRead(makeCtx(5), 'binary.bin');
    assert.equal(rBin.ok, false);
    assert.equal(rBin.ok === false && rBin.code, 'INVALID_ARG');
  });

  it('⑤ verifyCandidateLocation 剔除不存在路径与越界行号', async () => {
    const realRoot = fs.realpathSync(repoDir);
    const ok = await verifyCandidateLocation(realRoot, 'src/auth/guard.ts', 2);
    assert.equal(ok.ok, true);
    assert.match(ok.ok ? ok.realSnippet : '', /UNAUTHORIZED/);

    const badLine = await verifyCandidateLocation(realRoot, 'src/auth/guard.ts', 999);
    assert.equal(badLine.ok, false);

    const badFile = await verifyCandidateLocation(realRoot, 'src/not-exist.ts', 1);
    assert.equal(badFile.ok, false);
  });

  it('⑥ 物理隔离：CHAT_MCP_TOOLS 与 /mcp server 均不包含任何 fs_* 工具', () => {
    const fsNames = createFsToolEntries(makeCtx()).map((t) => t.name);
    assert.deepEqual(fsNames.sort(), ['fs_find', 'fs_grep', 'fs_ls', 'fs_read']);

    const chatNames = CHAT_MCP_TOOLS.map((t) => t.name);
    const mcpServer = buildKiMcpServer(null) as unknown as { _registeredTools?: Record<string, unknown> };
    const mcpNames = Object.keys(mcpServer._registeredTools ?? {});
    for (const name of fsNames) {
      assert.equal(chatNames.includes(name), false, `CHAT_MCP_TOOLS 不得暴露 ${name}`);
      assert.equal(mcpNames.includes(name), false, `/mcp 不得暴露 ${name}`);
    }
  });
});
