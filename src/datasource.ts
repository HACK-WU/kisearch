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
 */
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig, type KiConfig } from './lib/config.js';
import { getSource } from './lib/scope.js';
import {
  addDataSource,
  dataSourceNextStep,
  readDataSource,
  removeDataSource,
  scanDataSources,
  syncDataSource,
  type SyncDataSourceResult,
} from './lib/datasource.js';
import { callDaemon, cancelDaemonJob, createDaemonJobId, shouldUseDaemonClient } from './lib/daemon-client.js';
import { createTaskReporter } from './lib/task-registry.js';
import { toParamSnapshot } from './lib/task-snapshot.js';
import { executeDatasourcePrune, planDatasourcePrune } from './lib/datasource-prune.js';
import { closeEngine } from './lib/vector-client.js';
import { closeFtsEngine } from './lib/fts-client.js';
import type { DataSourceRecord } from './lib/datasource-types.js';

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
  .description('登记/更新该 scope 的唯一数据源（不写 group-index.json.source）')
  .requiredOption('-s, --scope <scope>', '目标 scope（必填）')
  .requiredOption('--source <dir>', '源目录（~ 会展开为绝对路径）')
  .option('--type <type>', '数据源类型：git|directory（缺省自动探测）')
  .option('-g, --group <group>', '落点 Group（留空 = 按顶层子目录自动）')
  .option('--conflict-mode <mode>', '同名文档策略：incremental|overwrite|skip|suffix（默认 incremental）')
  .option('--conflict-suffix <suffix>', '自动后缀模板（默认 _{n}）')
  .option('--chunk-size <n>', '切分目标长度（默认 1000）', intArg)
  .option('--chunk-overlap <n>', '切分重叠（默认 150）', intArg)
  .option('--no-vector', '只写 FTS 全文索引（不向量化）')
  .option('--force', '改 --source / --group 时必须显式确认')
  .action(async (opts) => {
    const result = await addDataSource({
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
      return;
    }
    for (const warning of result.warnings ?? []) process.stderr.write(`⚠ ${warning}\n`);
    const gitInfo = result.record.git;
    if (gitInfo) {
      process.stderr.write(`  类型：git（repoRoot=${gitInfo.repoRoot}，relativeRoot=${gitInfo.relativeRoot || '.'}，branch=${gitInfo.branch ?? 'detached'}）\n`);
    } else {
      process.stderr.write('  类型：directory（全量同步）\n');
    }
    const legacy = getSource(result.scope);
    if (legacy?.dir) {
      process.stderr.write(`ⓘ 该 scope 另有历史一次性导入目录 ${legacy.dir}（数据源不接管它；wiki 写回仍可能指向该目录）\n`);
    }
    process.stderr.write(`✓ 已登记 ${result.scope} → ${result.record.dir}（${result.created ? '新建' : '更新'}）\n下一步：${result.next}\n`);
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
    if (scan.registered.length === 0) process.stderr.write('还没有数据源。登记：ki datasource add --scope <s> --source <目录>\n');
    for (const { scope, record } of scan.registered) {
      const last = record.lastSync
        ? `${new Date(record.lastSync.at).toISOString()} (${record.lastSync.state})`
        : '从未同步';
      const commit = record.lastSync?.git?.shortCommit ? `\tcommit=${record.lastSync.git.shortCommit}` : '';
      console.log(`${scope}\t${record.type}\t${record.dir}\tgroup=${record.group ?? '(自动)'}\t${last}${commit}\t待删=${record.lastSync?.pendingDelete.total ?? 0}`);
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
  .action(async (opts) => {
    const config = loadConfig();
    const read = readDataSource(opts.scope);
    if (!read.ok) {
      printJson({ ok: false, code: read.code, error: read.error });
      process.exitCode = 1;
      return;
    }
    const legacy = getSource(opts.scope);
    const managedCloneDir = read.record.git?.managed ? path.dirname(read.record.git.repoRoot) : null;
    if (!opts.yes) {
      printJson({
        ok: true,
        preview: true,
        scope: opts.scope,
        dir: read.record.dir,
        note: '仅取消登记；库内文档保留；不修改 group-index.json.source',
        ...(legacy?.dir ? { legacySourceDir: legacy.dir } : {}),
        ...(managedCloneDir ? { managedCloneDir } : {}),
      });
      process.stderr.write('确认后加 --yes 执行\n');
      return;
    }
    const result = await removeDataSource(opts.scope, config);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    else {
      process.stderr.write('✓ 已取消登记；库内文档保留（未删除任何文档）\n');
      if (result.managedCloneDir) {
        process.stderr.write(`ⓘ 托管 clone 仍保留在 ${result.managedCloneDir}（后续支持 --purge 清理）\n`);
      }
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
