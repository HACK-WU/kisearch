import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadConfig } from './config.js';
import { assertOperationWritable, assertNotScopeView } from './scope-policy.js';

const heldLocks = new AsyncLocalStorage<Set<string>>();

/**
 * 本进程「确实正在持有」的锁：key → token。
 *
 * 为什么需要它：锁文件是盘上的，进程崩溃/删除失败都会留下残留文件，而
 * `process.kill(pid, 0)` 只能证明「这个 pid 活着」，**证明不了它还在写**。
 * 典型的失效链：外部删除守卫（例如 IDE 注入的 safe-delete 熔断）让 finally 的
 * `unlinkSync` 抛错 → 锁文件残留 → 该 pid 就是本进程 → 之后每次取锁都被误判成
 * 「正在写入」，用户看到「该知识库正在同步」而实际上没有任何任务在跑。
 *
 * 判据：pid 是本进程时，token 登记在这里 = 确实在写（busy）；查不到时**不立即回收**，
 * 还要 `releasedButNotRemoved` 也命中才算残留（见其注释，防双份实例误回收）。
 */
const heldTokens = new Map<string, string>();

/**
 * 本进程「已经放弃所有权、但文件没能删掉」的锁 key（释放失败时登记）。
 *
 * 只凭 `pid === process.pid` 就回收残留是不安全的：同一进程里若存在两份模块实例
 * （打包/双份加载），A 实例持锁时 B 实例的 heldTokens 里查不到该 token，会把**真锁**
 * 误判成残留并回收 → 两个写操作并发进同一 scope。故回收范围必须收紧到「本实例
 * 亲自释放失败过的 key」，其余一律按 busy 保守拒绝。
 */
const releasedButNotRemoved = new Set<string>();

function busy(): Error {
  return Object.assign(new Error('该知识库已有导入或还原任务正在写入，请等待任务结束后重试'), { code: 'SCOPE_OPERATION_BUSY' });
}

/** 残留锁无法清理（多为外部删除守卫拦截）：给可行动的报错，而不是伪装成「正在同步」 */
function staleLockUnremovable(key: string, cause: unknown): Error {
  return Object.assign(
    new Error(
      `清理残留锁失败：${key} 无法删除（${(cause as Error).message}）。`
      + '该锁已无持有者；若当前环境启用了删除守卫（如 CODEBUDDY_SAFE_DELETE_ENABLED），请手动删除该文件后重试。',
    ),
    { code: 'SCOPE_LOCK_STALE_UNREMOVABLE', cause },
  );
}

/** 已告警过的锁（同一 key 只喊一次，避免每次写操作都刷屏） */
const warnedReleaseFailures = new Set<string>();

/**
 * 释放锁文件。
 *
 * ★ 两件事必须分清：
 * 1. token 不符 → 锁已被别的持有者接管，**不得删除**（静默退出）；
 * 2. token 相符但 unlink 失败 → 这是真实故障，**不能静默吞掉**：锁会留在盘上，
 *    后续取锁会把本进程的残留误判成「正在写入」。本函数只告警、不改变控制流
 *    （释放失败不该让已成功的业务返回失败），自愈由 releasedButNotRemoved 判据负责。
 */
function releaseLockFile(key: string, token: string, operation: string): void {
  let ownerToken: string | undefined;
  try {
    ownerToken = (JSON.parse(fs.readFileSync(key, 'utf8')) as { token?: string }).token;
  } catch {
    return; // 已不存在或不可读：无可归属，绝不删除
  }
  if (ownerToken !== token) {
    releasedButNotRemoved.delete(key); // 已归别人，不留回收登记
    return;
  }
  try {
    fs.unlinkSync(key);
    releasedButNotRemoved.delete(key);
    warnedReleaseFailures.delete(key);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      releasedButNotRemoved.delete(key);
      return;
    }
    // 登记「已放弃所有权、但文件还在」—— 这是下一次取锁敢回收它的唯一依据
    releasedButNotRemoved.add(key);
    if (warnedReleaseFailures.has(key)) return;
    warnedReleaseFailures.add(key);
    process.stderr.write(
      `[kisearch] 警告：释放 scope 锁失败（${key}，operation=${operation}）：${(err as Error).message}\n`
      + '  锁文件已残留；本进程后续对同一 scope 的写入会自动回收它，其它进程则会一直判定为「正在写入」。\n',
    );
  }
}

/** 跨进程 scope 写锁；同一异步调用链内允许 restore → rebuild 嵌套。 */
export async function withScopeWriteLock<T>(scope: string, operation: string, run: () => Promise<T>): Promise<T> {
  /**
   * 只读门禁（REQ-20261029-001）——**取锁之前**判定：
   * ① 放行集见 `EXEMPT_OPS`（import / 数据源 / 运维），拦 `BLOCKED_OPS`（逐条写入）；
   * ② 放在此处而非锁内：只读库的写请求应立刻失败，否则会排在一个长导入后面十余秒才报错；
   * ③ 复用同一份 config 取 dataDir，避免重复 `loadConfig()`（每次含一次 statSync）。
   *
   * ⚠️ `scope-readonly` op 不得走到这里（否则只读库永远解除不了）；
   * `cloneLockScope(repoRoot)` 这类**合成锁键**不是业务 scope，名单精确匹配天然不命中。
   */
  const config = loadConfig();
  assertOperationWritable(scope, operation, config);
  /**
   * 视图门禁（REQ-20261104-003）：必须在**建目录/取锁之前**。
   * 视图名同样能通过字符集校验，漏拦会走到 getScopeDataDir() 凭空建出
   * `dataDir/<视图名>/` —— 静默产出脏目录，且后续「写错库」极难定位。
   */
  assertNotScopeView(scope, operation, config);
  const dir = path.join(config.dataDir, '.ki-scope-locks');
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
    // 只回收确定已无持有者的锁；无法判定时宁可拒绝并发写入。
    let stale = false;
    try {
      const stat = fs.lstatSync(key);
      if (!stat.isFile() || stat.isSymbolicLink()) throw busy();
      let owner: { pid?: number; token?: string } | null = null;
      try {
        owner = JSON.parse(fs.readFileSync(key, 'utf8')) as { pid?: number; token?: string };
      } catch {
        owner = null; // 半截锁（写入中断的残骸）：无法归属
      }
      /**
       * ★ 同进程残留自愈：pid === 本进程时，「活着」不能证明「还在写」——
       * 锁文件完全可能是自己上一条异步链删除失败留下的（见 heldTokens 注释）。
       * 但绝不能只看「token 不在 heldTokens 里」就回收：双份模块实例（打包/重复加载）
       * 下那个 token 是**别人的真锁**，误回收会让两个写操作并发进同一 scope。
       * 因此只回收**本实例亲自释放失败过**的 key（releasedButNotRemoved），其余一律 busy。
       * 这既解掉「明明没同步却提示正在同步」，又守住互斥。
       */
      if (owner === null) {
        // 半截锁同样只认「本实例放弃过它」；否则归属未知，保守拒绝
        if (!releasedButNotRemoved.has(key)) throw busy();
        stale = true;
      } else if (owner.pid === process.pid) {
        if (!owner.token) throw busy(); // 非本代码写入的畸形锁：无法判定，保守拒绝
        if (heldTokens.get(key) === owner.token) throw busy(); // 本实例正在写
        stale = releasedButNotRemoved.has(key);
      } else {
        if (!Number.isInteger(owner.pid) || !owner.pid || owner.pid < 1) throw busy();
        try { process.kill(owner.pid, 0); } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ESRCH') stale = true;
        }
      }
      if (!stale) throw busy();
      const latest = fs.lstatSync(key);
      if (latest.ino !== stat.ino || latest.dev !== stat.dev) throw busy();
      fs.unlinkSync(key);
      fd = fs.openSync(key, 'wx', 0o600);
      releasedButNotRemoved.delete(key); // 已换成新锁，回收登记作废
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw busy();
      if (code === 'SCOPE_OPERATION_BUSY') throw err;
      // 回收失败（典型：外部删除守卫拦截 unlink）—— 必须报出真实原因，不能谎称「正在同步」
      throw staleLockUnremovable(key, err);
    }
  }
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.unlinkSync(key); } catch (cleanupErr) {
      // 半截锁（0 字节或未写完）：登记「本实例放弃了它」，下次取锁才敢回收，
      // 否则它会以「内容不可解析」形态永久挡住该 scope 的写入。
      releasedButNotRemoved.add(key);
      process.stderr.write(
        `[kisearch] 警告：锁写入失败后清理 ${key} 也失败：${(cleanupErr as Error).message}\n`,
      );
    }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  const current = new Set(inherited ?? []);
  current.add(key);
  // 登记「真的持有」：finally 里先注销再删文件 → 删除失败留下的残留不会被误判为仍在写
  heldTokens.set(key, token);
  try {
    return await heldLocks.run(current, run);
  } finally {
    heldTokens.delete(key);
    releaseLockFile(key, token, operation);
  }
}
