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
import path from 'path';
import { loadConfig, resolveScope, runWithConfigSnapshot } from './lib/config.js';

import { handleDirectImport } from './lib/import.js';
import { autoBackup } from './lib/backup.js';
import { closeEngine } from './lib/vector-client.js';
import { parseCleanRules, type CleanRules } from './lib/clean.js';
import { callDaemon, createDaemonJobId, shouldUseDaemonClient } from './lib/daemon-client.js';
import { logProgress } from './lib/progress.js';

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
  .requiredOption('--source <sourceDir>', '外部 Markdown Wiki 根目录（原文直导，无 AI 依赖，自动切分）')
  .option('--group <group>', '目标 Group 落点（不存在时自动新建，含父路径）。缺省时目录导入按顶层子目录名各建根节点，单文档导入用 scope name')
  .option('--chunk-size <chunkSize>', '切分目标长度（字符，默认 1000）')
  .option('--chunk-overlap <chunkOverlap>', '切分重叠字符数（默认 150）')
  .option('--no-vector', 'FTS-only 模式：不调用 embedding，不写 dense 向量；清洗后的 chunk 写入独立全文 Collection，可被 fulltext 检索')
  .option('--tags <tags>', '文档级自定义标签（逗号分隔多个）：向量模式写内容向量，FTS-only 模式写全文标签索引；均持久化到 relation.tags')
  .option('--no-clean', '关闭全部数据清洗（含外部 hooks，等价 config clean.enabled:false）')
  .option('--no-assets', '关闭本地图片附件收集（等价 config import.assets:false；关闭后前端对图片引用显示占位块）')
  .option('--conflict-mode <mode>', '同名文档处理策略：overwrite / skip / suffix（默认 suffix）')
  .option('--conflict-suffix <template>', '自动后缀模板，必须包含 {n}（默认 _{n}）')
  .option('--clean-rules <rules>', '覆盖内置清洗规则开关，逗号分隔：bom,frontmatter,htmlComment,mermaid,codePath,codeBlock（不传用 config/默认）')
  .action(async (opts) => {
    const requestConfig = loadConfig();
    return runWithConfigSnapshot(requestConfig, async () => {
    try {
      const scope = resolveScope(requestConfig, opts.scope);
      const sourceDir = path.resolve(String(opts.source));
      const group = opts.group ? String(opts.group).trim() : '';
      const chunkSize = opts.chunkSize ? Number(opts.chunkSize) : undefined;
      const chunkOverlap = opts.chunkOverlap ? Number(opts.chunkOverlap) : undefined;
      const vector = opts.vector !== false;
      // 清洗开关：--no-clean 关闭全部；--clean-rules 覆盖内置规则
      const cleanEnabled = opts.clean !== false;
      const cleanRules: CleanRules | undefined = parseCleanRules(opts.cleanRules);

      const importParams = {
        scope,
        sourceDir,
        group,
        chunkSize,
        chunkOverlap,
        vector,
        cleanEnabled,
        cleanRules,
        tags: opts.tags,
        assets: opts.assets !== false,
        conflictMode: opts.conflictMode,
        conflictSuffix: opts.conflictSuffix,
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
        result = !useDaemon
          ? await handleDirectImport(importParams)
          // timeoutMs=0：导入内部向量化预算为 60s + N*10s（100 chunk ≈ 17 分钟），
          // 固定客户端超时会在任务完成前误报失败；daemon 死亡由 socket error 兜底感知。
          : await callDaemon('import', importParams, 0, {
            streamProgress: true,
            jobId: daemonJobId,
            abortSignal: daemonAbort?.signal,
            onProgress: (event) => logProgress(event.progress.done, Math.max(event.progress.total, 1), `import ${event.progress.phase ?? 'running'}`),
          });
      } finally {
        if (useDaemon) process.removeListener('SIGINT', onDaemonSignal);
      }
      await closeEngine();
      output(result as unknown as Record<string, unknown>);

      // 自动备份（失败不阻断）：导入成功后触发，保证首次导入也生成 scope 快照。
      try {
        const backupResult = shouldUseDaemonClient()
          ? await callDaemon<Record<string, unknown>>('backup', { scope }, 0)
          : autoBackup(loadConfig(), scope);
        const snapshot = (backupResult as { snapshotPath?: string; snapshotBackup?: string }).snapshotPath
          ?? (backupResult as { snapshotBackup?: string }).snapshotBackup;
        if ((backupResult as { ok?: boolean }).ok && snapshot) {
          process.stderr.write(`自动备份完成：${snapshot}\n`);
        }
      } catch (backupErr) {
        process.stderr.write(`警告：自动备份失败 — ${(backupErr as Error).message}\n`);
      }
    } catch (err) {
      await closeEngine();
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
    });
  });

program.parse();
