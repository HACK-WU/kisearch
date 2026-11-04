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
 *   - 引擎无 distinct：扫描 + 内存去重计数。S0-1（2026-10-08）起默认倍增 limit 取全
 *     （不再固定 10000 近似），超硬上限时 truncated:true 表示近似值；
 *     --scan-limit <n> 显式指定时仍视为硬上限（成本控制逃生口）
 */

import { Command } from 'commander';
import {
  vectorListTags,
  ensureVectorAvailable,
  closeEngine,
  SCAN_HARD_CAP,
  type VectorTagInfo,
} from './lib/vector-client.js';
import { parseIntArg } from './lib/cli-args.js';
import { loadConfig, resolveScope } from './lib/config.js';
import { resolveScopeTargets } from './lib/scope-view.js';
import { callDaemon, shouldUseDaemonClient } from './lib/daemon-client.js';

// ─── 纯函数（供 CLI / MCP 共享） ───

export type TagListResult =
  | { ok: true; scope: string; count: number; scanned: number; truncated: boolean; tags: VectorTagInfo[] }
  | { ok: false; error: string; degraded?: boolean };

async function executeTagListLocal(params: {
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

export async function executeTagList(params: { scope: string; scanLimit?: number }): Promise<TagListResult> {
  if (shouldUseDaemonClient()) return callDaemon<TagListResult>('tag-list', params);
  return executeTagListLocal(params);
}

// ─── CLI ───

const program = new Command();
program.name('tag').showHelpAfterError().description('向量层 tag 发现（只读）');

program
  .command('list')
  .description('列出指定 scope 下用过的 tag（含文档数，按数量降序）')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .option('--scan-limit <n>', '扫描上限（显式指定则为硬上限，结果为近似 truncated:true；缺省取全）')
  .action(async (opts) => {
    // 缺省不传 → 不下传 → vectorListTags 倍增取全；显式传入才解析（无效输入回落取全）
    const scanLimit = opts.scanLimit !== undefined
      ? parseIntArg(opts.scanLimit, 0, '--scan-limit', { min: 1, max: SCAN_HARD_CAP })
      : 0;

    /**
     * 视图模式：**合并 + 计数累加**（与 group/doc 的分桶不同）。
     *
     * 为什么这里合并而不是分桶：tag 是「跨库筛选维度」，用户要的是"整个视图里
     * 有哪些 tag、各多少篇"；分桶后得逐库看一遍才知道全貌，且浏览页的 tag 下拉
     * 只能吃一个扁平列表。同名 tag 的 count 直接相加，并用 scopes 标明来源库（S-07 D2）。
     */
    const config = loadConfig();
    const targets = resolveScopeTargets(config, opts.scope);
    if (targets.views.length > 0 && targets.scopes.length > 1) {
      const merged = new Map<string, { tag: string; count: number; scopes: string[] }>();
      const skipped: { scope: string; reason: string }[] = [...targets.skipped];
      for (const member of targets.scopes) {
        // 单个成员失败（向量服务不可用 / daemon 起不来）不应让整个视图抛裸堆栈：
        // 记进 skipped 继续，其余成员照常合并（与 group/doc 的分桶口径一致）
        let r: Awaited<ReturnType<typeof executeTagList>>;
        try {
          r = await executeTagList({ scope: member, ...(scanLimit > 0 ? { scanLimit } : {}) });
        } catch (err) {
          skipped.push({ scope: member, reason: (err as Error).message });
          continue;
        }
        if (!r.ok) {
          skipped.push({ scope: member, reason: r.error });
          continue;
        }
        for (const t of r.tags) {
          const hit = merged.get(t.tag);
          if (hit) {
            hit.count += t.count;
            if (!hit.scopes.includes(member)) hit.scopes.push(member);
          } else {
            merged.set(t.tag, { tag: t.tag, count: t.count, scopes: [member] });
          }
        }
      }
      const tags = [...merged.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
      console.log(JSON.stringify({
        ok: true,
        view: targets.views[0],
        members: targets.scopes,
        count: tags.length,
        tags,
        ...(skipped.length > 0 ? { skipped } : {}),
      }, null, 2));
      await closeEngine();
      return;
    }

    const scope = resolveScope(loadConfig(), opts.scope);
    const result = await executeTagList({
      scope,
      ...(scanLimit > 0 ? { scanLimit } : {}),
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
