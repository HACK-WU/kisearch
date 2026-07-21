#!/usr/bin/env node
/**
 * restore.ts —— ki restore 还原命令
 *
 * 用法：
 *   ki restore <scope> --from-snapshot [--timestamp <ts>] [--yes]
 *   ki restore <scope> --from-results  [--dir <ai-results-dir>]
 *   ki restore <scope>                 (列出可用备份)
 *
 * --from-snapshot: 从 tar.gz 快照覆盖还原（破坏性操作，需 --yes 确认）
 * --from-results:  按 timestamp 顺序重放 ai-results 备份文件
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import readline from 'readline';
import {
  loadConfig,
  getScopeDataDir,
  getBackupDir,
} from './lib/config.js';
import { validateScope } from './lib/scope.js';
import {
  backupScopeSnapshot,
  listBackups,
} from './lib/backup.js';
import { handleImport } from './lib/import.js';
import { handleIncremental } from './lib/incremental.js';
import { closeEngine } from './lib/vector-client.js';

// ─── 工具 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

function fail(msg: string): never {
  output({ ok: false, error: msg });
  process.exit(1);
}

// ─── 交互确认 ───

async function askConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ─── tar 解压 ───

function ensureTarAvailable(): void {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'tar 命令不可用，请安装 tar（Linux/macOS 内置，Windows 请安装 Git for Windows）'
    );
  }
}

// ─── from-snapshot 还原 ───

async function restoreFromSnapshot(
  scope: string,
  opts: { timestamp?: string; yes?: boolean }
): Promise<void> {
  ensureTarAvailable();

  const config = loadConfig();
  const backupDir = getBackupDir(config);
  const snapDir = path.join(backupDir, scope, 'snapshots');

  if (!fs.existsSync(snapDir)) {
    fail(`快照目录不存在：${snapDir}，无可还原的快照`);
  }

  // 列出快照
  const snapFiles = fs
    .readdirSync(snapDir)
    .filter((f) => f.startsWith('snapshot.') && f.endsWith('.tar.gz'))
    .sort();

  if (snapFiles.length === 0) {
    fail(`快照目录为空：${snapDir}`);
  }

  // 选择快照
  let snapshotFile: string;
  if (opts.timestamp) {
    snapshotFile = `snapshot.${opts.timestamp}.tar.gz`;
    if (!snapFiles.includes(snapshotFile)) {
      fail(
        `指定 timestamp 的快照不存在：${opts.timestamp}\n可用快照：\n${snapFiles.join('\n')}`
      );
    }
  } else {
    snapshotFile = snapFiles[snapFiles.length - 1]; // 最新
  }

  const snapshotPath = path.join(snapDir, snapshotFile);
  const scopeDataDir = getScopeDataDir(config, scope);
  const scopeDirParent = path.dirname(scopeDataDir);

  // 确认
  if (!opts.yes) {
    const msg =
      `⚠️  即将删除并覆盖目录：${scopeDataDir}\n` +
      `   还原快照：${snapshotFile}\n` +
      `   确认继续？`;
    const confirmed = await askConfirmation(msg);
    if (!confirmed) {
      console.log('已取消还原操作');
      process.exit(0);
    }
  }

  // 备份当前状态（还原前快照，安全网）
  let preRestoreSnapshot: string | null = null;
  try {
    if (fs.existsSync(scopeDataDir)) {
      process.stderr.write('还原前：创建当前状态快照...\n');
      preRestoreSnapshot = backupScopeSnapshot(backupDir, scope, scopeDataDir);
    }
  } catch (err) {
    process.stderr.write(
      `警告：还原前快照失败 — ${(err as Error).message}（继续还原）\n`
    );
  }

  // 删除现有目录内容
  if (fs.existsSync(scopeDataDir)) {
    fs.rmSync(scopeDataDir, { recursive: true, force: true });
  }

  // 解压
  try {
    execFileSync('tar', ['-xzf', snapshotPath, '-C', scopeDirParent], {
      stdio: 'ignore',
    });
  } catch (err) {
    // tar 解压失败：目录已删，尝试自动从安全网快照恢复
    if (preRestoreSnapshot) {
      process.stderr.write(`tar 解压失败，尝试从还原前快照自动恢复...\n`);
      try {
        execFileSync('tar', ['-xzf', preRestoreSnapshot, '-C', scopeDirParent], {
          stdio: 'ignore',
        });
        fail(
          `tar 解压失败：${(err as Error).message}\n已自动从还原前快照恢复原始数据`
        );
      } catch (recoverErr) {
        fail(
          `tar 解压失败且自动恢复也失败：\n` +
            `  解压错误：${(err as Error).message}\n` +
            `  恢复错误：${(recoverErr as Error).message}\n` +
            `  安全网快照：${preRestoreSnapshot}\n` +
            `  请手动执行：ki restore ${scope} --from-snapshot --timestamp <ts>`
        );
      }
    } else {
      fail(
        `tar 解压失败：${(err as Error).message}\n还原前未创建安全网快照，请检查备份目录`
      );
    }
  }

  output({
    ok: true,
    action: 'restore_snapshot',
    scope,
    snapshot: snapshotFile,
    restoredAt: new Date().toISOString(),
  });
}

// ─── from-results 重放 ───

async function restoreFromResults(scope: string, opts: { dir?: string }): Promise<void> {
  const config = loadConfig();
  const backupDir = getBackupDir(config);

  const aiResultsDir = opts.dir
    ? path.resolve(opts.dir)
    : path.join(backupDir, scope, 'ai-results');

  if (!fs.existsSync(aiResultsDir)) {
    fail(`ai-results 目录不存在：${aiResultsDir}`);
  }

  // 扫描并排序
  const files = fs
    .readdirSync(aiResultsDir)
    .filter((f) => /^ai-results\.\d{8}-\d{6}\.(full|incremental)\.json$/.test(f))
    .sort();

  if (files.length === 0) {
    fail(`ai-results 目录为空：${aiResultsDir}`);
  }

  // 校验首个文件的 meta 字段 + 模式
  const firstFile = path.join(aiResultsDir, files[0]);
  const firstModeMatch = files[0].match(/^ai-results\.\d{8}-\d{6}\.(full|incremental)\.json$/);
  if (!firstModeMatch || firstModeMatch[1] !== 'full') {
    fail(
      `首个文件不是全量备份，无法作为重放基底：\n  ${files[0]}\n` +
        `重放要求第一个文件必须是 full 模式的全量备份`  );
  }
  let firstRaw: Record<string, unknown>;
  try {
    firstRaw = JSON.parse(fs.readFileSync(firstFile, 'utf-8'));
  } catch (err) {
    fail(`读取首个文件失败：${(err as Error).message}`);
  }
  const meta = firstRaw.meta as Record<string, string> | undefined;
  if (!meta?.sourceDir || !meta?.rootName) {
    fail(
      `首个文件缺少 meta.sourceDir/rootName，无法作为全量基底：\n  ${files[0]}\n` +
        `请确保目录中包含完整的全量备份文件`
    );
  }

  // 还原前快照（仅一次）
  const scopeDataDir = getScopeDataDir(config, scope);
  try {
    if (fs.existsSync(scopeDataDir)) {
      process.stderr.write('重放前：创建当前状态快照...\n');
      backupScopeSnapshot(backupDir, scope, scopeDataDir);
    }
  } catch (err) {
    process.stderr.write(
      `警告：重放前快照失败 — ${(err as Error).message}（继续重放）\n`
    );
  }

  // 顺序重放
  const replayed: Array<{
    file: string;
    mode: 'full' | 'incremental';
    status: 'ok' | 'failed';
    error?: string;
  }> = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = path.join(aiResultsDir, file);
    // 从文件名解析实际模式（而非按位置推断）
    const modeMatch = file.match(/^ai-results\.\d{8}-\d{6}\.(full|incremental)\.json$/)!;
    const mode = modeMatch[1] as 'full' | 'incremental';

    process.stderr.write(`[${i + 1}/${files.length}] 重放：${file} (${mode})...\n`);

    try {
      if (mode === 'full') {
        await handleImport({ scope, resultsFile: filePath });
      } else {
        await handleIncremental({ scope, resultsFile: filePath });
      }
      replayed.push({ file, mode, status: 'ok' });
    } catch (err) {
      const errMsg = (err as Error).message;
      replayed.push({ file, mode, status: 'failed', error: errMsg });
      process.stderr.write(`重放失败：${file} — ${errMsg}\n`);

      // 停止后续重放
      output({
        ok: false,
        action: 'restore_results',
        scope,
        replayed,
        stats: {
          total: files.length,
          success: replayed.filter((r) => r.status === 'ok').length,
          failed: replayed.filter((r) => r.status === 'failed').length,
        },
        hint: '可从还原前快照恢复：ki restore ' + scope + ' --from-snapshot',
      });
      // CLI per-call：关闭 engine（terminate worker + 释放 LOCK），否则进程无法退出
      await closeEngine();
      process.exit(1);
    }
  }

  output({
    ok: true,
    action: 'restore_results',
    scope,
    replayed,
    stats: {
      total: files.length,
      success: replayed.filter((r) => r.status === 'ok').length,
      failed: 0,
    },
  });
}

// ─── 列出备份 ───

function listAvailableBackups(scope: string): void {
  const config = loadConfig();
  const backups = listBackups(config, scope);

  output({
    ok: true,
    action: 'restore_list',
    scope,
    available: backups,
    hint: '使用 --from-snapshot 或 --from-results 选择还原模式',
  });
}

// ─── 参数解析 ───

const args = process.argv.slice(2);

const scope = args[0];
if (!scope || scope.startsWith('--')) {
  console.error('用法：ki restore <scope> [--from-snapshot [--timestamp <ts>]] [--from-results [--dir <dir>]]');
  process.exit(1);
}

const fromSnapshot = args.includes('--from-snapshot');
const fromResults = args.includes('--from-results');
const skipYes = args.includes('--yes');

// 提取 --timestamp
let timestamp: string | undefined;
const tsIdx = args.indexOf('--timestamp');
if (tsIdx !== -1 && tsIdx + 1 < args.length) {
  timestamp = args[tsIdx + 1];
}

// 提取 --dir
let dir: string | undefined;
const dirIdx = args.indexOf('--dir');
if (dirIdx !== -1 && dirIdx + 1 < args.length) {
  dir = args[dirIdx + 1];
}

// ─── 主逻辑 ───

async function main() {
  try {
    validateScope(scope);

    if (fromSnapshot && fromResults) {
      fail('--from-snapshot 和 --from-results 不能同时使用');
    }

    if (fromSnapshot) {
      await restoreFromSnapshot(scope, { timestamp, yes: skipYes });
    } else if (fromResults) {
      await restoreFromResults(scope, { dir });
    } else {
      listAvailableBackups(scope);
    }
  } catch (err) {
    output({ ok: false, error: (err as Error).message });
    process.exit(1);
  } finally {
    // CLI per-call：关闭 engine（terminate worker + 释放 LOCK），否则 worker 线程持引用导致进程无法退出
    await closeEngine();
  }
}

main();
