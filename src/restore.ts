#!/usr/bin/env node
/**
 * restore.ts —— ki restore 还原命令
 *
 * 用法：
 *   ki restore <scope> --from-snapshot [--timestamp <ts>] [--yes]
 *   ki restore <scope> --from-results  [--dir <ai-results-dir>]
 *   ki restore <scope>                 (列出可用备份)
 *
 *   通用选项：
 *     --backup-dir <dir>  指定备份根目录（不传则用配置中的默认 backupDir）。
 *                         对列出/快照还原/结果重放三种模式均生效，按
 *                         `<backup-dir>/<scope>/{snapshots,ai-results}` 布局查找。
 *
 * --from-snapshot: 从 tar.gz 快照覆盖还原（破坏性操作，需 --yes 确认）
 * --from-results:  按 timestamp 顺序重放 ai-results 备份文件
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
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
import { detectUnknownFlags, toErrorPayload } from './lib/cli-args.js';
import { checkWritable, checkDiskSpace, estimateDirSize, PreflightError } from './lib/preflight.js';

// ─── 工具 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

function fail(msg: string): never {
  output({ ok: false, error: msg });
  process.exit(1);
}

// ─── 确认（非交互）───

/**
 * 展示还原总览并以 CONFIRMATION_REQUIRED 退出。
 * CLI 均为非交互式：不做任何交互提示、不挂起。未加 --yes 时，仅把总览写到 stderr，
 * 并输出机器可读的错误后直接退出；确认无误后由使用者加 --yes 重新执行以真正还原。
 */
function previewAndRequireYes(overview: string): never {
  process.stderr.write(overview);
  output({
    ok: false,
    error: '这是破坏性操作。确认以上总览无误后，请添加 --yes 重新执行以真正还原。',
    code: 'CONFIRMATION_REQUIRED',
  });
  process.exit(1);
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

// ─── 目标摘要（NEG-11：破坏性覆盖前展示将被删除的数据规模）───

/**
 * 汇总即将被覆盖的 scope 目录信息，供二次确认时展示。
 * 尽力而为：任何读取失败都降级为「未知」，不阻断流程。
 */
function summarizeScopeDir(scopeDataDir: string): string {
  if (!fs.existsSync(scopeDataDir)) {
    return '   目标目录当前不存在（等价于全新导入）';
  }
  const lines: string[] = [];

  // 关系条目数：统计 relations-cache.json 各 Group 的 hot_relations
  try {
    const rcPath = path.join(scopeDataDir, 'relations-cache.json');
    if (fs.existsSync(rcPath)) {
      const rc = JSON.parse(fs.readFileSync(rcPath, 'utf-8')) as {
        groups?: Record<string, { hot_relations?: unknown[] }>;
      };
      const groups = rc.groups || {};
      const groupCount = Object.keys(groups).length;
      let relCount = 0;
      for (const g of Object.values(groups)) {
        relCount += g.hot_relations?.length || 0;
      }
      lines.push(`   现有数据：${groupCount} 个 Group、${relCount} 条 Relation`);
    }
  } catch {
    /* 忽略统计失败 */
  }

  // 目录体积与最后修改时间
  try {
    const size = estimateDirSize(scopeDataDir);
    const mtime = fs.statSync(scopeDataDir).mtime;
    lines.push(
      `   目录体积：约 ${(size / 1024).toFixed(1)} KB，最后修改：${mtime.toISOString()}`
    );
  } catch {
    /* 忽略统计失败 */
  }

  return lines.length > 0 ? lines.join('\n') : '   （无法读取现有数据摘要）';
}

// ─── from-snapshot 还原 ───

async function restoreFromSnapshot(
  scope: string,
  opts: { timestamp?: string; yes?: boolean; backupDir?: string }
): Promise<void> {
  ensureTarAvailable();

  const config = loadConfig();
  const backupDir = opts.backupDir ? path.resolve(opts.backupDir) : getBackupDir(config);
  // 还原前安全网快照始终写入受管的默认 backupDir：--backup-dir 仅控制「从哪读」，
  // 不应把新建快照写进可能只读/外部的自定义目录（否则会因写失败而被 CH-2 中断还原）。
  const safetyBackupDir = getBackupDir(config);
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

  // NEG-07：还原前预检目标父目录可写性 + 解压空间（避免删除后无法写入）
  try {
    checkWritable(scopeDirParent);
    const snapSize = fs.statSync(snapshotPath).size;
    // tar.gz 解压后通常膨胀数倍，保守按 5x 估算所需空间
    checkDiskSpace(scopeDirParent, snapSize * 5);
  } catch (err) {
    if (err instanceof PreflightError) {
      output({ ok: false, error: err.message, code: err.code });
      await closeEngine();
      process.exit(1);
    }
    throw err;
  }

  // 确认（NEG-11）：CLI 非交互式——展示总览后要求显式 --yes 重新执行，绝不交互挂起
  if (!opts.yes) {
    previewAndRequireYes(
      `⚠️  即将删除并覆盖目录：${scopeDataDir}\n` +
        `${summarizeScopeDir(scopeDataDir)}\n` +
        `   还原来源：${snapshotPath}\n` +
        `   还原快照：${snapshotFile}\n` +
        `   ⚠️  此操作不可逆（还原前会自动创建安全网快照）\n`
    );
  }

  // 备份当前状态（还原前快照，安全网）
  // CH-2：安全网快照失败视为阻断性错误 —— 与 migrate-keywords 的备份策略保持一致。
  // 无法创建安全网时，绝不执行后续不可逆的删除+覆盖，避免「确认文案承诺了快照、
  // 却在快照失败后仍继续删除」造成的数据丢失窗口。
  let preRestoreSnapshot: string | null = null;
  if (fs.existsSync(scopeDataDir)) {
    process.stderr.write('还原前：创建当前状态快照...\n');
    try {
      preRestoreSnapshot = backupScopeSnapshot(safetyBackupDir, scope, scopeDataDir);
    } catch (err) {
      output({
        ok: false,
        error:
          `还原前安全网快照创建失败：${(err as Error).message}\n` +
          `为避免不可逆的数据丢失，已中止还原（未删除任何现有数据）。\n` +
          `请修复上述问题（如磁盘空间 / 目录权限 / tar 可用性）后重试。`,
        code: 'SAFETY_SNAPSHOT_FAILED',
      });
      await closeEngine();
      process.exit(1);
    }
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
      // CH-2 下：preRestoreSnapshot 为空仅出现于目标目录原本不存在（等价全新导入），
      // 此时无现有数据可丢失，无需安全网。
      fail(
        `tar 解压失败：${(err as Error).message}\n目标为空（全新导入，无现有数据丢失），请检查快照文件是否完整`
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

async function restoreFromResults(
  scope: string,
  opts: { dir?: string; backupDir?: string; yes?: boolean }
): Promise<void> {
  const config = loadConfig();
  const backupDir = opts.backupDir ? path.resolve(opts.backupDir) : getBackupDir(config);
  // 同 restoreFromSnapshot：重放前安全网快照写入受管的默认 backupDir，而非 --backup-dir 覆盖目录。
  const safetyBackupDir = getBackupDir(config);

  const aiResultsDir = opts.dir
    ? path.resolve(opts.dir)
    : path.join(backupDir, scope, 'ai-results');

  if (!fs.existsSync(aiResultsDir)) {
    fail(`ai-results 目录不存在：${aiResultsDir}`);
  }

  // 扫描并排序
  const files = fs
    .readdirSync(aiResultsDir)
    .filter((f) => /^ai-results\.\d{8}-\d{6}(?:-\d+)?\.(full|incremental)\.json$/.test(f))
    .sort();

  if (files.length === 0) {
    fail(`ai-results 目录为空：${aiResultsDir}`);
  }

  // 校验首个文件的 meta 字段 + 模式
  const firstFile = path.join(aiResultsDir, files[0]);
  const firstModeMatch = files[0].match(/^ai-results\.\d{8}-\d{6}(?:-\d+)?\.(full|incremental)\.json$/);
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

  // 确认（与 --from-snapshot 一致）：CLI 非交互式，展示总览后要求显式 --yes 重新执行
  const scopeDataDir = getScopeDataDir(config, scope);
  if (!opts.yes) {
    const fullCount = files.filter((f) => /\.full\.json$/.test(f)).length;
    const incCount = files.length - fullCount;
    previewAndRequireYes(
      `⚠️  即将通过重放 ai-results 改写 scope：${scope}\n` +
        `   目标目录：${scopeDataDir}\n` +
        `${summarizeScopeDir(scopeDataDir)}\n` +
        `   重放来源：${aiResultsDir}\n` +
        `   重放文件：共 ${files.length} 个（全量 ${fullCount} + 增量 ${incCount}），首个全量基底：${files[0]}\n` +
        `   ⚠️  此操作会改写现有数据（重放前会自动创建安全网快照）\n`
    );
  }

  // 还原前快照（仅一次）
  try {
    if (fs.existsSync(scopeDataDir)) {
      process.stderr.write('重放前：创建当前状态快照...\n');
      backupScopeSnapshot(safetyBackupDir, scope, scopeDataDir);
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
    const modeMatch = file.match(/^ai-results\.\d{8}-\d{6}(?:-\d+)?\.(full|incremental)\.json$/)!;
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

function listAvailableBackups(scope: string, opts: { backupDir?: string } = {}): void {
  const config = loadConfig();
  const backupDir = opts.backupDir ? path.resolve(opts.backupDir) : getBackupDir(config);
  const backups = listBackups(config, scope, backupDir);

  output({
    ok: true,
    action: 'restore_list',
    scope,
    // 明确告知备份文件物理位置，available 中的 file 为相对于对应 location 的文件名
    backupDir,
    locations: {
      snapshots: path.join(backupDir, scope, 'snapshots'),
      aiResults: path.join(backupDir, scope, 'ai-results'),
    },
    available: backups,
    hint:
      '使用 --from-snapshot 或 --from-results 选择还原模式；' +
      '--backup-dir <dir> 可指定其它备份目录',
  });
}

// ─── 参数解析 ───

const args = process.argv.slice(2);

// 未知参数检测（NEG-01）：--timestamp / --dir / --backup-dir 为带值参数
detectUnknownFlags(
  args,
  ['--from-snapshot', '--from-results', '--yes', '--timestamp', '--dir', '--backup-dir'],
  ['--timestamp', '--dir', '--backup-dir']
);

const scope = args[0];
if (!scope || scope.startsWith('--')) {
  console.error('用法：ki restore <scope> [--from-snapshot [--timestamp <ts>]] [--from-results [--dir <dir>]] [--backup-dir <dir>]');
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

// 提取 --backup-dir（指定备份根目录，不传则用配置默认）
let backupDirOverride: string | undefined;
const bdIdx = args.indexOf('--backup-dir');
if (bdIdx !== -1 && bdIdx + 1 < args.length) {
  backupDirOverride = args[bdIdx + 1];
}

// ─── 主逻辑 ───

async function main() {
  try {
    validateScope(scope);

    if (fromSnapshot && fromResults) {
      fail('--from-snapshot 和 --from-results 不能同时使用');
    }

    if (fromSnapshot) {
      await restoreFromSnapshot(scope, { timestamp, yes: skipYes, backupDir: backupDirOverride });
    } else if (fromResults) {
      await restoreFromResults(scope, { dir, backupDir: backupDirOverride, yes: skipYes });
    } else {
      listAvailableBackups(scope, { backupDir: backupDirOverride });
    }
  } catch (err) {
    output(toErrorPayload(err));
    process.exit(1);
  } finally {
    // CLI per-call：关闭 engine（terminate worker + 释放 LOCK），否则 worker 线程持引用导致进程无法退出
    await closeEngine();
  }
}

main();
