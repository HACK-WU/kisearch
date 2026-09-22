/**
 * 快照还原的 daemon-side 复合操作。
 *
 * 该模块不解析 CLI 参数、不输出 JSON、也不 process.exit；调用方负责确认语义，
 * 本函数只在 coordinator 已取得 scope 队列后执行删除、解压和安全网快照，
 * 确保 restore 不会与同 scope 的 import/search/write 交叉读写 KB。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, getScopeDataDir, getBackupDir } from './config.js';
import { validateScope } from './scope.js';
import { backupScopeSnapshot } from './backup.js';
import { checkWritable, checkDiskSpace } from './preflight.js';
import { extractScopeSnapshot } from './safe-tar.js';
import { rebuildFtsOnlyScope, type FtsRebuildResult } from './fts-rebuild.js';

export interface RestoreSnapshotOptions {
  timestamp?: string;
  backupDir?: string;
  snapshotFile?: string;
  /** 仅在安全批次边界检查；不会强行打断同步 tar 操作。 */
  abortSignal?: AbortSignal;
  onProgress?: (progress: { phase: 'restore'; done: number; total: number }) => void;
}

export interface RestoreSnapshotResult {
  ok: true;
  action: 'restore_snapshot';
  scope: string;
  snapshot: string;
  restoredAt: string;
  fullText?: FtsRebuildResult;
}

function ensureTarAvailable(): void {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('tar 命令不可用，请安装 tar（Linux/macOS 内置，Windows 请安装 Git for Windows）');
  }
}

function selectSnapshot(scope: string, opts: RestoreSnapshotOptions, backupDir: string): { path: string; file: string } {
  if (opts.snapshotFile) {
    const snapshotPath = path.resolve(opts.snapshotFile);
    if (!fs.existsSync(snapshotPath)) {
      throw new Error(`指定的快照文件不存在：${snapshotPath}`);
    }
    return { path: snapshotPath, file: path.basename(snapshotPath) };
  }

  const snapDir = path.join(backupDir, scope, 'snapshots');
  if (!fs.existsSync(snapDir)) throw new Error(`快照目录不存在：${snapDir}，无可还原的快照`);
  const snapFiles = fs.readdirSync(snapDir)
    .filter((file) => file.startsWith('snapshot.') && file.endsWith('.tar.gz'))
    .sort();
  if (snapFiles.length === 0) throw new Error(`快照目录为空：${snapDir}`);

  const file = opts.timestamp ? `snapshot.${opts.timestamp}.tar.gz` : snapFiles[snapFiles.length - 1];
  if (!snapFiles.includes(file)) {
    throw new Error(`指定 timestamp 的快照不存在：${opts.timestamp}\n可用快照：\n${snapFiles.join('\n')}`);
  }
  return { path: path.join(snapDir, file), file };
}

/** 在 daemon 的 scope 队列内执行一次完整快照还原。 */
export async function restoreSnapshotLocal(
  scope: string,
  opts: RestoreSnapshotOptions = {},
): Promise<RestoreSnapshotResult> {
  const checkCancelled = () => {
    if (opts.abortSignal?.aborted) {
      throw Object.assign(new Error('还原已取消（当前 restore 批次尚未开始写入）'), { code: 'RESTORE_CANCELLED' });
    }
  };
  checkCancelled();
  opts.onProgress?.({ phase: 'restore', done: 0, total: 1 });
  validateScope(scope);
  ensureTarAvailable();
  const config = loadConfig();
  const backupDir = opts.backupDir ? path.resolve(opts.backupDir) : getBackupDir(config);
  // --backup-dir 只控制读取来源；安全网始终写入受管的默认 backupDir。
  const safetyBackupDir = getBackupDir(config);
  const snapshot = selectSnapshot(scope, opts, backupDir);
  const scopeDataDir = getScopeDataDir(config, scope);
  const scopeDirParent = path.dirname(scopeDataDir);

  checkWritable(scopeDirParent);
  checkDiskSpace(scopeDirParent, fs.statSync(snapshot.path).size * 5);

  let safetySnapshot: string | null = null;
  if (fs.existsSync(scopeDataDir)) {
    checkCancelled();
    process.stderr.write('还原前：创建当前状态快照...\n');
    safetySnapshot = backupScopeSnapshot(safetyBackupDir, scope, scopeDataDir);
  }

  // 旧目录必须移开（safe-tar 内部是 staging + renameSync，而 rename 到已存在的
  // 非空目录会 ENOTEMPTY），但**移开要用 rename 而不是 rmSync**：
  // “先删后解压”会留下一个秒级窗口（rmSync + 两次完整 tar 清单读取 + 完整解压
  // + 递归符号链接校验），期间进程被 SIGKILL/OOM/断电 → scope 数据已删且 catch
  // 不会执行 → 无自动恢复；安全网快照虽在 backupDir，但进程已死、零输出，
  // 用户根本不知道要拿它恢复。rename 移开则任何时刻都有一份完整数据。
  // 目录名以 '.' 开头且含点：listAllScopes 用 /^[a-zA-Z0-9_-]+$/ 过滤，不会误认为 scope。
  const stashed = fs.existsSync(scopeDataDir)
    ? path.join(scopeDirParent, `.${path.basename(scopeDataDir)}.pre-restore-${process.pid}-${Date.now()}`)
    : null;
  checkCancelled();
  if (stashed) fs.renameSync(scopeDataDir, stashed);
  try {
    extractScopeSnapshot(snapshot.path, scopeDataDir);
  } catch (err) {
    if (stashed) {
      // 解压失败时目标要么不存在、要么是完整新数据（safe-tar 的全部校验都在
      // renameSync 之前），因此把移开的旧目录改名回来即可完整还原，不会与半成品混合。
      let rollbackError: unknown = null;
      try {
        if (fs.existsSync(scopeDataDir)) fs.rmSync(scopeDataDir, { recursive: true, force: true });
        fs.renameSync(stashed, scopeDataDir);
      } catch (rollbackErr) {
        rollbackError = rollbackErr;
      }
      if (rollbackError) {
        throw new Error(
          `tar 解压失败且自动回滚也失败：\n`
          + `  解压错误：${(err as Error).message}\n`
          + `  回滚错误：${(rollbackError as Error).message}\n`
          + `  你的原始数据仍完整保留在：${stashed}\n`
          + (safetySnapshot ? `  安全网快照：${safetySnapshot}\n` : '')
          + `  请手动执行：mv "${stashed}" "${scopeDataDir}"`,
        );
      }
      throw new Error(`tar 解压失败：${(err as Error).message}；已回滚到还原前的原始数据（${scopeDataDir}）`);
    }
    throw new Error(`tar 解压失败：${(err as Error).message}\n目标为空（全新导入，无现有数据丢失），请检查快照文件是否完整`);
  }

  opts.onProgress?.({ phase: 'restore', done: 1, total: 1 });
  // 解压成功后才删除移开的旧目录；删除失败不影响还原结果，仅留下可人工清理的残留。
  if (stashed) {
    try {
      fs.rmSync(stashed, { recursive: true, force: true });
    } catch (cleanupErr) {
      process.stderr.write(`还原已完成，但清理旧目录失败：${stashed}（${(cleanupErr as Error).message}）；可手动删除。\n`);
    }
  }

  // 快照不包含 vectorDir；无 dense 的 --no-vector 文档仍应在 restore 后可全文检索。
  // 该步骤不调用 embedding，失败只作为结构化告警返回，不回滚已成功还原的 KB。
  const fullText = await rebuildFtsOnlyScope(scope);

  return {
    ok: true,
    action: 'restore_snapshot',
    scope,
    snapshot: snapshot.file,
    restoredAt: new Date().toISOString(),
    fullText,
  };
}
