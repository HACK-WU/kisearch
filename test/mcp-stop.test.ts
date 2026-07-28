/**
 * mcp-stop.test.ts —— ki mcp stop 核心逻辑单元测试
 *
 * 覆盖：无实例无 lock 的空报告、陈旧 lock 清理、损坏 lock 清理、
 * 存活进程 SIGTERM 优雅关闭、忽略 SIGTERM 时 SIGKILL 兜底、
 * pid 复用校验跳过（不误杀 + 清陈旧锁）、排除自身 pid、healthz 兜底目标去重。
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
let stdioLockPath: string;
let httpLockPath: string;
let child: ChildProcess | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-mcp-stop-'));
  stdioLockPath = path.join(tmpDir, 'mcp-stdio.lock');
  httpLockPath = path.join(tmpDir, 'mcp-http.lock');
});

afterEach(() => {
  if (child && child.pid) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
    child = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLock(lockPath: string, pid: number): void {
  fs.writeFileSync(lockPath, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
}

describe('stopMcpInstances：空环境', () => {
  it('无实例无 lock 时返回空报告', async () => {
    const report = await stopMcpInstances({ ...NO_SERVICE, stdioLockPath, httpLockPath });
    assert.deepEqual(report.stopped, []);
    assert.deepEqual(report.cleanedLocks, []);
  });
});

describe('stopMcpInstances：陈旧/损坏 lock 清理', () => {
  it('pid 已死的陈旧 lock 被清理，不产生 stopped 记录', async () => {
    writeLock(stdioLockPath, DEAD_PID);
    writeLock(httpLockPath, DEAD_PID);
    const report = await stopMcpInstances({ ...NO_SERVICE, stdioLockPath, httpLockPath });
    assert.deepEqual(report.stopped, []);
    assert.deepEqual(report.cleanedLocks.sort(), [httpLockPath, stdioLockPath].sort());
    assert.equal(fs.existsSync(stdioLockPath), false);
    assert.equal(fs.existsSync(httpLockPath), false);
  });

  it('内容损坏的 lock 同样被清理', async () => {
    fs.writeFileSync(stdioLockPath, 'not-json');
    const report = await stopMcpInstances({ ...NO_SERVICE, stdioLockPath, httpLockPath });
    assert.deepEqual(report.cleanedLocks, [stdioLockPath]);
    assert.equal(fs.existsSync(stdioLockPath), false);
  });
});

describe('stopMcpInstances：关闭存活进程', () => {
  it('SIGTERM 优雅关闭 lock 指向的存活进程并清理 lock', async () => {
    // 用一个长驻 node 子进程模拟 ki mcp 服务（默认 SIGTERM 行为即退出）
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    writeLock(stdioLockPath, pid);
    const report = await stopMcpInstances({
      ...NO_SERVICE,
      stdioLockPath,
      httpLockPath,
      verifyPid: () => true, // 测试进程 cmdline 无 mcp-server 特征，注入放行
    });
    assert.deepEqual(report.stopped, [{ pid, kind: 'stdio', result: 'terminated' }]);
    assert.deepEqual(report.cleanedLocks, [stdioLockPath]);
    assert.equal(fs.existsSync(stdioLockPath), false);
  });

  it('忽略 SIGTERM 的进程走 SIGKILL 兜底，lock 被清理', async () => {
    // 捕获并忽略 SIGTERM，模拟卡死/拒绝优雅退出的服务
    child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    const pid = child.pid!;
    // 给子进程一点时间装好 SIGTERM handler，避免竞态下默认行为直接退出
    await new Promise((r) => setTimeout(r, 300));
    writeLock(httpLockPath, pid);
    const report = await stopMcpInstances({
      ...NO_SERVICE,
      stdioLockPath,
      httpLockPath,
      gracefulTimeoutMs: 500, // 缩短优雅等待，加速进入兜底分支
      verifyPid: () => true,
    });
    assert.equal(report.stopped.length, 1);
    assert.equal(report.stopped[0].result, 'killed');
    assert.equal(report.stopped[0].reason, undefined); // SIGKILL 后应确认退出
    assert.deepEqual(report.cleanedLocks, [httpLockPath]);
    assert.equal(fs.existsSync(httpLockPath), false);
  });

  it('pid 校验判定复用时跳过发信号，仅清理陈旧 lock', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    writeLock(stdioLockPath, pid);
    const report = await stopMcpInstances({
      ...NO_SERVICE,
      stdioLockPath,
      httpLockPath,
      verifyPid: () => false, // 模拟 pid 已被无关进程复用
    });
    assert.equal(report.stopped.length, 1);
    assert.equal(report.stopped[0].result, 'skipped');
    // 无辜进程未被杀
    assert.doesNotThrow(() => process.kill(pid, 0));
    // 复用者的锁属陈旧锁，应被清理
    assert.deepEqual(report.cleanedLocks, [stdioLockPath]);
  });

  it('lock 指向自身 pid 时不发信号（排除自杀）', async () => {
    writeLock(stdioLockPath, process.pid);
    const report = await stopMcpInstances({
      ...NO_SERVICE,
      stdioLockPath,
      httpLockPath,
      verifyPid: () => true,
    });
    assert.deepEqual(report.stopped, []);
  });

  it('stdio 与 http lock 指向同一 pid 时只处理一次', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    writeLock(stdioLockPath, pid);
    writeLock(httpLockPath, pid);
    const report = await stopMcpInstances({
      ...NO_SERVICE,
      stdioLockPath,
      httpLockPath,
      verifyPid: () => true,
    });
    assert.equal(report.stopped.length, 1);
    assert.equal(report.stopped[0].result, 'terminated');
    assert.deepEqual(report.cleanedLocks.sort(), [httpLockPath, stdioLockPath].sort());
  });
});
