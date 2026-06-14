#!/usr/bin/env node
/**
 * search.ts - ki search CLI
 *
 * 语义检索知识库内容（薄封装 mem search）。
 *
 * 用法:
 *   ki search --scope <scope> --query "自然语言查询" [--limit 10] [--threshold 0.0]
 */

import { Command } from 'commander';
import { validateScope } from './lib/scope.js';
import { memSearch, ensureMemAvailable } from './lib/mem-client.js';
import type { MemSearchResult } from './lib/mem-client.js';

// ─── 纯函数（供 MCP / CLI 共享） ───

export type SearchResult =
  | { ok: true; results: MemSearchResult[] }
  | { ok: false; error: string; degraded?: boolean };

export function executeSearch(params: {
  scope: string;
  query: string;
  limit?: number;
  threshold?: number;
  tags?: string;
}): SearchResult {
  try {
    validateScope(params.scope);

    // mem 可用性检测
    const avail = ensureMemAvailable();
    if (!avail.available) {
      return {
        ok: false,
        error: `向量检索暂不可用（${avail.reason || 'mem 未检测到'}）`,
        degraded: true,
      };
    }

    const results = memSearch({
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
  .option('--threshold <threshold>', '相似度阈值（0-1）', '0')
  .option('--tags <tags>', '过滤标签（默认 ki-search）', 'ki-search')
  .action((opts) => {
    const result = executeSearch({
      scope: opts.scope,
      query: opts.query,
      limit: parseInt(opts.limit, 10),
      threshold: parseFloat(opts.threshold) || undefined,
      tags: opts.tags,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
  });

program.parse();
