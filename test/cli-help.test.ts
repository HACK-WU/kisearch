/**
 * CLI 帮助回归测试：所有子命令必须支持 -h / --help
 *
 * 背景：手写 argv 解析的命令（backup/restore/export）早期缺少 -h/--help 预处理，
 * 导致 `ki restore -h` 把 -h 当作 scope 参数执行 restore_list（输出 scope: "-h"）。
 * mcp-server / doctor 曾有同类问题，现统一要求：任何子命令遇到 -h/--help 必须
 * 打印帮助并以退出码 0 结束，绝不落入业务逻辑。
 *
 * 覆盖：
 *   - 遍历全部子命令：-h 与 --help 均退出码 0
 *   - 手写解析命令（backup/restore/export）：额外断言输出帮助文案、不产出 JSON 业务结果
 *
 * 运行：npx jiti test/cli-help.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { execFileSync } from 'child_process';

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'ki.mjs');

/** 与 bin/ki.mjs 的 COMMANDS 保持一致；新增子命令时同步维护 */
const SUB_COMMANDS = [
  'scan-kb',
  'manage-index',
  'query-group',
  'get-module-info',
  'sync-relation',
  'delete-relation',
  'import-kb',
  'migrate-keywords',
  'mcp',
  'setup',
  'search',
  'store',
  'bulk_store',
  'scope',
  'doc',
  'tag',
  'config',
  'doctor',
  'backup',
  'restore',
  'export',
];

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout, status: 0 };
  } catch (err: any) {
    return { stdout: err.stdout || '', status: err.status ?? 1 };
  }
}

describe('所有子命令支持 -h / --help', () => {
  for (const cmd of SUB_COMMANDS) {
    it(`ki ${cmd} -h → 退出码 0，不输出业务 JSON`, () => {
      const { stdout, status } = runCli([cmd, '-h']);
      assert.strictEqual(
        status,
        0,
        `ki ${cmd} -h 应退出 0，实际 status=${status}\nstdout=${stdout}`
      );
      // 防「-h 分支写错 → 静默输出业务 JSON 且 exit 0」：帮助输出不得含 JSON 契约标记
      assert.ok(!stdout.includes('"ok":'), `帮助输出不应含业务 JSON：${stdout}`);
    });
    it(`ki ${cmd} --help → 退出码 0，不输出业务 JSON`, () => {
      const { stdout, status } = runCli([cmd, '--help']);
      assert.strictEqual(
        status,
        0,
        `ki ${cmd} --help 应退出 0，实际 status=${status}\nstdout=${stdout}`
      );
      assert.ok(!stdout.includes('"ok":'), `帮助输出不应含业务 JSON：${stdout}`);
    });
  }
});

describe('手写解析命令的 -h 不被当作 scope 参数', () => {
  const manual: Array<{ cmd: string; help: RegExp }> = [
    { cmd: 'backup', help: /ki backup -/ },
    { cmd: 'restore', help: /ki restore -/ },
    { cmd: 'export', help: /ki export -/ },
  ];
  for (const { cmd, help } of manual) {
    it(`ki ${cmd} -h 输出帮助文案而非业务 JSON`, () => {
      const { stdout, status } = runCli([cmd, '-h']);
      assert.strictEqual(status, 0, `stdout=${stdout}`);
      assert.match(stdout, help, `应输出 ${cmd} 帮助文案`);
      assert.ok(!stdout.includes('"ok":'), `不应输出 JSON 业务结果：${stdout}`);
    });
  }
});
