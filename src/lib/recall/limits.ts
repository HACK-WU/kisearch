/**
 * recall/limits.ts —— `ki_recall` 的运行期护栏（REQ-20261118-004）。
 *
 * 2026-11-18 变更（产品拍板）：
 *   · **删除结果缓存**：它是纯运维参数，上设置页用户也不知道填什么；调 0 又让每次调用变慢。
 *     缓存唯一的实质收益是"同一 query 重复检索"，而预取的 query 来自任务画像，重复率本就低。
 *   · **删除并发槽**：低频场景下它只会制造 `RECALL_BUSY` 噪声；真正需要挡住的是"误调用洪峰"，
 *     那由**频控**负责。
 *   · **保留频控**（默认 20 次/分钟）：唯一有效的护栏，满了直接拒、不排队 —— 开工前等 20 秒
 *     等于阻塞开发，让调用方立刻拿到 `retryAfterSec` 自己决定更划算。
 */

import type { RecallConfig } from '../config.js';
import { RECALL_TOOL_CODES, type RecallToolCode } from './codes.js';

export interface RecallRuntimeConfig {
  /** 每个调用方每分钟上限（1~120） */
  throttlePerMinute: number;
  /**
   * **部署级硬超时上限（cap，毫秒）** —— 2026-11-25 语义调整。
   *
   * 用户可配的超时已挪到「AI 查找」域（`find.timeoutMs`，默认 60s）。
   * 这里只作运维一刀切的上限：实际生效 = `min(find.timeoutMs, hardTimeoutMs)`。
   */
  hardTimeoutMs: number;
}

export const DEFAULT_RECALL_CONFIG: RecallRuntimeConfig = {
  throttlePerMinute: 20,
  /** 上限不宜低于用户默认值（60s），否则改了配置也永远被压住 */
  hardTimeoutMs: 300_000,
};

/** 配置合并：非法/缺省项回落默认（**越界由 config-schema 在加载期拦截**，这里只做兜底） */
export function resolveRecallConfig(raw: RecallConfig | undefined): RecallRuntimeConfig {
  const pick = (value: number | undefined, fallback: number, min: number, max: number): number => (
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
  );
  return {
    throttlePerMinute: pick(raw?.throttlePerMinute, DEFAULT_RECALL_CONFIG.throttlePerMinute, 1, 120),
    hardTimeoutMs: pick(raw?.hardTimeoutMs, DEFAULT_RECALL_CONFIG.hardTimeoutMs, 10_000, 600_000),
  };
}

// ─── 频控（滑动窗口按调用方计）──────────────────────────

const throttleWindows = new Map<string, { count: number; windowStart: number }>();

export interface ThrottleResult {
  ok: boolean;
  code?: RecallToolCode;
  retryAfterSec?: number;
}

export function acquireRecallSlot(
  principalKey: string,
  cfg: RecallRuntimeConfig,
  now: number,
): ThrottleResult {
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
  throttleWindows.set(principalKey, { count: count + 1, windowStart });
  return { ok: true };
}

/** 兼容旧调用方的空实现（并发槽已删除，无需释放；保留以免调用点漏改时崩） */
export function releaseRecallSlot(): void {
  /* no-op */
}

/** 仅单测：清空频控计数（生产不调用） */
export function resetRecallRuntimeForTest(): void {
  throttleWindows.clear();
}
