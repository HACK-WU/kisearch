/**
 * mcp-stdio-lock.ts —— ki mcp stdio 模式的多实例 lock
 *
 * 背景：早期单实例 lock（~/.ki/mcp-stdio.lock 单文件单 pid）无法承载多实例——
 * 后来者 pid 不登记，导致 `ki mcp stop` 只停第一个、`--status` 探测不到。
 * 现改为「每实例独立 lock 文件」：每个 stdio 实例用自己的文件 ~/.ki/mcp-stdio-<pid>.lock
 * （文件名即 pid），天然支持多实例登记、并发启动互不干扰、退出只删自己的文件。
 *
 * 与「多实例错开共享向量库」配套：lock 只用于进程管理（stop/restart/status 定位），
 * 不再拒绝多实例——多个 stdio 实例靠向量库空闲释放锁 + 撞锁重试错开共享。
 *
 * 陈旧锁处理：进程被 kill -9 等异常退出会残留 lock，读取时做 pid 存活校验，
 * pid 已死则视为陈旧锁自动清理。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** stdio lock 目录：~/.ki */
export function getStdioLockDir(): string {
  return path.join(os.homedir(), '.ki');
}

/** 构造某目录下某 pid 的 lock 文件路径（内部统一，避免多处散落字符串拼接） */
function stdioLockFilePathIn(dir: string, pid: number): string {
  return path.join(dir, `mcp-stdio-${pid}.lock`);
}

/** 单实例 lock 文件路径：~/.ki/mcp-stdio-<pid>.lock（文件名即 pid） */
export function getStdioLockFilePath(pid: number): string {
  return stdioLockFilePathIn(getStdioLockDir(), pid);
}

/** lock 文件内容结构 */
export interface StdioLockInfo {
  pid: number;
  startedAt: string;
}

/** 文件名匹配：mcp-stdio-<pid>.lock */
const STDIO_LOCK_RE = /^mcp-stdio-(\d+)\.lock$/;

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

/** 列出目录下所有 stdio lock 文件路径（含陈旧，按路径排序） */
export function listStdioLockFiles(dir = getStdioLockDir()): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => STDIO_LOCK_RE.test(f))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/** 从 lock 文件名解析 pid（非本格式或非法 pid 返回 null） */
export function stdioLockPidFromPath(filePath: string): number | null {
  const m = path.basename(filePath).match(STDIO_LOCK_RE);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** 读单个 lock 文件：pid 已死则清理并返回 null；存活返回 {pid, startedAt}（内容损坏仍用文件名 pid） */
function readLockFile(filePath: string): StdioLockInfo | null {
  const pid = stdioLockPidFromPath(filePath);
  if (pid === null) return null;
  if (!pidAlive(pid)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* 清理失败不阻塞判定 */
    }
    return null;
  }
  let startedAt = '';
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { startedAt?: unknown };
    if (typeof raw.startedAt === 'string') startedAt = raw.startedAt;
  } catch {
    /* 内容损坏仍可用文件名 pid */
  }
  return { pid, startedAt };
}

/**
 * 读取所有「存活的」stdio 实例（排除当前进程自身，顺带清理陈旧/损坏 lock）。
 * 供 stop/restart/status 定位多实例。
 */
export function listLiveStdioLocks(dir = getStdioLockDir()): StdioLockInfo[] {
  const result: StdioLockInfo[] = [];
  for (const filePath of listStdioLockFiles(dir)) {
    const info = readLockFile(filePath);
    if (info && info.pid !== process.pid) result.push(info);
  }
  return result;
}

/**
 * 登记当前进程的 stdio lock（创建 ~/.ki/mcp-stdio-<pid>.lock，wx 原子独占）。
 * 返回「其他存活实例」列表（供调用方提示，不再拒绝多实例）。
 * 写失败不阻塞启动：lock 仅用于进程管理定位。
 */
export function acquireStdioLock(dir = getStdioLockDir()): StdioLockInfo[] {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* 目录不可写不阻塞 */
  }
  // 先读其他存活实例（顺带清理陈旧锁）
  const others = listLiveStdioLocks(dir);
  const myPath = stdioLockFilePathIn(dir, process.pid);
  const payload =
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + '\n';
  try {
    fs.writeFileSync(myPath, payload, { flag: 'wx', mode: 0o600 });
  } catch {
    // 自身文件已存在（重入/上次残留）：覆盖更新 startedAt
    try {
      fs.writeFileSync(myPath, payload, { mode: 0o600 });
    } catch (err) {
      // 写失败不阻塞启动，但必须告警：lock 缺失会导致 ki mcp stop / --status 对本实例「失明」
      process.stderr.write(
        `[kisearch] 警告：无法写入 stdio lock 文件（${myPath}），` +
          `本实例将无法被 ki mcp stop / --status 定位。原因：${(err as Error).message}\n`,
      );
    }
  }
  return others;
}

/** 释放当前进程的 stdio lock：删除自己的文件（文件名即 pid，天然不误删他人） */
export function releaseStdioLock(dir = getStdioLockDir()): void {
  try {
    fs.rmSync(stdioLockFilePathIn(dir, process.pid), { force: true });
  } catch {
    /* 文件不存在或不可删，忽略 */
  }
}
