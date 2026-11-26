#!/usr/bin/env node
/**
 * `ki event-types` —— 事件类型的运维命令（日常增删改走页面，这里只有内置类型升级）。
 *
 * 逻辑在 `src/lib/events/migrate-*.ts`，本文件只做 CLI 包装：
 * 逻辑与 CLI 分离是为了让测试能直接 import 函数而不触发 commander 的 `parse()`。
 *
 * `migrate` 一次跑完全部已知升级（幂等，可重复执行）：
 *   · 技术债：两阶段 → 四阶段（只插中间）
 *   · 末位统一「已关闭」：补末位 + 原末位降档 + 存量已收口事件吸附
 */

import { Command } from 'commander';

import { migrateTechDebtStages } from './lib/events/migrate-tech-debt.js';
import { migrateClosingStage } from './lib/events/migrate-closing-stage.js';

const program = new Command();

program
  .name('event-types')
  .showHelpAfterError()
  .description('事件类型运维：内置类型升级与存量迁移');

program
  .command('migrate')
  .description('升级已落盘的内置类型：技术债四阶段 + 末位统一「已关闭」（含存量已收口事件吸附）；幂等，写盘前自动备份')
  .option('-s, --scope <scope>', '知识库名（缺省 default）')
  .option('--dry-run', '只打印将要做的变更，不写盘')
  .option('--skip-events', '只迁类型，不吸附存量已收口事件的阶段（会留下「类型已有已关闭、事件仍停在旧末位」的中间态）')
  /*
   * 不做交互式确认：这条命令会被脚本 / AI 调用，readline 会把它们挂住。
   * 缺省（既没 --dry-run 也没 --yes）按 dry-run 处理并要求显式 --yes，安全性等价。
   */
  .option('--yes', '确认执行（缺省只预览）')
  .action(async (opts: { scope?: string; dryRun?: boolean; skipEvents?: boolean; yes?: boolean }) => {
    const scope = opts.scope ?? 'default';
    const dryRun = Boolean(opts.dryRun) || !opts.yes;
    try {
      const techDebt = await migrateTechDebtStages(scope, { dryRun });
      const closing = await migrateClosingStage(scope, { dryRun, skipEvents: opts.skipEvents === true });
      console.log(JSON.stringify({
        ok: techDebt.ok && closing.ok,
        scope,
        dryRun,
        steps: [
          { step: 'tech-debt', ...techDebt },
          { step: 'closing', ...closing },
        ],
      }, null, 2));
      if (dryRun && !opts.dryRun) {
        console.log('\n（未加 --yes，仅预览；确认无误后追加 --yes 执行）');
      }
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2));
      process.exit(1);
    }
  });

program.parse();
