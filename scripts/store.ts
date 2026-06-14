#!/usr/bin/env node
/**
 * store.ts - ki store CLI
 *
 * 存储文本到向量索引（薄封装 mem store）。
 *
 * 用法:
 *   ki store --scope <scope> --text "存储内容" [--keywords "词1,词2"] [--tags "tag1,tag2"]
 */

import { Command } from 'commander';
import { validateScope } from './lib/scope.js';
import { memStore, ensureMemAvailable } from './lib/mem-client.js';

// ─── 纯函数（供 MCP / CLI 共享） ───

export type StoreResult =
  | { ok: true; memoryId: string }
  | { ok: false; error: string };

export function executeStore(params: {
  scope: string;
  text: string;
  tags?: string;
}): StoreResult {
  try {
    validateScope(params.scope);

    const avail = ensureMemAvailable();
    if (!avail.available) {
      return {
        ok: false,
        error: `向量存储暂不可用（${avail.reason || 'mem 未检测到'}）`,
      };
    }

    const result = memStore({
      scope: params.scope,
      text: params.text,
      tags: params.tags ?? 'ki-search',
    });

    return { ok: true, memoryId: result.memoryId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();

program
  .name('store')
  .description('存储文本到向量索引')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .requiredOption('--text <text>', '待向量化文本')
  .option('--tags <tags>', '逗号分隔 tags', 'ki-search')
  .action((opts) => {
    const result = executeStore({
      scope: opts.scope,
      text: opts.text,
      tags: opts.tags,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
  });

program.parse();
