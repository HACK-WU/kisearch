/**
 * WAL 写入机制（Write-Ahead Log）
 *
 * 写入流程：获取跨进程文件锁 → 写 .tmp → atomic rename → 释放锁
 * 原子写入保证：即使写入中断，原文件也不会损坏。
 * 并发保护（NEG-06）：同一目标文件同一时刻仅允许一个进程写入，
 *   避免多进程 / 多 MCP 工具调用并发写 JSON 造成 Last-Write-Wins 静默覆盖。
 * 备份策略：由用户自行备份 kb/ 目录（如 rsync / tar），不在此处自动备份。
 */

import fs from 'fs';
import path from 'path';

/** 锁获取超时（毫秒）：超时后视对方异常退出，抢占锁避免死锁 */
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
/** 锁陈旧阈值（毫秒）：锁文件超过此年龄视为持有进程已崩溃，可抢占 */
const LOCK_STALE_MS = 30_000;
/** 自旋重试间隔（毫秒） */
const LOCK_RETRY_INTERVAL_MS = 50;

/**
 * 同步睡眠（不依赖异步，适配 walWrite 的同步语义）。
 * 通过 Atomics.wait 阻塞当前线程指定毫秒。
 */
function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

/**
 * 获取目标文件的跨进程写锁。
 * 用 O_CREAT|O_EXCL 创建 `${filePath}.lock`，被占用则自旋等待；
 * 锁陈旧或超时则抢占，避免持锁进程崩溃导致永久死锁。
 * @returns 锁文件路径（用于释放）
 */
function acquireLock(filePath: string): string {
  const lockPath = `${filePath}.lock`;
  const start = Date.now();

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // O_CREAT|O_EXCL|O_WRONLY
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      fs.closeSync(fd);
      return lockPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // 锁已存在：检查是否陈旧（持有者可能已崩溃）
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath); // 抢占陈旧锁
          continue;
        }
      } catch {
        // 锁在检查间隙被释放，重试
        continue;
      }

      // 超时兜底：抢占以避免死锁
      if (Date.now() - start > LOCK_ACQUIRE_TIMEOUT_MS) {
        try { fs.unlinkSync(lockPath); } catch { /* 已被释放 */ }
        continue;
      }

      sleepSync(LOCK_RETRY_INTERVAL_MS);
    }
  }
}

/** 释放写锁（幂等） */
function releaseLock(lockPath: string): void {
  try { fs.unlinkSync(lockPath); } catch { /* 已释放 */ }
}

/**
 * WAL 写入：获取写锁 → 写临时文件 → 原子 rename → 释放锁
 *
 * ⚠️ 同步阻塞语义（CH-1）：本函数为同步实现，等锁期间通过 Atomics.wait 阻塞当前线程，
 *   最长可达 LOCK_ACQUIRE_TIMEOUT_MS。在 MCP 长驻进程中，一次锁争用会短暂冻结整个
 *   事件循环——其它并发工具 handler 与 setTimeout 定时器在此期间均无法执行，因此 MCP
 *   工具层的 withTimeout 超时在同步阻塞期间也不会触发。由于锁仅在「写 .tmp + rename」
 *   这一极短区间持有，正常争用窗口在毫秒级；仅当持锁进程崩溃（陈旧锁 30s 窗口内）或
 *   极端高并发时才可能出现秒级阻塞。如需彻底消除该阻塞，应改用异步锁（fs.promises +
 *   异步重试）以配合事件循环调度。
 *
 * @param filePath 目标文件绝对路径
 * @param data 要写入的数据（会被 JSON.stringify）
 */
export function walWrite(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const tmpPath = path.join(dir, `${basename}.tmp`);

  // 确保目录存在（锁文件也需要目录先存在）
  fs.mkdirSync(dir, { recursive: true });

  // 跨进程写锁：串行化同一文件的并发写入（NEG-06）
  const lockPath = acquireLock(filePath);
  try {
    // 写临时文件
    const jsonStr = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, jsonStr, 'utf-8');

    // 原子 rename
    fs.renameSync(tmpPath, filePath);
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * 清理目录中残留的 .tmp 与陈旧 .lock 文件（NEG-09：中断残留清理）
 * - .tmp：原子 rename 前的半截产物，永远可安全删除
 * - .lock：仅删除陈旧锁（age > LOCK_STALE_MS），避免误删并发进程持有的活锁
 * @param dir 要清理的目录
 * @returns 清理的文件数量
 */
export function cleanupTmpFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;

  let count = 0;
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (entry.endsWith('.tmp')) {
      try { fs.unlinkSync(full); count++; } catch { /* 已被清理 */ }
    } else if (entry.endsWith('.lock')) {
      // 仅回收陈旧锁，保护并发进程的活锁
      try {
        const age = Date.now() - fs.statSync(full).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(full);
          count++;
        }
      } catch { /* 已被清理 */ }
    }
  }
  return count;
}
