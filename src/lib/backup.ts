/**
 * backup.ts —— 备份模块
 *
 * 提供：
 *   - autoBackup: import 成功后自动备份（scope 快照）
 *   - backupScopeSnapshot: 打包 scope 目录为 tar.gz
 *   - listBackups: 列出现有备份
 *
 * 批次 3（REQ-04）：ai-results 输入契约已删除，备份仅保留 scope 快照。
 * 备份失败不阻断 import 返回（仅输出 stderr 警告）。
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { getBackupDir, getScopeDataDir, loadConfig } from './config.js';
import type { KiConfig } from './config.js';
import { checkWritable, checkDiskSpace, estimateDirSize } from './preflight.js';

// ─── 类型 ───

export interface BackupResult {
  ok: boolean;
  action: 'backup';
  scope: string;
  snapshotBackup?: string;
  snapshot?: string;
  snapshotPath?: string;
  message?: string;
}

export interface BackupOperationParams {
  scope: string;
}

/** daemon/CLI 共用的单 scope 备份操作；调用方负责调度与输出。 */
export function executeBackup(params: BackupOperationParams): BackupResult & { snapshotPath?: string } {
  const config = loadConfig();
  const { scope } = params;
  const scopeDataDir = getScopeDataDir(config, scope);
  if (!fs.existsSync(scopeDataDir)) throw new Error(`scope 数据目录不存在：${scopeDataDir}`);
  const rcPath = path.join(scopeDataDir, 'relations-cache.json');
  if (!fs.existsSync(rcPath)) throw new Error(`scope "${scope}" 尚未初始化（缺少 relations-cache.json），请先执行 import`);
  const snapshotPath = backupScopeSnapshot(config.backupDir, scope, scopeDataDir);
  return {
    ok: true,
    action: 'backup',
    scope,
    snapshot: path.basename(snapshotPath),
    snapshotPath,
    message: `scope 快照已保存：${snapshotPath}`,
  };
}

export function executeBackupList(scope: string): Record<string, unknown> {
  const config = loadConfig();
  return { ok: true, action: 'backup_list', scope, ...listBackups(config, scope) };
}

// ─── timestamp 工具 ───

function makeTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const M = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}${M}${d}-${h}${m}${s}`;
}

/**
 * 防覆盖（NEG-08）：时间戳精度到秒，同秒内多次备份会撞名。
 * 若目标文件已存在，在扩展名前插入递增序号 -1 / -2 …，返回不冲突的路径。
 * @param targetFile 期望的目标文件绝对路径
 * @param ext 完整扩展名（如 '.tar.gz' / '.json'），用于正确插入序号
 */
function avoidCollision(targetFile: string, ext: string): string {
  if (!fs.existsSync(targetFile)) return targetFile;
  const base = targetFile.slice(0, targetFile.length - ext.length);
  for (let n = 1; n < 10_000; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  // 极端兜底：附加毫秒时间戳
  return `${base}-${Date.now()}${ext}`;
}

// ─── tar 可用性检测 ───

let _tarAvailable: boolean | null = null;

function ensureTarAvailable(): void {
  if (_tarAvailable !== null) return;
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    _tarAvailable = true;
  } catch {
    _tarAvailable = false;
    throw new Error(
      'tar 命令不可用，请安装 tar（Linux/macOS 内置，Windows 请安装 Git for Windows）'
    );
  }
}

// ─── 核心函数 ───

/**
 * 备份 scope 目录为 tar.gz（供 import 自动备份与 restore 还原前安全网使用）
 *
 * @param backupDir     备份根目录（快照落 `<backupDir>/<scope>/snapshots`）
 * @param scope         scope 名
 * @param scopeDataDir  scope 数据目录绝对路径
 * @returns 生成的快照文件绝对路径
 */
export function backupScopeSnapshot(
  backupDir: string,
  scope: string,
  scopeDataDir: string
): string {
  ensureTarAvailable();

  const targetDir = path.join(backupDir, scope, 'snapshots');
  fs.mkdirSync(targetDir, { recursive: true });

  // 预检：可写性 + 磁盘空间（NEG-07，按源目录体积估算，tar.gz 通常更小，留作上界）
  checkWritable(targetDir);
  checkDiskSpace(targetDir, estimateDirSize(scopeDataDir));

  const ts = makeTimestamp();
  const targetFile = avoidCollision(path.join(targetDir, `snapshot.${ts}.tar.gz`), '.tar.gz');
  const scopeDirParent = path.dirname(scopeDataDir);
  const scopeDirName = path.basename(scopeDataDir);

  try {
    // 排除编辑草稿目录（.relation-edits）：草稿是"尚未生效/正在生效"的中间态，
    // 快照原样还原会让草稿复活——其 baseRevision 与还原后的正文未必匹配，甚至
    // 触发中断恢复把已还原的正文回滚成 baseContent。正文本身在 index.json 里，
    // 快照价值不受影响（restore 侧也会兜底清空该目录，覆盖历史快照）。
    execFileSync('tar', ['-czf', targetFile, '--exclude', `${scopeDirName}/.relation-edits`,
      '-C', scopeDirParent, scopeDirName], {
      stdio: 'ignore',
    });
  } catch (err) {
    // 中断/失败清理半截产物（NEG-09），避免残留损坏的 tar.gz
    try { if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile); } catch { /* ignore */ }
    throw err;
  }

  return targetFile;
}

/**
 * 自动备份：import 成功后调用
 * 1. 打包 scope 目录到快照目录
 *
 * 备份失败仅输出 stderr 警告，不阻断调用方
 */
export function autoBackup(
  config: KiConfig,
  scope: string
): BackupResult {
  const backupDir = getBackupDir(config);
  const result: BackupResult = { ok: true, action: 'backup', scope };

  try {
    result.snapshotBackup = backupScopeSnapshot(backupDir, scope, getScopeDataDir(config, scope));
  } catch (err) {
    process.stderr.write(
      `警告：scope 快照备份失败 — ${(err as Error).message}\n`
    );
    result.ok = false;
  }

  return result;
}

/**
 * 列出现有备份
 *
 * @param backupDirOverride 可选的备份根目录（对应 `ki restore --backup-dir`）；
 *   缺省时使用 config.backupDir。传入后按同样的 `<backupDir>/<scope>/snapshots`
 *   布局在该目录下查找。
 */
export function listBackups(
  config: KiConfig,
  scope: string,
  backupDirOverride?: string
): {
  snapshots: Array<{ file: string; timestamp: string; size: number }>;
} {
  const backupDir = backupDirOverride ?? getBackupDir(config);

  const snapshots: Array<{ file: string; timestamp: string; size: number }> = [];
  const snapDir = path.join(backupDir, scope, 'snapshots');
  if (fs.existsSync(snapDir)) {
    const files = fs.readdirSync(snapDir).filter((f) => f.startsWith('snapshot.') && f.endsWith('.tar.gz'));
    for (const file of files) {
      const match = file.match(/^snapshot\.(\d{8}-\d{6}(?:-\d+)?)\.tar\.gz$/);
      if (match) {
        const stat = fs.statSync(path.join(snapDir, file));
        snapshots.push({ file, timestamp: match[1], size: stat.size });
      }
    }
  }

  snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return { snapshots };
}
