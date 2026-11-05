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
import { getLocalKbDir } from './lib/scope.js';
import { resolveScopeTargets } from './lib/scope-view.js';
import { loadConfig } from './lib/config.js';
import { vectorSearch, fullTextSearch, vectorListTags, ensureVectorAvailable, closeEngine, findMissingScopeCollections, SEARCH_TOPK_MAX } from './lib/vector-client.js';
import type { VectorSearchResult } from './lib/vector-client.js';
import { getRelationMap } from './lib/relation-map.js';
import { hiddenEditIndexIds } from './lib/relation-edit-draft.js';
import { readJson } from './lib/store.js';
import {
  createOriginalLocator,
  DEFAULT_ORIGINAL_MATCH_LIMIT,
  selectTopOriginalMatches,
  type FtsLocator,
  type OriginalMatch,
  type OriginalMatchRankingContext,
  type OriginalLocator,
  type SourceLineRange,
} from './lib/original-locator.js';
import { parseIntArg, parseFloatArg } from './lib/cli-args.js';
import { callDaemon, shouldUseDaemonClient } from './lib/daemon-client.js';
import { DEFAULT_QUERY_EMBED_TIMEOUT_MS, timeoutSecondsToMs } from './lib/query-timeout.js';

/**
 * tag 优先级：默认搜全部时，ki-search（内容）优先，其次 ki-relation / ki-path
 * 路径解析辅助向量，其余自定义 tag 垫底。
 */
const TAG_PRIORITY = ['ki-search', 'ki-relation', 'ki-path'];

/**
 * 「无向量 Collection」跳过项的文案前缀。
 *
 * 降级为全文后必须按它把这类项移除：本次查询根本没有查向量，
 * "无向量 Collection … 请执行 ki import 重新导入" 与 "已降级为全文并给出结果" 同时出现时，
 * 用户看到的是"搜到了，但请重新导入"这种自相矛盾的提示（实测于 2026-11-02 降级验证）。
 */
const MISSING_COLLECTION_REASON_PREFIX = '无向量 Collection';

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
  /** local KB/导入源相对路径（可能缺失） */
  sourcePath?: string;
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
  /** 文档级聚合后的 FTS ID；单条命中时通常只有一个。 */
  ftsIds?: string[];
  /** 全文检索对应的原文命中行片段。 */
  matches?: OriginalMatch[];
  /** 当前文档已复核的命中区域数；matchCountComplete=false 时是已知下界。 */
  matchCount?: number;
  /** 命中区域数是否完整；无法可靠定位 fallback，或候选池饱和且仍可能有额外 fallback 时为 false。 */
  matchCountComplete?: boolean;
  /** 命中区域超过返回上限，或计数不完整且可能仍有未返回区域时为 true。 */
  matchesTruncated?: boolean;
  /** 便于 MCP 直接展示的多个命中片段拼接文本。 */
  originalExcerpt?: string;
  /** 完整原文的总行数。 */
  totalLines?: number;
}

function fullTextDocumentKey(hit: Pick<SearchHit, 'scope' | 'group' | 'relation' | 'indexType' | 'ftsId' | 'memoryId'>): string {
  return hit.group && hit.relation
    ? JSON.stringify([hit.scope ?? '', hit.group, hit.relation])
    : JSON.stringify([hit.scope ?? '', hit.indexType ?? 'unknown', hit.ftsId ?? hit.memoryId]);
}

export type SearchResult =
  | {
      ok: true;
      scope: string;
      /** 多 scope 检索时实际检索的 scope 列表（单 scope 不返回，向后兼容） */
      scopes?: string[];
      /**
       * 本次请求涉及的视图名（REQ-20261104-003）。缺省 = 纯 scope 请求。
       *
       * 刻意叫 `matchedViews` 而不是 `views`：`ki_scope_list` 的响应里已有一个
       * `views: ViewInfo[]`（对象数组），同名不同类型在实现时极易混用。
       */
      matchedViews?: string[];
      results: SearchHit[];
      /** 被跳过或受召回上限影响的 scope 及原因（多 scope 未注册 / 任意 scope 缺向量 Collection / 单成员检索失败 / 引擎候选上限导致的召回受限；无则省略） */
      skipped?: { scope: string; reason: string }[];
      /**
       * 本次**返回结果**按来源库的条数（仅多 scope / 视图请求返回，按条数降序）。
       *
       * 用途：视图把 N 个库折叠成一个名字后，只看 `results` 无法判断"是不是只有一两个库
       * 有内容"。跨库合并是按分数全局截断的（每库 topk=limit 后平铺排序），
       * 单库完全可能吃满 limit —— 有了这个字段，调用方能立刻看出覆盖面，
       * 而不是把"其余 N-1 个库没命中"误读成"这些库没内容"。
       */
      matchedByScope?: { scope: string; count: number }[];
      /** O1：语义侧降级为 FTS-only（查询 embedding 超时/网络失败）时置 true */
      degraded?: boolean;
      /** O1：降级原因（供调用方与用户诊断） */
      degradedReason?: string;
      /** 当前检索模式；缺省为 hybrid，fulltext 表示未调用 embedding。 */
      mode?: 'hybrid' | 'fulltext';
      /** 当前返回的文档结果数。fulltext 模式按文档聚合后计数。 */
      total?: number;
    }
  | {
      ok: false;
      error: string;
      degraded?: boolean;
      /**
       * 结构化错误码（如 VECTOR_DIMENSION_MISMATCH）。前端据此显示与导入页一致的
       * 处置指引——只给文案会让前端退回字符串匹配，检索页与导入页口径分叉。
       */
      code?: string;
    };

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

function mergeOriginalMatches(first?: OriginalMatch[], second?: OriginalMatch[]): OriginalMatch[] {
  const all = [...(first ?? []), ...(second ?? [])]
    .sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
  const merged: OriginalMatch[] = [];
  for (const match of all) {
    const previous = merged.at(-1);
    if (previous && match.lineStart <= previous.lineEnd + 1) {
      previous.lineEnd = Math.max(previous.lineEnd, match.lineEnd);
      const lines = new Map<number, string>();
      for (const line of previous.excerpt.split('\n')) {
        const separator = line.indexOf(' | ');
        if (separator > 0) lines.set(Number(line.slice(0, separator)), line);
      }
      for (const line of match.excerpt.split('\n')) {
        const separator = line.indexOf(' | ');
        if (separator > 0) lines.set(Number(line.slice(0, separator)), line);
      }
      previous.excerpt = [...lines.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, line]) => line)
        .join('\n');
    } else {
      merged.push({ ...match });
    }
  }
  return merged;
}

function buildOriginalExcerpt(matches?: OriginalMatch[]): string | undefined {
  if (!matches || matches.length === 0) return undefined;
  return matches.map((match) => match.excerpt).join('\n…\n');
}

async function executeSearchLocal(params: {
  scope?: string;
  query: string;
  limit?: number;
  threshold?: number;
  tags?: string;
  /** 查询 embedding 超时（ms）；CLI/MCP/Web 的 timeout 按秒转换后传入。 */
  timeoutMs?: number;
  /** REQ-09：是否返回 local KB 文件级原文（默认 false；CLI --original / MCP include_original 显式开启） */
  includeOriginal?: boolean;
  mode?: 'hybrid' | 'fulltext';
}): Promise<SearchResult> {
  try {
    // scope 解析（支持逗号分隔多 scope + 视图名）：去重保序、逐段字符集校验（非法快速失败）。
    // ★ 视图名 → 成员 scope 的**唯一展开点**在这里（scope-view.ts::resolveScopeTargets）。
    //   下游（vector-client fan-out / 命中回填 / 原文读取）只认真实 scope，完全不感知视图。
    const config = loadConfig();
    const expandStartedAt = Date.now();
    const targets = resolveScopeTargets(config, params.scope);
    const scopes = targets.scopes;
    const skipped: { scope: string; reason: string }[] = [...targets.skipped];
    /**
     * 是否走多库响应结构（返回 scopes / 命中标来源库）。
     * ★ 用「请求形态」而不是「生效数量」：strict 下 `--scope a,b` 可能只剩 1 个生效，
     *   但响应仍须给 scopes（既有调用方据此知道实际检索了哪些库）。
     */
    const multi = targets.multiRequested || targets.views.length > 0;
    // O1：查询 embedding 降级为 FTS-only 时记录一次（两处 vectorSearch 调用共用）
    let degradeReason: string | undefined;

    if (scopes.length === 0) {
      return {
        ok: false,
        error: `无可检索的 scope：${skipped.map((k) => `${k.scope}（${k.reason}）`).join('；')}`,
      };
    }

    // 展开可观测（S-02 B13）：视图把 N 个库折叠成一个名字后，"慢在展开还是慢在 fan-out"
    // 从外部完全看不出来，故打一行；成员多或展开慢时升为 ⚠ 以便直接扫到。
    if (targets.views.length > 0) {
      const costMs = Date.now() - expandStartedAt;
      const heavy = scopes.length >= 10 || costMs > 50;
      process.stderr.write(
        `${heavy ? '⚠ ' : ''}[view] ${targets.views.join(',')} → ${scopes.length} 个成员`
        + `（展开 ${costMs}ms${skipped.length > 0 ? `，跳过 ${skipped.length}` : ''}）\n`,
      );
    }

    // ★ let 而非 const：默认 hybrid 但向量库无任何 tag（库内全是 FTS-only 文档）时，
    //   下方会回退为全文检索 —— 那次查询的语义与返回字段（mode/total、原文命中行号生成）
    //   都必须按全文处理，否则会返回"有结果却没有 excerpt/行号"的半成品。
    let isFullText = params.mode === 'fulltext';

    // 全文模式不依赖 embedding provider，也不要求 hybrid Collection 存在。
    if (!isFullText) {
      // 向量服务可用性检测（以首个 scope 触发中断标记前置检测引导）
      const avail = await ensureVectorAvailable(scopes[0]);
      if (!avail.available) {
        /**
         * ★ 向量能力不可用（未配置/无效 key、向量库被占用…）不应让**全文检索一起不可用**。
         * 原文返回 `ok:false`：降级启动（`ki mcp` 允许 embedding 不可用仍启动）生效后，
         * CLI 默认搜索与 MCP 的检索工具会整体报错 —— 用户明明有 FTS 索引却搜不到任何东西，
         * 与"至少能用全文检索"的降级目标直接冲突（Web 端不受影响：SearchPage 在
         * `vectorAvailable=false` 时本来就改发 `mode:'fulltext'`）。
         * 现改为降级到全文并继续执行，原因写进 degradedReason（禁止静默降级）。
         */
        isFullText = true;
        degradeReason = `向量检索不可用（${avail.reason || '未检测到向量服务'}），已降级为全文检索`;
      }
    }

    // Collection 缺失检测（REQ-11 降级标记）：vectorSearch 的 fan-out 会静默跳过
    // 「已解析为合法 scope、但 Collection 目录不存在或为空」的分片（避免查询意外
    // 创建新库）。不上报就是静默漏召回：存量未迁移或目录被外部删除都会表现为
    // “搜不到”且零可诊断信息，故在此显式记录并给出出路。
    const missingCollections = isFullText ? [] : findMissingScopeCollections(scopes);
    for (const missing of missingCollections) {
      skipped.push({
        scope: missing,
        reason: `${MISSING_COLLECTION_REASON_PREFIX}（尚未导入，或仍是旧版单 Collection 布局）；当前不支持旧布局迁移，请执行 ki import 重新导入`,
      });
    }

    // 显式传 tags → 单次查询（多 tag OR，复用 vectorSearch 的 buildScopeTagFilter）。
    // 不传 tags（默认搜全部）→ 单次多 tag OR 查询：内部按 tag 分组取候选并保证
    // TAG_PRIORITY（ki-search 内容优先）；无论哪条路径，最终都按 limit 统一截断。
    // 引擎单次检索 topk 上限为 1000（SEARCH_TOPK_MAX），所有放大都要先收敛。
    // 多 scope：各 Collection fan-out 后应用层合并，query vector 在 fan-out 前只生成一次。
    const hiddenByScope = new Map(scopes.map((scope) => [scope, hiddenEditIndexIds(scope)]));
    const hiddenTotal = [...hiddenByScope.values()].reduce((sum, ids) => sum + ids.size, 0);
    const HIDDEN_HEADROOM_CAP = 1_000;
    const hiddenHeadroom = Math.min(HIDDEN_HEADROOM_CAP, hiddenTotal);
    // 待隐藏 ID 超过补位上限时，被过滤的候选可能挤掉真实结果，导致返回条数少于 limit。
    // 这是无法在本层完全消除的近似（检索 topk 有界），但必须显式上报，避免静默漏召回。
    const hiddenOverflow = hiddenTotal > HIDDEN_HEADROOM_CAP;
    if (hiddenOverflow) {
      skipped.push({
        scope: scopes.join(','),
        reason: `有 ${hiddenTotal} 条索引处于编辑中间态，超出 ${HIDDEN_HEADROOM_CAP} 条补位上限；结果可能少于 limit，请稍后重试`,
      });
    }
    const isVisibleHit = (hit: VectorSearchResult): boolean => {
      const hitScope = hit.scope ?? (scopes.length === 1 ? scopes[0] : undefined);
      return !hitScope || !hiddenByScope.get(hitScope)?.has(hit.ftsId ?? hit.memoryId);
    };
    /**
     * 单成员失败（维度不匹配 / 库被占用 / 索引损坏…）：**跳过该成员并上报**，
     * 其余库照常出结果。
     *
     * 与「Collection 不存在」的处理口径对齐（那条路径一直走 skipped）；
     * 视图把跨时期导入的一批库聚在一起，其中残留旧维度是常态，
     * 若整单失败，N-1 个完好库一条也搜不到，用户无从知道是哪一环的问题。
     */
    const scopeErrors: { scope: string; reason: string; code?: string }[] = [];
    const onScopeError = (scope: string, err: Error): void => {
      const code = (err as Error & { code?: string }).code;
      scopeErrors.push({ scope, reason: err.message, ...(code ? { code } : {}) });
      skipped.push({ scope, reason: err.message });
    };
    /**
     * 全部成员都失败时不能返回"空结果"（会被误读成"没有命中"）—— 保留 fail-loud。
     * 分母是**真正参与查询的库**（缺 Collection 的库已单独进 skipped，不参与 fan-out）。
     */
    const abortIfAllScopesFailed = (): SearchResult | null => {
      const queried = scopes.length - missingCollections.length;
      if (scopeErrors.length === 0 || scopeErrors.length < queried) return null;
      return {
        ok: false,
        error: `所有成员库检索失败：${scopeErrors.map((e) => `${e.scope}（${e.reason}）`).join('；')}`,
        ...(scopeErrors[0]?.code ? { code: scopeErrors[0].code } : {}),
      };
    };
    let raw: VectorSearchResult[];
    let fullTextCandidateLimit = 0;
    // 未传 tags = 搜全部 tag：最终结果需要恢复 TAG_PRIORITY 顺序再截断 limit。
    let implicitAllTags = false;
    if (isFullText) {
      const requestedCandidateLimit = Math.max((params.limit ?? 10) * 10, 50) + hiddenHeadroom;
      fullTextCandidateLimit = Math.min(requestedCandidateLimit, SEARCH_TOPK_MAX);
      if (requestedCandidateLimit > fullTextCandidateLimit) {
        skipped.push({
          scope: scopes.join(','),
          reason: `全文检索候选数 ${requestedCandidateLimit} 超过引擎单次检索上限 ${SEARCH_TOPK_MAX}；已按上限检索，结果可能少于 limit。可降低 limit`,
        });
      }
      raw = await fullTextSearch({
        scopes,
        query: params.query,
        // FTS 返回的是 chunk，先多取候选，再在本层按文档聚合并执行最终 limit，
        // 避免同一文档的多个 chunk 占满 MCP 的文档结果名额。
        limit: fullTextCandidateLimit,
        tags: params.tags,
        onScopeError,
      });
    } else if (params.tags) {
      const requestedTopk = (params.limit ?? 10) + hiddenHeadroom;
      const topk = Math.min(requestedTopk, SEARCH_TOPK_MAX);
      if (requestedTopk > topk) {
        skipped.push({
          scope: scopes.join(','),
          reason: `limit ${params.limit ?? 10} 加隐藏补位 ${hiddenHeadroom} 超过引擎单次检索上限 ${SEARCH_TOPK_MAX}；已按 ${topk} 检索，结果可能少于 limit`,
        });
      }
      raw = await vectorSearch({
        scopes,
        query: params.query,
        limit: topk,
        threshold: params.threshold,
        tags: params.tags,
        timeoutMs: params.timeoutMs,
        onDegrade: (reason) => { degradeReason ??= reason; },
        onScopeError,
      });
    } else {
      const tagUnion = new Map<string, number>();
      for (const s of scopes) {
        const { tags } = await vectorListTags({ scope: s });
        for (const t of tags) tagUnion.set(t.tag, (tagUnion.get(t.tag) ?? 0) + t.count);
      }
      const tagNames = [...tagUnion.keys()];
      if (tagNames.length === 0) {
        /**
         * ★ 向量库没有任何 tag ⇒ 库内文档全是 FTS-only（`import --no-vector` 导入，或
         * embedding 不可用期间导入的那批）。原实现直接 `raw = []`：既不查全文，也不打
         * degraded，用户看到"搜不到"却拿不到任何可诊断信息 —— 而降级启动生效后，
         * 这恰恰是最常见的形态（密钥无效 → 页面/CLI 只能写全文索引）。
         * 改为回退到全文检索（与 `--mode fulltext` 同一条路径），并显式标记降级原因。
         */
        const requestedCandidateLimit = Math.max((params.limit ?? 10) * 10, 50) + hiddenHeadroom;
        fullTextCandidateLimit = Math.min(requestedCandidateLimit, SEARCH_TOPK_MAX);
        raw = await fullTextSearch({
          scopes,
          query: params.query,
          limit: fullTextCandidateLimit,
          tags: params.tags,
          onScopeError,
        });
        isFullText = true;
        degradeReason ??= '向量库无任何索引（文档可能仅有全文索引），已降级为全文检索';
        // 本次查询不查向量 ⇒ 前面那条「无向量 Collection … 请执行 ki import 重新导入」不再成立，
        // 与结果同屏会误导（用户刚用 --no-vector 导入过，重导也不会产生 dense 向量）。
        for (let i = skipped.length - 1; i >= 0; i--) {
          if (skipped[i].reason.startsWith(MISSING_COLLECTION_REASON_PREFIX)) skipped.splice(i, 1);
        }
      } else {
        // 单次查询（多 tag OR 过滤）：每个 scope 内多 tag 只做 1 次 embedding（逐 tag
        // 分查会对同一 query 重复 embedding N 次，tag 多时线性放大检索延迟）。topk 按
        // tag 数放大保障每 tag 候选，但必须收敛到引擎上限（超出会让整次检索失败）；
        // 查询后按 tag 分组限额 + TAG_PRIORITY 排序，最终仍由 limit 统一截断。
        // ⚠️ topk 为全局分配，极端场景（单 tag 命中数占满 topk 且 score 全面占优）下
        // 其他 tag 可能被挤出——多数场景因下游 (scope, group, relation) 去重
        //（同文档多 tag 各写一条）而效果一致。
        // 传数组而非 join(',')：tag 值本身可能含逗号，join/split 往返会错拆。
        const limit = params.limit ?? 10;
        const requestedTopk = limit * tagNames.length + hiddenHeadroom;
        const topk = Math.min(requestedTopk, SEARCH_TOPK_MAX);
        if (requestedTopk > topk) {
          skipped.push({
            scope: scopes.join(','),
            reason: `未传 tags 时按 ${tagNames.length} 个 tag 分配候选（limit ${limit}${hiddenHeadroom > 0 ? ` + 隐藏补位 ${hiddenHeadroom}` : ''} → topk ${requestedTopk}），超过引擎单次检索上限 ${SEARCH_TOPK_MAX}；已按 ${SEARCH_TOPK_MAX} 检索，部分 tag 的召回可能减少。可显式传 tags 缩小范围或降低 limit`,
          });
        }
        implicitAllTags = true;
        const hits = await vectorSearch({
          scopes,
          query: params.query,
          limit: topk,
          threshold: params.threshold,
          tags: tagNames,
          timeoutMs: params.timeoutMs,
          onDegrade: (reason) => { degradeReason ??= reason; },
          onScopeError,
        });
        const byTag = new Map<string, VectorSearchResult[]>();
        for (const h of hits.filter(isVisibleHit)) {
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

    // 全部成员都检索失败 → 保留 fail-loud（不能返回空结果冒充"没有命中"）
    const allScopesFailed = abortIfAllScopesFailed();
    if (allScopesFailed) return allScopesFailed;

    // 编辑发布期间，新索引尚未成为正式版本；清理失败的旧索引也不应继续召回。
    // 草稿清单先于 zvec 写入持久化，故读路径可按 ID 排除两类中间态。
    raw = raw.filter(isVisibleHit);

    // 按 memoryId 反查 relations-cache：命中附加 group / relation 定位原文。
    // 多 scope：按命中所属 scope 选对应 relation-map（跨 scope 不错配）；
    // 命中缺 scope 字段时单 scope 兜底到唯一检索 scope。
    //（getRelationMap 带 TTL+mtime 缓存：首次构建 O(N)，后续 O(1)）
    const includeOriginal = params.includeOriginal === true;
    const originalFetchByDocument = new Map<string, ReturnType<typeof fetchOriginal>>();
    const originalLocatorByDocument = new Map<string, OriginalLocator>();
    const directMatchesByDocument = new Map<string, OriginalMatch[]>();
    const inferredRangeByChunk = new Map<string, SourceLineRange | undefined>();
    const unmappedChunkByDocument = new Set<string>();
    const fallbackMatchByDocument = new Set<string>();
    const rankingContextsByHit = new Map<SearchHit, OriginalMatchRankingContext[]>();
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
      const lookupId = r.ftsId ?? r.memoryId;
      const meta = map?.get(lookupId);
      if (meta) {
        hit.group = meta.group;
        hit.relation = meta.relation;
        if (meta.sourcePath) hit.sourcePath = meta.sourcePath;
        // 附加文档全量自定义标签（tag 字段仅是本条命中的向量 tag，多 tag 文档会去重丢标签）
        if (meta.tags && meta.tags.length > 0) hit.tags = meta.tags;
      }
      if (r.ftsId) hit.ftsIds = [r.ftsId];
      const documentKey = fullTextDocumentKey(hit);
      // 原文召回：includeOriginal 返回完整原文；fulltext 模式即使未请求完整原文，
      // 也必须读取 local KB 生成命中片段和行号，避免 MCP 只能看到清洗 chunk。
      // 原文不可用（含 relation 反查缺失）时降级：以向量文档 content 兜底，并提示没有原文。
      // 多 scope：按命中所属 scope 的本地 KB 取原文（跨 scope 不错配）
      if (includeOriginal || isFullText) {
        const originalGroup = meta?.group ?? hit.group;
        const originalRelation = meta?.relation ?? hit.relation;
        let fetched: ReturnType<typeof fetchOriginal>;
        if (originalFetchByDocument.has(documentKey)) {
          fetched = originalFetchByDocument.get(documentKey) ?? null;
        } else {
          fetched = originalGroup && originalRelation && hitScope
            ? fetchOriginal(hitScope, originalGroup, originalRelation)
            : null;
          originalFetchByDocument.set(documentKey, fetched);
        }
        if (fetched?.original) {
          hit.originalRetrieved = true;
          if (includeOriginal) hit.original = fetched.original;
          if (isFullText) {
            const locator: FtsLocator | undefined = meta?.ftsLocator;
            let sourceLocator = originalLocatorByDocument.get(documentKey);
            if (!sourceLocator) {
              sourceLocator = createOriginalLocator(fetched.original);
              originalLocatorByDocument.set(documentKey, sourceLocator);
              directMatchesByDocument.set(documentKey, sourceLocator.locate(params.query));
            }
            const directMatches = directMatchesByDocument.get(documentKey) ?? [];
            // FTS-only 优先使用持久化 locator；其他索引从 chunk 锚点推导范围，
            // 让字面查询命中之外的 fallback 仍关联到产生它的 chunk。若 direct 命中且
            // 全局候选池已饱和，则不对每个无 locator chunk 再搜索原文，完整性显式降级。
            const chunkKey = JSON.stringify([documentKey, r.content]);
            let inferredRange: SourceLineRange | undefined = locator;
            const canInferRange = !locator && (directMatches.length === 0 || raw.length < fullTextCandidateLimit);
            if (!inferredRange && canInferRange && inferredRangeByChunk.has(chunkKey)) {
              inferredRange = inferredRangeByChunk.get(chunkKey);
            } else if (!inferredRange && canInferRange) {
              inferredRange = sourceLocator.locateChunkRange(r.content);
              inferredRangeByChunk.set(chunkKey, inferredRange);
            }
            if (!locator && (!canInferRange || !inferredRange)) unmappedChunkByDocument.add(documentKey);
            let matches: OriginalMatch[];
            let rankingFallbackUsed = false;
            if (inferredRange) {
              const directChunkMatches = sourceLocator.locate(params.query, { range: inferredRange });
              if (directChunkMatches.length > 0) {
                matches = directChunkMatches;
              } else {
                matches = sourceLocator.locate(params.query, {
                  fallbackText: r.content,
                  range: inferredRange,
                  fallbackOnly: true,
                });
                rankingFallbackUsed = matches.length > 0;
                // 锚点范围可能只覆盖 chunk 的一小部分（清洗在行内删掉了路径/行号等，
                // 只有仍与原文连续的片段能当锚点）：此时范围外仍可能有该 chunk 的原文命中，
                // 硬过滤会让"原文有内容却查不到行号"。范围跨度小于 chunk 自身行数即视为
                // 不可信锚点，放开范围用 chunk 词项在整篇原文兜底，并把该 chunk 标记为
                // 未映射（matchCountComplete 因此降级，避免静默声称计数完整）。
                const chunkLineCount = r.content.split('\n').length;
                if (matches.length === 0 && chunkLineCount > inferredRange.lineEnd - inferredRange.lineStart + 1) {
                  const wideMatches = sourceLocator.locate(params.query, { fallbackText: r.content, fallbackOnly: true });
                  if (wideMatches.length > 0) {
                    matches = wideMatches;
                    rankingFallbackUsed = true;
                    unmappedChunkByDocument.add(documentKey);
                  }
                }
              }
            } else if (directMatches.length > 0) {
              matches = directMatches;
            } else {
              matches = sourceLocator.locate(params.query, { fallbackText: r.content });
              rankingFallbackUsed = matches.length > 0;
            }
            hit.matches = matches;
            if (rankingFallbackUsed) {
              fallbackMatchByDocument.add(documentKey);
              rankingContextsByHit.set(hit, [{ matches, fallbackText: r.content, score: r.score }]);
            }
            hit.totalLines = sourceLocator.totalLines;
            if (matches.length > 0) {
              hit.originalExcerpt = matches.map((match) => match.excerpt).join('\n…\n');
            } else {
              hit.originalHint = '原文存在，但无法从当前查询/清洗 chunk 复核精确命中行；未伪造行号';
            }
          }
        } else {
          hit.originalRetrieved = false;
          // fulltext 模式保留清洗 chunk 作为结果主体；includeOriginal 兼容旧行为也继续返回兜底内容。
          if (includeOriginal) hit.original = r.content;
          hit.originalHint = fetched?.hint ?? '原文不可用：无法定位 local KB 原文';
          if (isFullText) hit.matches = [];
        }
      }
      return hit;
    });

    // fulltext：按文档聚合 chunk/tag 命中。一个文档保留最高分，同时合并所有可复核的
    // FTS ID 与原文命中行区间；最终文档 limit 与每文档命中区域 limit 都在聚合后执行。
    if (isFullText) {
      const grouped = new Map<string, SearchHit>();
      const rankingContextsByDocument = new Map<string, OriginalMatchRankingContext[]>();
      for (const hit of results) {
        const key = fullTextDocumentKey(hit);
        const contexts = rankingContextsByHit.get(hit) ?? [];
        if (contexts.length > 0) {
          const documentContexts = rankingContextsByDocument.get(key);
          if (documentContexts) documentContexts.push(...contexts);
          else rankingContextsByDocument.set(key, [...contexts]);
        }
        const previous = grouped.get(key);
        if (!previous) {
          grouped.set(key, hit);
          continue;
        }
        const previousScore = previous.score ?? 0;
        const currentScore = hit.score ?? 0;
        if (currentScore > previousScore) {
          hit.ftsIds = [...new Set([...(previous.ftsIds ?? []), ...(hit.ftsIds ?? [])])];
          hit.matches = mergeOriginalMatches(previous.matches, hit.matches);
          hit.originalExcerpt = buildOriginalExcerpt(hit.matches);
          if (previous.original && !hit.original) hit.original = previous.original;
          if (previous.originalRetrieved && !hit.originalRetrieved) hit.originalRetrieved = true;
          if (!hit.totalLines) hit.totalLines = previous.totalLines;
          hit.deduplicated = true;
          grouped.set(key, hit);
        } else {
          previous.ftsIds = [...new Set([...(previous.ftsIds ?? []), ...(hit.ftsIds ?? [])])];
          previous.matches = mergeOriginalMatches(previous.matches, hit.matches);
          previous.originalExcerpt = buildOriginalExcerpt(previous.matches);
          previous.deduplicated = true;
          if (!previous.original && hit.original) previous.original = hit.original;
          if (hit.originalRetrieved) previous.originalRetrieved = true;
          if (!previous.totalLines) previous.totalLines = hit.totalLines;
        }
      }
      for (const hit of grouped.values()) {
        const key = fullTextDocumentKey(hit);
        const originalLocator = originalLocatorByDocument.get(key);
        const directMatches = directMatchesByDocument.get(key) ?? [];
        const candidateMatches = mergeOriginalMatches(hit.matches);
        // 合并完整原文直查与 chunk-specific fallback：直查覆盖所有字面命中，
        // fallback 补足清洗/分词差异；候选池饱和且存在额外 fallback 时只可确认下界。
        const allMatches = mergeOriginalMatches(directMatches, candidateMatches);
        const selectedMatches = selectTopOriginalMatches(
          allMatches,
          params.query,
          DEFAULT_ORIGINAL_MATCH_LIMIT,
          { fallbackContexts: rankingContextsByDocument.get(key) },
        );
        hit.matches = selectedMatches;
        // 逐条 chunk 的原始提示在聚合补齐命中后不再成立，否则会出现
        // "matches 有行号 + originalHint 说无法复核" 的自相矛盾响应。
        if (selectedMatches.length > 0) delete hit.originalHint;
        hit.matchCount = allMatches.length;
        const candidateAddsUnverifiedRegions = candidateMatches.some((candidate) => (
          !directMatches.some((direct) => candidate.lineStart >= direct.lineStart && candidate.lineEnd <= direct.lineEnd)
        ));
        hit.matchCountComplete = Boolean(originalLocator)
          && !unmappedChunkByDocument.has(key)
          && (raw.length < fullTextCandidateLimit || (
            directMatches.length > 0
            && !candidateAddsUnverifiedRegions
            && !fallbackMatchByDocument.has(key)
          ));
        hit.matchesTruncated = allMatches.length > selectedMatches.length
          || (Boolean(originalLocator) && !hit.matchCountComplete);
        hit.originalExcerpt = buildOriginalExcerpt(selectedMatches);
      }
      results.length = 0;
      results.push(...grouped.values());
      results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      results.splice(params.limit ?? 10);
    }

    // Multi-tag 去重：同一 (scope, group, relation) 因多 tag 写入产生多条向量命中 → 保留 score 最高的一条。
    // 多 scope 时 key 含 scope：不同 scope 的同名文档是不同知识，不得互相去重。
    //（sync-relation 为每个自定义 tag 各写一个 content 向量，搜索时同一文档会重复返回）
    if (!isFullText) {
      const best = new Map<string, SearchHit>();
      for (const hit of results) {
        const key = hit.group && hit.relation ? fullTextDocumentKey(hit) : '';
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

    // limit 是整次检索的返回条数上限（MCP 工具/CLI 的公开契约）：上面的 per-tag 分组
    // 只决定候选与优先级，去重后统一截断。未传 tags 时恢复 TAG_PRIORITY 顺序
    //（ki-search 内容优先），同优先级内按分数降序——去重分支会改按分数排序，
    // 不恢复会让辅助向量（ki-relation/ki-path）挤进 limit。
    if (implicitAllTags) {
      results.sort((a, b) => {
        const byPriority = tagPriority(a.tag ?? '') - tagPriority(b.tag ?? '');
        return byPriority !== 0 ? byPriority : (b.score ?? 0) - (a.score ?? 0);
      });
    }
    results.splice(params.limit ?? 10);

    /**
     * 覆盖面统计（仅多 scope / 视图）：返回结果按来源库计数。
     *
     * 跨库合并是"每库 topk=limit → 平铺 → 按分数全局截断"，单库完全可能吃满 limit；
     * 没有这个字段时，"其余 N-1 个库一条没出"与"这些库本来就没内容"在响应上无法区分。
     */
    const matchedByScope = (() => {
      if (!multi) return undefined;
      const counts = new Map<string, number>();
      for (const hit of results) {
        const hitScope = hit.scope ?? (scopes.length === 1 ? scopes[0] : undefined);
        if (!hitScope) continue;
        counts.set(hitScope, (counts.get(hitScope) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([scope, count]) => ({ scope, count }))
        .sort((a, b) => b.count - a.count || a.scope.localeCompare(b.scope));
    })();

    // 非全文模式保持原有 include_original 的完整原文去重行为；全文模式已在上方聚合。
    if (includeOriginal && !isFullText) {
      const seen = new Set<string>();
      for (const hit of results) {
        const key = hit.group && hit.relation ? fullTextDocumentKey(hit) : '';
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

    // 响应结构：单 scope 保持现状（向后兼容）；多 scope 增量返回 scopes 与命中级 scope。
    // skipped 不再仅限多 scope：单 scope 的 Collection 缺失同样是漏召回，必须显式标记。
    const degradeFields = degradeReason !== undefined
      ? { degraded: true, degradedReason: degradeReason }
      : {};
    // 纯 scope 请求不加该字段（与改造前逐字节一致）；只要用过视图就带上
    const viewFields = targets.views.length > 0 ? { matchedViews: targets.views } : {};
    const coverageFields = matchedByScope ? { matchedByScope } : {};
    return multi
      ? { ok: true, scope: scopes[0], scopes, ...viewFields, ...coverageFields, results, ...(isFullText ? { total: results.length } : {}), ...(skipped.length > 0 ? { skipped } : {}), ...(isFullText ? { mode: 'fulltext' as const } : {}), ...degradeFields }
      : { ok: true, scope: scopes[0], ...viewFields, ...coverageFields, results, ...(isFullText ? { total: results.length } : {}), ...(skipped.length > 0 ? { skipped } : {}), ...(isFullText ? { mode: 'fulltext' as const } : {}), ...degradeFields };
  } catch (err) {
    const e = err as Error & { code?: string };
    // 保留 code：HTTP/MCP 两条出口都按 code 透传，前端才能区分"维度不匹配需重建"与普通失败
    return { ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) };
  }
}

export async function executeSearch(params: {
  scope?: string;
  query: string;
  limit?: number;
  threshold?: number;
  tags?: string;
  /** 查询 embedding 超时（ms）；未传时使用配置中的默认值。 */
  timeoutMs?: number;
  includeOriginal?: boolean;
  mode?: 'hybrid' | 'fulltext';
}): Promise<SearchResult> {
  if (shouldUseDaemonClient()) {
    // CLI/stdio 通过 daemon 时也要使用调用方配置文件的默认值，不能因请求未显式
    // 传 timeout 而悄悄回退到 daemon 启动时的另一份配置。
    const config = loadConfig();
    return callDaemon<SearchResult>('search', {
      ...params,
      timeoutMs: params.timeoutMs ?? config.embedding.queryTimeoutMs ?? DEFAULT_QUERY_EMBED_TIMEOUT_MS,
      mode: params.mode,
    });
  }
  return executeSearchLocal(params);
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
  .option('--limit <limit>', '返回条数上限（整次检索最多返回的文档数；未传 --tags 时内部按 tag 取候选，最终仍按该值截断；引擎单次候选上限 1000，超出时部分 tag 召回可能减少）', '10')
  .option('--threshold <threshold>', '相似度阈值（融合得分，略过低于此值的命中；默认 0 不过滤）', '0')
  .option('--tags <tags>', '过滤标签（不传则搜索全部 tag：内部按 tag 取候选，最终仍按 --limit 截断，ki-search 内容优先；多个用逗号分隔，OR 组合）')
  .option('--timeout <seconds>', '查询 embedding 超时（秒，范围 0.001-60；未传则使用配置值）')
  .option('--original', '返回 local KB 文件级原文（默认不返回，仅返回向量匹配数据，REQ-09）')
  .option('--mode <mode>', '检索模式：hybrid 或 fulltext', 'hybrid')
  .action(async (query: string | undefined, opts) => {
    const finalQuery = query ?? opts.query;
    if (!finalQuery) {
      console.error('错误: 缺少查询文本。用法: ki search <query> 或 ki search --query <query>');
      process.exit(1);
    }
    // NEG-02：非法数值显式警告并回退（避免 NaN 静默丢光结果）
    const parsedThreshold = parseFloatArg(opts.threshold, undefined, '--threshold');
    let timeoutMs: number | undefined;
    if (opts.timeout !== undefined) {
      try {
        timeoutMs = timeoutSecondsToMs(Number(opts.timeout), '--timeout');
      } catch (err) {
        console.error(`错误: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    const result = await executeSearch({
      scope: opts.scope,
      query: finalQuery,
      limit: parseIntArg(opts.limit, 10, '--limit', { min: 1 }),
      threshold: parsedThreshold,
      tags: opts.tags,
      timeoutMs,
      includeOriginal: opts.original === true,
      mode: opts.mode === 'fulltext' ? 'fulltext' : 'hybrid',
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
