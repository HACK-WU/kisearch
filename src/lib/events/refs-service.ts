/**
 * 参考文档服务（REQ-20261113-004 · S-05）
 *
 * 两件事：维护引用关系、为"AI 查找"产出候选。
 *
 * 三个刻意的取舍：
 *   1. **候选检索不调 LLM**：要可复现、可断言（A15「每步数字与真实召回量一致」）。
 *      LLM 参与会让同一输入产出不同 `why` 与顺序，测试只能写"看起来差不多"。
 *   2. **加入/移除不写被引文档任何字段**（A13 红线）：引用是事件侧的关系，
 *      写到 `Relation` 上会污染文档属性，且被引文档被删时留下脏字段。
 *   3. **悬空引用保留并标 `stale`**：静默清理会让用户以为"引用没加成功"（N10）。
 *
 * 检索实现由调用方注入（`deps.search`）：本层不直接依赖 `search.ts`，
 * 既避免循环依赖，也让候选链路能在离线环境完整验证。
 */

import { readAllGroupCaches } from '../group-cache.js';
import { readAllEvents, findEventIn, isEventClosed } from './store.js';
import { addRefDocs, readRefs, removeRefDoc } from './refs-store.js';
import { getType, resolveStageVisibility } from './type-service.js';
import { collectMembers } from './event-service.js';
import { resolveVisibilityOfRelation } from '../visibility-index.js';
import { GovernanceError } from '../governance-errors.js';
import type { EventRefDoc, Visibility } from './types.js';

const TOP_K_DEFAULT = 12;
const CANDIDATE_LIMIT_DEFAULT = 5;
/** 归一化后 >= 0.6 默认勾选；这是**批次内相对分位**，不是绝对相似度 */
const THRESHOLD = 0.6;
const REF_LIMIT = 50;

/**
 * 一步里**真实发生**的一次调用（用于过程面板的调用行）。
 *
 * 只记真的调了东西的：`ki_search` 走引擎（语义 + 全文）；本地分片读 / 纯函数计算不记 ——
 * 后者标成"skill"或"MCP"就是伪造（demo 的 `event-context` / `relevance-rank` 两个 skill
 * 在本功能里并不存在，不得照搬）。
 */
export interface RefSearchCall {
  kind: 'tool' | 'skill';
  /** 机器名，给人核对（与 chat 工具行的"工具名胶囊"同口径） */
  name: string;
  /** 人话动作名 */
  label: string;
  ms: number;
  /** 可选的补充说明（如降级原因） */
  note?: string;
}

export interface RefSearchStep {
  name: 'understand' | 'extract' | 'search' | 'exclude' | 'rank';
  ms: number;
  metrics: Record<string, number | string>;
  detail?: Record<string, unknown>;
  calls?: RefSearchCall[];
}

export interface RefCandidate {
  group: string;
  name: string;
  /** 同批次 min-max 归一化后的相对分（0~1），不是绝对相似度 */
  score: number;
  why: string;
  matchedKeywords: string[];
  weak: boolean;
  /** 该文档自身的检索可见性（**不是**事件阶段档位）；被引文档被删时兜底 full，与 listRefs 同口径 */
  visibility: Visibility;
  /** 去重前的 chunk 命中数（同一文档可能多个 chunk 命中） */
  chunkHits: number;
}

/** 0 候选的原因：前端据此写不一样的空态文案，不许一律「没有相关文档」 */
export type RefSearchReason = 'no-keywords' | 'empty-scope' | 'no-hits' | 'all-excluded';

export interface RefSearchResult {
  candidates: RefCandidate[];
  steps: RefSearchStep[];
  excluded: { associated: string[]; added: string[] };
  total: number;
  durationMs: number;
  /** 实际发给检索的 query（过程面板要展示，不让前端自己拼） */
  query: string;
  reason?: RefSearchReason;
  /** 实际检索模式：`fulltext` = 语义侧不可用已降级（面板必须如实显示，不能一律写 hybrid） */
  mode?: 'hybrid' | 'fulltext';
  degraded?: boolean;
  degradedReason?: string;
}

export interface RefSearchOutcome {
  hits: Array<{ group: string; name: string; score: number }>;
  /** 缺省按 hybrid（executeSearch 未标 fulltext 即 hybrid） */
  mode?: 'hybrid' | 'fulltext';
  degraded?: boolean;
  degradedReason?: string;
}

export interface RefSearchDeps {
  /**
   * 语义检索（生产用 `executeSearch` 适配器）。返回 score 为原始量纲，本层负责归一化。
   *
   * 同时接受裸数组：早期测试 fake 只回命中列表，没必要为了一个可选元数据全量改测试；
   * 生产路径走 `RefSearchOutcome`，好让面板能如实显示 mode / 降级原因。
   */
  search: (args: { scope: string; query: string; topK: number }) => Promise<RefSearchOutcome | Array<{ group: string; name: string; score: number }>>;
}

// 极简停用词：只处理会在中文标题里高频出现、但对检索无区分度的词
const STOP_WORDS = new Set(['的', '了', '和', '与', '及', '在', '是', '有', '不', '为', '对', '把', '被', '一个', '记录', '问题', '排查']);

/**
 * 从事件标题 + 关联文档名提取线索词（去重、去停用词、长度 ≥ 2）。
 *
 * **刻意不含类型名**（偏离 S-05 §3.2 原设计，2026-11-15 实测后修正）：
 * 内置类型名是「bug 排查 / 性能问题 / 需求交付」这类模板词，几乎每个事件都带同一个词，
 * 对 query 是常量噪声而非区分信号；更关键的是它会让「提不出线索词」这条路径**永不触发**
 * —— 于是没线索的事件也会跑去检索，单条命中还会被归一化成 1.0 默认勾选。
 */
export function extractKeywords(title: string, memberNames: string[]): string[] {
  const raw = [title, ...memberNames].join(' ');
  const tokens = raw
    .split(/[\s,，。、;；:：!！?？()（）[\]【】"“”'‘’/\\|·\-—_]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return [...new Set(tokens)].slice(0, 8);
}

function mustEvent(scope: string, eventRef: string) {
  const event = findEventIn(readAllEvents(scope), eventRef);
  if (!event) {
    throw new GovernanceError('EVENT_NOT_FOUND', `事件「${eventRef}」不存在`, {
      available: readAllEvents(scope).filter((e) => !isEventClosed(e)).slice(0, 5)
        .map((e) => ({ id: e.id, shortId: e.shortId, title: e.title })),
    });
  }
  return event;
}

/** 库内文档总数（口径：分片里的全部 relation，一个 chunk 行不算） */
function countAllDocs(caches: ReturnType<typeof readAllGroupCaches>): number {
  let total = 0;
  for (const [, doc] of caches) total += doc.hot_relations.length;
  return total;
}

export interface ListRefsResult {
  refs: Array<EventRefDoc & { stale: boolean; visibility: Visibility }>;
}

/** 列出引用；被引文档已不存在时标 `stale`（不静默清理） */
export function listRefs(scope: string, eventRef: string): ListRefsResult {
  const event = mustEvent(scope, eventRef);
  const refs = readRefs(scope, event.id);

  const byGroup = new Map<string, Set<string>>();
  for (const ref of refs) {
    const set = byGroup.get(ref.group) ?? new Set<string>();
    set.add(ref.name);
    byGroup.set(ref.group, set);
  }
  const caches = readAllGroupCaches(scope);

  return {
    refs: refs.map((ref) => {
      const doc = caches.get(ref.group);
      const rel = doc?.hot_relations.find((r) => r.text === ref.name);
      if (!rel) return { ...ref, stale: true, visibility: 'full' as Visibility };
      const resolved = resolveVisibilityOfRelation(scope, rel);
      return { ...ref, stale: false, visibility: resolved.mode };
    }),
  };
}

/**
 * 候选检索（5 步，每步 metrics 必须来自真实执行结果）。
 *
 * 分数口径：`search` 返回的是 RRF 融合分（本机实测 0.02~0.03 量级），
 * 因此阈值只能按**同批次 min-max 归一化**后的相对分位理解，不能当绝对相似度。
 */
export async function searchRefCandidates(
  scope: string,
  eventRef: string,
  deps: RefSearchDeps,
  opts: { topK?: number; limit?: number; threshold?: number } = {},
): Promise<RefSearchResult> {
  const started = Date.now();
  const steps: RefSearchStep[] = [];

  const event = mustEvent(scope, eventRef);
  const type = getType(scope, event.typeId);
  const { visibility } = resolveStageVisibility(type, event.stageKey);

  // ① 理解事件
  const step1Start = Date.now();
  steps.push({
    name: 'understand',
    // 不夹到 ≥1ms：这几步常是亚毫秒，抬成 1ms 就是在面板上编数字（前端把 0 渲染成 `<1ms`）
    ms: Date.now() - step1Start,
    metrics: { stages: type?.stages.length ?? 0, visibility },
  });

  const members = collectMembers(scope, event.id);
  const added = readRefs(scope, event.id);
  // 分片只读一次：文档总数与逐候选可见性都复用它（N 次读会随候选数放大）
  const caches = readAllGroupCaches(scope);
  const total = countAllDocs(caches);

  // ② 提取线索（类型名不进 query，理由见 extractKeywords 注释）
  const step2Start = Date.now();
  const keywords = extractKeywords(event.title, members.map((m) => m.name));
  const query = keywords.join(' ');
  steps.push({
    name: 'extract',
    ms: Date.now() - step2Start,
    metrics: { keywords: keywords.length, sources: members.length },
    detail: { keywords },
  });

  // ③ 语义检索
  const searchStart = Date.now();
  const topK = Math.min(Math.max(opts.topK ?? TOP_K_DEFAULT, 1), 50);
  const rawOutcome = keywords.length > 0
    ? await deps.search({ scope, query, topK })
    : { hits: [] as Array<{ group: string; name: string; score: number }> };
  const outcome: RefSearchOutcome = Array.isArray(rawOutcome) ? { hits: rawOutcome } : rawOutcome;
  const hits = outcome.hits;
  // mode 必须如实取：`executeSearch` 在语义不可用时会降级为全文，写死 hybrid 等于骗人
  const mode: 'hybrid' | 'fulltext' = outcome.mode ?? 'hybrid';
  const searchMs = Date.now() - searchStart;

  // ③b 文档聚合：search 返回的是 **chunk 级** 命中，同篇文档多 chunk 会重复占位，
  //     并把它在 min-max 里的权重叠高 —— 必须按 (group, name) 收敛，取最高分、记命中数
  const byDoc = new Map<string, { group: string; name: string; score: number; chunkHits: number }>();
  for (const h of hits) {
    if (!h.group || !h.name) continue;   // 辅助通道命中无 relation，定位不到文档
    const key = `${h.group}\u0000${h.name}`;
    const prev = byDoc.get(key);
    if (!prev) {
      byDoc.set(key, { group: h.group, name: h.name, score: h.score, chunkHits: 1 });
      continue;
    }
    prev.chunkHits += 1;
    if (h.score > prev.score) prev.score = h.score;
  }
  const docs = [...byDoc.values()];

  steps.push(keywords.length === 0
    ? {
        name: 'search',
        ms: searchMs,
        metrics: { total, hits: 0, docs: 0, mode },
        detail: { note: '标题未提取到线索词，跳过检索' },
      }
    : {
        name: 'search',
        ms: searchMs,
        metrics: { total, hits: hits.length, docs: docs.length, mode, ...(outcome.degraded ? { degraded: 1 } : {}) },
        // 展开可见的参数：与 demo 的「query / mode / scope / 命中」同口径，全部是真实值
        detail: {
          query,
          mode,
          scope,
          ...(outcome.degraded ? { degradedReason: outcome.degradedReason ?? '语义检索不可用，已降级为全文检索' } : {}),
        },
        calls: [{
          kind: 'tool',
          name: 'ki_search',
          label: '语义检索',
          ms: searchMs,
          ...(mode === 'fulltext' ? { note: '语义侧不可用，本次为全文检索' } : {}),
        }],
      });

  // ④ 排除：已关联（Relation.eventId）+ 已加入（refs）
  const excludeStart = Date.now();
  const associatedKeys = new Set(members.map((m) => `${m.group}\u0000${m.name}`));
  const addedKeys = new Set(added.map((r) => `${r.group}\u0000${r.name}`));
  const remaining = docs.filter((h) => {
    const key = `${h.group}\u0000${h.name}`;
    return !associatedKeys.has(key) && !addedKeys.has(key);
  });
  steps.push({
    name: 'exclude',
    ms: Date.now() - excludeStart,
    metrics: { associated: associatedKeys.size, added: addedKeys.size, remaining: remaining.length },
  });

  // ⑤ 排序 + 归一化 + 可见性
  const rankStart = Date.now();
  const rawScores = remaining.map((h) => h.score);
  const maxRaw = rawScores.length > 0 ? Math.max(...rawScores) : 0;
  const minRaw = rawScores.length > 0 ? Math.min(...rawScores) : 0;
  const normalize = (raw: number) => (maxRaw > minRaw ? (raw - minRaw) / (maxRaw - minRaw) : 1);

  const threshold = opts.threshold ?? THRESHOLD;
  const limit = Math.min(Math.max(opts.limit ?? CANDIDATE_LIMIT_DEFAULT, 1), 20);
  const memberGroups = new Set(members.map((m) => m.group));

  const candidates: RefCandidate[] = remaining
    .map((h) => {
      const score = normalize(h.score);
      const matched = keywords.filter((k) => h.name.includes(k) || h.group.includes(k)).slice(0, 3);
      const whyParts: string[] = [];
      if (matched.length > 0) whyParts.push(`命中「${matched.join(' / ')}」`);
      if (memberGroups.has(h.group)) whyParts.push(`与关联文档同属「${h.group}」`);
      // 候选的可见性取**文档自身**（与 listRefs 同口径）；被引文档刚被删时兜底 full
      const rel = caches.get(h.group)?.hot_relations.find((r) => r.text === h.name);
      const docVisibility: Visibility = rel ? resolveVisibilityOfRelation(scope, rel).mode : 'full';
      return {
        group: h.group,
        name: h.name,
        score: Number(score.toFixed(2)),
        why: whyParts.join(' · ') || '语义相似',
        matchedKeywords: matched,
        weak: score < threshold,
        visibility: docVisibility,
        chunkHits: h.chunkHits,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  steps.push({
    name: 'rank',
    ms: Date.now() - rankStart,
    metrics: { candidates: candidates.length, threshold },
  });

  // 0 候选的原因：四种情况对用户意味着完全不同的下一步动作，不能合并成一句空话
  const reason: RefSearchReason | undefined = keywords.length === 0
    ? 'no-keywords'
    : total === 0
      ? 'empty-scope'
      : hits.length === 0
        ? 'no-hits'
        : remaining.length === 0
          ? 'all-excluded'
          : undefined;

  return {
    candidates,
    steps,
    excluded: { associated: [...associatedKeys].map((k) => k.split('\u0000')[1]), added: [...addedKeys].map((k) => k.split('\u0000')[1]) },
    total,
    durationMs: Date.now() - started,
    query,
    mode,
    ...(outcome.degraded ? { degraded: true } : {}),
    ...(outcome.degradedReason ? { degradedReason: outcome.degradedReason } : {}),
    ...(reason ? { reason } : {}),
  };
}

export interface AddRefsInput {
  docs: Array<{ group: string; name: string; score?: number }>;
  addedBy: 'ai' | 'manual';
}

export function addRefs(scope: string, eventRef: string, input: AddRefsInput): { added: number; skipped: string[] } {
  const event = mustEvent(scope, eventRef);
  const existing = readRefs(scope, event.id);
  if (existing.length + input.docs.length > REF_LIMIT) {
    throw new GovernanceError(
      'REF_LIMIT_EXCEEDED',
      `单个事件最多 ${REF_LIMIT} 条参考文档（当前 ${existing.length} 条，本次 ${input.docs.length} 条），请先清理`,
    );
  }

  const associated = new Set(collectMembers(scope, event.id).map((m) => `${m.group}\u0000${m.name}`));
  const now = Date.now();
  const accepted: EventRefDoc[] = [];
  const skipped: string[] = [];

  for (const doc of input.docs) {
    if (associated.has(`${doc.group}\u0000${doc.name}`)) {
      throw new GovernanceError(
        'REF_ALREADY_ASSOCIATED',
        `「${doc.name}」已作为关联文档挂在事件 #${event.shortId} 上，无需再加为参考文档`,
        { group: doc.group, name: doc.name },
      );
    }
    accepted.push({
      scope,
      group: doc.group,
      name: doc.name,
      addedBy: input.addedBy,
      addedAt: now,
      ...(doc.score !== undefined ? { score: doc.score } : {}),
    });
  }

  const result = addRefDocs(scope, event.id, accepted, now);
  for (const dup of result.skipped) skipped.push(`${dup.group}/${dup.name}`);
  return { added: result.added.length, skipped };
}

export function removeRef(scope: string, eventRef: string, group: string, name: string): boolean {
  const event = mustEvent(scope, eventRef);
  const removed = removeRefDoc(scope, event.id, group, name, Date.now());
  if (!removed) {
    throw new GovernanceError('REF_NOT_FOUND', `引用不存在：${group}/${name}`);
  }
  return true;
}

/**
 * 供 UI「手动添加」用的文档搜索：按名精确/包含匹配，走向量反而引入噪声。
 *
 * `eventId` 传了就排除「该事件已关联」与「已加入参考文档」的文档（R31 的服务端兜底）。
 * 不在前端做：前端只能覆盖"弹窗打开后别人加过"的竞态，覆盖不了初始集合，
 * 而且两份数据集（members / refs）在前端并不同源。
 *
 * `q` 为空时**不过滤**，返回可加入的前 `limit` 篇 —— 对齐 demo：打开弹窗即能看到有哪些可加，
 * 不必先猜关键词（此前空查询直接返回 `[]`，弹窗里一片空白且没有任何提示）。
 */
export function searchDocsForAdd(
  scope: string,
  q: string,
  limit = 20,
  opts: { eventId?: string } = {},
): Array<{ group: string; name: string; visibility: Visibility }> {
  // 空查询 = 列可加入的前 N 篇（对齐 demo：打开弹窗就能看到有哪些可加，不必先猜关键词）
  const query = q.trim().toLowerCase();

  let excluded: Set<string> | null = null;
  if (opts.eventId) {
    const event = mustEvent(scope, opts.eventId);   // 事件不存在要显式报错，不静默返回空
    excluded = new Set([
      ...collectMembers(scope, event.id).map((m) => `${m.group}\u0000${m.name}`),
      ...readRefs(scope, event.id).map((r) => `${r.group}\u0000${r.name}`),
    ]);
  }

  const out: Array<{ group: string; name: string; visibility: Visibility }> = [];
  for (const [group, doc] of readAllGroupCaches(scope)) {
    for (const rel of doc.hot_relations) {
      if (excluded?.has(`${group}\u0000${rel.text}`)) continue;
      // query 为空时不过滤（列全部可加入的），非空时按名 / 路径包含匹配
      if (query && !rel.text.toLowerCase().includes(query) && !group.toLowerCase().includes(query)) continue;
      out.push({ group, name: rel.text, visibility: resolveVisibilityOfRelation(scope, rel).mode });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
