/**
 * mcp-stop.ts —— ki mcp stop：一键关闭本机所有 ki mcp 实例并清理 lock
 *
 * 背景：ki mcp 实际是多层进程链（ki 壳 → npm exec → sh → node mcp-server），
 * 手动 kill 顶层壳时真正持锁的孙进程会存活为孤儿，lock 也随之"看似不释放"。
 * 本命令按 lock 文件 + healthz 探活定位真正的服务进程（即持锁者本体），
 * 直接对其发信号——服务进程退出后各层壳会自然级联退出。
 *
 * 安全防线：杀前读 /proc/<pid>/cmdline 校验目标确为 ki mcp 进程，
 * 防止 pid 复用后误杀无辜进程（校验不可用的平台上退化为直接发信号）。
 * 流程：SIGTERM 优雅退出（走 exit 钩子自动清锁）→ 超时 SIGKILL 兜底 → 清理残留 lock。
 */

import * as fs from 'node:fs';

import { getHttpLockPath, fetchHealthz } from './mcp-http.js';
import { getStdioLockPath, pidAlive } from './mcp-stdio-lock.js';

/** 待关闭的目标进程 */
interface StopTarget {
  pid: number;
  kind: 'stdio' | 'http';
}

/** 单个目标的处理结果 */
export interface StopEntry {
  pid: number;
  kind: 'stdio' | 'http';
  /** terminated=SIGTERM 退出；killed=SIGKILL 兜底；skipped=校验不通过未动 */
  result: 'terminated' | 'killed' | 'skipped';
  reason?: string;
}

export interface StopReport {
  stopped: StopEntry[];
  /** 被清理的 lock 文件路径（含陈旧锁） */
  cleanedLocks: string[];
}

export interface StopOptions {
  host: string;
  port: number;
  stdioLockPath?: string;
  httpLockPath?: string;
  /** SIGTERM 后等待优雅退出的时长（毫秒），超时 SIGKILL */
  gracefulTimeoutMs?: number;
  /**
   * pid 身份校验：true=确认是 ki mcp 进程；false=pid 已被复用应跳过；
   * null=无法校验（按可杀处理）。默认读 /proc/<pid>/cmdline。
   */
  verifyPid?: (pid: number) => boolean | null;
}

/** 默认身份校验：Linux 下读 /proc/<pid>/cmdline，包含 mcp-server 特征即认定 */
export function defaultVerifyPid(pid: number): boolean | null {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ');
    return /mcp-server|knowledge-indexer/.test(cmdline);
  } catch {
    return null; // 无 /proc 或不可读：无法校验
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读 lock 文件里的 pid（不做存活校验，容错损坏内容） */
function readLockPid(lockPath: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid?: unknown };
    return Number.isInteger(raw.pid) && (raw.pid as number) > 0 ? (raw.pid as number) : null;
  } catch {
    return null;
  }
}

/** 等待 pid 退出，超时返回 false */
async function waitPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

/**
 * 关闭本机所有 ki mcp 实例并清理 lock。
 * 定位来源：stdio lock、http lock、healthz 探活（lock 被手动删过时的兜底）。
 */
export async function stopMcpInstances(opts: StopOptions): Promise<StopReport> {
  const stdioLockPath = opts.stdioLockPath ?? getStdioLockPath();
  const httpLockPath = opts.httpLockPath ?? getHttpLockPath();
  const gracefulTimeoutMs = opts.gracefulTimeoutMs ?? 3000;
  const verifyPid = opts.verifyPid ?? defaultVerifyPid;

  // ─── 收集目标（去重，排除自身） ───
  const targets: StopTarget[] = [];
  const seen = new Set<number>();
  const addTarget = (pid: number | null, kind: 'stdio' | 'http') => {
    if (pid === null || pid === process.pid || seen.has(pid)) return;
    seen.add(pid);
    if (pidAlive(pid)) targets.push({ pid, kind });
  };
  addTarget(readLockPid(stdioLockPath), 'stdio');
  addTarget(readLockPid(httpLockPath), 'http');
  // healthz 兜底：lock 丢失但服务仍在跑（返回体自带 kisearch 身份，无需再校验 cmdline）
  const live = await fetchHealthz(opts.host, opts.port);
  if (live?.ok === true && live?.name === 'kisearch' && typeof live.pid === 'number') {
    addTarget(live.pid, 'http');
  }

  // ─── SIGTERM 优雅退出 → 超时 SIGKILL 兜底 ───
  const stopped: StopEntry[] = [];
  for (const t of targets) {
    if (verifyPid(t.pid) === false) {
      stopped.push({
        pid: t.pid,
        kind: t.kind,
        result: 'skipped',
        reason: 'pid 已被其他进程复用，未发送信号（仅清理陈旧 lock）',
      });
      continue;
    }
    try {
      process.kill(t.pid, 'SIGTERM');
    } catch {
      /* 进程可能刚好退出，交给下面的存活判定 */
    }
    if (await waitPidExit(t.pid, gracefulTimeoutMs)) {
      stopped.push({ pid: t.pid, kind: t.kind, result: 'terminated' });
      continue;
    }
    try {
      process.kill(t.pid, 'SIGKILL');
    } catch {
      /* 忽略 */
    }
    const gone = await waitPidExit(t.pid, 1000);
    stopped.push({
      pid: t.pid,
      kind: t.kind,
      result: 'killed',
      // SIGKILL 后极端场景（如 D 状态）仍可能短暂存活，如实标注避免报告与锁状态矛盾
      ...(gone ? {} : { reason: '已发送 SIGKILL，但 1s 内未确认退出，lock 暂保留' }),
    });
  }

  // ─── 清理残留 lock（正常退出路径已自清；此处兜底 SIGKILL/陈旧/复用场景） ───
  const cleanedLocks: string[] = [];
  for (const lockPath of [stdioLockPath, httpLockPath]) {
    if (!fs.existsSync(lockPath)) continue;
    const pid = readLockPid(lockPath);
    // pid 已死（含刚被杀掉的）或内容损坏 → 删；仍存活（如校验失败被跳过且真是 ki 进程）→ 保留
    if (pid === null || !pidAlive(pid) || (seen.has(pid) && verifyPid(pid) === false)) {
      try {
        fs.rmSync(lockPath, { force: true });
        cleanedLocks.push(lockPath);
      } catch {
        /* 忽略 */
      }
    }
  }

  return { stopped, cleanedLocks };
}
