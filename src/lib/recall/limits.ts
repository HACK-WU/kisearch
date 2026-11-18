/**
 * recall/limits.ts —— `ki_recall` 的运行期护栏：配置默认值、检索结果缓存、并发槽、频控。
 *
 * 三件东西刻意都在**进程内**（不落盘、不跨进程）：
 *   - 缓存存的是**检索原始命中**（`{group,name,score}`），**不存**可见性判定结果 ——
 *     每次命中缓存后仍会重算 hidden/已读剔除。事件 `#37`（hidden 摘除不校验实删）证明
 *     「缓存与实态漂移」是这里最容易出的安全类问题，宁可多算一遍。
 *   - 并发槽与频控只是"别把一次误调用放大成洪峰"，不承担配额计费。
 *
 * ⚠️ 缓存键是**检索三元组**（scope + query + mode），不是「任务文本指纹」。
 *    后者看起来更语义化，实则命中率极低（同一个人换句话描述同一件事就 miss），
 *    而真正重复的是底层的 query —— 下沉到检索层，缓存才有意义（challenger C4 的结论）。
 */

import crypto from 'node:crypto';

import type { RecallConfig } from '../config.js';
import { RECALL_TOOL_CODES, type RecallToolCode } from './codes.js';

export interface RecallRuntimeConfig {
  /** 检索结果缓存有效期（秒），0 = 关闭 */
  cacheTtlSec: number;
  /** 缺省候选数上限 */
  maxCandidates: number;
  /** 进程内并发槽 */
  maxConcurrent: number;
  /** 每个调用方每分钟上限 */
  throttlePerMinute: number;
  /** 单次硬超时（毫秒） */
  hardTimeoutMs: number;
}

/** 配置缺省值（`config.yaml` 的 `recall` 段未配置时全部走这里） */
export const DEFAULT_RECALL_CONFIG: RecallRuntimeConfig = {
  cacheTtlSec: 600,
  maxCandidates: 8,
  maxConcurrent: 4,
  throttlePerMinute: 20,
  hardTimeoutMs: 20_000,
};

/**
 * 合并用户配置与默认值。
 *
 * 用 `??` 而不是 `||`：`cacheTtlSec: 0` 是**合法值**（关闭缓存），用 `||` 会被静默改回 600。
 */
export function resolveRecallConfig(raw: RecallConfig | undefined): RecallRuntimeConfig {
  return {
    cacheTtlSec: raw?.cacheTtlSec ?? DEFAULT_RECALL_CONFIG.cacheTtlSec,
    maxCandidates: raw?.maxCandidates ?? DEFAULT_RECALL_CONFIG.maxCandidates,
    maxConcurrent: raw?.maxConcurrent ?? DEFAULT_RECALL_CONFIG.maxConcurrent,
    throttlePerMinute: raw?.throttlePerMinute ?? DEFAULT_RECALL_CONFIG.throttlePerMinute,
    hardTimeoutMs: raw?.hardTimeoutMs ?? DEFAULT_RECALL_CONFIG.hardTimeoutMs,
  };
}

// ─── 检索结果缓存（LRU + TTL）─────────────────────────────────

/** 条目上限：一次查找最多 2×12=24 次检索，500 条足够覆盖几十个并发任务 */
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  value: unknown;
  at: number;
}

/** Map 的插入顺序天然是 LRU：读命中时 delete+set 移到队尾 */
const cache = new Map<string, CacheEntry>();

export function recallCacheKey(scope: string, query: string, mode: string): string {
  return crypto.createHash('sha1').update(`${scope}\u0000${mode}\u0000${query}`).digest('hex');
}

export function readRecallCache<T>(key: string, ttlSec: number, now: number): { value: T; ageMs: number } | null {
  if (ttlSec <= 0) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  const ageMs = now - hit.at;
  if (ageMs > ttlSec * 1000) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return { value: hit.value as T, ageMs };
}

export function writeRecallCache(key: string, value: unknown, now: number): void {
  cache.delete(key);
  cache.set(key, { value, at: now });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function recallCacheSize(): number {
  return cache.size;
}

// ─── 并发槽 + 频控 ───────────────────────────────────────────

let activeRuns = 0;
const throttleWindows = new Map<string, { count: number; windowStart: number }>();

export interface AcquireResult {
  ok: boolean;
  code?: RecallToolCode;
  retryAfterSec?: number;
}

/**
 * 取执行许可（**并发 + 频控**两道，一起判）。
 *
 * 与「AI 查找」相反：这里**不排队**，满了直接拒 —— 开工前的预取等 20 秒等于阻塞开发，
 * 让调用方立刻拿到 `retryAfterSec` 自己决定重试或改用 `ki_search` 更划算（D-02-4）。
 */
export function acquireRecallSlot(
  principalKey: string,
  cfg: RecallRuntimeConfig,
  now: number,
): AcquireResult {
  const win = throttleWindows.get(principalKey);
  const windowStart = win && now - win.windowStart < 60_000 ? win.windowStart : now;
  const count = win && windowStart === win.windowStart ? win.count : 0;
  if (count >= cfg.throttlePerMinute) {
    return {
      ok: false,
      code: RECALL_TOOL_CODES.THROTTLED,
      retryAfterSec: Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000)),
    };
  }
  if (activeRuns >= cfg.maxConcurrent) {
    return { ok: false, code: RECALL_TOOL_CODES.BUSY, retryAfterSec: 1 };
  }
  throttleWindows.set(principalKey, { count: count + 1, windowStart });
  activeRuns += 1;
  return { ok: true };
}

/** 必须放在 `finally`：异常路径漏释放会让并发槽永久少一个 */
export function releaseRecallSlot(): void {
  activeRuns = Math.max(0, activeRuns - 1);
}

export function recallActiveRuns(): number {
  return activeRuns;
}

/** 仅单测：清空缓存与计数（生产不调用） */
export function resetRecallRuntimeForTest(): void {
  cache.clear();
  throttleWindows.clear();
  activeRuns = 0;
}
