/**
 * mcp-stop.test.ts —— ki mcp stop 核心逻辑单元测试
 *
 * 覆盖：无实例无 lock 的空报告、陈旧 lock 清理、损坏 lock 清理、
 * 存活进程 SIGTERM 优雅关闭、忽略 SIGTERM 时 SIGKILL 兜底、
 * pid 复用校验跳过（不误杀 + 清陈旧锁）、排除自身 pid、healthz 兜底目标去重、
 * 多 stdio 实例逐一登记并全部停止。
 * 运行：node node_modules/jiti/lib/jiti-cli.mjs test/mcp-stop.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { stopMcpInstances } from '../src/lib/mcp-stop.js';

/** 找一个几乎必然已死的 pid（Linux 默认 pid_max 通常 <= 4194304） */
const DEAD_PID = 2 ** 30;
/** 探活目标指向必然无服务的端口，避免误连真实实例 */
const NO_SERVICE = { host: '127.0.0.1', port: 65531 };

let tmpDir: string;
let stdioLockDir: string;
let httpLockPath: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-mcp-stop-'));
  stdioLockDir = tmpDir; // 多实例 lock 直接落在 tmpDir 下
  httpLockPath = path.join(tmpDir, 'mcp-http.lock');
});

afterEach(() => {
  for (const c of children) {
    if (c.pid) {
      try {
        process.kill(c.pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
  children.length = 0;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function spawnChild(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(c);
  return c;
}

/** 写 stdio 实例 lock（每实例一个 mcp-stdio-<pid>.lock） */
function writeStdioLock(pid: number): void {
  fs.writeFileSync(
    path.join(stdioLockDir, `mcp-stdio-${pid}.lock`),
    JSON.stringify({ pid, startedAt: new Date().toISOString() }),
  );
}

/** 写 http lock（单文件，内容含 pid） */
function writeHttpLock(pid: number): void {
  fs.writeFileSync(httpLockPath, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
}

describe('stopMcpInstances：空环境', () => {
  it('无实例无 lock 时返回空报告', async () => {
    const report = await stopMcpInstances({ ...NO_SERVICE, stdioLockDir, httpLockPath });
    assert.deepEqual(report.stopped, []);
    assert.deepEqual(report.cleanedLocks, []);
  });
});

describe('stopMcpInstances：陈旧/损坏 lock 清理', () => {
  it('pid 已死的陈旧 stdio + http lock 被清理，不产生 stopped 记录', async () => {
    writeStdioLock(DEAD_PID);
    writeHttpLock(DEAD_PID);
    const report = await stopMcpInstances({ ...NO_SERVICE, stdioLockDir, httpLockPath });
    assert.deepEqual(report.stopped, []);
    assert.equal(report.cleanedLocks.length, 2);
    assert.equal(fs.existsSync(path.join(stdioLockDir, `mcp-stdio-${DEAD_PID}.lock`)), false);
    assert.equal(fs.existsSync(httpLockPath), false);
  });

  it('内容损坏的 http lock 同样被清理', async () => {
    fs.writeFileSync(httpLockPath, 'not-json');
    const report = await stopMcpInstances({ ...NO_SERVICE, stdioLockDir, httpLockPath });
    assert.deepEqual(report.cleanedLocks, [httpLockPath]);
    assert.equal(fs.existsSync(httpLockPath), false);
  });
});

describe('stopMcpInstances：关闭存活进程', () => {
  it('SIGTERM 优雅关闭 stdio lock 指向的存活进程并清理 lock', async () => {
    const child = spawnChild();
    const pid = child.pid!;
    writeStdioLock(pid);
    const report = await stopMcpInstances({
      ...NO_SERVICE,
      stdioLockDir,
      httpLockPath,
      verifyPid: () => true,
    });
    assert.deepEqual(report.stopped, [{ pid, kind: 'stdio', result: 'terminated' }]);
    assert.equal(fs.existsSync(path.join(stdioLockDir, `mcp-stdio-${pid}.lock`)), false);
  });

  it('忽略 SIGTERM 的进程走 SIGKILL 兜底，lock 被清理', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    children.push(child);
    const pid = child.pid!;
    await new Promise((r) => setTimeout(r, 300));
    writeHttpLock(pid);
    const report = await stopMcpInstances({
      ...NO_SERVICE,
      stdioLockDir,
      httpLockPath,
      gracefulTimeoutMs: 500,
      verifyPid: () => true,
    });
    assert.equal(report.stopped.length, 1);
    assert.equal(report.stopped[0].result, 'killed');
    assert.deepEqual(report.cleanedLocks, [httpLockPath]);
  });

  it('pid 校验判定复用时跳过发信号，仅清理陈旧 lock', async () => {
    const child = spawnChild();
    const pid = child.pid!;
    writeStdioLock(pid);
    const report = await stopMcpInstances({
      ...NO_SERVICE,
      stdioLockDir,
      httpLockPath,
      verifyPid: () => false,
    });
    assert.equal(report.stopped.length, 1);
    assert.equal(report.stopped[0].result, 'skipped');
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal(fs.existsSync(path.join(stdioLockDir, `mcp-stdio-${pid}.lock`)), false);
  });

  it('lock 指向自身 pid 时不发信号（排除自杀）', async () => {
    writeStdioLock(process.pid);
    const report = await stopMcpInstances({
      ...NO_SERVICE,
      stdioLockDir,
      httpLockPath,
      verifyPid: () => true,
    });
    assert.deepEqual(report.stopped, []);
  });

  it('stdio 与 http lock 指向同一 pid 时只处理一次', async () => {
    const child = spawnChild();
    const pid = child.pid!;
    writeStdioLock(pid);
    writeHttpLock(pid);
    const report = await stopMcpInstances({
      ...NO_SERVICE,
      stdioLockDir,
      httpLockPath,
      verifyPid: () => true,
    });
    assert.equal(report.stopped.length, 1);
    assert.equal(report.stopped[0].result, 'terminated');
    assert.equal(report.cleanedLocks.length, 2);
  });

  it('多个 stdio 实例逐一登记并全部停止', async () => {
    const c1 = spawnChild();
    const c2 = spawnChild();
    const c3 = spawnChild();
    const pids = [c1.pid!, c2.pid!, c3.pid!];
    for (const p of pids) writeStdioLock(p);
    const report = await stopMcpInstances({
      ...NO_SERVICE,
      stdioLockDir,
      httpLockPath,
      verifyPid: () => true,
    });
    const stoppedPids = report.stopped.filter((s) => s.kind === 'stdio').map((s) => s.pid).sort();
    assert.deepEqual(stoppedPids, pids.slice().sort());
    assert.equal(report.stopped.length, 3);
    for (const p of pids) {
      assert.equal(fs.existsSync(path.join(stdioLockDir, `mcp-stdio-${p}.lock`)), false);
    }
  });
});
