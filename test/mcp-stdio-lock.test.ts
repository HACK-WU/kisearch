/**
 * mcp-stdio-lock.test.ts —— stdio 多实例 lock 模块单元测试
 *
 * 覆盖：每实例独立 lock 文件（文件名即 pid）、多实例登记、listLiveStdioLocks
 * 排除自身 + 清理陈旧锁、acquire 返回其他存活实例、release 只删自己文件、
 * 文件名解析、pid 存活校验。
 * 运行：node node_modules/jiti/lib/jiti-cli.mjs test/mcp-stdio-lock.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  pidAlive,
  getStdioLockDir,
  getStdioLockFilePath,
  listStdioLockFiles,
  stdioLockPidFromPath,
  listLiveStdioLocks,
  acquireStdioLock,
  releaseStdioLock,
} from '../src/lib/mcp-stdio-lock.js';

/** 找一个几乎必然已死的 pid（Linux 默认 pid_max 通常 <= 4194304） */
const DEAD_PID = 2 ** 30;
/** 用 pid 1（init/systemd，恒存活；无权限时 EPERM 也判存活）模拟其他存活实例 */
const LIVE_OTHER_PID = 1;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-stdio-lock-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLock(dir: string, pid: number): void {
  fs.writeFileSync(
    getStdioLockFilePath2(dir, pid),
    JSON.stringify({ pid, startedAt: new Date().toISOString() }),
  );
}

/** 测试辅助：用指定目录构造 lock 文件路径（绕过模块默认 ~/.ki） */
function getStdioLockFilePath2(dir: string, pid: number): string {
  return path.join(dir, `mcp-stdio-${pid}.lock`);
}

describe('getStdioLockDir / getStdioLockFilePath', () => {
  it('默认目录为 ~/.ki，文件名为 mcp-stdio-<pid>.lock', () => {
    assert.equal(getStdioLockDir(), path.join(os.homedir(), '.ki'));
    assert.equal(getStdioLockFilePath(123), path.join(os.homedir(), '.ki', 'mcp-stdio-123.lock'));
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

describe('stdioLockPidFromPath / listStdioLockFiles', () => {
  it('从文件名解析 pid', () => {
    assert.equal(stdioLockPidFromPath('/x/.ki/mcp-stdio-123.lock'), 123);
  });

  it('非本格式或非法 pid 返回 null', () => {
    assert.equal(stdioLockPidFromPath('/x/.ki/mcp-stdio.lock'), null);
    assert.equal(stdioLockPidFromPath('/x/.ki/mcp-stdio-abc.lock'), null);
    assert.equal(stdioLockPidFromPath('/x/.ki/mcp-http.lock'), null);
    assert.equal(stdioLockPidFromPath('/x/.ki/mcp-stdio-0.lock'), null);
  });

  it('listStdioLockFiles 只匹配本格式，忽略其他文件', () => {
    writeLock(tmpDir, 111);
    writeLock(tmpDir, 222);
    fs.writeFileSync(path.join(tmpDir, 'mcp-http.lock'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'mcp-stdio.lock'), 'old-format');
    fs.writeFileSync(path.join(tmpDir, 'random.txt'), 'y');
    const files = listStdioLockFiles(tmpDir);
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => /mcp-stdio-\d+\.lock$/.test(f)));
  });

  it('目录不存在返回 []', () => {
    assert.deepEqual(listStdioLockFiles(path.join(tmpDir, 'nope')), []);
  });
});

describe('acquireStdioLock / releaseStdioLock（多实例登记）', () => {
  it('无其他实例：创建自己的文件，返回 []', () => {
    const others = acquireStdioLock(tmpDir);
    assert.deepEqual(others, []);
    const myPath = getStdioLockFilePath2(tmpDir, process.pid);
    assert.equal(fs.existsSync(myPath), true);
    assert.equal(JSON.parse(fs.readFileSync(myPath, 'utf-8')).pid, process.pid);
  });

  it('已有其他存活实例：返回其信息，且自己的文件独立创建（不覆盖他人）', () => {
    writeLock(tmpDir, LIVE_OTHER_PID);
    const others = acquireStdioLock(tmpDir);
    assert.equal(others.length, 1);
    assert.equal(others[0].pid, LIVE_OTHER_PID);
    // 自己与他人的文件并存
    assert.equal(fs.existsSync(getStdioLockFilePath2(tmpDir, process.pid)), true);
    assert.equal(fs.existsSync(getStdioLockFilePath2(tmpDir, LIVE_OTHER_PID)), true);
  });

  it('多个其他实例全部返回', () => {
    writeLock(tmpDir, LIVE_OTHER_PID);
    // 第二个"其他实例"用当前进程的父 pid 或任意存活 pid 模拟；此处仅验证多文件遍历
    const otherPid2 = process.ppid;
    writeLock(tmpDir, otherPid2);
    const others = acquireStdioLock(tmpDir);
    const pids = others.map((o) => o.pid).sort();
    assert.deepEqual(pids, [LIVE_OTHER_PID, otherPid2].sort());
  });

  it('release 只删自己的文件，不误删他人', () => {
    writeLock(tmpDir, LIVE_OTHER_PID);
    acquireStdioLock(tmpDir);
    releaseStdioLock(tmpDir);
    assert.equal(fs.existsSync(getStdioLockFilePath2(tmpDir, process.pid)), false);
    assert.equal(fs.existsSync(getStdioLockFilePath2(tmpDir, LIVE_OTHER_PID)), true);
  });

  it('release 文件不存在时不抛错', () => {
    assert.doesNotThrow(() => releaseStdioLock(tmpDir));
  });
});

describe('listLiveStdioLocks', () => {
  it('目录为空返回 []', () => {
    assert.deepEqual(listLiveStdioLocks(tmpDir), []);
  });

  it('返回所有存活实例（排除自身）', () => {
    writeLock(tmpDir, LIVE_OTHER_PID);
    writeLock(tmpDir, process.pid); // 自身
    const lives = listLiveStdioLocks(tmpDir);
    const pids = lives.map((l) => l.pid);
    assert.ok(pids.includes(LIVE_OTHER_PID));
    assert.ok(!pids.includes(process.pid));
  });

  it('陈旧锁（pid 已死）被清理且不返回', () => {
    writeLock(tmpDir, DEAD_PID);
    const lives = listLiveStdioLocks(tmpDir);
    assert.deepEqual(lives, []);
    assert.equal(fs.existsSync(getStdioLockFilePath2(tmpDir, DEAD_PID)), false);
  });

  it('内容损坏的 lock 仍按文件名 pid 返回（存活时）', () => {
    fs.writeFileSync(getStdioLockFilePath2(tmpDir, LIVE_OTHER_PID), 'not-json{');
    const lives = listLiveStdioLocks(tmpDir);
    assert.equal(lives.length, 1);
    assert.equal(lives[0].pid, LIVE_OTHER_PID);
    assert.equal(lives[0].startedAt, ''); // 内容损坏，startedAt 为空
  });
});
