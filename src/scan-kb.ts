#!/usr/bin/env node
/**
 * scan-kb.ts - 外部知识库导入
 *
 * 子命令:
 *   import    （REQ-01）--source 直导外部 Markdown 目录（无 AI，自动切分；幂等追加）
 *
 * 历史（已废弃）：
 *   import --mode incremental（增量直连，git diff 驱动）—— 由幂等追加语义替代
 *   diff 子命令（对比 source.commit..HEAD）—— 随 incremental 一并移除
 */

import { Command } from 'commander';
import path from 'path';
import { loadConfig, resolveScope } from './lib/config.js';

import { handleDirectImport } from './lib/import.js';
import { autoBackup } from './lib/backup.js';
import { closeEngine } from './lib/vector-client.js';
import { parseCleanRules, type CleanRules } from './lib/clean.js';

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

const program = new Command();

program
  .name('scan-kb')
  .showHelpAfterError()
  .description('外部知识库导入：import');

// ─── S-04：统一导入命令（幂等追加）──────────────────────────

program
  .command('import')
  .description('导入：--source 直导外部 Wiki（无 AI，自动切分；幂等追加到目标 group）')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .requiredOption('--source <sourceDir>', '外部 Markdown Wiki 根目录（原文直导，无 AI 依赖，自动切分）')
  .option('--group <group>', '目标 Group 落点（不存在时自动新建，含父路径）。默认 default')
  .option('--chunk-size <chunkSize>', '切分目标长度（字符，默认 1000）')
  .option('--chunk-overlap <chunkOverlap>', '切分重叠字符数（默认 150）')
  .option('--no-vector', '非向量化模式：仅写 KB 层（relations-cache + local KB），不写向量（不产生 memoryId，无法被 ki search 召回）')
  .option('--no-clean', '关闭全部数据清洗（含外部 hooks，等价 config clean.enabled:false）')
  .option('--clean-rules <rules>', '覆盖内置清洗规则开关，逗号分隔：bom,frontmatter,htmlComment,mermaid,codePath,codeBlock（不传用 config/默认）')
  .action(async (opts) => {
    try {
      const scope = resolveScope(loadConfig(), opts.scope);
      const sourceDir = path.resolve(String(opts.source));
      const group = opts.group ? String(opts.group).trim() : 'default';
      const chunkSize = opts.chunkSize ? Number(opts.chunkSize) : undefined;
      const chunkOverlap = opts.chunkOverlap ? Number(opts.chunkOverlap) : undefined;
      const vector = opts.vector !== false;
      // 清洗开关：--no-clean 关闭全部；--clean-rules 覆盖内置规则
      const cleanEnabled = opts.clean !== false;
      const cleanRules: CleanRules | undefined = parseCleanRules(opts.cleanRules);

      const result = await handleDirectImport({ scope, sourceDir, group, chunkSize, chunkOverlap, vector, cleanEnabled, cleanRules });
      await closeEngine();
      output(result as unknown as Record<string, unknown>);

      // 自动备份（失败不阻断）：导入成功后触发，保证首次导入也生成 scope 快照。
      try {
        const config = loadConfig();
        const backupResult = autoBackup(config, scope);
        if (backupResult.ok && backupResult.snapshotBackup) {
          process.stderr.write(`自动备份完成：${backupResult.snapshotBackup}\n`);
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

program.parse();
