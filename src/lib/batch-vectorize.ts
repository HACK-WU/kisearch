/**
 * batch-vectorize.ts —— S-03：批量向量化 entries（Vector Adapter 版）
 *
 * 设计要点：
 *   - bulkVectorize（推荐）：一次 vectorBulkStore 写入全部条目，共享一次 engine + 批量 embed
 *   - batchVectorize（兼容）：串行逐条 vectorizeOne，用于增量等小批量场景
 *   - vectorizeOne：单条向量化，增量 modify 使用
 *   - deleteMemory：按 docId 删除（增量 modify/delete 使用），需传 scope
 *   - 底层走 vector-client（zvec 基座），替换原 mem CLI spawn；写入均为 async
 *   - doc id 由 vector-client 用 sha256(fullText+scope) 确定性生成，返回真实 docId
 *   - 失败条目记入 errors，不中断整体
 *   - 不处理 action=delete 条目（调用方过滤）
 */

import type { ScanResultEntry } from './ai-results.js';
import { vectorStore, vectorBulkStore, vectorDelete } from './vector-client.js';

const VECTORIZE_TAG = 'ki-search';

export interface BatchVectorizeResult {
  /** path → docId（成功条目） */
  ok: Map<string, string>;
  errors: { path: string; error: string }[];
}

export interface BatchVectorizeOptions {
  /** 保留字段（vector 版不再使用超时参数，仅为签名兼容） */
  timeoutMs?: number;
  /** 保留字段（vector 版不再使用 category，仅为签名兼容） */
  category?: string;
  /** 每完成一条时回调，用于增量保存进度 */
  onProgress?: (completed: { path: string; memoryId: string }[], failedCount: number) => void;
}

/**
 * 构造向量化的 content 文本
 *   [摘要] ...
 *   [关键词] k1, k2
 *   [路径] xxx
 */
export function buildVectorizeContent(entry: ScanResultEntry): string {
  const kw = (entry.keywords || []).join(', ');
  return `[摘要] ${entry.summary}\n[关键词] ${kw}\n[路径] ${entry.path}`;
}

/**
 * 单条向量化
 * 内部使用，便于 S-06 modify/add 单条调用
 */
export async function vectorizeOne(
  entry: ScanResultEntry,
  scope: string,
  _options: BatchVectorizeOptions = {}
): Promise<{ ok: true; memoryId: string } | { ok: false; error: string }> {
  const content = buildVectorizeContent(entry);

  try {
    const { docId } = await vectorStore({ scope, text: content, tags: VECTORIZE_TAG });
    return { ok: true, memoryId: docId };
  } catch (err) {
    return { ok: false, error: `向量存储失败: ${(err as Error).message}` };
  }
}

/**
 * 批量向量化（串行逐条）
 * @param entries  需要向量化的条目（调用方应预先过滤掉 action=delete）
 * @param scope    目标 scope
 * @returns        ok Map（成功）+ errors（失败明细）
 */
export async function batchVectorize(
  entries: ScanResultEntry[],
  scope: string,
  options: BatchVectorizeOptions = {}
): Promise<BatchVectorizeResult> {
  const ok = new Map<string, string>();
  const errors: { path: string; error: string }[] = [];

  for (const entry of entries) {
    if (entry.action === 'delete') {
      // 调用方未过滤，跳过以容错
      continue;
    }
    const r = await vectorizeOne(entry, scope, options);
    if (r.ok) {
      ok.set(entry.path, r.memoryId);
    } else {
      errors.push({ path: entry.path, error: r.error });
    }
  }

  return { ok, errors };
}

/**
 * 删除单条向量（S-06 modify/delete 路径使用）
 *
 * @param memoryId  doc id（= 存储时 vector-client 返回的 docId）
 * @param scope     目标 scope（vectorDelete 需按 scope 定位）
 */
export async function deleteMemory(
  memoryId: string,
  scope: string,
  _options: BatchVectorizeOptions = {}
): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await vectorDelete({ scope, ids: [memoryId] });
    if (result.errors.length > 0) {
      return { ok: false, error: `向量删除 ${memoryId} 失败: ${result.errors[0].reason}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `向量删除 ${memoryId} 失败: ${(err as Error).message}` };
  }
}

/**
 * 批量向量化（使用 vectorBulkStore）
 *
 * 一次调用完成全部条目的 embed + 写入，共享一次 engine。
 *
 * @param entries  需要向量化的条目（调用方应预先过滤掉 action=delete）
 * @param scope    目标 scope
 * @param options  选项
 * @returns        ok Map（path → 真实 docId）+ errors（失败明细）
 */
export async function bulkVectorize(
  entries: ScanResultEntry[],
  scope: string,
  options: BatchVectorizeOptions = {}
): Promise<BatchVectorizeResult> {
  const ok = new Map<string, string>();
  const errors: { path: string; error: string }[] = [];

  if (entries.length === 0) return { ok, errors };

  try {
    const result = await vectorBulkStore({
      scope,
      entries: entries.map((e) => ({ text: buildVectorizeContent(e), tags: VECTORIZE_TAG })),
    });
    for (const item of result.results) {
      const entry = entries[item.index];
      if (!entry) continue;
      if (item.success && item.memoryId) {
        ok.set(entry.path, item.memoryId);
      } else {
        errors.push({ path: entry.path, error: item.error || 'unknown error' });
      }
    }
  } catch (err) {
    const errMsg = `bulk-store 失败: ${(err as Error).message}`;
    for (const entry of entries) {
      errors.push({ path: entry.path, error: errMsg });
    }
    return { ok, errors };
  }

  // 完成后一次性回调（供调用方增量保存进度）
  if (options.onProgress) {
    const completed = [...ok.entries()].map(([path, memoryId]) => ({ path, memoryId }));
    options.onProgress(completed, errors.length);
  }

  return { ok, errors };
}
