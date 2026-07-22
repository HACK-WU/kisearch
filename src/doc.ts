#!/usr/bin/env node
/**
 * doc.ts - ki doc CLI（src 版）
 *
 * 向量层文档的查看与删除（管理面）。
 *
 * 用法:
 *   ki doc list   [--scope <scope>] [--limit <n>] [--tags tag1,tag2] [--full]
 *   ki doc delete <docid...> [--scope <scope>] --yes
 *
 * 说明:
 *   - list 顺序不保证（引擎无排序 / 时间字段），--limit 返回任意顺序前 N 条
 *   - delete 仅删向量层单条记忆；按 scope 护栏，只删归属该 scope 的 docid，
 *     跨 scope 的 docid 列入 scopeMismatch 跳过（docid = sha256(text+scope)，一条只属一个 scope）
 *   - 若该 docid 来自 scan-kb/sync-relation，KB 层 relations-cache 的 memoryId 会变悬空引用
 *     （删关系请用 ki delete-relation）
 */

import { Command } from 'commander';
import {
  vectorListDocs,
  vectorFetchDocs,
  vectorDelete,
  ensureVectorAvailable,
  closeEngine,
  type VectorDocInfo,
} from './lib/vector-client.js';

const PREVIEW_LEN = 200;

// ─── 辅助 ───

/** 解析逗号分隔 tags；空 → undefined（不按 tag 过滤） */
function parseTags(raw?: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const arr = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  return arr.length > 0 ? arr : undefined;
}

/** 截断内容预览 */
function truncate(content: string): string {
  if (content.length <= PREVIEW_LEN) return content;
  return content.slice(0, PREVIEW_LEN) + '…';
}

function shapeDocs(docs: VectorDocInfo[], full: boolean): VectorDocInfo[] {
  if (full) return docs;
  return docs.map((d) => ({ ...d, content: truncate(d.content) }));
}

// ─── 纯函数（供 CLI 共享） ───

export type DocListResult =
  | { ok: true; scope: string; tags: string[] | 'all'; count: number; docs: VectorDocInfo[] }
  | { ok: false; error: string; degraded?: boolean };

export async function executeDocList(params: {
  scope: string;
  tags?: string[];
  limit?: number;
  full?: boolean;
}): Promise<DocListResult> {
  try {
    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      return { ok: false, error: `向量服务暂不可用（${avail.reason || '未检测到向量服务'}）`, degraded: true };
    }
    const docs = await vectorListDocs({
      scope: params.scope,
      tags: params.tags,
      limit: params.limit ?? 10,
    });
    return {
      ok: true,
      scope: params.scope,
      tags: params.tags ?? 'all',
      count: docs.length,
      docs: shapeDocs(docs, params.full ?? false),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export type DocDeleteResult =
  | { ok: true; scope: string; requested: number; deleted: number; errors: { id: string; reason: string }[] }
  | { ok: false; error: string; requireConfirm?: boolean; willDelete?: VectorDocInfo[]; notFound?: string[]; scopeMismatch?: VectorDocInfo[] };

export async function executeDocDelete(params: {
  scope: string;
  ids: string[];
  yes: boolean;
}): Promise<DocDeleteResult> {
  try {
    if (params.ids.length === 0) {
      return { ok: false, error: '未提供 docid' };
    }
    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      return { ok: false, error: `向量服务暂不可用（${avail.reason || '未检测到向量服务'}）` };
    }

    // 删前取回，用于预览 / 核对（docid 不透明，防删错）
    const found = await vectorFetchDocs(params.ids);
    const foundIds = new Set(found.map((d) => d.docId));
    const notFound = params.ids.filter((id) => !foundIds.has(id));
    // scope 护栏：docid = sha256(text+scope)，一条 doc 只属于一个 scope。
    // 只删归属目标 scope 的；不属于的列入 scopeMismatch 跳过（防跨 scope 误删）。
    const inScope = found.filter((d) => d.scope === params.scope);
    const scopeMismatch = found.filter((d) => d.scope !== params.scope);

    // 未确认：拒绝并回显将删项预览
    if (!params.yes) {
      const extra = [
        notFound.length ? `${notFound.length} 条未找到` : '',
        scopeMismatch.length ? `${scopeMismatch.length} 条不属于 scope "${params.scope}"（已跳过）` : '',
      ].filter((s) => s.length > 0).join('，');
      return {
        ok: false,
        error: `破坏性操作需 --yes 确认：将删除 ${inScope.length} 条${extra ? `（${extra}）` : ''}`,
        requireConfirm: true,
        willDelete: inScope.map((d) => ({ ...d, content: truncate(d.content) })),
        notFound,
        scopeMismatch: scopeMismatch.map((d) => ({ ...d, content: truncate(d.content) })),
      };
    }

    // 确认后：只删归属本 scope 的 docid（scope 护栏在此强制生效）
    const inScopeIds = inScope.map((d) => d.docId);
    if (inScopeIds.length === 0) {
      return { ok: true, scope: params.scope, requested: params.ids.length, deleted: 0, errors: [] };
    }
    const res = await vectorDelete({ scope: params.scope, ids: inScopeIds });
    return {
      ok: true,
      scope: params.scope,
      requested: params.ids.length,
      deleted: res.deleted,
      errors: res.errors,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();
program.name('doc').description('向量层文档查看与删除（管理面）');

program
  .command('list')
  .description('列出指定 scope 下文档（顺序不保证）')
  .option('--scope <scope>', '项目隔离标识（省略用 default）', 'default')
  .option('--limit <limit>', '返回条数上限', '10')
  .option('--tags <tags>', '过滤标签，逗号分隔多值（默认 ki-search）', 'ki-search')
  .option('--full', '显示完整内容（默认截断预览 200 字）', false)
  .action(async (opts) => {
    const result = await executeDocList({
      scope: opts.scope,
      tags: parseTags(opts.tags),
      limit: parseInt(opts.limit, 10),
      full: !!opts.full,
    });
    console.log(JSON.stringify(result, null, 2));
    await closeEngine();
    if (!result.ok) process.exit(1);
  });

program
  .command('delete')
  .description('按 docid 删除向量层记忆（可多个）')
  .argument('<docid...>', '一个或多个 docid')
  .option('--scope <scope>', '项目隔离标识（护栏：仅删归属该 scope 的 docid，跨 scope 跳过）', 'default')
  .option('--yes', '确认执行删除（缺省则仅预览并拒绝）', false)
  .action(async (docids: string[], opts) => {
    const result = await executeDocDelete({
      scope: opts.scope,
      ids: docids,
      yes: !!opts.yes,
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
