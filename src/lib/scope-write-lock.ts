import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadConfig } from './config.js';

const heldLocks = new AsyncLocalStorage<Set<string>>();

function busy(): Error {
  return Object.assign(new Error('该知识库已有导入或还原任务正在写入，请等待任务结束后重试'), { code: 'SCOPE_OPERATION_BUSY' });
}

/** 跨进程 scope 写锁；同一异步调用链内允许 restore → rebuild 嵌套。 */
export async function withScopeWriteLock<T>(scope: string, operation: string, run: () => Promise<T>): Promise<T> {
  const dir = path.join(loadConfig().dataDir, '.ki-scope-locks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw busy();
  const key = path.join(dir, `${crypto.createHash('sha256').update(scope).digest('hex')}.lock`);
  const inherited = heldLocks.getStore();
  if (inherited?.has(key)) return run();
  const token = crypto.randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token, operation, startedAt: Date.now() });
  let fd: number;
  try {
    fd = fs.openSync(key, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // 只回收确定属于已退出进程的锁；无法判定时宁可拒绝并发写入。
    let stale = false;
    try {
      const stat = fs.lstatSync(key);
      if (!stat.isFile() || stat.isSymbolicLink()) throw busy();
      const owner = JSON.parse(fs.readFileSync(key, 'utf8')) as { pid?: number };
      if (!Number.isInteger(owner.pid) || !owner.pid || owner.pid < 1) throw busy();
      try { process.kill(owner.pid, 0); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') stale = true;
      }
      if (!stale) throw busy();
      const latest = fs.lstatSync(key);
      if (latest.ino !== stat.ino || latest.dev !== stat.dev) throw busy();
      fs.unlinkSync(key);
      fd = fs.openSync(key, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw busy();
      throw err;
    }
  }
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.unlinkSync(key); } catch { /* keep original write error */ }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  const current = new Set(inherited ?? []);
  current.add(key);
  try {
    return await heldLocks.run(current, run);
  } finally {
    try {
      if (JSON.parse(fs.readFileSync(key, 'utf8')).token === token) fs.unlinkSync(key);
    } catch { /* 其他进程不得删除当前持有者的锁 */ }
  }
}
