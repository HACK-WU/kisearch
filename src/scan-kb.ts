#!/usr/bin/env node
/**
 * scan-kb.ts - 外部知识库导入
 *
 * 子命令:
 *   import    （REQ-01）--source 直导外部 Markdown 目录（无 AI，自动切分）
 *   import --mode incremental（REQ-06）增量直连：git diff 驱动（add/modify/delete）
 *   diff      （S-05）对比 source.commit..HEAD 输出变更文件列表
 *
 * 批次 3（REQ-04/13）：已删除 `scan` 子命令（含 scan-pending/scan-index 产物）、
 * `vectorize` 子命令、`import --results`（ai-results）模式与 `migrate-keywords`。
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { ensureScopeDir } from './lib/store.js';
import { validateScope } from './lib/scope.js';

import { handleDirectImport } from './lib/import.js';
import { handleIncrementalDirect } from './lib/incremental.js';
import { handleDiff } from './lib/diff.js';
import { loadConfig } from './lib/config.js';
import { autoBackup } from './lib/backup.js';
import { closeEngine } from './lib/vector-client.js';

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

const program = new Command();

program
  .name('scan-kb')
  .showHelpAfterError()
  .description('外部知识库导入：import / diff');

// ─── S-04 / S-06：统一导入命令（直导 / 直连）──────────────────────────

program
  .command('import')
  .description('导入：--source 直导外部 Wiki（无 AI，自动切分；full / incremental）')
  .requiredOption('-s, --scope <scope>', '项目隔离标识')
  .requiredOption('--source <sourceDir>', '外部 Markdown Wiki 根目录（原文直导，无 AI 依赖，自动切分）')
  .option('--mode <mode>', '导入模式：full | incremental（默认 full）', 'full')
  .option('--root-name <rootName>', '导入根节点名称（全量直导必填）')
  .option('--chunk-size <chunkSize>', '切分目标长度（字符，默认 1000，全量直导专用；增量复用 source 块持久化值）')
  .option('--chunk-overlap <chunkOverlap>', '切分重叠字符数（默认 150，全量直导专用）')
  .action(async (opts) => {
    try {
      const scope = String(opts.scope);
      const mode = String(opts.mode || 'full');

      validateScope(scope);

      if (mode !== 'full' && mode !== 'incremental') {
        output({ ok: false, error: `未知 --mode: ${mode}（应为 full | incremental）` });
        process.exit(1);
      }

      const sourceDir = path.resolve(String(opts.source));
      const rootName = opts.rootName ? String(opts.rootName).trim() : '';
      const chunkSize = opts.chunkSize ? Number(opts.chunkSize) : undefined;
      const chunkOverlap = opts.chunkOverlap ? Number(opts.chunkOverlap) : undefined;

      const result =
        mode === 'full'
          ? await handleDirectImport({ scope, sourceDir, rootName, chunkSize, chunkOverlap })
          : await handleIncrementalDirect({ scope, sourceDir, chunkSize, chunkOverlap });
      await closeEngine();
      output(result as unknown as Record<string, unknown>);

      // 自动备份（失败不阻断）：full / incremental 导入成功后均触发，
      // 保证首次全量直导也生成 scope 快照（backup.ts 契约：import 成功后自动备份）。
      try {
        const config = loadConfig();
        const backupResult = autoBackup(config, scope, mode as 'full' | 'incremental');
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

// ─── S-05：增量 diff ──────────────────────────────────────────────────

program
  .command('diff')
  .description('对比 group-index.source.commit 与 HEAD，输出变更文件列表（含 memoryId 关联）')
  .requiredOption('-s, --scope <scope>', '项目隔离标识')
  .option('-o, --output <outputFile>', '将结果写入指定文件（默认仅 stdout）')
  .action((opts) => {
    try {
      const scope = String(opts.scope);
      const outputFile = opts.output ? path.resolve(String(opts.output)) : undefined;
      validateScope(scope);

      const result = handleDiff({ scope, outputFile });
      const json = JSON.stringify(result, null, 2);
      if (outputFile) {
        fs.writeFileSync(outputFile, json + '\n', 'utf-8');
      }
      console.log(json);
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

program.parse();
