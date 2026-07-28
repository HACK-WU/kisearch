/**
 * mcp-stdio-lock.ts —— ki mcp stdio 模式的单实例 lock
 *
 * 背景：stdio 模式此前没有任何进程管理，多个 IDE 各自用 `command: ki mcp`
 * 拉起独立进程时会静默共存——只有一个抢到向量库锁，其余降级且用户无感知。
 * 本模块把「单一持锁进程」约束前移到启动时刻：后来者读到存活 lock 即被拒绝，
 * 不允许带病共存。
 *
 * 存储：~/.ki/mcp-stdio.lock（JSON：pid + startedAt，与 mcp-http.lock 同目录）。
 * 陈旧锁处理：进程被 kill -9 等异常退出会残留 lock，读取时做 pid 存活校验，
 * pid 已死则视为陈旧锁自动清理，不阻塞新实例启动。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** stdio lock 文件路径：~/.ki/mcp-stdio.lock */
export function getStdioLockPath(): string {
  return path.join(os.homedir(), '.ki', 'mcp-stdio.lock');
}

/** lock 文件内容结构 */
export interface StdioLockInfo {
  pid: number;
  startedAt: string;
}

/**
 * pid 存活校验：signal 0 只探测不发送信号。
 * EPERM 表示进程存在但无权限（如属主不同），同样视为存活。
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 读取「存活的」stdio lock：
 *   - 文件不存在 / 内容损坏 → null
 *   - pid 已死（陈旧锁） → 清理文件并返回 null
 *   - pid 为当前进程自身 → null（自身不构成冲突）
 */
export function readLiveStdioLock(lockPath = getStdioLockPath()): StdioLockInfo | null {
  let info: StdioLockInfo;
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as StdioLockInfo;
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) throw new Error('invalid pid');
    info = raw;
  } catch {
    return null;
  }
  if (info.pid === process.pid) return null;
  if (!pidAlive(info.pid)) {
    // 陈旧锁：持有者已死，清理后放行
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* 清理失败不阻塞判定 */
    }
    return null;
  }
  return info;
}

/**
 * 以原子独占方式写入当前进程的 stdio lock。
 * 竞态防护：flag 'wx' 保证并发启动时只有一个进程创建成功；EEXIST 时复读锁判定——
 * 存活的他人锁 → 返回冲突方信息（调用方应拒绝启动）；陈旧/自身锁 → 清理后重试一次。
 * 其他写失败（如目录不可写）不阻塞启动：lock 仅用于启动守卫与排查。
 */
export function acquireStdioLock(lockPath = getStdioLockPath()): StdioLockInfo | null {
  const payload = JSON.stringify(
    { pid: process.pid, startedAt: new Date().toISOString() },
    null,
    2,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(lockPath, payload, { flag: 'wx' });
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const live = readLiveStdioLock(lockPath);
      if (live) return live; // 竞态输家：已有存活的其他实例
      // 陈旧锁已被 readLiveStdioLock 清理；自身残留锁在此删除后重试独占创建
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
  return null;
}

/** 释放 stdio lock：仅当 lock 属于当前进程时删除，防止误删新实例的锁 */
export function releaseStdioLock(lockPath = getStdioLockPath()): void {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as StdioLockInfo;
    if (raw.pid !== process.pid) return;
    fs.rmSync(lockPath, { force: true });
  } catch {
    /* 文件不存在或不可读，忽略 */
  }
}
