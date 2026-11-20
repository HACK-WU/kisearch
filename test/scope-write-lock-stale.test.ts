/**
 * scope-write-lock-stale.test.ts —— 残留 scope 锁的自愈与 fail-loud
 *
 * 背景（真实故障）：IDE 注入的删除守卫在累计删除 500 次后会 fail-closed 拦截进程内
 * 所有 unlink，`withScopeWriteLock` 的 finally 静默吞错 → 锁文件残留；而取锁只判
 * `process.kill(pid, 0)` 存活，本进程的残留被误判成「他人在写」⇒ 用户保存时反复看到
 * 「该知识库正在同步，完成后再保存」，实际没有任何任务在跑。
 *
 * 契约：
 *   1. 正常完成 → 锁文件删除；
 *   2. 删除失败（守卫拦截）→ 锁残留，但同一进程再次取锁必须自愈成功，不能 busy；
 *   3. 残留且仍无法删除 → 抛 `SCOPE_LOCK_STALE_UNREMOVABLE`（不得谎称「正在同步」）；
 *   4. 锁归外部存活进程 → 仍然 busy（不能误回收他人锁）；
 *   5. 锁归已退出进程 → 回收；
 *   6. token 不符 → 不删除他人锁。
 *
 * 运行：npx jiti test/scope-write-lock-stale.test.ts
 */
import { describe, it, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-scope-lock-'));
const cfgPath = path.join(tmpRoot, 'config.yaml');
const dataDir = path.join(tmpRoot, 'data');
const lockDir = path.join(dataDir, '.ki-scope-locks');
const SCOPE = 'probe-lock';

const lockPathOf = (scope: string): string => path.join(
  lockDir,
  `${crypto.createHash('sha256').update(scope).digest('hex')}.lock`,
);

const lockPath = lockPathOf(SCOPE);
/** 独立 scope：避免上一个用例在模块内留下的「释放失败登记」污染本用例 */
const SCOPE2 = 'probe-lock-2';
const lockPath2 = lockPathOf(SCOPE2);
const SCOPE3 = 'probe-lock-3';
const lockPath3 = lockPathOf(SCOPE3);
const realUnlinkSync = fs.unlinkSync.bind(fs);
const realExists = (p: string): boolean => fs.existsSync(p);

/** 模拟 safe-delete 熔断：所有 .lock 删除抛错（与真实 shim 的错误文案一致） */
function installDeleteBlocker(): void {
  (fs as unknown as { unlinkSync: (p: fs.PathLike, ...rest: unknown[]) => void }).unlinkSync = (
    p: fs.PathLike,
    ...rest: unknown[]
  ) => {
    if (String(p).endsWith('.lock')) {
      throw Object.assign(
        new Error('[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":500,"threshold":500,"scope":"turn"}'),
        { code: 'SAFE_DELETE_BLOCKED' },
      );
    }
    return realUnlinkSync(p, ...rest as []);
  };
}

function restoreUnlink(): void {
  (fs as unknown as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = realUnlinkSync;
}

const realWriteFileSync = fs.writeFileSync.bind(fs);

/** 模拟锁 payload 写失败（仅拦截 fd 形态调用，不影响配置/锁文件内容写入以外的路径） */
function installWriteBlocker(): void {
  (fs as unknown as { writeFileSync: (p: unknown, ...rest: unknown[]) => void }).writeFileSync = (
    p: unknown,
    ...rest: unknown[]
  ) => {
    if (typeof p === 'number') throw new Error('mock ENOSPC');
    return (realWriteFileSync as unknown as (a: unknown, ...r: unknown[]) => void)(p, ...rest);
  };
}

function restoreWrite(): void {
  (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWriteFileSync;
}

before(() => {
  process.env.KI_CONFIG_PATH = cfgPath;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    cfgPath,
    [
      `dataDir: ${dataDir}`,
      `backupDir: ${path.join(tmpRoot, 'backup')}`,
      `vectorDir: ${path.join(tmpRoot, 'vector')}`,
      'scopeMode: default',
      'scopes:',
      `  ${SCOPE}: {}`,
      `  ${SCOPE2}: {}`,
      `  ${SCOPE3}: {}`,
      '',
    ].join('\n'),
    'utf-8',
  );
});

after(() => {
  restoreUnlink();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  restoreUnlink();
  restoreWrite();
  for (const p of [lockPath, lockPath2, lockPath3]) {
    if (realExists(p)) realUnlinkSync(p);
    if (realExists(`${p}.stale`)) realUnlinkSync(`${p}.stale`);
  }
});

async function loadLock() {
  return import('../src/lib/scope-write-lock.js');
}

describe('scope 写锁的释放与残留自愈', () => {
  it('1) 正常完成 → 锁文件被删除', async () => {
    const { withScopeWriteLock } = await loadLock();
    const r = await withScopeWriteLock(SCOPE, 'probe', async () => 'ok');
    assert.equal(r, 'ok');
    assert.equal(realExists(lockPath), false);
  });

  it('2) 删除被拦 → 改名让路（不留锁），下一次取锁直接成功', async () => {
    const { withScopeWriteLock } = await loadLock();
    installDeleteBlocker();
    const first = await withScopeWriteLock(SCOPE, 'probe', async () => 'first');
    assert.equal(first, 'first');
    // 2026-11-20 起：删除守卫拦截时改用 rename 让路，锁路径必须已让出
    assert.equal(realExists(lockPath), false, '删除被拦后锁路径应已让出（改名为 .stale）');
    assert.equal(realExists(`${lockPath}.stale`), true, '应留下 .stale 残骸作为证据');
    restoreUnlink();

    const second = await withScopeWriteLock(SCOPE, 'probe', async () => 'second');
    assert.equal(second, 'second');
    assert.equal(realExists(lockPath), false, '正常释放');
  });

  it('3) 删除与改名双双被拦 → 报 SCOPE_LOCK_STALE_UNREMOVABLE，不谎称正在同步', async () => {
    const { withScopeWriteLock } = await loadLock();
    installDeleteBlocker();
    // 连 rename 也拦掉（模拟「守卫涵盖所有清理手段」的最坏环境）
    const realRename = fs.renameSync.bind(fs);
    (fs as unknown as { renameSync: (a: string, b: string) => void }).renameSync = (a: string, b: string) => {
      if (String(a).endsWith('.lock')) throw Object.assign(new Error('rename blocked'), { code: 'EPERM' });
      return realRename(a, b);
    };
    try {
      await withScopeWriteLock(SCOPE, 'probe', async () => 'first');
      await assert.rejects(
        () => withScopeWriteLock(SCOPE, 'probe', async () => 'second'),
        (err: NodeJS.ErrnoException) => err.code === 'SCOPE_LOCK_STALE_UNREMOVABLE',
      );
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = realRename;
      restoreUnlink();
    }
  });

  it('4) 锁归外部存活进程 → 仍然 busy', async () => {
    const { withScopeWriteLock } = await loadLock();
    const child: ChildProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, token: 'other', operation: 'import', startedAt: Date.now() }));
      await assert.rejects(
        () => withScopeWriteLock(SCOPE, 'probe', async () => 'x'),
        (err: NodeJS.ErrnoException) => err.code === 'SCOPE_OPERATION_BUSY',
      );
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('5) 锁归已退出进程 → 回收后成功', async () => {
    const { withScopeWriteLock } = await loadLock();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: 'dead', operation: 'import', startedAt: Date.now() }));
    const r = await withScopeWriteLock(SCOPE, 'probe', async () => 'ok');
    assert.equal(r, 'ok');
    assert.equal(realExists(lockPath), false);
  });

  it('6) token 不符（被他人接管）→ 不删除他人锁', async () => {
    const { withScopeWriteLock } = await loadLock();
    await withScopeWriteLock(SCOPE, 'probe', async () => {
      // 持有期间把 payload 改成别人的 token：模拟被接管
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'someone-else', operation: 'import', startedAt: Date.now() }));
      return 'ok';
    });
    assert.equal(realExists(lockPath), true, '不归属自己的锁不得删除');
  });

  it('7) 同进程但不认识的 token → 仍 busy（防双份模块实例误回收真锁）', async () => {
    const { withScopeWriteLock } = await loadLock();
    // 模拟「另一份模块实例」正持有（pid 同为本站进程，但本实例从未释放失败过它）
    fs.writeFileSync(
      lockPath2,
      JSON.stringify({ pid: process.pid, token: 'foreign-instance', operation: 'import', startedAt: Date.now() }),
    );
    await assert.rejects(
      () => withScopeWriteLock(SCOPE2, 'probe', async () => 'x'),
      (err: NodeJS.ErrnoException) => err.code === 'SCOPE_OPERATION_BUSY',
    );
    assert.equal(realExists(lockPath2), true, '不认识的锁不得回收');
    realUnlinkSync(lockPath2);
  });

  it('8) 写锁失败 + 清理失败留下的半截锁 → 下次取锁自愈，不永久 busy', async () => {
    const { withScopeWriteLock } = await loadLock();
    try {
      // 写 payload 失败（fd 形态）+ 清理失败（守卫拦截）→ 残留 0 字节锁
      installWriteBlocker();
      installDeleteBlocker();
      await assert.rejects(() => withScopeWriteLock(SCOPE3, 'probe', async () => 'x'), /mock ENOSPC/);
      // 2026-11-20 起：删除被拦时改名让路，半截锁不在原位（否则会永久挡住该 scope）
      assert.equal(realExists(lockPath3), false, '半截锁应已让路');
    } finally {
      restoreWrite();
      restoreUnlink();
    }

    // 修复前：内容不可解析 → 永久 busy；现在认得「本实例放弃过它」→ 回收重建
    const r = await withScopeWriteLock(SCOPE3, 'probe', async () => 'ok');
    assert.equal(r, 'ok');
    assert.equal(realExists(lockPath3), false);
  });
});
