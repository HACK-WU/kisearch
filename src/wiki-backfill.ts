#!/usr/bin/env node
/**
 * wiki-backfill.ts —— ki wiki-backfill 命令
 *
 * 历史补齐：将 KB 中已有 Relations 全量写回 Wiki。
 * 场景：scope 先导入数据、后开启 wikiSync——开启前的历史关系不会随
 * sync_relation 自动落盘，用本命令一次性补齐（幂等，覆盖写）。
 *
 * 用法：
 *   ki wiki-backfill <scope>
 */

import { detectUnknownFlags, toErrorPayload } from './lib/cli-args.js';
import { loadConfig, resolveScope } from './lib/config.js';
import { backfillWiki } from './lib/wiki-sync.js';
import { validateScope } from './lib/scope.js';

const WIKI_BACKFILL_HELP = `ki wiki-backfill - 将 KB 中已有 Relations 全量写回 Wiki（历史补齐）

用法：
  ki wiki-backfill <scope> [--force]

说明：
  wikiSync 开启后，此前的历史关系不会自动补写 wiki 文件；本命令遍历
  relations-cache 全部 group，从 local KB 取内容逐条写回
  （{wiki目标目录}/{group}/{relation}.md）。
  幂等：已存在的文件跳过（不刷新时间戳，git 仓库不产生脏 diff）。
  前置：wikiSync.enabled 不为 false，且存在 wiki 目标目录
  （group-index source 块或 wikiSync.sourceDir）。

选项：
  --force             全量覆盖写（刷新已存在文件的 exportedAt）
  -h, --help          显示帮助`;

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    console.log(WIKI_BACKFILL_HELP);
    return;
  }

  // 未知参数检测：位置参数（scope）之外仅接受 --force（布尔）
  const flags = args.filter((a) => a.startsWith('-'));
  detectUnknownFlags(flags, ['--force'], [], WIKI_BACKFILL_HELP);

  const scopeArg = args.find((a) => !a.startsWith('-'));
  if (!scopeArg) {
    output({ ok: false, error: '缺少 <scope> 参数', code: 'MISSING_SCOPE', help: WIKI_BACKFILL_HELP });
    process.exitCode = 1;
    return;
  }

  try {
    const config = loadConfig();
    const scope = resolveScope(config, scopeArg);
    validateScope(scope);
    output(backfillWiki(scope, { force: flags.includes('--force') }));
  } catch (err) {
    output(toErrorPayload(err));
    process.exitCode = 1;
  }
}

main();
