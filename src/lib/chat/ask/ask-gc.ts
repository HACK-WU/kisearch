/**
 * ask-gc.ts —— 短会话过期清理（REQ-20261113-001 二期 · S-03 §4.4）
 *
 * ═══ 为什么需要 GC（而不是只做"读时判过期"）═══
 * 只做惰性判定的话，**再也没人访问**的短会话会永久占盘 —— 而"忘了"正是短会话最常见的结局。
 * 所以三个时机都要有：读时判定（精确）+ 定时清扫（兜住不再访问的）+ 启动扫一次（兜住停机期间）。
 *
 * ═══ 只碰 `ka-*`（硬约束）═══
 * 扫描走 `listAskSessionIds()`，它只认 `/^ka-[A-Za-z0-9-]+\.json$/`。
 * **绝不**用 `rm -rf` 或通配删除 —— 同目录下还有 `c-*.json`（用户会话）、`assets/`、压缩备份。
 *
 * ═══ 失败处理 ═══
 * 单个文件删除失败只计数不中断整轮（否则一个权限异常会让整个 GC 停摆，垃圾无限累积）。
 *
 * @see design/S03_短会话续接_DESIGN.md §3.2 / §4.4
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../config.js';
import { chatRootDir } from '../chat-store.js';
import { isAskSessionExpired, listAskSessionIds } from './ask-store.js';
import { ASK_SESSION_TTL_DEFAULT_MS } from './ask-contract.js';

/** 清扫间隔：60s（与 `mcp-http` 的会话清扫同量级，避免过密 readdir） */
const SWEEP_INTERVAL_MS = 60_000;

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * 当前生效的 TTL。
 *
 * 缺省 600000ms，配置项 `llm.askSessionTtlMs`（越界由 `config-schema` fail-loud 拦下，
 * 这里再兜一层"非法值用默认"，避免一个坏配置把 TTL 变成 0 导致立刻全量过期）。
 */
export function resolveAskSessionTtl(): number {
  const raw = loadConfig().llm?.askSessionTtlMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return ASK_SESSION_TTL_DEFAULT_MS;
  return raw;
}

/**
 * 扫一轮：遍历 `{chatDir}/` 下每个 scope 目录，删除过期短会话。
 *
 * @returns `scanned` 检查的文件数、`deleted` 实际删除数（失败也计入 scanned，不计 deleted）
 */
export function sweepExpiredAskSessions(now = Date.now()): { scanned: number; deleted: number } {
  const ttlMs = resolveAskSessionTtl();
  const root = chatRootDir();

  let scopeDirs: string[] = [];
  try {
    scopeDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // 目录不存在（首次运行）或不可读：无事可做
    return { scanned: 0, deleted: 0 };
  }

  let scanned = 0;
  let deleted = 0;
  for (const scope of scopeDirs) {
    // `assets` 等非 scope 目录里不会有 `ka-*`；`validateScope` 抛错也不该打断整轮
    let ids: string[] = [];
    try {
      ids = listAskSessionIds(scope);
    } catch {
      continue;
    }
    for (const id of ids) {
      scanned += 1;
      const filePath = path.join(root, scope, `${id}.json`);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { updatedAt?: string };
        if (!isAskSessionExpired({ updatedAt: String(raw.updatedAt ?? '') }, ttlMs, now)) continue;
        fs.rmSync(filePath, { force: true });
        deleted += 1;
      } catch {
        // 解析失败 / 读失败 ⇒ 按"不可用"直接删（与 readAskSession 的损坏处理一致）
        try {
          fs.rmSync(filePath, { force: true });
          deleted += 1;
        } catch {
          // 单文件失败不中断整轮
        }
      }
    }
  }
  return { scanned, deleted };
}

/**
 * 启动 GC：立即扫一次 + 起 60s 定时器（`unref` 不阻进程退出）。
 *
 * 幂等：重复调用只保留一个定时器。
 */
export function startAskGc(): void {
  if (sweepTimer !== null) return;
  sweepExpiredAskSessions();
  sweepTimer = setInterval(() => {
    try {
      sweepExpiredAskSessions();
    } catch (error) {
      // GC 失败不得拖垮 daemon
      process.stderr.write(`[kisearch] 短会话 GC 异常：${(error as Error).message}\n`);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/** 停止 GC（单测用；daemon 生命周期内不需要） */
export function stopAskGc(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
