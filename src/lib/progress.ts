/**
 * progress.ts —— 导入进度管理
 *
 * 功能：
 *   - 进度文件读写（断点续跑支持）
 *   - apt install 风格的控制台进度展示（输出到 stderr）
 *
 * 进度文件格式（kb/{scope}/import-progress.json）：
 *   {
 *     "scope": "monitor",
 *     "mode": "full",
 *     "rootName": "BkMonitorWiki",
 *     "startedAt": "2026-06-10T10:00:00Z",
 *     "total": 100,
 *     "completed": [
 *       { "path": "docs/api.md", "groupPath": "Wiki/部署", "relation": "API 概览", "memoryId": "abc-123" }
 *     ]
 *   }
 *
 * 设计约束：
 *   - 进度文件使用原子写入（write-then-rename），防止写入中断导致文件损坏
 *   - 控制台进度走 stderr，不污染 stdout 的 JSON 结果
 */

import fs from 'fs';
import path from 'path';
import { getKbDir } from './scope.js';

// ─── 类型 ───────────────────────────────────────────────

export interface ProgressEntry {
  /** 相对于 sourceDir 的 posix 路径，唯一标识 */
  path: string;
  /** Group 树中的完整路径（含 rootName 前缀） */
  groupPath: string;
  /** 由 path 推导的 relation 文本 */
  relation: string;
  /** 向量化后返回的 memory ID */
  memoryId: string;
}

export interface ProgressFile {
  scope: string;
  mode: 'full' | 'incremental';
  rootName: string;
  startedAt: string;
  total: number;
  completed: ProgressEntry[];
}

// ─── 进度文件操作 ───────────────────────────────────────

export function getProgressFilePath(scope: string): string {
  return path.join(getKbDir(scope), 'import-progress.json');
}

export function readProgressFile(scope: string): ProgressFile | null {
  const filePath = getProgressFilePath(scope);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ProgressFile;
  } catch {
    return null;
  }
}

/** 原子写入进度文件：先写 .tmp 再 rename，防止写中断导致文件损坏 */
export function writeProgressFile(scope: string, data: ProgressFile): void {
  const filePath = getProgressFilePath(scope);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export function cleanProgressFile(scope: string): void {
  const filePath = getProgressFilePath(scope);
  for (const p of [filePath, filePath + '.tmp']) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

export function createProgressFile(
  scope: string,
  mode: 'full' | 'incremental',
  rootName: string,
  total: number
): ProgressFile {
  const data: ProgressFile = {
    scope,
    mode,
    rootName,
    startedAt: new Date().toISOString(),
    total,
    completed: [],
  };
  writeProgressFile(scope, data);
  return data;
}

/**
 * 校验进度文件是否与当前导入参数匹配
 * 不匹配返回 null（应忽略旧进度文件）
 */
export function validateProgressFile(
  progress: ProgressFile | null,
  scope: string,
  mode: 'full' | 'incremental',
  rootName: string
): ProgressFile | null {
  if (!progress) return null;
  if (progress.scope !== scope) return null;
  if (progress.mode !== mode) return null;
  if (progress.rootName !== rootName) return null;
  return progress;
}

// ─── 控制台进度展示 ─────────────────────────────────────

const PROGRESS_BAR_WIDTH = 30;

function formatProgressBar(current: number, total: number): string {
  if (total === 0) return `[${' '.repeat(PROGRESS_BAR_WIDTH)}] 0/0 (—)`;
  const pct = Math.min(current / total, 1);
  const filled = Math.round(PROGRESS_BAR_WIDTH * pct);
  // head 占 1 字符（>），filled=0 时无 head
  const head = filled > 0 ? '='.repeat(filled - 1) + '>' : '';
  const tail = ' '.repeat(Math.max(0, PROGRESS_BAR_WIDTH - filled));
  return `[${head}${tail}] ${current}/${total} (${Math.round(pct * 100)}%)`;
}

export function logPhaseStart(phase: number, totalPhases: number, message: string): void {
  process.stderr.write(`\n[Phase ${phase}/${totalPhases}] ${message}\n`);
}

export function logPhaseDone(phase: number, _totalPhases: number, message: string): void {
  process.stderr.write(`  ✓ ${message}\n`);
}

/** 覆写当前行展示进度条（apt install 风格） */
export function logProgress(current: number, total: number, detail?: string): void {
  const bar = formatProgressBar(current, total);
  const line = detail ? `${bar} ${detail}` : bar;
  process.stderr.write(`\r  ${line}`);
  if (current >= total) {
    process.stderr.write('\n');
  }
}

export function logInfo(message: string): void {
  process.stderr.write(`  ${message}\n`);
}

export function logWarn(message: string): void {
  process.stderr.write(`  ⚠ ${message}\n`);
}

export function logSummary(message: string): void {
  process.stderr.write(`\n${message}\n`);
}
