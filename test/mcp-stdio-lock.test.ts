/**
 * mcp-stdio-lock.test.ts —— stdio 单实例 lock 模块单元测试
 *
 * 覆盖：pid 存活校验、lock 写入/读取/释放、陈旧锁自动清理、
 * 自身 pid 不构成冲突、损坏文件容错、非本进程 lock 不误删、
 * 原子独占创建的竞态判定（存活他人锁拒绝 / 陈旧锁重试 / 自身残留锁重入）。
 * 运行：node node_modules/jiti/lib/jiti-cli.mjs test/mcp-stdio-lock.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  pidAlive,
  readLiveStdioLock,
  acquireStdioLock,
  releaseStdioLock,
  getStdioLockPath,
} from '../src/lib/mcp-stdio-lock.js';

/** 找一个几乎必然已死的 pid（Linux 默认 pid_max 通常 <= 4194304） */
const DEAD_PID = 2 ** 30;

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-stdio-lock-'));
  lockPath = path.join(tmpDir, 'mcp-stdio.lock');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getStdioLockPath', () => {
  it('默认路径位于 ~/.ki/mcp-stdio.lock', () => {
    assert.equal(getStdioLockPath(), path.join(os.homedir(), '.ki', 'mcp-stdio.lock'));
  });
});

describe('pidAlive', () => {
  it('当前进程视为存活', () => {
    assert.equal(pidAlive(process.pid), true);
  });

  it('不存在的 pid 视为已死', () => {
    assert.equal(pidAlive(DEAD_PID), false);
  });
});

describe('acquireStdioLock / releaseStdioLock', () => {
  it('写入成功返回 null，可读回自身 pid 与 startedAt', () => {
    assert.equal(acquireStdioLock(lockPath), null);
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    assert.equal(raw.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(raw.startedAt)));
  });

  it('已有存活的他人锁：返回冲突方信息且不覆盖原锁', () => {
    const startedAt = new Date().toISOString();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt }));
    const conflict = acquireStdioLock(lockPath);
    assert.ok(conflict);
    assert.equal(conflict.pid, 1);
    assert.equal(conflict.startedAt, startedAt);
    // 竞态输家不得覆盖胜者的锁
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid, 1);
  });

  it('陈旧锁（pid 已死）：清理后重试创建成功', () => {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() }),
    );
    assert.equal(acquireStdioLock(lockPath), null);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid, process.pid);
  });

  it('自身残留锁：重新 acquire 成功（不被自己拦住）', () => {
    assert.equal(acquireStdioLock(lockPath), null);
    assert.equal(acquireStdioLock(lockPath), null);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid, process.pid);
  });

  it('释放后文件消失', () => {
    acquireStdioLock(lockPath);
    releaseStdioLock(lockPath);
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('lock 属于其他进程时不误删', () => {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString() }),
    );
    releaseStdioLock(lockPath);
    assert.equal(fs.existsSync(lockPath), true);
  });

  it('文件不存在时释放不抛错', () => {
    assert.doesNotThrow(() => releaseStdioLock(lockPath));
  });
});

describe('readLiveStdioLock', () => {
  it('文件不存在返回 null', () => {
    assert.equal(readLiveStdioLock(lockPath), null);
  });

  it('内容损坏返回 null', () => {
    fs.writeFileSync(lockPath, 'not-json{');
    assert.equal(readLiveStdioLock(lockPath), null);
  });

  it('pid 非法（0/负数/非整数）返回 null', () => {
    for (const pid of [0, -1, 1.5, 'x']) {
      fs.writeFileSync(lockPath, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
      assert.equal(readLiveStdioLock(lockPath), null);
    }
  });

  it('自身 pid 不构成冲突：返回 null', () => {
    acquireStdioLock(lockPath);
    assert.equal(readLiveStdioLock(lockPath), null);
  });

  it('陈旧锁（pid 已死）：返回 null 并清理文件', () => {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() }),
    );
    assert.equal(readLiveStdioLock(lockPath), null);
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('存活的其他进程：返回其 lock 信息', () => {
    // 用 pid 1（init/systemd，恒存活；无权限时 EPERM 也判存活）模拟其他存活进程
    const startedAt = new Date().toISOString();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt }));
    const live = readLiveStdioLock(lockPath);
    assert.ok(live);
    assert.equal(live.pid, 1);
    assert.equal(live.startedAt, startedAt);
    // 存活锁不被清理
    assert.equal(fs.existsSync(lockPath), true);
  });
});
