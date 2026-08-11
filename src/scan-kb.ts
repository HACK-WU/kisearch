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
import { loadConfig, resolveScope } from './lib/config.js';
import { getRelationsCachePath } from './lib/scope.js';
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
  .description('外部知识库导入：import / diff');

// ─── S-04 / S-06：统一导入命令（直导 / 直连）──────────────────────────

program
  .command('import')
  .description('导入：--source 直导外部 Wiki（无 AI，自动切分；full / incremental）')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .requiredOption('--source <sourceDir>', '外部 Markdown Wiki 根目录（原文直导，无 AI 依赖，自动切分）')
  .option('--mode <mode>', '导入模式：full | incremental（默认 full）', 'full')
  .option('--root-name <rootName>', '导入根节点名称（全量直导必填）')
  .option('--chunk-size <chunkSize>', '切分目标长度（字符，默认 1000，全量直导专用；增量复用 source 块持久化值）')
  .option('--chunk-overlap <chunkOverlap>', '切分重叠字符数（默认 150，全量直导专用）')
  .option('--no-vector', '非向量化模式：仅写 KB 层（relations-cache + local KB），不写向量（不产生 memoryId，无法被 ki search 召回）')
  .option('--yes', '确认覆盖：scope 已存在时跳过确认提示直接执行（full 模式覆盖导入含向量清空重建）')
  .option('--no-clean', '关闭全部数据清洗（含外部 hooks，等价 config clean.enabled:false）')
  .option('--clean-rules <rules>', '覆盖内置清洗规则开关，逗号分隔：bom,frontmatter,htmlComment,mermaid,codePath,codeBlock（不传用 config/默认）')
  .action(async (opts) => {
    try {
      const scope = resolveScope(loadConfig(), opts.scope);
      const mode = String(opts.mode || 'full');

      if (mode !== 'full' && mode !== 'incremental') {
        output({ ok: false, error: `未知 --mode: ${mode}（应为 full | incremental）` });
        process.exit(1);
      }

      const sourceDir = path.resolve(String(opts.source));
      const rootName = opts.rootName ? String(opts.rootName).trim() : '';
      const chunkSize = opts.chunkSize ? Number(opts.chunkSize) : undefined;
      const chunkOverlap = opts.chunkOverlap ? Number(opts.chunkOverlap) : undefined;
      const vector = opts.vector !== false;
      // 清洗开关：--no-clean 关闭全部；--clean-rules 覆盖内置规则
      const cleanEnabled = opts.clean !== false;
      const cleanRules: CleanRules | undefined = parseCleanRules(opts.cleanRules);

      // CLI-07：--root-name 语义统一——full 模式必填（前置校验），incremental 忽略
      if (mode === 'full' && !rootName) {
        output({ ok: false, error: '全量直导必须传 --root-name <name>' });
        process.exit(1);
      }

      // 覆盖保护（full 模式）：scope 已存在（有 relations-cache 即已建过）时，
      // 覆盖导入会清空重建向量，必须显式 --yes 确认；incremental 是增量更新不触发。
      if (mode === 'full' && !opts.yes) {
        const scopeExists = fs.existsSync(getRelationsCachePath(scope));
        if (scopeExists) {
          output({
            ok: false,
            error:
              `scope "${scope}" 已存在，全量导入将覆盖原数据（KB + 向量：先清空旧向量再重建）。` +
              '如确认覆盖请追加 --yes（incremental 增量更新无需）。',
          });
          process.exit(1);
        }
      }

      const result =
        mode === 'full'
          ? await handleDirectImport({ scope, sourceDir, rootName, chunkSize, chunkOverlap, vector, cleanEnabled, cleanRules })
          : await handleIncrementalDirect({ scope, sourceDir, chunkSize, chunkOverlap, vector, cleanEnabled, cleanRules });
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
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .option('-o, --output <outputFile>', '将结果写入指定文件（默认仅 stdout）')
  .action((opts) => {
    try {
      const scope = resolveScope(loadConfig(), opts.scope);
      const outputFile = opts.output ? path.resolve(String(opts.output)) : undefined;

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
