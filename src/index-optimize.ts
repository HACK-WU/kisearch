/**
 * index-optimize.ts —— CLI：手动触发索引整理（optimize）= **重试入口**
 *
 * S-01（REQ-20261009-003）：导入收尾会自动异步触发整理；本命令用于
 *   ① 整理**失败/超时（= 中断）后的重试**；② 存量 scope 的按需整理。
 *
 * 用法：`ki index-optimize --scope <s> [--concurrency N] [--timeout-ms N]`
 * 输出：JSON（含 `degraded` 原因）；失败退出码 1。
 *
 * 注：CLI 为**本进程**执行整理。若 daemon 正在持有该 scope 的 collection 锁，会返回
 * `degraded:'unavailable'`（此处不自动改走 daemon：整理的重试入口同时提供
 * `POST /api/vector/optimize`，在 daemon 进程内执行，天然不受锁影响）。
 */
import { Command } from 'commander';
import { loadConfig, resolveScope } from './lib/config.js';
import { validateScope } from './lib/scope.js';
import { closeEngine, optimizeVectorIndex } from './lib/vector-client.js';

const program = new Command();

program
  .name('ki index-optimize')
  .description('触发索引整理（optimize）——导入收尾会自动执行；本命令用于失败重试 / 存量按需整理')
  .requiredOption('-s, --scope <scope>', '目标 scope')
  .option('--concurrency <n>', '整理线程数（0 = 引擎自动；建议 1，实验 1 实测 ≈1 核）')
  .option('--timeout-ms <ms>', '等待上限；超时按"中断"处理（默认 600000）')
  .action(async (opts: { scope: string; concurrency?: string; timeoutMs?: string }) => {
    const scope = resolveScope(loadConfig(), opts.scope);
    validateScope(scope);
    const outcome = await optimizeVectorIndex(scope, {
      ...(opts.concurrency !== undefined ? { concurrency: Number(opts.concurrency) } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: Number(opts.timeoutMs) } : {}),
    });
    // outcome 自身含 ok（联合类型），勿再重复声明
    console.log(JSON.stringify({ action: 'index-optimize', scope, ...outcome }, null, 2));
    // CLI per-call：必须关闭引擎（terminate worker + 释放 LOCK），否则进程无法退出
    await closeEngine();
    if (!outcome.ok) process.exit(1);
  });

// 仅在直接运行时解析参数（被 import 时不执行）——与其它 CLI 命令一致
const _isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry || !import.meta.url) return false;
    return import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  } catch { return false; }
})();
if (_isMain) program.parse();
