/**
 * E2E 隔离 daemon 生命周期工具。
 *
 * 约束：只能停止调用方启动且由 healthz 返回的 daemon PID，不能调用全局
 * `ki mcp stop`，避免隔离测试误停同机其它实例。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const KI_BIN = path.join(REPO_ROOT, 'bin', 'ki.mjs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function probeHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function waitForHealth(port, timeoutMs = 90_000, shouldAbort = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort()) return null;
    const health = await probeHealth(port);
    if (health?.ok === true && health.name === 'kisearch') return health;
    await sleep(500);
  }
  return null;
}

/**
 * 读取隔离 owner 的 OS 资源快照。Linux 上使用 procfs；其他平台明确返回
 * supported=false，调用方不得把缺失采样当成 0。
 */
export function readProcessResourceMetrics(pid) {
  if (process.platform !== 'linux') return { supported: false, pid };
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    const maps = fs.readFileSync(`/proc/${pid}/maps`, 'utf8');
    const fdCount = fs.readdirSync(`/proc/${pid}/fd`).length;
    return {
      supported: true,
      pid,
      rssKb: rssMatch ? Number(rssMatch[1]) : null,
      mmapCount: maps ? maps.trim().split('\n').length : 0,
      fdCount,
    };
  } catch (error) {
    return { supported: false, pid, error: error.message };
  }
}

export async function startIsolatedDaemon({ configPath, env, port, timeoutMs = 60_000 }) {
  // 测试自行持有前台 HTTP 进程，避免 `ki mcp --daemon` 的后台包装器在
  // 3 秒后退出、把后续真实 embedding 预检错误隐藏在 detached 子进程中。
  // bin/ki.mjs 会把 SIGTERM 转发给真正的 mcp-server 子进程，healthz 返回的
  // pid 仍是唯一的 zvec owner，teardown 只针对这个实际 PID。
  const child = spawn(
    process.execPath,
    [KI_BIN, 'mcp', '--http', '--port', String(port), '--config', configPath],
    { cwd: REPO_ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  let exitInfo = null;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.once('exit', (code, signal) => { exitInfo = { code, signal }; });
  const health = await waitForHealth(port, timeoutMs, () => exitInfo !== null);
  if (!health) {
    try { child.kill('SIGTERM'); } catch { /* 启动失败时可能已经退出 */ }
    await waitForPidExit(child.pid, 3000);
    throw new Error(
      `隔离 daemon 未在 ${timeoutMs}ms 内就绪（port=${port}）`
      + (exitInfo ? `；launcher exit=${exitInfo.code ?? 'null'} signal=${exitInfo.signal ?? 'null'}` : '')
      + `；stderr=${stderr.trim() || '(empty)'}；stdout=${stdout.trim() || '(empty)'}`,
    );
  }
  return { ...health, launcherPid: child.pid };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

/**
 * 精确停止隔离 daemon。pid 可省略，此时从隔离端口 healthz 读取。
 * 返回值同时确认 PID 和端口均已退出，调用方据此决定是否安全清理目录。
 */
export async function stopIsolatedDaemon({ port, pid, gracefulTimeoutMs = 5000 }) {
  const health = pid ? null : await probeHealth(port);
  const targetPid = pid ?? health?.pid;
  if (!Number.isInteger(targetPid) || targetPid <= 0 || targetPid === process.pid) {
    return { pid: targetPid ?? null, exited: true, portClosed: !(await probeHealth(port)) };
  }

  try {
    process.kill(targetPid, 'SIGTERM');
  } catch {
    // 进程可能已退出，下面统一确认终态。
  }
  let exited = await waitForPidExit(targetPid, gracefulTimeoutMs);
  if (!exited) {
    try {
      process.kill(targetPid, 'SIGKILL');
    } catch {
      // 进程可能在 SIGKILL 前退出。
    }
    exited = await waitForPidExit(targetPid, 2000);
  }

  const deadline = Date.now() + 3000;
  let portClosed = false;
  while (Date.now() < deadline) {
    if (!(await probeHealth(port))) {
      portClosed = true;
      break;
    }
    await sleep(100);
  }
  return { pid: targetPid, exited, portClosed };
}
