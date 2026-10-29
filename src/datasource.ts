/**
 * datasource.ts —— 数据源 CLI（REQ-20261020-001）
 *
 * 命令（串行 4 阶段中的 S-01 / S-02）：
 *   add    登记/更新唯一数据源（--scope 必填 --source 必填）
 *   list   列出已登记数据源
 *   remove 取消登记（默认预览，--yes 执行；**不删库内文档**，不碰 source 块）
 *   sync   同步：导入 + 计算待删候选，**永不删除**（--dry-run 只算不写）
 *
 * stdout = JSON；人类可读进度/提示一律走 stderr（与 ki group 一致）。
 * 例外：`list` 的人类可读表格走 stdout（`--json` 时输出 JSON，脚本请用后者）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig, type KiConfig } from './lib/config.js';
import { getSource } from './lib/scope.js';
import {
  addDataSource,
  addRemoteDataSource,
  countManagedRepoRefs,
  dataSourceNextStep,
  readDataSource,
  removeDataSource,
  resetScheduleFailures,
  scanDataSources,
  syncDataSource,
  withManagedCloneLock,
  type SyncDataSourceResult,
} from './lib/datasource.js';
import { managedCloneDirOf, managedScopeDir, purgeManagedCloneDir } from './lib/datasource-clone.js';
import { callDaemon, cancelDaemonJob, createDaemonJobId, shouldUseDaemonClient } from './lib/daemon-client.js';
import { createTaskReporter } from './lib/task-registry.js';
import { toParamSnapshot } from './lib/task-snapshot.js';
import { executeDatasourcePrune, planDatasourcePrune } from './lib/datasource-prune.js';
import { closeEngine } from './lib/vector-client.js';
import { closeFtsEngine } from './lib/fts-client.js';
import type { DataSourceRecord } from './lib/datasource-types.js';
import {
  buildDataSourceList,
  renderDataSourceTable,
  sanitizeTerminalText,
} from './lib/datasource-format.js';

const program = new Command();
program
  .name('datasource')
  .showHelpAfterError()
  .description('数据源登记与同步：add / list / remove / sync（同步只导入+算候选，永不删除）');

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function intArg(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function compactPending(plan: SyncDataSourceResult extends never ? never : any, itemLimit = 20): unknown {
  if (!plan) return null;
  // candidateSourcePaths 是服务端重算基线（可能数万条），CLI 输出只给摘要
  const { items, candidateSourcePaths: _candidateSourcePaths, ...rest } = plan;
  return {
    ...rest,
    ...(Array.isArray(items) && items.length > 0
      ? { items: items.slice(0, itemLimit), itemsTruncated: items.length > itemLimit }
      : {}),
  };
}

function compactSyncResult(res: SyncDataSourceResult): unknown {
  if (!res.ok) return res;
  if (res.dryRun) return { ...res, pendingDelete: compactPending(res.pendingDelete) };
  return { ...res, summary: { ...res.summary, pendingDelete: compactPending(res.summary.pendingDelete) } };
}

function logProgress(event: { progress: { phase?: string; done: number; total: number } }): void {
  const p = event.progress;
  if (!p.phase) return;
  if (p.done === p.total || p.done % 50 === 0) {
    process.stderr.write(`  ${p.phase} ${p.done}/${p.total}\n`);
  }
}

/** 短命 CLI：删除/同步会打开 dense/FTS 引擎，不关会留住 worker 让进程不退出 */
async function shutdownEngines(): Promise<void> {
  try { await closeEngine(); } catch { /* ignore */ }
  try { await closeFtsEngine(); } catch { /* ignore */ }
}

function taskParamsOf(record: DataSourceRecord, dryRun: boolean, full: boolean): ReturnType<typeof toParamSnapshot> {
  return toParamSnapshot('datasource-sync', {
    sourceDir: record.dir,
    type: record.type,
    mode: record.type === 'git' && !full ? 'incremental' : 'full',
    ...(record.group ? { group: record.group } : {}),
    vector: record.vector,
    conflictMode: record.conflictMode,
    conflictSuffix: record.conflictSuffix,
    ...(record.chunkSize !== null ? { chunkSize: record.chunkSize } : {}),
    ...(record.chunkOverlap !== null ? { chunkOverlap: record.chunkOverlap } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  } as Parameters<typeof toParamSnapshot>[1]);
}

// ─── add ────────────────────────────────────────────────

program
  .command('add')
  .description('登记/更新该 scope 的唯一数据源（--source 本地目录 或 --git-url 托管 clone，二选一）')
  .requiredOption('-s, --scope <scope>', '目标 scope（必填）')
  .option('--source <dir>', '源目录（~ 会展开为绝对路径；与 --git-url 互斥）')
  .option('--git-url <url>', 'Git 仓库地址（https/ssh/scp-like；clone 到 ~/.ki/datasources/<scope>/repo）')
  .option('--branch <branch>', '仅 --git-url：跟踪的远端分支（缺省 = 仓库默认分支）')
  .option('--subdir <path>', '仅 --git-url：仓库内的导入子目录（缺省 = 仓库根）')
  .option('--type <type>', '仅 --source：数据源类型 git|directory（缺省自动探测）')
  .option('-g, --group <group>', '落点 Group（留空 = 按顶层子目录自动）')
  .option('--conflict-mode <mode>', '同名文档策略：incremental|overwrite|skip|suffix（默认 incremental）')
  .option('--conflict-suffix <suffix>', '自动后缀模板（默认 _{n}）')
  .option('--chunk-size <n>', '切分目标长度（默认 1000）', intArg)
  .option('--chunk-overlap <n>', '切分重叠（默认 150）', intArg)
  .option('--no-vector', '只写 FTS 全文索引（不向量化）')
  .option('--force', '改 --source / --group 时必须显式确认')
  .action(async (opts) => {
    const hasSource = typeof opts.source === 'string' && opts.source.trim() !== '';
    const hasGitUrl = typeof opts.gitUrl === 'string' && opts.gitUrl.trim() !== '';
    if (hasSource === hasGitUrl) {
      printJson({ ok: false, code: 'ADD_SOURCE_REQUIRED', error: '--source 与 --git-url 必须且只能提供一个' });
      process.exitCode = 1;
      return;
    }
    if (hasGitUrl && (opts.type !== undefined || opts.force === true)) {
      printJson({ ok: false, code: 'INVALID_OPTIONS', error: '--type / --force 只对 --source 有效' });
      process.exitCode = 1;
      return;
    }
    if (hasSource && (opts.branch !== undefined || opts.subdir !== undefined)) {
      printJson({ ok: false, code: 'INVALID_OPTIONS', error: '--branch / --subdir 只对 --git-url 有效' });
      process.exitCode = 1;
      return;
    }

    let lastPercent = -1;
    const result = hasGitUrl
      ? await addRemoteDataSource({
          scope: opts.scope,
          url: opts.gitUrl,
          branch: opts.branch ?? null,
          subdir: opts.subdir ?? null,
          group: opts.group ?? null,
          conflictMode: opts.conflictMode,
          conflictSuffix: opts.conflictSuffix,
          vector: opts.vector !== false,
          chunkSize: opts.chunkSize ?? null,
          chunkOverlap: opts.chunkOverlap ?? null,
          // 与 HTTP 同口径：file:// 默认拒绝，仅隔离测试环境放行
          allowFileUrl: process.env.KI_DATASOURCE_ALLOW_FILE_URL === '1',
          onProgress: (p) => {
            if (p.done === lastPercent) return;
            lastPercent = p.done;
            process.stderr.write(p.done >= 100 ? `\r  克隆中 100%\n` : `\r  克隆中 ${p.done}%`);
          },
        })
      : await addDataSource({
          scope: opts.scope,
          dir: opts.source,
          ...(opts.type ? { type: opts.type } : {}),
          group: opts.group ?? null,
          conflictMode: opts.conflictMode,
          conflictSuffix: opts.conflictSuffix,
          vector: opts.vector !== false,
          chunkSize: opts.chunkSize ?? null,
          chunkOverlap: opts.chunkOverlap ?? null,
          force: opts.force === true,
        });
    printJson(result);
    if (!result.ok) {
      process.exitCode = 1;
      const next = dataSourceNextStep(result.code, result.scope);
      if (next) process.stderr.write(`下一步：${next}\n`);
      if ('cleanupWarning' in result && result.cleanupWarning) process.stderr.write(`⚠ ${result.cleanupWarning}\n`);
      return;
    }
    for (const warning of result.warnings ?? []) process.stderr.write(`⚠ ${warning}\n`);
    const gitInfo = result.record.git;
    if (gitInfo) {
      process.stderr.write(`  类型：git（${gitInfo.managed ? '托管 clone，' : ''}repoRoot=${gitInfo.repoRoot}，relativeRoot=${gitInfo.relativeRoot || '.'}，branch=${gitInfo.branch ?? 'detached'}）\n`);
    } else {
      process.stderr.write('  类型：directory（全量同步）\n');
    }
    if ('reused' in result && result.reused) {
      process.stderr.write(`  复用已有托管 clone（${result.clone.repoRoot}），未重复下载\n`);
    } else if ('clone' in result && result.clone.headCommit) {
      process.stderr.write(`  已克隆 HEAD ${result.clone.headCommit.slice(0, 8)}\n`);
    }
    const legacy = getSource(result.scope);
    if (legacy?.dir) {
      process.stderr.write(`ⓘ 该 scope 另有历史一次性导入目录 ${legacy.dir}（数据源不接管它；wiki 写回仍可能指向该目录）\n`);
    }
    const next = 'next' in result ? result.next : `ki datasource sync --scope ${result.scope}`;
    process.stderr.write(`✓ 已登记 ${result.scope} → ${result.record.dir}（${result.created ? '新建' : '更新'}）\n下一步：${next}\n`);
  });

// ─── list ───────────────────────────────────────────────

program
  .command('list')
  .description('列出已登记数据源（默认人类可读；--json 输出机器格式）')
  .option('--json', '输出 JSON')
  .action((opts) => {
    const scan = scanDataSources(loadConfig());
    if (opts.json) {
      printJson({
        ok: true,
        total: scan.registered.length,
        sources: scan.registered.map(({ scope, record }) => ({
          scope,
          type: record.type,
          dir: record.dir,
          git: record.git
            ? {
              repoRoot: record.git.repoRoot,
              relativeRoot: record.git.relativeRoot,
              branch: record.git.branch,
              managed: record.git.managed,
              shortCommit: record.lastSync?.git?.shortCommit ?? null,
              commitTime: record.lastSync?.git?.authorTime ?? null,
              untrackedMarkdown: record.lastSync?.git?.untrackedMarkdown ?? 0,
            }
            : null,
          group: record.group,
          conflictMode: record.conflictMode,
          vector: record.vector,
          registeredAt: record.createdAt,
          updatedAt: record.updatedAt,
          lastSync: record.lastSync
            ? {
              at: record.lastSync.at,
              durationMs: record.lastSync.durationMs,
              state: record.lastSync.state,
              files: record.lastSync.result.files,
              pendingDelete: {
                total: record.lastSync.pendingDelete.total,
                overLimit: record.lastSync.pendingDelete.overLimit,
                stale: record.lastSync.pendingDelete.stale,
                blocked: record.lastSync.pendingDelete.blocked,
              },
            }
            : null,
        })),
        missing: scan.missing,
        corrupt: scan.corrupt,
      });
      return;
    }
    if (scan.registered.length === 0) {
      process.stderr.write('还没有数据源。登记：ki datasource add --scope <s> --source <目录>\n');
    } else {
      const model = buildDataSourceList(scan.registered);
      // 非 TTY（重定向 / 管道）没有"屏幕宽度"这回事：此时不截断，否则路径会被裁成不可读的一小段
      const columns = process.stdout.isTTY && process.stdout.columns && process.stdout.columns > 0
        ? process.stdout.columns
        : 0;
      console.log('');
      for (const line of renderDataSourceTable(model.rows, columns)) console.log(line);
      for (const { dir, scopes } of model.sharedDirs) {
        console.log(`  ⚠ ${scopes.length} 个 scope 指向同一目录：${scopes.join(' ↔ ')}（${sanitizeTerminalText(dir)}）`);
      }
      model.explicitGroups.forEach(({ scope, group }, index) => {
        const hint = index === 0 ? '（未列出的按顶层子目录自动）' : '';
        console.log(`  落点 Group：${sanitizeTerminalText(scope)} → ${sanitizeTerminalText(group)}${hint}`);
      });
      console.log('');
    }
    for (const item of scan.missing) console.error(`⚠ ${item.scope} 目录不可读：${item.reason}`);
    for (const item of scan.corrupt) console.error(`⚠ ${item.scope} 登记损坏：${item.reason}`);
  });

// ─── remove ─────────────────────────────────────────────

program
  .command('remove')
  .description('取消登记（默认预览；只删 datasource.json，不删库内文档、不碰 source 块）')
  .requiredOption('-s, --scope <scope>', '目标 scope')
  .option('--yes', '确认执行')
  .option('--purge', '同时删除托管 clone 目录（仅 --git-url 登记的 git.managed=true）')
  .action(async (opts) => {
    const config = loadConfig();
    const read = readDataSource(opts.scope);
    if (!read.ok) {
      // 无登记时才走「清理遗留目录」；CORRUPT 必须原样报错，不能被 --purge 掩盖
      if (read.code === 'NOT_FOUND' && opts.purge && opts.yes) {
        let leftover: string | null = null;
        try { leftover = managedScopeDir(opts.scope); } catch { /* 非法 scope 交给原错误 */ }
        if (leftover && fs.existsSync(leftover)) {
          const repoRoot = path.join(leftover, 'repo');
          let locked: { refs: number; purge: { removed: boolean; error?: string } | null };
          try {
            locked = await withManagedCloneLock(repoRoot, 'datasource-purge', async () => {
              const refs = countManagedRepoRefs(repoRoot, config);
              if (refs > 0) return { refs, purge: null };
              const result = await purgeManagedCloneDir(leftover);
              return {
                refs,
                purge: result.removed === false && 'error' in result
                  ? { removed: false, error: result.error }
                  : { removed: result.removed },
              };
            });
          } catch (err) {
            printJson({ ok: false, scope: opts.scope, code: (err as NodeJS.ErrnoException).code ?? 'PURGE_FAILED', error: (err as Error).message });
            process.exitCode = 1;
            return;
          }
          if (locked.refs > 0) {
            printJson({ ok: false, scope: opts.scope, code: 'CLONE_SHARED', error: `该目录仍被 ${locked.refs} 个其他 scope 引用，拒绝清理：${leftover}` });
            process.exitCode = 1;
            return;
          }
          if (!locked.purge) {
            printJson({ ok: false, scope: opts.scope, code: 'PURGE_FAILED', error: '未能清理遗留托管目录' });
            process.exitCode = 1;
            return;
          }
          printJson({
            ok: locked.purge.removed,
            scope: opts.scope,
            removed: false,
            note: '该 scope 无数据源登记；仅清理遗留托管目录',
            managedCloneDir: leftover,
            cloneRemoved: locked.purge.removed,
            ...(locked.purge.error ? { cloneRemoveError: locked.purge.error } : {}),
          });
          if (locked.purge.removed) process.stderr.write(`✓ 已清理遗留托管 clone：${leftover}\n`);
          else process.exitCode = 1;
          return;
        }
      }
      printJson({ ok: false, code: read.code, error: read.error });
      process.exitCode = 1;
      return;
    }
    const legacy = getSource(opts.scope);
    const managedCloneDir = managedCloneDirOf(read.record);
    if (opts.purge && !managedCloneDir) {
      printJson({ ok: false, code: 'NOT_MANAGED', error: '该数据源不是托管 clone（--purge 只适用于 --git-url 登记的来源）' });
      process.exitCode = 1;
      return;
    }
    if (!opts.yes) {
      printJson({
        ok: true,
        preview: true,
        scope: opts.scope,
        dir: read.record.dir,
        note: opts.purge
          ? '将取消登记并删除托管 clone 目录；库内文档保留；不修改 group-index.json.source'
          : '仅取消登记；库内文档保留；不修改 group-index.json.source',
        ...(legacy?.dir ? { legacySourceDir: legacy.dir } : {}),
        ...(managedCloneDir ? { managedCloneDir } : {}),
        ...(opts.purge && managedCloneDir ? { willDelete: managedCloneDir } : {}),
      });
      process.stderr.write('确认后加 --yes 执行\n');
      return;
    }
    const result = await removeDataSource(opts.scope, config);
    if (!result.ok) {
      printJson(result);
      process.exitCode = 1;
      return;
    }
    if (opts.purge && result.managedCloneDir) {
      const managedDir = result.managedCloneDir;
      const repoRoot = path.join(managedDir, 'repo');
      let locked: { refs: number; purge: { removed: boolean; error?: string } | null };
      try {
        locked = await withManagedCloneLock(repoRoot, 'datasource-purge', async () => {
          const refs = countManagedRepoRefs(repoRoot, config);
          if (refs > 0) return { refs, purge: null };
          const result = await purgeManagedCloneDir(managedDir);
          return {
            refs,
            purge: result.removed === false && 'error' in result
              ? { removed: false, error: result.error }
              : { removed: result.removed },
          };
        });
      } catch (err) {
        printJson({ ...result, cloneRemoved: false, cloneRemoveError: (err as Error).message });
        process.stderr.write(`✓ 已取消登记；库内文档保留（未删除任何文档）\n`);
        process.stderr.write(`⚠ 托管 clone 未删除，请稍后重试：${(err as Error).message}\n`);
        return;
      }
      if (locked.refs > 0) {
        printJson({
          ...result,
          cloneRemoved: false,
          cloneRemoveSkipped: true,
          cloneRemoveReason: `其他 ${locked.refs} 个 scope 仍在使用该 clone，已保留 ${managedDir}`,
        });
        process.stderr.write(`✓ 已取消登记；库内文档保留（未删除任何文档）\n`);
        process.stderr.write(`ⓘ 该托管 clone 仍被 ${locked.refs} 个其他 scope 使用，未删除：${managedDir}\n`);
        return;
      }
      if (!locked.purge) {
        printJson({ ...result, cloneRemoved: false, cloneRemoveError: '未能清理托管目录' });
        process.stderr.write(`✓ 已取消登记；库内文档保留（未删除任何文档）\n`);
        return;
      }
      printJson({
        ...result,
        cloneRemoved: locked.purge.removed,
        ...(locked.purge.error ? { cloneRemoveError: locked.purge.error } : {}),
      });
      process.stderr.write('✓ 已取消登记；库内文档保留（未删除任何文档）\n');
      if (locked.purge.removed) process.stderr.write(`✓ 已删除托管 clone：${managedDir}\n`);
      else if (locked.purge.error) process.stderr.write(`⚠ 托管 clone 未删除，请手动清理 ${managedDir}：${locked.purge.error}\n`);
      return;
    }
    printJson(result);
    process.stderr.write('✓ 已取消登记；库内文档保留（未删除任何文档）\n');
    if (result.managedCloneDir) {
      process.stderr.write(`ⓘ 托管 clone 仍保留在 ${result.managedCloneDir}（如需一并删除，加 --purge）\n`);
    }
  });

// ─── sync ───────────────────────────────────────────────

program
  .command('sync')
  .description('同步：导入 + 计算待删候选（永不删除；一次一个 scope）')
  .option('-s, --scope <scope>', '目标 scope（必填；不支持 --all）')
  .option('--dry-run', '只算不写：扫描 + 候选摘要，零写入')
  .option('--full', '忽略 Git commit diff，处理全部文件（含 untracked）')
  .action(async (opts) => {
    const config: KiConfig = loadConfig();
    const scope = typeof opts.scope === 'string' ? opts.scope.trim() : '';
    if (!scope) {
      const scan = scanDataSources(config);
      process.stderr.write('缺少 --scope（同步一次只处理一个数据源）。已登记：\n');
      for (const { scope: s, record } of scan.registered) {
        process.stderr.write(`  ${s}  上次同步：${record.lastSync ? new Date(record.lastSync.at).toISOString() : '从未'}\n`);
      }
      process.exitCode = 1;
      return;
    }
    const read = readDataSource(scope);
    if (!read.ok) {
      printJson({ ok: false, scope, code: read.code, error: read.error, next: dataSourceNextStep(read.code, scope) });
      process.exitCode = 1;
      return;
    }
    const record = read.record;
    const dryRun = opts.dryRun === true;
    const full = opts.full === true;
    const jobId = createDaemonJobId();

    if (shouldUseDaemonClient()) {
      const abort = new AbortController();
      const onSigint = (): void => { abort.abort(); void cancelDaemonJob(jobId); };
      process.once('SIGINT', onSigint);
      try {
        const res = await callDaemon<SyncDataSourceResult>('datasource-sync', {
          scope,
          dryRun,
          full,
          jobId,
          group: record.group,
          conflictMode: record.conflictMode,
          vector: record.vector,
          chunkSize: record.chunkSize,
          chunkOverlap: record.chunkOverlap,
        }, 0, { streamProgress: true, jobId, abortSignal: abort.signal, onProgress: logProgress });
        printJson(compactSyncResult(res));
        if (!res?.ok) process.exitCode = 1;
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
      return;
    }

    const task = createTaskReporter(config, { id: jobId, source: 'cli', operation: 'datasource-sync', scope });
    task.update({ state: 'running', startedAt: Date.now(), params: taskParamsOf(record, dryRun, full) });
    const abort = new AbortController();
    let settled = false;
    const onSigint = (): void => {
      abort.abort();
      if (!settled) { task.finish('cancelled'); settled = true; }
      process.stderr.write('\n已请求取消，等待当前批次收束...\n');
    };
    process.once('SIGINT', onSigint);
    try {
      const res = await syncDataSource({
        scope,
        dryRun,
        full,
        taskId: jobId,
        config,
        abortSignal: abort.signal,
        onProgress: (p) => { void task.progress(p); },
        onInterrupt: () => { if (!settled) { task.finish('cancelled'); settled = true; } },
      });
      if (res.ok && res.dryRun) {
        printJson({
          ok: true,
          scope,
          dryRun: true,
          mode: res.mode,
          plannedFiles: res.plannedFiles,
          changedFiles: res.changedFiles,
          untrackedMarkdown: res.untrackedMarkdown,
          wouldFallbackFull: res.wouldFallbackFull,
          warnings: res.warnings,
          pendingDelete: compactPending(res.pendingDelete),
        });
        if (!settled) { task.finish('succeeded'); settled = true; }
      } else if (res.ok) {
        printJson({
          ok: true,
          scope,
          state: res.summary.state,
          mode: res.summary.mode,
          durationMs: res.summary.durationMs,
          files: res.summary.files,
          ...(res.summary.git ? { git: res.summary.git } : {}),
          warnings: res.summary.warnings,
          pendingDelete: compactPending(res.summary.pendingDelete, 10),
        });
        if (!settled) {
          task.finish(res.summary.state === 'partial' ? 'partial' : res.summary.state === 'cancelled' ? 'cancelled' : 'succeeded');
          settled = true;
        }
        for (const warning of res.summary.warnings ?? []) process.stderr.write(`⚠ ${warning.message}\n`);
        if (res.summary.state === 'partial') process.stderr.write('⚠ 部分文件未完成，详见 datasource.json 的 lastSync.result.failures\n');
        // 与 daemon 路径（daemon-dispatch 的 datasource-sync 分支）同口径：
        // 手动同步成功/部分成功清零「自动同步连续失败」，否则 CLI 直连修好后页面仍显示「连续失败 N 次」
        if (res.summary.state === 'ok' || res.summary.state === 'partial') {
          await resetScheduleFailures(scope);
        }
      } else {
        printJson(res);
        if (!settled) { task.finish('failed', { errorCode: res.code, error: res.error }); settled = true; }
        process.exitCode = 1;
      }
    } catch (err) {
      if (!settled) { task.finish('failed', { error: (err as Error).message }); settled = true; }
      printJson({ ok: false, scope, code: 'SYNC_FAILED', error: (err as Error).message });
      process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', onSigint);
      await shutdownEngines();
    }
  });

// ─── prune ──────────────────────────────────────────────

program
  .command('prune')
  .description('删除待删候选（默认预览；--yes 执行；只删知识库记录，不动源目录文件）')
  .requiredOption('-s, --scope <scope>', '目标 scope')
  .option('-g, --group <group>', '只在客户端筛选该 group 的候选（不传给服务端）')
  .option('--yes', '确认执行（每次最多 500 篇，删完刷新继续）')
  .action(async (opts) => {
    try {
    const config = loadConfig();
    const planned = planDatasourcePrune({ scope: opts.scope, config });
    if (!planned.ok) {
      printJson(planned);
      process.exitCode = 1;
      return;
    }
    const { plan } = planned;
    const group = typeof opts.group === 'string' ? opts.group.trim() : '';
    const visible = group
      ? plan.items.filter((item) => item.group === group || item.group.startsWith(`${group}/`))
      : plan.items;

    if (!opts.yes) {
      printJson({
        ok: true,
        preview: true,
        scope: planned.scope,
        total: plan.total,
        overLimit: plan.overLimit,
        token: plan.token ?? null,
        blocked: plan.skipReason ?? null,
        ...(plan.skipDetail ? { skipDetail: plan.skipDetail } : {}),
        items: visible.slice(0, 20),
        itemsTruncated: visible.length > 20,
        note: '确认后加 --yes；每次最多删 500 篇',
      });
      process.stderr.write('本次只删知识库记录，不动源目录文件\n');
      return;
    }
    if (plan.skipReason) {
      printJson({ ok: false, code: 'PRUNE_BLOCKED', error: plan.skipDetail ?? '未生成候选' });
      process.exitCode = 1;
      return;
    }
    if (!plan.token) {
      printJson({ ok: false, code: 'PRUNE_EMPTY_SELECTION', error: '没有可用的候选 token' });
      process.exitCode = 1;
      return;
    }
    const selected = visible.slice(0, 500).map((item) => ({ group: item.group, relation: item.relation }));
    if (selected.length === 0) {
      printJson({ ok: false, code: 'PRUNE_EMPTY_SELECTION', error: '没有匹配的候选' });
      process.exitCode = 1;
      return;
    }
    const result = await executeDatasourcePrune({ scope: planned.scope, token: plan.token, selected, config });
    if (!result.ok) {
      printJson({ ok: false, code: result.code, error: result.error });
      process.exitCode = 1;
      return;
    }
    if (result.dryRun) return;
    printJson({ ...result, pendingDelete: compactPending(result.pendingDelete) });
    process.stderr.write('本次只删知识库记录，不动源目录文件\n');
    if (result.pendingDelete.total > 0) {
      process.stderr.write(`剩余 ${result.pendingDelete.total} 篇，可再次执行继续删除\n`);
    }
    } finally {
      await shutdownEngines();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  printJson({ ok: false, error: (err as Error).message });
  process.exitCode = 1;
});
