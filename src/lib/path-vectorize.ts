/**
 * path-vectorize.ts —— 路径向量索引写入模块（Vector Adapter 版）
 *
 * 为 ki 命令的 group 路径和 relation 名称提供向量语义索引能力。
 * 写入 tag=ki-path 和 tag=ki-relation 的向量记录，供 path-search.ts 查询时兜底。
 *
 * 设计要点：
 *   - 路径层级用空格分隔存储（禁止用 /），如 "告警系统设计 告警收敛机制"
 *   - 保留根节点名，保证 extractPathFromContent 能还原完整路径
 *   - 底层走 vector-client（zvec 基座），替换原 mem CLI spawn；写入均为 async
 *   - 写入失败不阻塞主流程，errors 仅记录日志
 */

import { vectorStore, vectorBulkStore, vectorSearch, vectorDelete } from './vector-client.js';

// ─── 类型 ───

export interface PathVectorizeEntry {
  /** 向量文本内容（空格分隔格式） */
  text: string;
  /** 标签：ki-path 或 ki-relation */
  tag: 'ki-path' | 'ki-relation';
  /** scope */
  scope: string;
}

export interface PathVectorizeOptions {
  /** 保留字段（vector 版不再使用超时参数，仅为签名兼容） */
  timeoutMs?: number;
}

export interface PathVectorizeResult {
  /** text → docId（成功条目） */
  ok: Map<string, string>;
  errors: { text: string; error: string }[];
}

// ─── 文本构建 ───

/**
 * 构建 Group 路径向量文本
 *
 * 格式：路径层级用空格分隔（含根节点） | 关键词
 * @example buildGroupPathContent("BK-Monitor-Wiki/告警系统设计/告警收敛机制", ["告警收敛","降噪"])
 *          → "BK-Monitor-Wiki 告警系统设计 告警收敛机制 | 告警收敛,降噪"
 */
export function buildGroupPathContent(
  groupPath: string,
  keywords: string[]
): string {
  // 保留根节点，整条路径用空格分隔，确保 extractPathFromContent 能还原完整路径
  const pathWords = groupPath.split('/').filter(Boolean).join(' ');
  const kw = keywords.filter(Boolean).join(',');
  return kw ? `${pathWords} | ${kw}` : pathWords;
}

/**
 * 构建 Relation 向量文本
 *
 * 格式：Relation 名称 | Group: 路径层级（空格分隔，含根节点）| 关键词
 * @example buildRelationContent("告警收敛服务", "BK-Monitor-Wiki/告警系统设计/告警处理服务", ["收敛","去重"])
 *          → "告警收敛服务 | Group: BK-Monitor-Wiki 告警系统设计 告警处理服务 | 收敛,去重"
 */
export function buildRelationContent(
  relationText: string,
  groupPath: string,
  keywords: string[]
): string {
  // 保留根节点，保证路径可还原
  const pathWords = groupPath.split('/').filter(Boolean).join(' ');
  const kw = keywords.filter(Boolean).join(',');
  const groupPart = pathWords ? ` | Group: ${pathWords}` : '';
  const kwPart = kw ? ` | ${kw}` : '';
  return `${relationText}${groupPart}${kwPart}`;
}

// ─── 批量存储 ───

/**
 * 批量存储路径向量（走 vectorBulkStore，一次 embed 多条）。
 *
 * 按 scope 分组后逐组批量写入，消除逐条 embed 开销。
 */
export async function bulkStorePaths(
  entries: PathVectorizeEntry[],
  _options?: PathVectorizeOptions
): Promise<PathVectorizeResult> {
  const ok = new Map<string, string>();
  const errors: { text: string; error: string }[] = [];

  if (entries.length === 0) return { ok, errors };

  // 按 scope 分组（vectorBulkStore 一次只能指定一个 scope）
  const byScope = new Map<string, PathVectorizeEntry[]>();
  for (const entry of entries) {
    const list = byScope.get(entry.scope) || [];
    list.push(entry);
    byScope.set(entry.scope, list);
  }

  for (const [scope, scopeEntries] of byScope) {
    try {
      const result = await vectorBulkStore({
        scope,
        entries: scopeEntries.map((e) => ({ text: e.text, tags: e.tag })),
      });
      for (const item of result.results) {
        const entry = scopeEntries[item.index];
        if (!entry) continue;
        if (item.success && item.memoryId) {
          ok.set(entry.text, item.memoryId);
        } else {
          errors.push({ text: entry.text, error: item.error || 'unknown' });
        }
      }
    } catch (err) {
      const errMsg = `[path-vectorize] bulk-store 失败: ${(err as Error).message}`;
      for (const entry of scopeEntries) {
        errors.push({ text: entry.text, error: errMsg });
      }
    }
  }

  return { ok, errors };
}

// ─── 单条存储 ───

/**
 * 异步单条存储路径向量（sync-relation / incremental 场景）。
 */
export async function storeOnePathAsync(
  entry: PathVectorizeEntry,
  _options?: PathVectorizeOptions
): Promise<{ ok: true; memoryId: string } | { ok: false; error: string }> {
  try {
    const { docId } = await vectorStore({
      scope: entry.scope,
      text: entry.text,
      tags: entry.tag,
    });
    return { ok: true, memoryId: docId };
  } catch (err) {
    return { ok: false, error: `[path-vectorize] store 失败: ${(err as Error).message}` };
  }
}

/**
 * 单条存储路径向量（storeOnePathAsync 别名，保持向后兼容的调用方签名）。
 */
export const storeOnePath = storeOnePathAsync;

// ─── 删除 ───

/**
 * 删除路径向量：先按 tag 语义搜索命中精确同文本的条目，再按 docId 删除。
 */
export async function deletePathVector(
  text: string,
  tag: 'ki-path' | 'ki-relation',
  scope: string,
  _options?: PathVectorizeOptions
): Promise<{ ok: boolean; error?: string }> {
  try {
    const results = await vectorSearch({ scope, query: text, tags: tag, limit: 5 });
    // 精确文本匹配才删除，避免误删近似条目
    const match = results.find((r) => r.content === text);
    if (!match) {
      return { ok: true }; // 没有精确匹配，视为已删除
    }
    const del = await vectorDelete({ scope, ids: [match.memoryId] });
    if (del.errors.length > 0) {
      return { ok: false, error: del.errors[0].reason };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `[path-vectorize] delete 失败: ${(err as Error).message}` };
  }
}
