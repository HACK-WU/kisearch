#!/usr/bin/env node
/**
 * search.ts - ki search CLI（src 版）
 *
 * 语义检索知识库内容（Vector Adapter / zvec）。
 *
 * 用法:
 *   ki search --scope <scope> --query "自然语言查询" [--limit 10] [--threshold 0.0]
 */

import { Command } from 'commander';
import { validateScope } from './lib/scope.js';
import { vectorSearch, ensureVectorAvailable, closeEngine } from './lib/vector-client.js';
import type { VectorSearchResult } from './lib/vector-client.js';

// ─── 纯函数（供 MCP / CLI 共享） ───

export type SearchResult =
  | { ok: true; results: VectorSearchResult[] }
  | { ok: false; error: string; degraded?: boolean };

export async function executeSearch(params: {
  scope: string;
  query: string;
  limit?: number;
  threshold?: number;
  tags?: string;
}): Promise<SearchResult> {
  try {
    validateScope(params.scope);

    // 向量服务可用性检测
    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      return {
        ok: false,
        error: `向量检索暂不可用（${avail.reason || '未检测到向量服务'}）`,
        degraded: true,
      };
    }

    const results = await vectorSearch({
      scope: params.scope,
      query: params.query,
      limit: params.limit ?? 10,
      threshold: params.threshold,
      tags: params.tags ?? 'ki-search',
    });

    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();

program
  .name('search')
  .description('语义检索知识库内容')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .requiredOption('--query <query>', '自然语言查询文本')
  .option('--limit <limit>', '返回条数上限', '10')
  .option('--threshold <threshold>', '相似度阈值（融合得分，略过低于此值的命中；默认 0 不过滤）', '0')
  .option('--tags <tags>', '过滤标签（默认 ki-search）', 'ki-search')
  .action(async (opts) => {
    // parseFloat 遇非法值返回 NaN，而 NaN ?? undefined 仍为 NaN（?? 只拦 null/undefined），
    // 会使下游 score >= NaN 恒为 false → 静默丢光全部结果。故非有限值一律视为不过滤。
    const parsedThreshold = parseFloat(opts.threshold);
    const result = await executeSearch({
      scope: opts.scope,
      query: opts.query,
      limit: parseInt(opts.limit, 10),
      threshold: Number.isFinite(parsedThreshold) ? parsedThreshold : undefined,
      tags: opts.tags,
    });
    console.log(JSON.stringify(result, null, 2));
    // CLI per-call：关闭 engine（terminate worker + 释放 LOCK），否则进程无法退出
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
