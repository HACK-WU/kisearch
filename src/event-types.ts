#!/usr/bin/env node
/**
 * `ki event-types` —— 事件类型的运维命令（日常增删改走页面，这里只有内置类型升级）。
 *
 * 逻辑在 `src/lib/events/migrate-tech-debt.ts`，本文件只做 CLI 包装：
 * 逻辑与 CLI 分离是为了让测试能直接 import 函数而不触发 commander 的 `parse()`。
 */

import { Command } from 'commander';

import { migrateTechDebtStages } from './lib/events/migrate-tech-debt.js';

const program = new Command();

program
  .name('event-types')
  .showHelpAfterError()
  .description('事件类型运维：内置类型升级与存量迁移');

program
  .command('migrate')
  .description('把存量的「技术债」类型中间插入成四阶段（幂等；写盘前自动备份 _types.json.bak）')
  .option('-s, --scope <scope>', '知识库名（缺省 default）')
  .option('--dry-run', '只打印将要做的变更，不写盘')
  /*
   * 不做交互式确认：这条命令会被脚本 / AI 调用，readline 会把它们挂住。
   * 缺省（既没 --dry-run 也没 --yes）按 dry-run 处理并要求显式 --yes，安全性等价。
   */
  .option('--yes', '确认执行（缺省只预览）')
  .action(async (opts: { scope?: string; dryRun?: boolean; yes?: boolean }) => {
    const scope = opts.scope ?? 'default';
    try {
      const result = await migrateTechDebtStages(scope, { dryRun: opts.dryRun || !opts.yes });
      console.log(JSON.stringify(result, null, 2));
      if (result.skipped) console.log(`无需迁移：${result.skipped}`);
      if (!opts.yes && !opts.dryRun) {
        console.log('\n（未加 --yes，仅预览；确认无误后追加 --yes 执行）');
      }
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2));
      process.exit(1);
    }
  });

program.parse();
