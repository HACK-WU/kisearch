/**
 * recall/fast-recall.ts —— 确定性召回通道（S-01 §3.3）。
 *
 * 十一步固定顺序（**不要重排**，顺序本身就是契约）：
 *   ① 解析范围 ② 抽线索 ③ 主检索（语义块）④ 备检索（精确词，仅在命中过少时）
 *   ⑤ 归一化 ⑥ 去重 ⑦ 可见性 ⑧ 已读/失效剔除 ⑨ 配额+排序 ⑩ 理由 ⑪ 同名提示
 *
 * 三条硬约束：
 *   1. **不依赖模型**：不读 `llm` 段、不读 prompt-config ⇒ 外发未确认、模型未配置时照常可用；
 *   2. **可复现**：同输入同输出（排序尾部用名称字典序兜底），没有随机、没有时间依赖；
 *   3. **不编造理由**：`why` 里的「命中」只来自线索词真实出现在 **文档名或 group 路径**里；
 *      正文里是否命中无法在检索层得知，此时如实写「本库第 N」，绝不假称命中。
 */

import type { RefSearchOutcome } from '../events/refs-service.js';
import type { FindTargetDeps } from '../events/find-targets.js';
import type { Visibility } from '../events/types.js';
import type { Relation } from '../scoring.js';
import { resolveVisibilityOfRelation } from '../visibility-index.js';
import { buildNeedMore, buildWhy } from './assemble.js';
import { RecallKernelError } from './codes.js';
import { extractRecallTerms } from './keywords.js';
import { resolveRecallTargets } from './targets.js';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PER_SCOPE_CAP,
  SEARCH_TOP_K,
  TIER1_MAX_RANK,
  TIER1_MIN_SCORE,
  type CoreRecallResult,
  type RecallCandidate,
  type RecallRequest,
} from './types.js';

/** 检索适配器：生产用 `createSearchAdapter()`（`events/refs-search.ts`），测试注入 fake */
export interface RecallSearchFn {
  (args: { scope: string; query: string; topK: number; mode?: 'hybrid' | 'fulltext' }): Promise<
    RefSearchOutcome | Array<{ group: string; name: string; score: number }>
  >;
}

export interface FastRecallDeps {
  /** 授权名字全集；`null` = 本机不限权 */
  tokenScopes: string[] | null;
  search: RecallSearchFn;
  /** 分片缓存读取：判断文档是否还存在、取 lifecycle/eventId 算可见性 */
  cachesOf: (scope: string) => Map<string, { hot_relations: Array<{ text: string; eventId?: string }> }>;
  /** 可见性判定（默认走 `resolveVisibilityOfRelation`；注入便于单测） */
  resolveVisibility?: (scope: string, rel: unknown) => Visibility;
  /** 范围解析的注入点（listScopes / listViews / config），测试用 */
  scopeDeps?: Omit<FindTargetDeps, 'tokenScopes'>;
  now?: () => number;
}

interface RawHit {
  scope: string;
  group: string;
  name: string;
  raw: number;
  /** 由哪一路检索命中：`terms` = 精确线索词（强），`blocks` = 语义块（弱） */
  via: 'terms' | 'blocks';
}

/** 把适配器两种返回形状归一成命中数组 */
function hitsOf(outcome: RefSearchOutcome | Array<{ group: string; name: string; score: number }>): Array<{ group: string; name: string; score: number }> {
  return Array.isArray(outcome) ? outcome : outcome.hits;
}

/** 已读清单键：`scope::group::name` 或 `group::name`（省略 scope = 任意库） */
function parseExclude(list: string[] | undefined): { scoped: Set<string>; loose: Set<string> } {
  const scoped = new Set<string>();
  const loose = new Set<string>();
  for (const raw of list ?? []) {
    const value = raw.trim();
    if (!value) continue;
    const parts = value.split('::').map((p) => p.trim());
    if (parts.length === 3 && parts.every((p) => p.length > 0)) {
      scoped.add(`${parts[0]}\u0000${parts[1]}\u0000${parts[2]}`);
      continue;
    }
    if (parts.length === 2 && parts.every((p) => p.length > 0)) {
      loose.add(`${parts[0]}\u0000${parts[1]}`);
    }
    // 其它形态（1 段 / 4 段 / 含空段）= 格式非法，由工具层计数（ignoredExclude），此处静默跳过
  }
  return { scoped, loose };
}

export async function runFastRecall(req: RecallRequest, deps: FastRecallDeps): Promise<CoreRecallResult> {
  const now = deps.now ?? ((): number => Date.now());
  const started = now();

  // ① 范围（抛 SCOPE_REQUIRED / NO_TARGETS）
  const resolved = resolveRecallTargets({
    requested: req.scope,
    tokenScopes: deps.tokenScopes,
    ...(deps.scopeDeps ? { deps: deps.scopeDeps } : {}),
  });
  if (resolved.targets.length === 0 || resolved.physicalTargets.length === 0) {
    throw new RecallKernelError('NO_TARGETS', '所有 scope 都不可用（不存在 / 无权限 / 被截断 / 视图无成员）');
  }

  // ② 线索
  const terms = extractRecallTerms({ task: req.task, hints: req.hints });
  /*
   * ⚠️ 主检索用**精确线索词**，不是整句任务描述（2026-11-18 真机改）：
   *   实测「删除一篇文档以后，用 ki_search 还能把它搜出来…」这种长句做主查询时，
   *   语义侧会命中一堆泛化文档（archive / 决策记录），而真正该读的那篇（名字里就带
   *   `delete-relation`）排在 5 名之外 —— 因为长句里 90% 是虚词。
   *   hints / 错误码 / 路径这类强线索才是区分度所在，故：
   *     主路 = tokens（强）→ 命中不足 3 条才用 blocks（弱）补一轮。
   */
  const strongQuery = terms.strong.join(' ');
  const semanticQuery = terms.blocks.join(' ');
  const weakQuery = terms.weak.join(' ');
  /*
   * 主路优先级：**强线索 → 语义块 → 中文窗口**。
   * 中文窗口（weak）永远排最后：它是 2~3 字碎片，进主 query 会把强线索稀释成噪声
   * （实测 query 变成「删除一 除一篇 一篇文…」）。
   */
  const query = strongQuery || semanticQuery || weakQuery;

  const base = {
    targets: resolved.targets,
    skipped: resolved.skipped,
    forbiddenRequested: resolved.forbiddenRequested,
    truncated: resolved.truncated,
  };

  if (!query) {
    return {
      ...base,
      query: '',
      candidates: [],
      excludedHidden: 0,
      dropped: 0,
      needMore: buildNeedMore({ blocks: [], tokens: [], candidateCount: 0, scopeCount: resolved.targets.length }),
      durationMs: now() - started,
    };
  }

  /*
   * ③④ 双路并行检索：**字面（fulltext）** 与 **语义（hybrid）** 各跑一遍，逐库交替合并。
   *
   * 为什么不是「主路 + 命中不足才补」（2026-11-18 真机改）：
   *   `archive.md` 这类几千行的归档文档会把 hybrid 的前几名全部占满 ——
   *   目标文档（名字里就带 `delete-relation`）连 top5 都进不去；
   *   而同一查询用 fulltext 能把它排到第 2。两路各有各的盲区，交替合并最稳。
   *
   * 字面路用**短词表**（强线索 → 中文窗口），语义路可以带整句块：
   *   长句喂 fulltext 等于没有字面命中，喂 hybrid 才有意义。
   */
  let failed = 0;
  let okCalls = 0;
  const runAll = async (text: string, via: 'terms' | 'blocks', mode?: 'hybrid' | 'fulltext'): Promise<RawHit[]> => {
    const out: RawHit[] = [];
    // 检索走**物理库**：视图不是物理库，`cachesOf(视图)` 恒为空会让命中全被判成"已删除"
    for (const target of resolved.physicalTargets) {
      try {
        const hits = hitsOf(await deps.search({ scope: target, query: text, topK: SEARCH_TOP_K, ...(mode ? { mode } : {}) }));
        okCalls += 1;
        for (const hit of hits) {
          if (!hit || typeof hit.group !== 'string' || typeof hit.name !== 'string') continue;
          out.push({ scope: target, group: hit.group, name: hit.name, raw: Number.isFinite(hit.score) ? hit.score : 0, via });
        }
      } catch {
        failed += 1;
      }
    }
    return out;
  };

  const viaOf: 'terms' | 'blocks' = strongQuery ? 'terms' : 'blocks';
  const exactText = strongQuery || weakQuery;                 // 字面路：短词表
  const semanticText = strongQuery || semanticQuery || weakQuery; // 语义路：可带整句块
  const [exactHits, semanticHits] = await Promise.all([
    exactText ? runAll(exactText, viaOf, 'fulltext') : Promise.resolve<RawHit[]>([]),
    semanticText ? runAll(semanticText, viaOf) : Promise.resolve<RawHit[]>([]),
  ]);
  if (okCalls === 0) {
    throw new RecallKernelError('ALL_TARGETS_FAILED', '每个 scope 的检索都失败了');
  }

  // ⑤ 归一化：逐库先按原始分排，再把两路**交替合并**，最后给库内名次与相对分位
  const chunkHits = new Map<string, number>();
  for (const hit of [...exactHits, ...semanticHits]) {
    const key = `${hit.scope}\u0000${hit.group}\u0000${hit.name}`;
    chunkHits.set(key, (chunkHits.get(key) ?? 0) + 1);
  }

  const groupByScope = (hits: RawHit[]): Map<string, RawHit[]> => {
    const map = new Map<string, RawHit[]>();
    for (const hit of hits) {
      const rows = map.get(hit.scope) ?? [];
      const index = rows.findIndex((row) => row.group === hit.group && row.name === hit.name);
      if (index < 0) rows.push(hit);
      else if (hit.raw > (rows[index]?.raw ?? -1)) rows[index] = hit;
      map.set(hit.scope, rows);
    }
    for (const [scope, rows] of map) {
      rows.sort((a, b) => b.raw - a.raw || a.name.localeCompare(b.name));
      map.set(scope, rows);
    }
    return map;
  };

  const exactByScope = groupByScope(exactHits);
  const semanticByScope = groupByScope(semanticHits);
  const scored: Array<RawHit & { rankInScope: number; score: number }> = [];
  const allScopes = new Set([...exactByScope.keys(), ...semanticByScope.keys()]);
  for (const scope of allScopes) {
    const exactRows = exactByScope.get(scope) ?? [];
    const semanticRows = semanticByScope.get(scope) ?? [];
    const merged: RawHit[] = [];
    const pushUnique = (row: RawHit): void => {
      if (merged.some((m) => m.group === row.group && m.name === row.name)) return;
      merged.push(row);
    };
    const longest = Math.max(exactRows.length, semanticRows.length);
    for (let i = 0; i < longest; i += 1) {
      const exact = exactRows[i];
      if (exact) pushUnique(exact);
      const semantic = semanticRows[i];
      if (semantic) pushUnique(semantic);
    }
    merged.forEach((row, index) => {
      const score = merged.length === 1 ? 1 : (merged.length - 1 - index) / (merged.length - 1);
      scored.push({
        scope, group: row.group, name: row.name, raw: row.raw, via: row.via,
        rankInScope: index + 1, score: Number(score.toFixed(2)),
      });
    });
  }

  // ⑥⑦⑧ 去重 → 可见性 → 已读/失效剔除
  const exclude = parseExclude(req.exclude);
  const resolveVisibility = deps.resolveVisibility
    ?? ((scope: string, rel: unknown): Visibility => resolveVisibilityOfRelation(scope, rel as Relation).mode);

  let excludedHidden = 0;
  let dropped = 0;
  const survivors: RecallCandidate[] = [];
  const seen = new Set<string>();
  /** 候选 → 召回它的那一路（用于生成 why；不对外暴露该字段） */
  const viaByKey = new Map<string, 'terms' | 'blocks'>();
  /** 候选 → 名字/路径里命中的线索词（用于 why 与相关性分级） */
  const matchedByKey = new Map<string, string[]>();
  /**
   * 相关性分级（2026-11-18 真机新增）：
   *   1 = 名字或 group 路径里含线索词（有证据）
   *   2 = 由线索词检索召回，但名字里不含（可能在正文）
   *   3 = 纯语义相似（无任何字面证据）
   *
   * 为什么需要它：`score` 是**库内相对分位**，噪声文档只要在库内排第一就是 1.00 ——
   * 归档类超长文档（`archive.md`）因此恒居首位，真目标被挤出 top3。分级不依赖分数。
   */
  const tierByKey = new Map<string, 1 | 2 | 3>();

  for (const row of scored) {
    const key = `${row.scope}\u0000${row.group}\u0000${row.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (exclude.scoped.has(key) || exclude.loose.has(`${row.group}\u0000${row.name}`)) {
      dropped += 1;
      continue;
    }

    const rel = deps.cachesOf(row.scope).get(row.group)?.hot_relations.find((r) => r.text === row.name);
    if (!rel) {
      // 索引里已不存在（删除/重建期间）—— 不能把幽灵文档推给调用方
      dropped += 1;
      continue;
    }
    const visibility = resolveVisibility(row.scope, rel);
    if (visibility === 'hidden') {
      // 只计数不暴露名字：hidden 的语义就是"对我不可见"
      excludedHidden += 1;
      continue;
    }

    const haystack = `${row.group} ${row.name}`.toLowerCase();
    const matched = terms.tokens.filter((t) => haystack.includes(t.toLowerCase())).slice(0, 3);
    // tier1 = 名字含线索 **且** 检索本身够强（库内前 N 或相对分够高），否则降到 tier2
    const strongHit = row.rankInScope <= TIER1_MAX_RANK || row.score >= TIER1_MIN_SCORE;
    const tier: 1 | 2 | 3 = matched.length > 0 && strongHit ? 1 : row.via === 'terms' ? 2 : 3;
    viaByKey.set(key, row.via);
    matchedByKey.set(key, matched);
    tierByKey.set(key, tier);
    survivors.push({
      scope: row.scope,
      group: row.group,
      name: row.name,
      score: row.score,
      rankInScope: row.rankInScope,
      why: '',
      visibility,
      weak: tier === 3 || row.score < 0.6,
      chunkHits: Math.max(0, (chunkHits.get(key) ?? 1) - 1),
    });
  }

  // ⑪ 同名提示：**只从已过可见性的 survivors 推导**（hidden 不得经 alsoIn 泄漏）
  const scopesByDoc = new Map<string, string[]>();
  for (const c of survivors) {
    const docKey = `${c.group}\u0000${c.name}`;
    const list = scopesByDoc.get(docKey) ?? [];
    if (!list.includes(c.scope)) list.push(c.scope);
    scopesByDoc.set(docKey, list);
  }

  // ⑨ 排序（先按相关性分级，再按库内名次）→ 相关性下限 → 每库配额 → 总数上限
  const tierOf = (c: RecallCandidate): 1 | 2 | 3 => (
    tierByKey.get(`${c.scope}\u0000${c.group}\u0000${c.name}`) ?? 3
  );
  const ordered = survivors.sort((a, b) => (
    tierOf(a) - tierOf(b) || a.rankInScope - b.rankInScope || b.score - a.score || a.name.localeCompare(b.name)
  ));

  /*
   * 相关性下限（2026-11-18 真机）：优先只保留 tier1/2。
   * 没有下限时每个库必凑满 3 条 —— 语料的未命中组（M1~M5）因此永远能拿到"看似相关"的清单，
   * 调用方也就永远看不到「确实没找到」。tier3（纯语义）只在一条强候选都没有时补 ≤2 条，并标 weak。
   */
  const strongEnough = ordered.filter((c) => tierOf(c) <= 2);
  const weakOnly = ordered.filter((c) => tierOf(c) > 2).slice(0, 2);
  const pool = strongEnough.length > 0 ? strongEnough : weakOnly;

  const limit = Math.min(Math.max(1, req.limit || DEFAULT_LIMIT), MAX_LIMIT);
  const perScope = new Map<string, number>();
  const picked: RecallCandidate[] = [];
  for (const c of pool) {
    if (picked.length >= limit) break;
    const used = perScope.get(c.scope) ?? 0;
    if (used >= PER_SCOPE_CAP) continue;
    perScope.set(c.scope, used + 1);
    picked.push(c);
  }

  // ⑩ 理由（alsoIn 只对本条候选所在库之外的其他库做提示）
  const candidates = picked.map((c) => {
    const key = `${c.scope}\u0000${c.group}\u0000${c.name}`;
    const others = (scopesByDoc.get(`${c.group}\u0000${c.name}`) ?? []).filter((s) => s !== c.scope);
    const via = viaByKey.get(key);
    return {
      ...c,
      ...(others.length > 0 ? { alsoIn: others } : {}),
      why: buildWhy({
        matched: matchedByKey.get(key) ?? [],
        rankInScope: c.rankInScope,
        ...(via ? { via, hitTerms: terms.strong.length > 0 ? terms.strong : terms.tokens } : {}),
        ...(others.length > 0 ? { alsoIn: others } : {}),
      }),
    };
  });

  return {
    ...base,
    query,
    candidates,
    excludedHidden,
    dropped,
    needMore: buildNeedMore({
      blocks: terms.blocks,
      tokens: terms.tokens,
      candidateCount: candidates.length,
      scopeCount: resolved.targets.length,
    }),
    durationMs: now() - started,
  };
}
