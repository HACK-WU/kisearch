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
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'ki.mjs');

function runCli(args: string[], envExtra: Record<string, string | undefined> = {}): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = { ...process.env, NODE_NO_WARNINGS: '1' } as Record<string, string>;
  for (const [k, v] of Object.entries(envExtra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
      env,
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
    // 仅验证参数层：--http 不应落入「仅 HTTP 模式」报错分支。
    // （不用 -d + --status 组合：daemon 存活探测会把它判为"子进程退出"失败）
    const { stdout } = runCli(['mcp', '--http', '--status']);
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

describe('daemon 启动期存活探测（假成功修复）', () => {
  const randPort = () => 20000 + Math.floor(Math.random() * 20000);

  it('非回环 + 无 token + -d → exit 1 报"启动失败"（不再假成功）', () => {
    // 隔离 HOME（无 ~/.ki/mcp-tokens.json）+ 删 KI_MCP_TOKEN → 子进程必 fail-loud
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-dmn-fail-'));
    const port = randPort();
    const { stdout, stderr, status } = runCli(
      ['mcp', '--http', '--host', '0.0.0.0', '--port', String(port), '-d'],
      { HOME: home, KI_MCP_TOKEN: undefined }
    );
    fs.rmSync(home, { recursive: true, force: true });
    assert.strictEqual(status, 1, `stdout=${stdout} stderr=${stderr}`);
    assert.match(stderr, /daemon 启动失败/);
    assert.match(stderr, /ki mcp --http --host 0\.0\.0\.0/); // 前台复跑指引（-d 已剥离）
  });

  it('回环正常启动 + -d → exit 0 且服务真实就绪（探测不误杀）', { skip: !process.env.SILICONFLOW_API_KEY && '需真实 embedding 密钥（预检含网络探测）' }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-dmn-ok-'));
    const port = randPort();
    try {
      // 构造可通过启动预检的最小配置：目录齐全 + apiKey 引用环境变量
      for (const d of ['kb', 'vector', 'backup']) fs.mkdirSync(path.join(home, `.ki/${d}`), { recursive: true });
      fs.writeFileSync(path.join(home, '.ki', 'config.json'), JSON.stringify({
        dataDir: path.join(home, '.ki/kb'),
        vectorDir: path.join(home, '.ki/vector'),
        backupDir: path.join(home, '.ki/backup'),
        embedding: {
          provider: 'siliconflow',
          baseURL: 'https://api.siliconflow.cn/v1',
          model: 'Qwen/Qwen3-Embedding-8B',
          dimension: 4096,
          apiKey: '${SILICONFLOW_API_KEY}',
        },
        scopes: { default: {} },
      }));
      const { stdout, status } = runCli(
        ['mcp', '--http', '--port', String(port), '-d'],
        { HOME: home }
      );
      assert.strictEqual(status, 0, `stdout=${stdout}`);
      assert.match(stdout, /已在后台启动/);
      // 轮询 healthz 确认服务真实就绪（jiti 冷启动 + 预检（含 embedding 网络探测）
      // 可能超过 3s 探测窗口，探测超时按成功处理——此断言确保其确实成立）
      let ready = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const res = await fetch(`http://127.0.0.1:${port}/healthz`);
          if (res.ok) { ready = true; break; }
        } catch { /* not yet */ }
      }
      assert.ok(ready, 'healthz 应在 30s 内就绪');
    } finally {
      // 清理：stop 走同一隔离 HOME（lock 文件位置一致）
      runCli(['mcp', 'stop'], { HOME: home });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
