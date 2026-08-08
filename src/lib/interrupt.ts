/**
 * interrupt.ts —— REQ-01/02 导入中断标记 + 并发导入锁（方案 D，批次 4）
 *
 * 设计（REQ-20260807-001 v9）：
 *   - 中断标记：导入被 SIGINT/SIGTERM 中断时写入（含进度/时间），向量命令前置检测引导重建
 *   - 标记生命周期：rebuild-vector/restore 成功后自动清除；full/incremental 成功导入后清除；手动清除
 *   - 导入锁：<scope>/.import.lock（pid + 开始时间），正常完成删除；SIGKILL 残留 → pid 不存在自动清理（N4）
 *   - 触发范围（N1）：getEngine 前置检测（所有打开向量库的命令）；纯 KB 命令不触发
 */

import fs from 'fs';
import path from 'path';
import { getKbDir } from './scope.js';

// ─── 中断标记 ─────────────────────────────────────────────

export interface InterruptMark {
  scope: string;
  interruptedAt: string;
  /** 中断时已处理的文件数（进度口径：local KB 写入完成计） */
  processedFiles: number;
  /** 中断时总文件数 */
  totalFiles: number;
  /** 触发信号（SIGINT / SIGTERM / unknown） */
  signal: string;
}

/** 中断标记文件路径：kb/{scope}/import-interrupt.json */
export function getInterruptMarkPath(scope: string): string {
  return path.join(getKbDir(scope), 'import-interrupt.json');
}

/** 读取中断标记（不存在返回 null） */
export function readInterruptMark(scope: string): InterruptMark | null {
  const p = getInterruptMarkPath(scope);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as InterruptMark;
  } catch {
    return null; // 损坏标记视为不存在（可重新导入覆盖）
  }
}

/** 写入中断标记（原子写） */
export function writeInterruptMark(scope: string, mark: Omit<InterruptMark, 'scope' | 'interruptedAt'>): void {
  const p = getInterruptMarkPath(scope);
  const data: InterruptMark = {
    scope,
    interruptedAt: new Date().toISOString(),
    ...mark,
  };
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, p);
}

/** 清除中断标记（rebuild 成功 / 成功导入 / 手动） */
export function clearInterruptMark(scope: string): void {
  const p = getInterruptMarkPath(scope);
  for (const f of [p, p + '.tmp']) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

/**
 * REQ-02 引导文案（N1：与 REQ-09 originalHint 去重——此处为完整引导，REQ-09 不再重复）
 * @returns 引导提示字符串；无标记返回 null
 */
export function interruptGuidance(scope: string): string | null {
  const mark = readInterruptMark(scope);
  if (!mark) return null;
  return (
    `检测到未完成的导入（${mark.interruptedAt}，已完成 ${mark.processedFiles}/${mark.totalFiles} 个文件），` +
    `向量库可能不完整。建议执行：ki rebuild-vector 或 ki restore ${scope} --from-snapshot --rebuild-vector 恢复`
  );
}

// ─── 并发导入锁（N4）──────────────────────────────────────

export interface ImportLock {
  pid: number;
  startedAt: string;
}

/** 导入锁文件路径：kb/{scope}/.import.lock */
export function getImportLockPath(scope: string): string {
  return path.join(getKbDir(scope), '.import.lock');
}

/** 尝试获取导入锁：成功返回 true；已有活动锁返回 false */
export function acquireImportLock(scope: string): boolean {
  const p = getImportLockPath(scope);
  if (fs.existsSync(p)) {
    // 检查 pid 是否存活：pid 不存在（SIGKILL/崩溃残留）→ 自动清理（N4）
    try {
      const lock = JSON.parse(fs.readFileSync(p, 'utf-8')) as ImportLock;
      if (lock.pid && isPidAlive(lock.pid)) {
        return false; // 真并发导入，拒绝
      }
      // pid 不存在 → 残留死锁，清理后继续
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    } catch {
      // 锁文件损坏 → 清理后继续
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
  const data: ImportLock = { pid: process.pid, startedAt: new Date().toISOString() };
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, p);
  return true;
}

/** 仅删除导入锁文件（不清中断标记；中断路径用，保留标记供引导） */
export function clearImportLock(scope: string): void {
  const p = getImportLockPath(scope);
  for (const f of [p, p + '.tmp']) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

/** 释放导入锁（正常完成）；同时清除中断标记（REQ-02 生命周期②③） */
export function releaseImportLock(scope: string): void {
  clearInterruptMark(scope); // 成功导入同时清除中断标记（REQ-02 生命周期②③）
  clearImportLock(scope);
}

/** pid 是否存活（macOS/Linux 用 process.kill(pid, 0)） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH（不存在）或 EPERM（存在但无权限——视为存活）
  }
}
