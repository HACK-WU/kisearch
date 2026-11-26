#!/usr/bin/env node
/**
 * assets.ts - 附件（图片）治理：孤儿扫描与清理（事件 #102）
 *
 * 用法:
 *   ki assets gc [--scope <库>] [--group <组>] [--min-age-days <n>] [--apply] [--json]
 *
 * 什么是孤儿：`{group}/assets/` 下没有被**本组任何文档正文**引用的文件。
 *   删除文档只删正文，图片会留下来（assets 没有回收站，也没有 GC）—— 见 #102。
 *
 * 默认 **dry-run**：只列清单与可回收字节，不删任何文件。`--apply` 才真的删。
 *   为什么默认不删：assets 没有回收站，`fs.rm` 之后只能靠备份；而「没被引用」的判据
 *   依赖正文可读（正文读不到时那一组会被跳过，不会误判成全孤儿）。
 *
 * 判据实现与口径见 `lib/asset-orphan.ts` 头注释（不引入引用计数表的理由）。
 */

import { Command } from 'commander';

import {
  deleteOrphans,
  scanScopeOrphans,
  type ScopeOrphanScan,
} from './lib/asset-orphan.js';
import { loadConfig, resolveScope } from './lib/config.js';
import { parseIntArg } from './lib/cli-args.js';

// ─── 纯函数（供 CLI / 将来的 MCP 共用） ───

export interface AssetGcParams {
  scope: string;
  /** 只看某个 group（缺省 = 整个 scope） */
  group?: string;
  /** 只清 mtime 早于 N 天的孤儿（给「保留期」留出口，默认 0 = 不限） */
  minAgeDays?: number;
  /** 真删；缺省 dry-run */
  apply?: boolean;
  /** dry-run 时每组列多少条样本 */
  sampleLimit?: number;
}

export interface AssetGcGroupView {
  group: string;
  files: number;
  totalBytes: number;
  orphanCount: number;
  orphanBytes: number;
  /** 前 N 条孤儿（dry-run 用；`--apply` 时是实际删除的清单前缀） */
  sample: { rel: string; bytes: number }[];
  /** 引用了但磁盘上不存在的（破图诊断），不参与删除 */
  danglingRefs: string[];
}

export type AssetGcResult =
  | {
    ok: true;
    scope: string;
    apply: boolean;
    minAgeDays: number;
    scannedGroups: number;
    files: number;
    totalBytes: number;
    orphanCount: number;
    orphanBytes: number;
    groups: AssetGcGroupView[];
    deleted?: number;
    deletedBytes?: number;
    errors?: string[];
    hint?: string;
  }
  | { ok: false; error: string };

const DAY_MS = 86_400_000;

/** 扫（可选删）指定 scope 的孤儿附件。**不做权限/只读判断** —— 调用方负责。 */
export async function executeAssetGc(params: AssetGcParams): Promise<AssetGcResult> {
  try {
    const minAgeDays = Math.max(0, params.minAgeDays ?? 0);
    const sampleLimit = Math.max(1, Math.min(200, params.sampleLimit ?? 20));
    const scan: ScopeOrphanScan = scanScopeOrphans(params.scope, {
      minAgeMs: minAgeDays * DAY_MS,
      ...(params.group ? { group: params.group } : {}),
    });

    const groups: AssetGcGroupView[] = scan.groups.map((report) => ({
      group: report.group,
      files: report.files,
      totalBytes: report.totalBytes,
      orphanCount: report.orphans.length,
      orphanBytes: report.orphanBytes,
      sample: report.orphans.slice(0, sampleLimit).map((file) => ({ rel: file.rel, bytes: file.bytes })),
      danglingRefs: report.danglingRefs,
    }));

    const base = {
      scope: params.scope,
      apply: params.apply === true,
      minAgeDays,
      scannedGroups: scan.groups.length,
      files: scan.files,
      totalBytes: scan.totalBytes,
      orphanCount: scan.orphanCount,
      orphanBytes: scan.orphanBytes,
      groups,
    };

    if (params.apply !== true) {
      return {
        ok: true,
        ...base,
        ...(scan.orphanCount > 0
          ? { hint: '以上仅为扫描结果（dry-run）。确认无误后加 --apply 才会真正删除；assets 没有回收站，删了只能靠备份' }
          : {}),
      };
    }

    const targets = scan.groups.flatMap((report) =>
      report.orphans.map((file) => ({ group: report.group, rel: file.rel })));
    const outcome = deleteOrphans(params.scope, targets);
    return {
      ok: true,
      ...base,
      orphanCount: outcome.deleted,
      orphanBytes: outcome.bytes,
      deleted: outcome.deleted,
      deletedBytes: outcome.bytes,
      ...(outcome.errors.length > 0 ? { errors: outcome.errors } : {}),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();
program.name('assets').showHelpAfterError().description('附件（图片）治理：孤儿扫描与清理（默认 dry-run）');

program
  .command('gc')
  .description('找出没有被任何文档引用的图片（默认只报告，--apply 才删）')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .option('-g, --group <group>', '只处理指定 group（缺省 = 整个 scope）')
  .option('--min-age-days <n>', '只清理 mtime 早于 N 天的孤儿（默认 0 = 不限；给"保留期"留出口）')
  .option('--apply', '真正删除（缺省 dry-run）', false)
  .option('--sample-limit <n>', '每组列多少条样本（1~200，默认 20）')
  .action(async (opts) => {
    const scope = resolveScope(loadConfig(), opts.scope);
    const minAgeDays = opts.minAgeDays !== undefined
      ? parseIntArg(opts.minAgeDays, 0, '--min-age-days', { min: 0, max: 3650 })
      : 0;
    const sampleLimit = opts.sampleLimit !== undefined
      ? parseIntArg(opts.sampleLimit, 20, '--sample-limit', { min: 1, max: 200 })
      : 20;

    const result = await executeAssetGc({
      scope,
      ...(opts.group ? { group: opts.group } : {}),
      minAgeDays,
      apply: opts.apply === true,
      sampleLimit,
    });
    console.log(JSON.stringify(result, null, 2));
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
