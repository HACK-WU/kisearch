/**
 * rules/store.ts —— 规则文件路径、缓存读、写锁与原子写（S-01 · 规则内核）。
 *
 * 设计锚点：`.requirements/ai-rules/AI_RULES_S01_KERNEL_DESIGN.md` §3.2 读写路径、§5.1、§6、§7
 *
 * 全局约束：
 *   · 存储位置 = `{chatDir}/scope-rules.json`，与 `prompt-config.json` 同目录；
 *   · 读**不加锁**：写是 tmp + rename，读只会见旧或新；
 *   · 写**必须**在 `withRulesLock()` 内，禁止裸调 `writeRules()`；
 *   · 文件损坏时读降级为空、写拒绝覆盖。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteConfig, resolveDefaultChatDir, type KiConfig } from '../config.js';
import { rulesLog } from './log.js';
import { MAX_RULE_CHARS, RULES_FILE_VERSION, RulesError, type RuleRecord, type RulesFile } from './types.js';

/** 锁等待上限：写操作是毫秒级，2s 足够；超时即可重试 */
const LOCK_WAIT_MS = 2_000;
/** 锁文件超过该年龄才允许回收（防误删正在写的进程） */
const LOCK_STALE_MS = 30_000;

/** 进程内读缓存：`path:mtimeMs:size` → 解析结果；本进程写成功后直接替换 */
let cache: { key: string; file: RulesFile } | null = null;

/** 本进程持有的锁路径；同进程重入直接拒绝，避免自己等自己 */
const heldLocks = new Set<string>();

/** 同步 sleep 用的共享缓冲（Node 主线程允许 Atomics.wait） */
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function emptyFile(): RulesFile {
  return { version: RULES_FILE_VERSION, rules: [] };
}

/**
 * 拷贝文件对象：缓存里的对象绝不能被写路径原地修改。
 * 写路径若在 writeRules 之前抛错，磁盘未变、缓存也不能出现“幽灵更新”。
 */
function cloneFile(file: RulesFile): RulesFile {
  return { version: RULES_FILE_VERSION, rules: file.rules.map((r) => ({ ...r })) };
}

/** 单条记录的结构校验：坏记录跳过，不让一个手改坏的行拖垮整个文件 */
function isRuleRecord(value: unknown): value is RuleRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return false;
  if (typeof r.scope !== 'string' || r.scope.length === 0) return false;
  if (typeof r.text !== 'string') return false;
  const text = r.text.trim();
  if (text.length === 0 || text.length > MAX_RULE_CHARS) return false;
  if (r.source !== 'human' && r.source !== 'ai') return false;
  if (r.expiresAt !== null && typeof r.expiresAt !== 'string') return false;
  if (typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt))) return false;
  if (typeof r.updatedAt !== 'string' || !Number.isFinite(Date.parse(r.updatedAt))) return false;
  if (typeof r.createdBy !== 'string') return false;
  if (r.expiresAt !== null && !Number.isFinite(Date.parse(r.expiresAt as string))) return false;
  // 不变量：AI 规则没有 expiresAt（1 天是淘汰年龄，不是 TTL）
  if (r.source === 'ai' && r.expiresAt !== null) return false;
  return true;
}

/**
 * 规则文件绝对路径：`{chatDir}/scope-rules.json`。
 *
 * 参数：config — 运行时配置（`chatDir` 缺省派生自 `dataDir`）
 * 返回：绝对路径
 * 异常：无
 * 设计文档：§ S-01 §3.2 / §9
 */
export function rulesFilePath(config: KiConfig): string {
  const chatDir = config.chatDir ?? resolveDefaultChatDir(config.dataDir);
  return path.join(chatDir, 'scope-rules.json');
}

/**
 * 读取规则文件（带 `path:mtime:size` 缓存）。
 *
 * 参数：config — 运行时配置
 * 返回：`RulesFile`；文件不存在 / 解析失败 / version 不识别 → `{ version: 1, rules: [] }`
 * 异常：不抛（损坏只记日志并降级为空）
 * 预期行为：
 *   1. `statSync` 取 `mtimeMs:size`，与 `rulesFilePath` 拼成缓存 key
 *   2. 与缓存一致则直接返回缓存
 *   3. 否则读文件、`JSON.parse`、校验 `version`
 *   4. 成功则更新缓存；失败则记日志、返回空文件
 * 设计文档：§ S-01 §5.1 / §6 / §7
 */
export function readRules(config: KiConfig): RulesFile {
  const filePath = rulesFilePath(config);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // 不存在 / 不可读：都按空规则处理，读取方不需要区分
    return emptyFile();
  }

  const key = `${filePath}:${stat.mtimeMs}:${stat.size}`;
  if (cache && cache.key === key) return cloneFile(cache.file);

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== RULES_FILE_VERSION || !Array.isArray(obj.rules)) throw new Error('unrecognized shape');

    const all = obj.rules;
    const rules = all.filter(isRuleRecord);
    if (rules.length !== all.length) {
      rulesLog('error', { code: 'RULES_CORRUPT' });
    }
    const file: RulesFile = { version: RULES_FILE_VERSION, rules };
    cache = { key, file };
    return cloneFile(file);
  } catch {
    rulesLog('error', { code: 'RULES_CORRUPT' });
    const file = emptyFile();
    cache = { key, file };
    return cloneFile(file);
  }
}

/**
 * 原子写入规则文件（调用方必须已持有写锁）。
 *
 * 参数：config、file — 完整文件内容（version 必须为 1）
 * 返回：void
 * 异常：`RULES_WRITE_FAILED`（磁盘失败）/ `RULES_CORRUPT`（调用方传入非法结构）
 * 预期行为：
 *   1. `JSON.stringify(file, null, 2) + '\n'`
 *   2. 复用 `atomicWriteConfig()`（tmp + rename + 保留 mode）
 *   3. 成功后同步替换进程内缓存
 * 约束：**禁止**在 `withRulesLock()` 之外调用
 * 设计文档：§ S-01 §5.1 / §6 / §7
 */
export function writeRules(config: KiConfig, file: RulesFile): void {
  if (!file || file.version !== RULES_FILE_VERSION || !Array.isArray(file.rules)) {
    throw new RulesError('RULES_CORRUPT', '规则文件结构非法：version 必须为 1 且 rules 必须是数组');
  }
  const filePath = rulesFilePath(config);
  if (!heldLocks.has(`${filePath}.lock`)) {
    throw new RulesError('RULES_BUSY', 'writeRules 必须在 withRulesLock() 内调用，否则会丢失并发更新');
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteConfig(filePath, `${JSON.stringify(file, null, 2)}\n`);
  } catch (err) {
    throw new RulesError('RULES_WRITE_FAILED', `规则文件写入失败：${(err as Error).message}`);
  }

  try {
    const stat = fs.statSync(filePath);
    cache = { key: `${filePath}:${stat.mtimeMs}:${stat.size}`, file: cloneFile(file) };
  } catch {
    cache = null;
  }
}

/** 锁文件里的持有者信息 */
interface LockOwner {
  pid: number;
  token: string;
  at: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 尝试回收崩溃进程留下的锁；成功回收返回 true */
function reclaimStaleLock(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;
    let pid = 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockOwner>;
      if (typeof parsed.pid === 'number') pid = parsed.pid;
    } catch {
      /* 锁文件损坏：按无人持有处理，仍受 age 约束 */
    }
    if (pid > 0 && pidAlive(pid)) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 规则文件写锁（进程内 + 跨进程）。
 *
 * 参数：config、fn — 持锁期间执行的同步函数
 * 返回：`fn()` 的返回值
 * 异常：`RULES_BUSY` — 等待超过 2s；同进程重入
 * 预期行为：
 *   1. 锁路径 = `${rulesFilePath}.lock`，`fs.openSync(lockPath, 'wx', 0o600)`
 *   2. 写入 `{ pid, token, at }`；失败则 10~50ms 退避重试，总超时 2s
 *   3. 残留判定：锁 age > 30s 且 pid 不存活 → 删除后重试
 *   4. `try/finally` 释放锁；释放失败只告警
 * 约束：仅写路径使用；GC 抢锁失败应**跳过**而不是重试到超时
 * 设计文档：§ S-01 §3.2 / §6
 * @internal 不通过 index.ts 对外导出
 */
export function withRulesLock<T>(config: KiConfig, fn: () => T): T {
  const lockPath = `${rulesFilePath(config)}.lock`;
  if (heldLocks.has(lockPath)) {
    throw new RulesError('RULES_BUSY', '规则写锁重入：当前调用已在持锁状态，请勿嵌套');
  }

  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (err) {
    throw new RulesError('RULES_WRITE_FAILED', `规则锁目录创建失败：${(err as Error).message}`);
  }

  const token = `${process.pid}-${crypto.randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = -1;
  let acquired = false;

  try {
    for (;;) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        acquired = true;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new RulesError('RULES_WRITE_FAILED', `规则锁创建失败：${(err as Error).message}`);
        }
        if (reclaimStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new RulesError('RULES_BUSY', '规则文件正在被其他写入方占用，请稍后重试');
        }
        sleepSync(10 + Math.floor(Math.random() * 40));
      }
    }

    try {
      const owner: LockOwner = { pid: process.pid, token, at: Date.now() };
      fs.writeFileSync(fd, JSON.stringify(owner), 'utf8');
    } catch (err) {
      try { fs.unlinkSync(lockPath); } catch { /* 释放失败不掩盖原错误 */ }
      throw new RulesError('RULES_WRITE_FAILED', `规则锁写入失败：${(err as Error).message}`);
    }

    heldLocks.add(lockPath);
    // 写路径要在锁内看到磁盘最新内容：让下一次 readRules 重新 stat + 解析
    cache = null;
    return fn();
  } finally {
    heldLocks.delete(lockPath);
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    if (acquired) {
      try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const owner = JSON.parse(raw) as Partial<LockOwner>;
        if (owner.token === token) fs.unlinkSync(lockPath);
      } catch {
        /* 已释放 / 文件损坏：不在这里制造二次异常 */
      }
    }
  }
}
