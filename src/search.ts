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
import { validateScope, getLocalKbDir } from './lib/scope.js';
import { loadConfig, resolveScope } from './lib/config.js';
import { vectorSearch, vectorListTags, ensureVectorAvailable, closeEngine } from './lib/vector-client.js';
import type { VectorSearchResult } from './lib/vector-client.js';
import { getRelationMap } from './lib/relation-map.js';
import { readJson } from './lib/store.js';
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
  /** 文件级 relation（方案 D：basename 去扩展名，可能缺失） */
  relation?: string;
  /** REQ-09：原文是否成功获取 */
  originalRetrieved?: boolean;
  /** REQ-09：原文内容（local KB 文件级原文，未清洗；获取失败时缺失） */
  original?: string;
  /** REQ-09：原文获取失败提示（精简，与 REQ-02 引导去重） */
  originalHint?: string;
  /** REQ-09：同一文件多 chunk 命中去重标记（原文已在前一条返回，本条省略） */
  deduplicated?: boolean;
}

export type SearchResult =
  | { ok: true; scope: string; results: SearchHit[] }
  | { ok: false; error: string; degraded?: boolean };

/** REQ-09：从 local KB 按 (group, relation) 取文件级原文；失败返回 null + hint */
export function fetchOriginal(scope: string, group: string, relation: string): { original: string; hint?: string } | null {
  try {
    const localKbPath = getLocalKbDir(scope, group);
    const localKb = readJson<Record<string, string>>(localKbPath);
    const original = localKb?.[relation] ?? null;
    if (original) return { original };
    // 本地 KB 缺失该 relation → 精简提示（REQ-09 与 REQ-02 引导去重，不重复完整恢复文案）
    return {
      original: '',
      hint: `原文不可用：本地 KB 缺失 relation "${relation}"（可尝试 sync-relation 或 rebuild-vector）`,
    };
  } catch {
    return { original: '', hint: '原文不可用：本地 KB 读取异常' };
  }
}

export async function executeSearch(params: {
  scope?: string;
  query: string;
  limit?: number;
  threshold?: number;
  tags?: string;
  /** REQ-09：是否返回 local KB 文件级原文（默认 false；CLI --original / MCP include_original 显式开启） */
  includeOriginal?: boolean;
}): Promise<SearchResult> {
  try {
    // scope 护栏：default 模式下缺省回退 default，strict 模式下强制显式且须注册
    const scope = resolveScope(loadConfig(), params.scope);
    validateScope(scope);

    // 向量服务可用性检测（REQ-02：传入 scope 触发中断标记前置检测引导）
    const avail = await ensureVectorAvailable(scope);
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
    // includeOriginal 默认 false（不返回原文）；CLI --original / MCP include_original 显式传 true 才返回
    const includeOriginal = params.includeOriginal === true;
    const map = getRelationMap(scope);
    const results: SearchHit[] = raw.map((r) => {
      const hit: SearchHit = { ...r };
      const meta = map.get(r.memoryId);
      if (meta) {
        hit.group = meta.group;
        hit.relation = meta.relation;
      }
      // REQ-09：原文召回（显式开启才执行）——命中任一 chunk memoryId → 返回文件级原文；多 chunk 命中去重
      // 原文不可用（含 relation 反查缺失）时降级：以向量文档 content 兜底，并提示没有原文
      if (includeOriginal) {
        if (meta?.group && meta.relation) {
          const fetched = fetchOriginal(scope, meta.group, meta.relation);
          if (fetched?.original) {
            hit.originalRetrieved = true;
            hit.original = fetched.original;
          } else {
            hit.originalRetrieved = false;
            // 兜底：返回向量文档作为原文，并提示无原文（REQ 原文不可用降级）
            hit.original = r.content;
            hit.originalHint = fetched?.hint ?? '原文不可用：已降级返回向量文档';
          }
        } else {
          // relation 反查缺失：无 local KB 定位，无法取文件级原文 → 向量文档兜底
          hit.originalRetrieved = false;
          hit.original = r.content;
          hit.originalHint = '原文不可用：无法定位本地 KB 原文，已降级返回向量文档';
        }
      }
      return hit;
    });

    // REQ-09：同一文件多 chunk 命中去重（保留首个命中，其余 original 置空避免重复返回）
    if (includeOriginal) {
      const seen = new Set<string>();
      for (const hit of results) {
        const key = hit.group && hit.relation ? `${hit.group}/${hit.relation}` : '';
        if (key && seen.has(key)) {
          // 同一文件多 chunk 命中：原文已在前一条返回，本条省略 original；
          // originalRetrieved 保持 true（非失败），并标注 deduplicated 供消费方区分
          delete hit.original;
          hit.originalRetrieved = true;
          hit.deduplicated = true;
        } else if (key) {
          seen.add(key);
        }
      }
    }

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
  .argument('[query]', '自然语言查询文本（位置参数，REQ-12；--query 保留兼容）')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .option('-q, --query <query>', '自然语言查询文本')
  .option('--limit <limit>', '返回条数上限', '10')
  .option('--threshold <threshold>', '相似度阈值（融合得分，略过低于此值的命中；默认 0 不过滤）', '0')
  .option('--tags <tags>', '过滤标签（不传则搜索全部；多个用逗号分隔，OR 组合）')
  .option('--original', '返回 local KB 文件级原文（默认不返回，仅返回向量匹配数据，REQ-09）')
  .action(async (query: string | undefined, opts) => {
    const finalQuery = query ?? opts.query;
    if (!finalQuery) {
      console.error('错误: 缺少查询文本。用法: ki search <query> 或 ki search --query <query>');
      process.exit(1);
    }
    // NEG-02：非法数值显式警告并回退（避免 NaN 静默丢光结果）
    const parsedThreshold = parseFloatArg(opts.threshold, undefined, '--threshold');
    const result = await executeSearch({
      scope: opts.scope,
      query: finalQuery,
      limit: parseIntArg(opts.limit, 10, '--limit', { min: 1 }),
      threshold: parsedThreshold,
      tags: opts.tags,
      includeOriginal: opts.original === true,
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
