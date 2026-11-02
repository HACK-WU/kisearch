/**
 * GET /api/tasks/:id/log 单元测试（S-04）
 *
 * 覆盖：
 *   - 200：台账 + 日志都在，返回 lines / head / rotated / expired=false
 *   - 200：台账已过期（删 JSON）但日志在 → expired=true，仍可读（拍板 E）
 *   - 200：tail 夹紧到 0–1000
 *   - 404：台账与日志都不存在
 *   - 400：任务 id 非法
 *   - 403：日志在但头行损坏 → 无法定 scope，保守拒绝（不得误判 404）
 *
 * 运行：npx jiti test/task-log-api.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import { createTaskReporter } from '../src/lib/task-registry.js';
import { taskLogPath } from '../src/lib/task-log.ts';

// ─── 测试隔离：临时 HOME，避免污染真实 ~/.ki ───
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-tasklog-api-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.KI_CONFIG_PATH = path.join(tmpHome, 'ki-config.json');
fs.writeFileSync(
  process.env.KI_CONFIG_PATH,
  JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock' } }),
);

const dataDir = path.join(tmpHome, '.ki', 'kb');

function buildTestServer(): McpServer {
  const server = new McpServer({ name: 'kisearch', version: '0.0.0-test' });
  server.tool('ping', 'test ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

let base = '';
let closeServer: (() => Promise<void>) | null = null;

before(async () => {
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: false,
    buildServer: buildTestServer,
    webDir: null,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  closeServer = async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closeAllSessions();
  };
});

after(async () => {
  if (closeServer) await closeServer();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** 造一个失败任务（reporter 会同时写台账与日志） */
function makeFailedTask(id: string, scope = 'ai-docs'): void {
  const reporter = createTaskReporter({ dataDir }, {
    id, source: 'web', operation: 'datasource-add-remote', scope,
  });
  try {
    reporter.update({ state: 'running', startedAt: Date.now(), phase: 'clone' });
    reporter.finish('failed', {
      errorCode: 'GIT_NETWORK_FAILED',
      error: '无法连接远端（Could not resolve host: no-such.invalid）',
      recoveryHint: '检查网络后再试',
    });
  } finally {
    reporter.stop();
  }
}

describe('GET /api/tasks/:id/log', () => {
  it('台账与日志都在：200，返回头行与日志正文', async () => {
    makeFailedTask('api-ok');
    const res = await fetch(`${base}/api/tasks/api-ok/log`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.taskId, 'api-ok');
    assert.equal(body.expired, false);
    // 只回文件名，不回绝对路径（台账刻意对路径脱敏）
    assert.equal(body.logFile, 'api-ok.log');
    assert.ok(!String(body.logFile).includes('/'));
    const head = body.head as { scope: string; operation: string } | null;
    assert.equal(head?.scope, 'ai-docs');
    assert.equal(head?.operation, 'datasource-add-remote');
    const lines = body.lines as string[];
    assert.ok(lines.some((line) => /Could not resolve host/.test(line)), '日志应含 git 原文');
    assert.ok((body.totalLines as number) >= lines.length);
    assert.equal(body.rotated, false);
  });

  it('tail 夹紧到 0–1000', async () => {
    makeFailedTask('api-tail');
    const zero = await fetch(`${base}/api/tasks/api-tail/log?tail=0`);
    assert.equal(((await zero.json()) as { lines: string[] }).lines.length, 0);

    const huge = await fetch(`${base}/api/tasks/api-tail/log?tail=99999`);
    const hugeBody = await huge.json() as { lines: string[] };
    assert.ok(hugeBody.lines.length <= 1000);

    const nan = await fetch(`${base}/api/tasks/api-tail/log?tail=abc`);
    assert.equal(nan.status, 200, '非法 tail 回退默认值而不是 400');
  });

  it('台账过期但日志仍在：200 + expired=true（否则「事后能查」不成立）', async () => {
    makeFailedTask('api-expired');
    fs.rmSync(path.join(dataDir, '.ki-tasks', 'api-expired.json'));

    const res = await fetch(`${base}/api/tasks/api-expired/log`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.expired, true);
    assert.equal((body.head as { scope: string }).scope, 'ai-docs');
    assert.ok((body.lines as string[]).some((line) => /Could not resolve host/.test(line)));
  });

  it('台账与日志都不存在：404', async () => {
    const res = await fetch(`${base}/api/tasks/no-such-task/log`);
    assert.equal(res.status, 404);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.code, 'TASK_LOG_NOT_FOUND');
  });

  it('任务 id 非法：400', async () => {
    const res = await fetch(`${base}/api/tasks/bad%20id/log`);
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.code, 'TASK_ID_INVALID');
  });

  it('日志在但头行损坏：403 而非 404（不得把已有日志判没）', async () => {
    const id = 'api-corrupt-head';
    const file = taskLogPath({ dataDir }, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${'not-json-head'}\n2026-11-02T00:00:00.000Z INFO  state queued\n`);

    const res = await fetch(`${base}/api/tasks/${id}/log`);
    assert.equal(res.status, 403);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.code, 'TASK_LOG_SCOPE_UNKNOWN');
  });
});
