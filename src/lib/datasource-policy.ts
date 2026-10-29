/**
 * 数据源页面同步策略（S-03）。
 *
 * 纯函数，不读磁盘：服务端用它下发 `syncAvailability` 并强制 429；
 * CLI 不经过这里（CLI 始终可强制同步）。
 */
import type { DataSourceKind } from './datasource-types.js';

/** 普通目录页面同步冷却：30 分钟 */
export const DATASOURCE_PAGE_SYNC_MIN_INTERVAL_MS = 30 * 60 * 1000;

export type SyncAvailabilityReason = 'active' | 'cooldown' | null;

export interface SyncAvailability {
  allowed: boolean;
  /** 冷却结束的绝对时间（epoch ms）；非冷却为 null */
  nextAvailableAt: number | null;
  /** 相对秒数，便于前端倒计时（避免客户端时钟偏差） */
  retryAfterSec: number | null;
  reason: SyncAvailabilityReason;
}

export function computeSyncAvailability(input: {
  type: DataSourceKind;
  lastSync: { at: number; state: 'ok' | 'partial' | 'failed' | 'cancelled' } | null;
  active: boolean;
  now?: number;
}): SyncAvailability {
  if (input.active) {
    return { allowed: false, nextAvailableAt: null, retryAfterSec: null, reason: 'active' };
  }
  // Git 源增量成本低，不做 30 分钟冷却；仍受服务端并发闸门约束
  if (input.type === 'git') {
    return { allowed: true, nextAvailableAt: null, retryAfterSec: null, reason: null };
  }
  // 只有「完整成功」才启动冷却；partial/failed/cancelled 允许立即重试
  if (input.lastSync?.state === 'ok') {
    const now = input.now ?? Date.now();
    const nextAvailableAt = input.lastSync.at + DATASOURCE_PAGE_SYNC_MIN_INTERVAL_MS;
    if (nextAvailableAt > now) {
      return {
        allowed: false,
        nextAvailableAt,
        retryAfterSec: Math.ceil((nextAvailableAt - now) / 1000),
        reason: 'cooldown',
      };
    }
  }
  return { allowed: true, nextAvailableAt: null, retryAfterSec: null, reason: null };
}
