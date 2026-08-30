#!/usr/bin/env node
/**
 * search.ts - ki search CLI（src 版）
 *
 * 语义检索知识库内容（Vector Adapter / zvec）。
 *
 * 用法:
 *   ki search --scope <scope> --query "自然语言查询" [--limit 10] [--threshold 0.0]
 *   ki search --scope a,b "查询"   # 多 scope 聚合检索（逗号分隔，结果统一排序）
 */

import { Command } from 'commander';
import { validateScope, parseScopes, getLocalKbDir } from './lib/scope.js';
import { loadConfig, resolveScope, getScopeMode } from './lib/config.js';
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
  /** 命中所属 scope（多 scope 检索时标注来源；单 scope 不额外标注） */
  scope?: string;
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
  /** 文档级自定义标签全量（来自 relations-cache relation.tags 反查；缺省无自定义 tag） */
  tags?: string[];
}

export type SearchResult =
  | {
      ok: true;
      scope: string;
      /** 多 scope 检索时实际检索的 scope 列表（单 scope 不返回，向后兼容） */
      scopes?: string[];
      results: SearchHit[];
      /** 多 scope 下被跳过的 scope 及原因（合法但未注册等；无跳过时不返回） */
      skipped?: { scope: string; reason: string }[];
    }
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
      hint: `原文不可用：本地 KB 缺失 relation "${relation}"（可尝试 sync-relation 或 ki restore ${scope} --rebuild-vector）`,
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
    // scope 解析（支持逗号分隔多 scope）：去空格/去重/保序，逐个字符集校验（非法快速失败）
    const config = loadConfig();
    const parsed = parseScopes(params.scope);
    const multi = parsed.length > 1;

    // scope 护栏：
    //  - 单 scope：保持现状（default 模式缺省回退 default；strict 未注册 fail-loud）
    //  - 多 scope：strict 未注册 → 跳过+提示（容忍个别 scope 配置缺失，不阻塞其余检索）
    let scopes: string[];
    const skipped: { scope: string; reason: string }[] = [];
    if (!multi) {
      // 单段但含空段（如 'a,'）时用归一化结果，与多 scope 解析语义一致；
      // 解析为空（未传/纯空白）才回退原始参数走缺省/必填校验（保持现状）
      const singleRaw = parsed.length === 1 ? parsed[0] : params.scope;
      const scope = resolveScope(config, singleRaw);
      validateScope(scope);
      scopes = [scope];
    } else {
      const strict = getScopeMode(config) === 'strict';
      const effective: string[] = [];
      for (const s of parsed) {
        if (strict && !Object.prototype.hasOwnProperty.call(config.scopes, s)) {
          skipped.push({ scope: s, reason: '未注册（scopeMode=strict，不在配置 scopes 白名单）' });
          continue;
        }
        effective.push(s);
      }
      if (effective.length === 0) {
        return {
          ok: false,
          error: `无可检索的 scope：${skipped.map((k) => `${k.scope}（${k.reason}）`).join('；')}`,
        };
      }
      scopes = effective;
    }

    // 向量服务可用性检测（单集合共享：以首个 scope 触发中断标记前置检测引导）
    const avail = await ensureVectorAvailable(scopes[0]);
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
    // 多 scope：单次查询 + scope OR 过滤（embedding 仅 1 次）；无 tags 时对各 scope tag 并集分组限额。
    let raw: VectorSearchResult[];
    if (params.tags) {
      raw = await vectorSearch({
        scopes,
        query: params.query,
        limit: params.limit ?? 10,
        threshold: params.threshold,
        tags: params.tags,
      });
    } else {
      const tagUnion = new Map<string, number>();
      for (const s of scopes) {
        const { tags } = await vectorListTags({ scope: s });
        for (const t of tags) tagUnion.set(t.tag, (tagUnion.get(t.tag) ?? 0) + t.count);
      }
      const tagNames = [...tagUnion.keys()];
      if (tagNames.length === 0) {
        raw = [];
      } else {
        // 单次查询（多 tag OR 过滤）：embedding 只做 1 次（逐 tag 分查会对同一 query
        // 重复 embedding N 次，tag 多时线性放大检索延迟）。topk 按 tag 数放大保障
        // 每 tag 召回上限，查询后按 tag 分组限额 + TAG_PRIORITY 排序。
        // ⚠️ 与原逐 tag 分查近似等价：topk 为全局分配，极端场景（单 tag 命中数
        // 超过 limit×N 且 score 全面占优）下其他 tag 可能被挤出——多数场景因下游
        // (scope, group, relation) 去重（同文档多 tag 各写一条）而效果一致。
        // 传数组而非 join(',')：tag 值本身可能含逗号，join/split 往返会错拆。
        const limit = params.limit ?? 10;
        const hits = await vectorSearch({
          scopes,
          query: params.query,
          limit: limit * tagNames.length,
          threshold: params.threshold,
          tags: tagNames,
        });
        const byTag = new Map<string, VectorSearchResult[]>();
        for (const h of hits) {
          const tag = h.tag ?? '';
          const group = byTag.get(tag);
          if (group) group.push(h);
          else byTag.set(tag, [h]);
        }
        const perTag: { priority: number; hits: VectorSearchResult[] }[] = [];
        for (const group of byTag.values()) {
          perTag.push({ priority: tagPriority(group[0].tag ?? ''), hits: group.slice(0, limit) });
        }
        perTag.sort((a, b) => a.priority - b.priority);
        raw = perTag.flatMap((p) => p.hits);
      }
    }

    // 按 memoryId 反查 relations-cache：命中附加 group / relation 定位原文。
    // 多 scope：按命中所属 scope 选对应 relation-map（跨 scope 不错配）；
    // 命中缺 scope 字段时单 scope 兜底到唯一检索 scope。
    //（getRelationMap 带 TTL+mtime 缓存：首次构建 O(N)，后续 O(1)）
    const includeOriginal = params.includeOriginal === true;
    const relationMaps = new Map<string, ReturnType<typeof getRelationMap>>(
      scopes.map((s) => [s, getRelationMap(s)]),
    );
    const results: SearchHit[] = raw.map((r) => {
      const hit: SearchHit = { ...r };
      // 命中归属 scope：向量字段透出；单 scope 兜底唯一检索 scope（字段由全部写入路径填充，兜底仅防御）
      const hitScope = r.scope ?? (scopes.length === 1 ? scopes[0] : undefined);
      // 多 scope 命中标注来源（单 scope 保持现状不标注）；只标注确定归属，不猜测（与反查/原文路径同源）
      if (multi && hitScope) hit.scope = hitScope;
      const map = hitScope ? relationMaps.get(hitScope) : undefined;
      const meta = map?.get(r.memoryId);
      if (meta) {
        hit.group = meta.group;
        hit.relation = meta.relation;
        // 附加文档全量自定义标签（tag 字段仅是本条命中的向量 tag，多 tag 文档会去重丢标签）
        if (meta.tags && meta.tags.length > 0) hit.tags = meta.tags;
      }
      // REQ-09：原文召回（显式开启才执行）——命中任一 chunk memoryId → 返回文件级原文；多 chunk 命中去重
      // 原文不可用（含 relation 反查缺失）时降级：以向量文档 content 兜底，并提示没有原文。
      // 多 scope：按命中所属 scope 的本地 KB 取原文（跨 scope 不错配）
      if (includeOriginal) {
        if (meta?.group && meta.relation && hitScope) {
          const fetched = fetchOriginal(hitScope, meta.group, meta.relation);
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

    // Multi-tag 去重：同一 (scope, group, relation) 因多 tag 写入产生多条向量命中 → 保留 score 最高的一条。
    // 多 scope 时 key 含 scope：不同 scope 的同名文档是不同知识，不得互相去重。
    //（sync-relation 为每个自定义 tag 各写一个 content 向量，搜索时同一文档会重复返回）
    {
      const best = new Map<string, SearchHit>();
      for (const hit of results) {
        const key = hit.group && hit.relation ? `${hit.scope ?? ''}|${hit.group}|${hit.relation}` : '';
        if (!key) continue;
        const prev = best.get(key);
        if (!prev || (hit.score ?? 0) > (prev.score ?? 0)) {
          best.set(key, hit);
        }
      }
      if (best.size > 0 && best.size < results.length) {
        results.length = 0;
        results.push(...best.values());
        // 保持 score 降序（跨 scope 单集合，得分可比，统一排序）
        results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      }
    }
    
    // REQ-09：同一文件多 chunk 命中去重（保留首个命中，其余 original 置空避免重复返回）
    if (includeOriginal) {
      const seen = new Set<string>();
      for (const hit of results) {
        const key = hit.group && hit.relation ? `${hit.scope ?? ''}/${hit.group}/${hit.relation}` : '';
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

    // 响应结构：单 scope 保持现状（向后兼容）；多 scope 增量返回 scopes / skipped 与命中级 scope
    return multi
      ? { ok: true, scope: scopes[0], scopes, results, ...(skipped.length > 0 ? { skipped } : {}) }
      : { ok: true, scope: scopes[0], results };
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
  .option('-s, --scope <scope>', '项目隔离标识（多个用逗号分隔聚合检索；default 模式可省略，默认 default；strict 模式必填）')
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
