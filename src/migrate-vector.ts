#!/usr/bin/env node
/**
 * ki migrate-vector —— 显式迁移旧单 Collection 到按 scope Collection。
 *
 * 旧目录只读保留；迁移失败时不会删除或覆盖旧数据。
 */

import { Command } from 'commander';
import { callDaemon, shouldUseDaemonClient } from './lib/daemon-client.js';
import { migrateLegacyVectorLayout, type MigrateVectorResult } from './lib/vector-migrate.js';

export async function executeMigrateVector(params: { yes: boolean; resume?: boolean }): Promise<MigrateVectorResult> {
  // timeoutMs=0：迁移需读取旧 Collection 全量文档（含向量）并逐 scope 写入与核对，
  // 耗时随文档数线性增长；客户端超时不取消 daemon 侧任务，只会误报失败。
  if (shouldUseDaemonClient()) return callDaemon<MigrateVectorResult>('migrate-vector', params, 0);
  return migrateLegacyVectorLayout(params);
}

const program = new Command();
program
  .name('migrate-vector')
  .description('显式迁移旧单 Collection 到按 scope Collection（旧数据保留）')
  .option('--yes', '确认创建新 Collection；不会删除旧目录')
  .option('--resume', '从 collections/migration.json checkpoint 继续')
  .action(async (opts) => {
    const result = await executeMigrateVector({ yes: opts.yes === true, resume: opts.resume === true });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
  });

const entry = process.argv[1];
if (entry && import.meta.url.endsWith(entry.replace(/\\/g, '/'))) program.parse();
