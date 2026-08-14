/**
 * mcp-daemon.test.ts —— ki mcp --daemon / restart 参数校验与帮助回归测试
 *
 * 覆盖：
 *   - --daemon / -d 不带 --http 时报错（MCP_DAEMON_REQUIRES_HTTP），不落入 stdio 启动
 *   - -d 短别名被正确归一为 --daemon（报错文案一致，而非「未知参数 -d」）
 *   - mcp 帮助输出包含 --daemon/-d 与 restart 子命令
 * 运行：npx jiti test/mcp-daemon.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'ki.mjs');

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout || '', stderr: e.stderr || '', status: e.status ?? 1 };
  }
}

describe('--daemon/-d 仅 HTTP 模式', () => {
  it('ki mcp --daemon（无 --http）→ exit 1，code=MCP_DAEMON_REQUIRES_HTTP', () => {
    const { stdout, status } = runCli(['mcp', '--daemon']);
    assert.strictEqual(status, 1, `stdout=${stdout}`);
    assert.match(stdout, /MCP_DAEMON_REQUIRES_HTTP/);
    assert.match(stdout, /仅支持 HTTP 模式/);
  });

  it('ki mcp -d（无 --http）→ 归一并报同错误，而非「未知参数 -d」', () => {
    const { stdout, status } = runCli(['mcp', '-d']);
    assert.strictEqual(status, 1, `stdout=${stdout}`);
    assert.match(stdout, /MCP_DAEMON_REQUIRES_HTTP/);
    assert.doesNotMatch(stdout, /未知参数/);
  });

  it('--daemon 与 --http 组合不再报错（daemon 校验通过）', () => {
    // 仅验证参数层：--http --daemon 不应落入「仅 HTTP 模式」报错分支。
    // 真实启动会进入探活/预检，这里断言它不输出 MCP_DAEMON_REQUIRES_HTTP 即通过。
    const { stdout } = runCli(['mcp', '--http', '--daemon', '--status']);
    assert.doesNotMatch(stdout, /MCP_DAEMON_REQUIRES_HTTP/);
  });
});

describe('mcp 帮助包含新增能力', () => {
  it('ki mcp -h 输出 --daemon/-d 与 restart', () => {
    const { stdout, status } = runCli(['mcp', '-h']);
    assert.strictEqual(status, 0, `stdout=${stdout}`);
    assert.match(stdout, /--daemon/);
    assert.match(stdout, /-d/);
    assert.match(stdout, /restart/);
  });

  it('ki mcp -h 输出 --no-web（web 显式关闭开关）', () => {
    const { stdout, status } = runCli(['mcp', '-h']);
    assert.strictEqual(status, 0, `stdout=${stdout}`);
    assert.match(stdout, /--no-web/);
  });
});

describe('--no-web 显式关闭前端页面', () => {
  it('--http --no-web 不被判为未知参数（known flag 覆盖）', () => {
    // 仅验证参数层：--no-web 应被 detectUnknownFlags 接受，不输出 UNKNOWN_OPTION。
    // 真实启动会进入探活/预检，这里断言它不报未知参数即通过。
    const { stdout } = runCli(['mcp', '--http', '--no-web', '--status']);
    assert.doesNotMatch(stdout, /UNKNOWN_OPTION/);
    assert.doesNotMatch(stdout, /未知参数/);
  });

  it('--http --web --no-web 同时出现时不报未知参数（no-web 覆盖 web）', () => {
    const { stdout } = runCli(['mcp', '--http', '--web', '--no-web', '--status']);
    assert.doesNotMatch(stdout, /UNKNOWN_OPTION/);
    assert.doesNotMatch(stdout, /未知参数/);
  });
});
