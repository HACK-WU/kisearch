#!/usr/bin/env node
/**
 * bulk-store.ts - ki bulk_store CLI（src 版）
 *
 * 批量存储文本到向量索引（Vector Adapter / zvec）。
 *
 * 用法:
 *   ki bulk_store --scope <scope> --input /path/to/batch.json
 *
 * batch.json 格式:
 *   [
 *     { "text": "内容1", "keywords": "词1,词2", "tags": "ki-search" },
 *     { "text": "内容2", "keywords": "词3" }
 *   ]
 */

import { Command } from 'commander';
import fs from 'fs';
import { validateScope } from './lib/scope.js';
import { vectorBulkStore, ensureVectorAvailable, closeEngine } from './lib/vector-client.js';
import type { BulkStoreItemResult } from './lib/vector-client.js';

// ─── 纯函数（供 MCP / CLI 共享） ───

export type BulkStoreResult =
  | { ok: true; total: number; succeeded: number; failed: number; results: BulkStoreItemResult[] }
  | { ok: false; error: string };

export async function executeBulkStore(params: {
  scope: string;
  inputFile: string;
}): Promise<BulkStoreResult> {
  try {
    validateScope(params.scope);

    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      return {
        ok: false,
        error: `向量存储暂不可用（${avail.reason || '未检测到向量服务'}）`,
      };
    }

    // 读取并校验输入文件
    if (!fs.existsSync(params.inputFile)) {
      return { ok: false, error: `输入文件不存在: ${params.inputFile}` };
    }

    let entries: { text: string; tags?: string; keywords?: string[] }[];
    try {
      const raw = JSON.parse(fs.readFileSync(params.inputFile, 'utf-8'));
      if (!Array.isArray(raw)) {
        return { ok: false, error: '输入文件必须是 JSON 数组' };
      }
      entries = raw.map((item: any, i: number) => {
        if (!item.text || typeof item.text !== 'string') {
          throw new Error(`第 ${i} 条缺少 text 字段`);
        }
        return {
          text: item.text,
          tags: item.tags || 'ki-search',
          keywords: item.keywords
            ? (typeof item.keywords === 'string'
              ? item.keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
              : item.keywords)
            : undefined,
        };
      });
    } catch (err) {
      return { ok: false, error: `输入文件解析失败: ${(err as Error).message}` };
    }

    const result = await vectorBulkStore({ scope: params.scope, entries });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();

program
  .name('bulk_store')
  .description('批量存储文本到向量索引')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .requiredOption('--input <file>', '批量数据 JSON 文件路径')
  .action(async (opts) => {
    const result = await executeBulkStore({
      scope: opts.scope,
      inputFile: opts.input,
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
