#!/usr/bin/env node
/**
 * store.ts - ki store CLI（src 版）
 *
 * 存储文本到向量索引（Vector Adapter / zvec）。
 *
 * 用法:
 *   ki store --scope <scope> --text "存储内容" [--keywords "词1,词2"] [--tags "tag1"]
 */

import { Command } from 'commander';
import { validateScope } from './lib/scope.js';
import { loadConfig, resolveScope } from './lib/config.js';
import { vectorStore, ensureVectorAvailable, closeEngine } from './lib/vector-client.js';

// ─── 纯函数（供 MCP / CLI 共享） ───

export type StoreResult =
  | { ok: true; docId: string }
  | { ok: false; error: string };

export async function executeStore(params: {
  scope?: string;
  text: string;
  tags?: string;
}): Promise<StoreResult> {
  try {
    // scope 护栏：default 模式下缺省回退 default，strict 模式下强制显式且须注册
    const scope = resolveScope(loadConfig(), params.scope);
    validateScope(scope);

    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      return {
        ok: false,
        error: `向量存储暂不可用（${avail.reason || '未检测到向量服务'}）`,
      };
    }

    const result = await vectorStore({
      scope,
      text: params.text,
      tags: params.tags ?? 'ki-search',
    });

    return { ok: true, docId: result.docId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();

program
  .name('store')
  .description('存储文本到向量索引')
  .option('--scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .requiredOption('--text <text>', '待向量化文本')
  .option('--tags <tags>', '标签（默认 ki-search）', 'ki-search')
  .action(async (opts) => {
    const result = await executeStore({
      scope: opts.scope,
      text: opts.text,
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
