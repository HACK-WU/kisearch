#!/usr/bin/env node
/**
 * import.ts - 外部知识库导入（ki import）
 *
 *   （REQ-01）--source 直导外部 Markdown 目录（无 AI，自动切分；幂等追加）
 *
 * 历史：
 *   2026-09-07  由 `ki scan-kb import` 扁平化为 `ki import`，scan-kb 壳已移除且不保留兼容别名。
 *               两点依据：① 壳下仅存 import 一个子命令，层级冗余（19 个命令中 14 个本就是扁平）；
 *               ② bin/ki.mjs 的 COMMANDS 是单级扁平映射且 scriptArgs 会剥掉子命令名，与 commander
 *               嵌套子命令不兼容——实测 `jiti src/scan-kb.ts --source x` 报 `unknown option '--source'`，
 *               故仅在映射表加一行不可行，必须拆掉 .command() 嵌套层。
 *   已废弃      import --mode incremental（增量直连，git diff 驱动）—— 由幂等追加语义替代；
 *               diff 子命令（对比 source.commit..HEAD）—— 随 incremental 一并移除
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { loadConfig, resolveScope, runWithConfigSnapshot } from './lib/config.js';
import { readImportIncompleteStatus } from './lib/import-retry.js';

import { handleDirectImport } from './lib/import.js';
import { closeEngine } from './lib/vector-client.js';
import { parseCleanRules, type CleanRules } from './lib/clean.js';
import { callDaemon, createDaemonJobId, shouldUseDaemonClient } from './lib/daemon-client.js';
import { logProgress } from './lib/progress.js';
import { createTaskReporter } from './lib/task-registry.js';
import { refreshVectorDimensionSnapshot } from './lib/vector-dimension-snapshot.js';
import { closeFtsEngine } from './lib/fts-client.js';
// S-02：导入收尾的索引整理"等待 + 展示"（入队在 handleDirectImport 内部完成）
import { whenIndexMaintenanceIdle, getIndexMaintenanceState, readIndexReadiness } from './lib/index-maintenance.js';

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

const program = new Command();

// ─── S-04：统一导入命令（幂等追加）──────────────────────────
// 扁平结构：选项直接挂在 program 上（对齐 export/search/store/restore 等扁平命令惯例）

program
  .name('import')
  .showHelpAfterError()
  .description('导入：--source 直导外部 Wiki（无 AI，自动切分；幂等追加到目标 group）')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  // 非 requiredOption：`--retry-incomplete` 允许省略 --source（沿用上次导入记录的源目录），
  // 缺省校验移到 action 内（见下方「必须提供 --source」），以便给出更准确的提示
  .option('--source <sourceDir>', '外部 Markdown Wiki 根目录（原文直导，无 AI 依赖，自动切分）；--retry-incomplete 时可省略')
  .option('--group <group>', '目标 Group 落点（不存在时自动新建，含父路径）。缺省时目录导入按顶层子目录名各建根节点，单文档导入用 scope name')
  .option('--chunk-size <chunkSize>', '切分目标长度（字符，默认 1000）')
  .option('--chunk-overlap <chunkOverlap>', '切分重叠字符数（默认 150）')
  .option('--no-vector', 'FTS-only 模式：不调用 embedding，不写 dense 向量；清洗后的 chunk 写入独立全文 Collection，可被 fulltext 检索')
  .option('--tags <tags>', '文档级自定义标签（逗号分隔多个）：向量模式写内容向量，FTS-only 模式写全文标签索引；均持久化到 relation.tags')
  .option('--no-clean', '关闭全部数据清洗（含外部 hooks，等价 config clean.enabled:false）')
  .option('--no-assets', '关闭本地图片附件收集（等价 config import.assets:false；关闭后前端对图片引用显示占位块）')
  .option('--conflict-mode <mode>', '同名文档处理策略：incremental（内容未变则跳过重算，默认）/ overwrite / skip（已存在的一律不动，只导入新文件）/ suffix')
  .option('--conflict-suffix <template>', '自动后缀模板，必须包含 {n}（默认 _{n}）')
  .option('--clean-rules <rules>', '覆盖内置清洗规则开关，逗号分隔：bom,frontmatter,htmlComment,mermaid,codePath,codeBlock（不传用 config/默认）')
  .option('--max-batch-files <n>', '整批最大文件数（S0-3 预算；默认 20000，≤0 显式关闭该项限制）')
  .option('--max-batch-bytes <n>', '整批最大总字节数（S0-3 预算；默认 4GiB，≤0 显式关闭该项限制）')
  .option('--max-batch-chunks <n>', '整批最大预计 chunk 数（S0-3 预算；默认 300000，≤0 显式关闭该项限制）')
  .option('--retry-incomplete', 'R2：只重试上次未完成的文件（读 <scope>/.ki-import-incomplete.json；可省略 --source，沿用那次导入的源目录与参数）')
  .action(async (opts) => {
    const requestConfig = loadConfig();
    return runWithConfigSnapshot(requestConfig, async () => {
    try {
      const scope = resolveScope(requestConfig, opts.scope);
      // ── R2：未完成清单重试模式（只重试失败/未处理文件）──
      // 清单由部分成功导入写入 scope 目录；--source/参数缺省时沿用那次导入的记录，
      // 以保证重试与首次口径一致（切分/向量化/标签/冲突策略）。
      // P2（review）：清单「损坏」与「不存在」必须区分（否则会把损坏说成"没有待办"）；
      // 跨源覆盖留下的备份清单也在这里给出出路。
      const retryStatus = opts.retryIncomplete ? readImportIncompleteStatus(scope) : null;
      if (opts.retryIncomplete && retryStatus?.corrupted) {
        throw new Error(
          `scope "${scope}" 的未完成清单损坏（<scope>/.ki-import-incomplete.json 无法解析）。`
          + '请删除该文件后重新导入；或显式指定 --source 全量重导。',
        );
      }
      const retryRecord = retryStatus?.record ?? null;
      if (opts.retryIncomplete && !retryRecord) {
        const backupHint = retryStatus?.previous
          ? ` 另发现跨源覆盖前的备份清单（源 ${retryStatus.previous.sourceDir}，${retryStatus.previous.items.length} 项）：如需重试请先把它改名回 .ki-import-incomplete.json。`
          : '';
        throw new Error(
          `scope "${scope}" 没有待重试的未完成清单（<scope>/.ki-import-incomplete.json 不存在）。`
          + `请先按常规方式执行一次导入；若上次全部成功，则无需重试。${backupHint}`,
        );
      }
      if (opts.retryIncomplete && retryRecord!.items.length === 0) {
        throw new Error(`scope "${scope}" 的未完成清单为空，无需重试`);
      }
      if (!opts.retryIncomplete && !opts.source) {
        throw new Error('必须提供 --source <sourceDir>（或使用 --retry-incomplete 沿用上次导入的源目录）');
      }
      const sourceOpt = opts.source ? String(opts.source)
        : (retryRecord!.sourceDir ?? '');
      const sourceDir = path.resolve(sourceOpt);
      if (opts.retryIncomplete) {
        if (!fs.existsSync(sourceDir)) {
          throw new Error(`上次导入的源目录已不存在：${sourceDir}；请用 --source 显式指定当前源目录后重试`);
        }
        process.stderr.write(
          `重试未完成：${retryRecord!.items.length} 个文件（清单 ${new Date(retryRecord!.createdAt).toLocaleString()}；源 ${sourceDir}）\n`,
        );
      }
      const group = opts.group ? String(opts.group).trim() : (retryRecord?.params.group ?? '');
      const chunkSize = opts.chunkSize ? Number(opts.chunkSize) : retryRecord?.params.chunkSize;
      const chunkOverlap = opts.chunkOverlap ? Number(opts.chunkOverlap) : retryRecord?.params.chunkOverlap;
      // --no-vector 才是显式关闭；未显式传时沿用上次导入的向量化口径
      const vector = opts.vector === false ? false : (retryRecord?.params.vector ?? (opts.vector !== false));
      // 清洗开关：--no-clean 关闭全部；--clean-rules 覆盖内置规则
      const cleanEnabled = opts.clean !== false;
      const cleanRules: CleanRules | undefined = parseCleanRules(opts.cleanRules);
      // S0-3 整批预算覆盖（未传的项交给 resolveImportBudget 走 config/默认）
      const parseBudgetFlag = (name: string, raw: unknown): number | undefined => {
        if (raw === undefined) return undefined;
        const s = String(raw).trim();
        if (s === '' || !Number.isFinite(Number(s))) {
          // 无效输入告警后回落：该项交给 resolveImportBudget 走 scope 配置/默认预算
          // （注意不是"不限制"——显式关闭请传 ≤0 数值）
          process.stderr.write(`警告：${name} 取值无效（${String(raw)}），该项已忽略，改用 config/默认预算\n`);
          return undefined;
        }
        return Number(s);
      };
      const budgetFiles = parseBudgetFlag('--max-batch-files', opts.maxBatchFiles);
      const budgetBytes = parseBudgetFlag('--max-batch-bytes', opts.maxBatchBytes);
      const budgetChunks = parseBudgetFlag('--max-batch-chunks', opts.maxBatchChunks);
      const budget = {
        ...(budgetFiles !== undefined ? { maxBatchFiles: budgetFiles } : {}),
        ...(budgetBytes !== undefined ? { maxBatchBytes: budgetBytes } : {}),
        ...(budgetChunks !== undefined ? { maxBatchChunks: budgetChunks } : {}),
      };

      const importParams = {
        scope,
        sourceDir,
        group,
        chunkSize,
        chunkOverlap,
        vector,
        cleanEnabled,
        cleanRules,
        tags: opts.tags ?? retryRecord?.params.tags,
        assets: opts.assets !== false,
        conflictMode: opts.conflictMode ?? retryRecord?.params.conflictMode,
        conflictSuffix: opts.conflictSuffix ?? retryRecord?.params.conflictSuffix,
        budget,
        // R2：只重试未完成子集（名单外的文件本轮不处理）
        ...(retryRecord ? { onlyRelPaths: retryRecord.items.map((item) => item.path) } : {}),
      };
      const daemonJobId = createDaemonJobId();
      const useDaemon = shouldUseDaemonClient();
      const daemonAbort = useDaemon ? new AbortController() : undefined;
      const onDaemonSignal = () => {
        process.stderr.write('\n已请求取消 daemon import，等待当前批次收束...\n');
        daemonAbort?.abort();
      };
      if (useDaemon) process.once('SIGINT', onDaemonSignal);
      let result: unknown;
      try {
        if (!useDaemon) {
          const task = createTaskReporter(requestConfig, { id: daemonJobId, source: 'cli', operation: 'import', scope });
          task.update({ state: 'running', startedAt: Date.now() });
          try { await refreshVectorDimensionSnapshot(requestConfig, scope); } catch { /* diagnostics never block the import */ }
          try {
            result = await handleDirectImport({
              ...importParams,
              onInterrupt: () => task.finish('cancelled'),
              onProgress: (progress) => task.progress(progress),
            });
            const stats = (result as { stats?: { errors?: number; vectorized?: number; files?: { completed: number; incomplete: number } } }).stats;
            const partial = Boolean((result as { partial?: boolean }).partial) || (stats?.errors ?? 0) > 0;
            // ── S-02（REQ-20261009-003）：两级完成口径 ──
            // 元数据一提交，**「可用」即刻成立**：台账立刻写终态值 + phase=indexing；
            // 索引整理已由 `handleDirectImport` 内部**异步入队**（`indexMaintenance.scheduled`），
            // 此处只负责"等待 + 展示 + 降级文案"，且**整理失败不得算成导入失败**（护栏 3）。
            const maint = (result as { indexMaintenance?: { scheduled?: boolean } }).indexMaintenance;
            const optimizeTimeoutMs = (requestConfig as unknown as {
              vector?: { optimize?: { timeoutMs?: number } };
            }).vector?.optimize?.timeoutMs ?? 600_000;
            task.update({ state: partial ? 'partial' : 'succeeded', phase: maint?.scheduled ? 'indexing' : 'available' });
            if (maint?.scheduled) {
              process.stdout.write('⏳ 索引整理中…（本知识库检索可能变慢；文档浏览/编辑不受影响）\n');
              await whenIndexMaintenanceIdle(optimizeTimeoutMs);
              const last = getIndexMaintenanceState().last;
              // S-03/R6：就绪判据写入任务台账（任务中心/详情可直接核对"索引是否真的建了"）
              const readiness = await readIndexReadiness(scope);
              task.update({ indexReadiness: readiness });
              if (last && last.scope === scope) {
                if (last.ok) {
                  // A11 交叉核对：整理成功但**没有** dense 实体 = 信号与实物矛盾，必须说出来（不静默）
                  process.stdout.write(
                    `✅ 索引已优化（${(last.wallMs / 1000).toFixed(1)}s）`
                    + `${readiness.denseIndexed ? '' : '（注意：未检测到 dense 索引实体，可执行 ki doctor 诊断）'}\n`,
                  );
                  task.update({ phase: 'optimized' });
                } else {
                  process.stdout.write(
                    `⚠️  索引整理未完成（${last.degraded ?? 'error'}）：${last.reason ?? ''}\n`
                    + `   文档已可用；重试：ki index-optimize -s ${scope}\n`,
                  );
                  task.update({
                    phase: 'available',
                    recoveryHint: `索引整理未完成（${last.degraded ?? 'error'}）；可执行 ki index-optimize -s ${scope} 重试`,
                  });
                }
              }
            }
            task.finish(partial ? 'partial' : 'succeeded', {
              error: partial
                ? `完成 ${stats?.files?.completed ?? '?'} / 未完成 ${stats?.files?.incomplete ?? '?'} 个文件`
                : undefined,
              recoveryHint: partial ? '未完成文件可在修复 embedding 后重试导入；已完成部分已可用。' : undefined,
              partialCommitted: stats?.vectorized,
            });
          } catch (error) {
            const e = error as Error & { code?: string; stats?: { partialCommitted?: number } };
            task.finish(e.code === 'IMPORT_CANCELLED' ? 'cancelled' : 'failed', {
              error: e.message,
              recoveryHint: e.code === 'VECTORIZATION_STOPPED' ? '检查 embedding 配置、鉴权与服务状态；确认后重试导入。' : undefined,
              partialCommitted: e.stats?.partialCommitted,
            });
            throw error;
        } finally {
            try { await refreshVectorDimensionSnapshot(requestConfig, scope); } catch { /* task result remains authoritative */ }
            // 直连 CLI 是短进程；释放全文 Collection，避免 --no-vector 导入完成后
            // 因持有 SQLite/native 句柄而一直不退出。daemon 分支保留共享引擎。
            try { await closeFtsEngine(scope); } catch { /* best effort */ }
          }
        } else {
          // timeoutMs=0：导入内部向量化预算为 60s + N*10s（100 chunk ≈ 17 分钟），
          // 固定客户端超时会在任务完成前误报失败；daemon 死亡由 socket error 兜底感知。
          result = await callDaemon('import', importParams, 0, {
            streamProgress: true,
            jobId: daemonJobId,
            abortSignal: daemonAbort?.signal,
            onProgress: (event) => logProgress(event.progress.done, Math.max(event.progress.total, 1), `import ${event.progress.phase ?? 'running'}`),
          });
        }
      } finally {
        if (useDaemon) process.removeListener('SIGINT', onDaemonSignal);
      }
      await closeEngine();
      // R1（REQ-20261009-001，Q2 同口径）：部分成功 = **成功**（退出码 0、JSON ok:true），
      // 但必须把「完成 N / 未完成 M」与未完成清单显式告警到 stderr（fail-loud：不静默）。
      {
        const r = result as {
          partial?: boolean;
          stopReason?: { kind: string; code: string; phase: string; reason: string };
          cancelled?: true;
          incomplete?: { path: string; group: string; relation: string; reason: string }[];
          stats?: { files?: { total: number; completed: number; incomplete: number } };
        };
        if (r.partial) {
          const files = r.stats?.files;
          process.stderr.write(
            `\n⚠️  部分成功：完成 ${files?.completed ?? '?'} / 未完成 ${files?.incomplete ?? '?'} 个文件`
            + `（共 ${files?.total ?? '?'}；已完成部分已可浏览与检索）\n`,
          );
          if (r.stopReason) {
            process.stderr.write(`   停止原因：${r.stopReason.kind}/${r.stopReason.code}（${r.stopReason.phase}）：${r.stopReason.reason}\n`);
          }
          if (r.cancelled) process.stderr.write('   本次收到取消请求：已提交完成部分，未完成部分未写入\n');
          const list = r.incomplete ?? [];
          for (const item of list.slice(0, 20)) {
            process.stderr.write(`   - ${item.path}（${item.group}/${item.relation}）：${item.reason}\n`);
          }
          if (list.length > 20) {
            process.stderr.write(`   …另有 ${list.length - 20} 个未完成文件，详见 JSON 输出 incomplete 字段\n`);
          }
          process.stderr.write('   下一步：修复 embedding 后重试导入（已完成文件不会被重复向量化）\n');
        } else if (r.stopReason) {
          // 辅助向量降级（P0-2/P1-1）：正文已全部提交（无未完成文件），故不打印「部分成功」块；
          // 但仍要说清"为什么有错误"与重建出路，避免用户只能自己去读 JSON 的 errors 数组。
          process.stderr.write(
            `\nℹ️  辅助向量未完成（${r.stopReason.kind}/${r.stopReason.code}）：文档正文已全部提交可用；`
            + '标签向量 / 关系路径向量可用 `ki rebuild-vector` 重建。\n',
          );
        }
      }
      output(result as unknown as Record<string, unknown>);
    } catch (err) {
      await closeEngine();
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
    });
  });

program.parse();
