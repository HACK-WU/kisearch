#!/usr/bin/env node
/**
 * tag.ts - ki tag CLI（src 版）
 *
 * 向量层 tag 发现（只读）。
 *
 * 用法:
 *   ki tag list [--scope <scope>] [--scan-limit <n>]
 *
 * 说明:
 *   - tag 是文档上的标量字段，无独立生命周期；本命令仅用于发现某 scope 下用过哪些 tag，
 *     便于后续 ki search / ki doc list --tags 精确过滤
 *   - 只读：删除某 tag 下内容请用 ki doc delete / ki scope clear --tags
 *   - 引擎无 distinct：一次扫描 + 内存去重计数，受 --scan-limit 约束（默认 10000），
 *     超限时 truncated:true 表示结果为"已扫描范围内"的近似值
 */

import { Command } from 'commander';
import {
  vectorListTags,
  ensureVectorAvailable,
  closeEngine,
  type VectorTagInfo,
} from './lib/vector-client.js';
import { parseIntArg } from './lib/cli-args.js';

// ─── 纯函数（供 CLI / MCP 共享） ───

export type TagListResult =
  | { ok: true; scope: string; count: number; scanned: number; truncated: boolean; tags: VectorTagInfo[] }
  | { ok: false; error: string; degraded?: boolean };

export async function executeTagList(params: {
  scope: string;
  scanLimit?: number;
}): Promise<TagListResult> {
  try {
    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      return { ok: false, error: `向量服务暂不可用（${avail.reason || '未检测到向量服务'}）`, degraded: true };
    }
    const { tags, scanned, truncated } = await vectorListTags({
      scope: params.scope,
      scanLimit: params.scanLimit,
    });
    return { ok: true, scope: params.scope, count: tags.length, scanned, truncated, tags };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();
program.name('tag').description('向量层 tag 发现（只读）');

program
  .command('list')
  .description('列出指定 scope 下用过的 tag（含文档数，按数量降序）')
  .option('--scope <scope>', '项目隔离标识（省略用 default）', 'default')
  .option('--scan-limit <n>', '扫描上限（超出则结果为近似，truncated:true）', '10000')
  .action(async (opts) => {
    const result = await executeTagList({
      scope: opts.scope,
      scanLimit: parseIntArg(opts.scanLimit, 10000, '--scan-limit', { min: 1 }),
    });
    console.log(JSON.stringify(result, null, 2));
    await closeEngine();
    if (!result.ok) process.exit(1);
  });

// 仅在直接运行时解析参数（被 import 时不执行）
const _isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry || !import.meta.url) return false;
    return import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  } catch { return false; }
})();
if (_isMain) program.parse();
