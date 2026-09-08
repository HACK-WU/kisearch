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
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'ki.mjs');

/**
 * 子命令清单**从 bin/ki.mjs 的 COMMANDS 映射派生**，不再维护手工副本。
 *
 * 为何改：此处原为硬编码列表 + 注释「与 COMMANDS 保持一致；新增子命令时同步维护」，
 * 但该注释的断言长期为假——`wiki-backfill` 自加入 COMMANDS 起就未被列入（18 vs 19）。
 * 更隐蔽的是：缺一个命令**不会让本套件变红**，只是静默少测一个（覆盖率降低无人察觉）。
 * 改为派生后，新增命令自动纳入本套件，一致性由结构保证而非靠人记得同步。
 */
const SUB_COMMANDS: string[] = (() => {
  const src = fs.readFileSync(CLI, 'utf-8');
  const block = /const COMMANDS = \{([\s\S]*?)\n\};/.exec(src)?.[1];
  if (!block) {
    throw new Error(`无法从 ${CLI} 解析 COMMANDS 映射——入口结构已变，请同步本测试的解析规则`);
  }
  // 剥掉整行注释再匹配：否则块内注释里的 `'xxx':` 会被当成活命令，生成指向不存在命令的
  // 幻影用例（实测：在块内写一行「// 历史：'mcp-legacy': '...' 已移除」或注释掉一个条目，
  // 都会让本套件假红且报错指向一个从未存在的命令，排查者会先怀疑 CLI 坏了而非解析规则）
  const code = block.replace(/^\s*\/\/.*$/gm, '');
  const cmds = [...code.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]);
  // fail-loud：解析到空清单时拒绝「空跑绿」（否则本套件会因零用例而静默失去守护作用）
  if (cmds.length === 0) {
    throw new Error(`从 ${CLI} 解析到 0 个命令——解析规则已失效，不得以空清单跑绿`);
  }
  // fail-loud：重复命令名意味着解析误纳了注释或块外内容（剥注释后仍重复 → 规则真的错了）
  const dup = cmds.filter((c, i) => cmds.indexOf(c) !== i);
  if (dup.length > 0) {
    throw new Error(`从 ${CLI} 派生出重复命令名 [${[...new Set(dup)].join(', ')}]——解析规则可能误纳了注释或块外内容`);
  }
  return cmds;
})();

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

describe('已删除命令走未知命令分支', () => {
  it('ki setup → 退出码 1，stderr 提示未知命令', () => {
    try {
      execFileSync('node', [CLI, 'setup'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.fail('ki setup 应失败退出');
    } catch (err: any) {
      assert.strictEqual(err.status, 1, `stdout=${err.stdout} stderr=${err.stderr}`);
      assert.match(err.stderr, /未知命令/, `stderr 应提示未知命令：${err.stderr}`);
    }
  });
});
