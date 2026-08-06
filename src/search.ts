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
import { loadConfig, resolveScope } from './lib/config.js';
import { vectorSearch, vectorListTags, ensureVectorAvailable, closeEngine } from './lib/vector-client.js';
import type { VectorSearchResult } from './lib/vector-client.js';
import { getRelationMap } from './lib/relation-map.js';
import { parseIntArg, parseFloatArg } from './lib/cli-args.js';

/**
 * tag 优先级：默认搜全部时，ki-search（内容）优先，其次 ki-relation / ki-path
 * 路径解析辅助向量，其余自定义 tag 垫底。
 */
const TAG_PRIORITY = ['ki-search', 'ki-relation', 'ki-path'];

function tagPriority(tag: string): number {
  const idx = TAG_PRIORITY.indexOf(tag);
  return idx === -1 ? TAG_PRIORITY.length : idx;
}

// ─── 纯函数（供 MCP / CLI 共享） ───

/** 搜索结果：附带 memoryId 反查的原文定位信息 */
export interface SearchHit extends VectorSearchResult {
  /** 所属 Group 路径（relations-cache 反查，可能缺失） */
  group?: string;
  /** 原文全文（relations-cache 的 hot_relation.text，可能缺失） */
  relation?: string;
}

export type SearchResult =
  | { ok: true; scope: string; results: SearchHit[] }
  | { ok: false; error: string; degraded?: boolean };

export async function executeSearch(params: {
  scope?: string;
  query: string;
  limit?: number;
  threshold?: number;
  tags?: string;
}): Promise<SearchResult> {
  try {
    // scope 护栏：default 模式下缺省回退 default，strict 模式下强制显式且须注册
    const scope = resolveScope(loadConfig(), params.scope);
    validateScope(scope);

    // 向量服务可用性检测
    const avail = await ensureVectorAvailable();
    if (!avail.available) {
      return {
        ok: false,
        error: `向量检索暂不可用（${avail.reason || '未检测到向量服务'}）`,
        degraded: true,
      };
    }

    // 显式传 tags → 单次查询（多 tag OR，复用 vectorSearch 的 buildScopeTagFilter）。
    // 不传 tags（默认搜全部）→ 按 tag 分查：每个 tag 最多取 limit 条（组内按 score 降序），
    // 再按 TAG_PRIORITY 排序（ki-search 内容优先），总条数 = 各 tag 上限之和。
    let raw: VectorSearchResult[];
    if (params.tags) {
      raw = await vectorSearch({
        scope,
        query: params.query,
        limit: params.limit ?? 10,
        threshold: params.threshold,
        tags: params.tags,
      });
    } else {
      const { tags } = await vectorListTags({ scope });
      const perTag: { priority: number; hits: VectorSearchResult[] }[] = [];
      for (const t of tags) {
        const hits = await vectorSearch({
          scope,
          query: params.query,
          limit: params.limit ?? 10,
          threshold: params.threshold,
          tags: t.tag,
        });
        if (hits.length > 0) perTag.push({ priority: tagPriority(t.tag), hits });
      }
      perTag.sort((a, b) => a.priority - b.priority);
      raw = perTag.flatMap((p) => p.hits);
    }

    // 按 memoryId 反查 relations-cache：命中附加 group / relation 定位原文
    // （getRelationMap 带 TTL+mtime 缓存：首次构建 O(N)，后续 O(1)）
    const map = getRelationMap(scope);
    const results: SearchHit[] = raw.map((r) => {
      const hit: SearchHit = { ...r };
      const meta = map.get(r.memoryId);
      if (meta) {
        hit.group = meta.group;
        hit.relation = meta.relation;
      }
      return hit;
    });

    return { ok: true, scope, results };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();

program
  .name('search')
  .showHelpAfterError()
  .description('语义检索知识库内容')
  .option('--scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .requiredOption('--query <query>', '自然语言查询文本')
  .option('--limit <limit>', '返回条数上限', '10')
  .option('--threshold <threshold>', '相似度阈值（融合得分，略过低于此值的命中；默认 0 不过滤）', '0')
  .option('--tags <tags>', '过滤标签（不传则搜索全部；多个用逗号分隔，OR 组合）')
  .action(async (opts) => {
    // NEG-02：非法数值显式警告并回退（避免 NaN 静默丢光结果）
    const parsedThreshold = parseFloatArg(opts.threshold, undefined, '--threshold');
    const result = await executeSearch({
      scope: opts.scope,
      query: opts.query,
      limit: parseIntArg(opts.limit, 10, '--limit', { min: 1 }),
      threshold: parsedThreshold,
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
