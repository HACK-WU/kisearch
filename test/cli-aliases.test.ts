/**
 * CLI 简化回归测试（REQ-11 / REQ-12 / REQ-10）
 *
 * REQ-11 短别名：-s(--scope) -q(--query) -t(--text) -g(--group) -r(--relation)
 *               -i(--input) -o(--output) -n(--name)
 * REQ-12 位置参数：search <query>、store <text>（--query/--text option 保留兼容）
 * REQ-10 超长警告：sync-relation --module-info >1000 字符输出警告
 *
 * 不依赖真实向量服务：校验 CLI 参数解析层（帮助输出含别名、无 key 时缺参数报错文案）。
 * 运行：npx jiti test/cli-aliases.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { spawnSync } from 'child_process';

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'ki.mjs');

/** 用 spawnSync 同时捕获 stdout/stderr（execFileSync 成功时不暴露 stderr） */
function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    timeout: 30_000,
  });
  return {
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    status: res.status ?? 1,
  };
}

describe('REQ-11 短别名帮助输出', () => {
  const cases: Array<{ cmd: string; helpArgs: string[]; short: string; long: string }> = [
    { cmd: 'search', helpArgs: [], short: '-q', long: '--query' },
    { cmd: 'search', helpArgs: [], short: '-s', long: '--scope' },
    { cmd: 'store', helpArgs: [], short: '-t', long: '--text' },
    { cmd: 'store', helpArgs: [], short: '-s', long: '--scope' },
    { cmd: 'sync-relation', helpArgs: [], short: '-g', long: '--group' },
    { cmd: 'sync-relation', helpArgs: [], short: '-r', long: '--relation' },
    { cmd: 'sync-relation', helpArgs: [], short: '-i', long: '--input' },
    { cmd: 'query-group', helpArgs: [], short: '-s', long: '--scope' },
    { cmd: 'get-module-info', helpArgs: [], short: '-g', long: '--group' },
    { cmd: 'get-module-info', helpArgs: [], short: '-r', long: '--relation' },
    { cmd: 'delete-relation', helpArgs: [], short: '-r', long: '--relation' },
    { cmd: 'bulk-store', helpArgs: [], short: '-i', long: '--input' },
    { cmd: 'manage-index', helpArgs: [], short: '-n', long: '--name' },
    { cmd: 'scan-kb', helpArgs: ['import'], short: '-s', long: '--scope' },
    { cmd: 'scan-kb', helpArgs: ['diff'], short: '-o', long: '--output' },
  ];

  for (const { cmd, helpArgs, short, long } of cases) {
    it(`ki ${[cmd, ...helpArgs].join(' ')} -h 帮助应含 "${short}, ${long}"`, () => {
      const { stdout, status } = runCli([cmd, ...helpArgs, '-h']);
      assert.strictEqual(status, 0, `stdout=${stdout}`);
      assert.ok(
        stdout.includes(`-${short.replace('-', '')}, ${long}`) || stdout.includes(`${short}, ${long}`),
        `帮助应含短别名 ${short}: ${stdout}`
      );
    });
  }
});

describe('REQ-12 位置参数解析', () => {
  it('store 位置参数被消费（进入执行层而非"缺少 --text"参数解析错误）', () => {
    const { stdout } = runCli(['store', '位置参数文本', '-s', 'nonexistent-scope-xyz']);
    // 位置参数应被消费并进入 executeStore：scope 不注册走 strict 护栏报错，
    // 或写入成功；绝不应是 commander 的 "error: required option '--text'" 参数解析错误。
    assert.ok(
      !stdout.includes("required option '--text'"),
      `位置参数应被消费，而非报缺少 --text：${stdout}`
    );
  });

  it('store 位置参数 + option 双通道（短别名 -t 仍可用）', () => {
    const { stdout } = runCli(['store', '-t', 'option通道文本', '-s', 'nonexistent-scope-xyz']);
    assert.ok(
      !stdout.includes("required option '--text'"),
      `-t 短别名应被消费：${stdout}`
    );
  });

  it('store 双通道均缺 text 时明确报错（与 search 对齐）', () => {
    const { stdout, stderr, status } = runCli(['store', '-s', 'some-scope']);
    const all = stdout + stderr;
    assert.ok(all.includes('缺少存储文本'), `应提示缺少存储文本：${all}`);
    assert.notStrictEqual(status, 0, '缺 text 应非 0 退出');
  });

  it('search 位置参数被消费（缺 query 会报业务错误而非参数解析错误）', () => {
    const { stdout, stderr } = runCli(['search', '位置查询词', '-s', 'nonexistent-scope-xyz']);
    const all = stdout + stderr;
    assert.ok(
      !all.includes('missing required argument') && !all.includes("required option '--query'"),
      `位置参数应被消费：${all}`
    );
  });

  it('search 双通道均缺 query 时明确报错', () => {
    const { stdout, stderr, status } = runCli(['search', '-s', 'some-scope']);
    const all = stdout + stderr;
    assert.ok(all.includes('缺少查询文本'), `应提示缺少查询文本：${all}`);
    assert.notStrictEqual(status, 0, '缺 query 应非 0 退出');
  });
});

describe('REQ-10 sync-relation 超长 module-info 警告', () => {
  it('>1000 字符时输出警告文案', () => {
    const long = '内容'.repeat(600); // 1200 字符
    const { stdout, stderr } = runCli([
      'sync-relation', '-s', 'warn-scope',
      '-g', 'wiki', '-r', '超长关系',
      '--module-info', `# 超长\n${long}`,
    ]);
    const all = stdout + stderr;
    assert.ok(
      all.includes('警告: --module-info 长度') || all.includes('超长内容可能导致向量质量稀释'),
      `应输出超长警告：${all}`
    );
  });

  it('≤1000 字符不输出警告', () => {
    const short = '内容'.repeat(400); // 800 字符
    const { stdout, stderr } = runCli([
      'sync-relation', '-s', 'normal-scope',
      '-g', 'wiki', '-r', '正常关系',
      '--module-info', `# 正常\n${short}`,
    ]);
    const all = stdout + stderr;
    assert.ok(
      !all.includes('警告: --module-info 长度'),
      `短 module-info 不应输出警告：${all}`
    );
  });
});
