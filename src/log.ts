#!/usr/bin/env node
/**
 * log.ts - ki log CLI（任务运行诊断，只读）
 *
 * 用法:
 *   ki log <taskId>
 *   ki log --id <taskId>                 # 也接受用户习惯写法 -id <taskId>
 *   ki log --scope <scope> [--failed] [--limit <n>]
 *   ki log                               # 最近 10 个任务
 *
 * 说明:
 *   - 数据来源是任务台账（`{dataDir}/.ki-tasks/<taskId>.json`），**只保留 1 小时**
 *     （`TASK_TTL_MS`）；过期即无记录，本命令明确告知而不是给空结果
 *   - `--scope` 只作一致性校验 / 列表过滤：与任务实际 scope 不符时报错退出，
 *     绝不静默忽略（否则「填错 scope」会被误读成「任务不存在」）
 *   - 只读：不启动服务、不改任务状态、不触碰向量
 *   - 运行日志落盘（`.ki-tasks/logs/<taskId>.log`）尚未启用（S-02）；
 *     接入后命令形态不变，只在输出中追加日志正文
 */

import { Command } from 'commander';
import { loadConfig } from './lib/config.js';
import { parseIntArg } from './lib/cli-args.js';
import { executeTaskLog, normalizeTaskLogArgv, renderList, renderTask } from './lib/task-log-view.js';

const program = new Command();
program.name('log').showHelpAfterError().description('任务运行诊断（只读）');

program
  .argument('[taskId]', '任务 ID（与 --id 二选一）')
  .option('--id <taskId>', '任务 ID（与位置参数二选一；-id 等价）')
  .option('-s, --scope <scope>', '一致性校验（与任务 scope 不符即报错）/ 列表过滤')
  .option('--failed', '列表模式只显示 failed / partial / cancelled')
  .option('--limit <n>', '列表行数，默认 10，上限 100')
  .option('--json', '结构化输出（脚本用）')
  .action((taskIdArg: string | undefined, opts: { id?: string; scope?: string; failed?: boolean; limit?: string; json?: boolean }) => {
    if (taskIdArg && opts.id && taskIdArg !== opts.id) {
      process.stderr.write(`错误：位置参数 ${taskIdArg} 与 --id ${opts.id} 冲突（只保留一个）\n`);
      process.exitCode = 2;
      return;
    }
    const limit = opts.limit !== undefined
      ? parseIntArg(opts.limit, 10, '--limit', { min: 1, max: 100 })
      : undefined;
    const taskId = taskIdArg ?? opts.id;
    const { exitCode, result } = executeTaskLog(loadConfig(), {
      ...(taskId ? { taskId } : {}),
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.failed ? { failed: true } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    if (opts.json) {
      const ok = result.kind === 'task' || result.kind === 'list';
      process.stdout.write(`${JSON.stringify({ ok, exitCode, ...result }, null, 2)}\n`);
      process.exitCode = exitCode;
      return;
    }
    if (result.kind === 'invalid') {
      process.stderr.write(`错误：${result.message}\n`);
      process.exitCode = exitCode;
      return;
    }
    if (result.kind === 'not-found') {
      process.stderr.write([
        `未找到任务 ${result.taskId}`,
        '',
        '  可能原因：',
        '    1. 任务台账只保留 1 小时，已过期清理',
        '    2. 任务由另一份配置的服务执行（dataDir 不同）：用 --config 指向同一配置文件',
        '',
        '  可以这样查：',
        ...result.next.map((line) => `    ${line}`),
        '',
      ].join('\n'));
      process.exitCode = exitCode;
      return;
    }
    process.stdout.write(`${result.kind === 'task' ? renderTask(result.task) : renderList(result)}\n`);
    process.exitCode = exitCode;
  });

program.parse([process.argv[0], process.argv[1], ...normalizeTaskLogArgv(process.argv.slice(2))]);
