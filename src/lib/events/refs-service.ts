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
import { readAllEvents, readEventTypes, findEventIn, isEventClosed } from './store.js';
import { addRefDocs, readRefs, refKey, removeRefDoc } from './refs-store.js';
import { listAllScopes } from '../scope.js';
import { isScopeAccessAllowed } from '../scope-access.js';
import { loadConfig } from '../config.js';
import { readViews } from '../scope-view.js';
import { countDocsByTargets } from './find-targets.js';
import { getType, resolveStageVisibility } from './type-service.js';
import { collectMembers } from './members.js';
import { resolveVisibility, resolveVisibilityOfRelation } from '../visibility-index.js';
import { GovernanceError } from '../governance-errors.js';
import type { EventRefDoc, Visibility } from './types.js';

const TOP_K_DEFAULT = 12;
const CANDIDATE_LIMIT_DEFAULT = 5;
/** 归一化后 >= 0.6 默认勾选；这是**批次内相对分位**，不是绝对相似度 */
const THRESHOLD = 0.6;
/** 单事件参考文档上限（`createEvent` 预检也要用，故导出） */
export const REF_LIMIT = 50;

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
  /** 调用入参（已截断 300 字；skill 调用可能为空） */
  args?: string;
  /** 工具返回（已截断 2000 字；note 记的是错误/降级摘要，不是返回体） */
  response?: string;
  /** 返回原文长度（用于 UI 标「已截断（原文 N 字）」）；无 response 时不写 */
  responseChars?: number;
}

export interface RefSearchStep {
  /**
   * 快速通道用前五个；深度通道（二期）用 `tools`（每轮一条，带真实工具调用行）与
   * `verify`（模型输出 → 三重校验）。与 `RefSearchStepDto` 的类型保持同形。
   */
  name: 'understand' | 'extract' | 'search' | 'exclude' | 'rank' | 'tools' | 'verify';
  ms: number;
  metrics: Record<string, number | string>;
  detail?: Record<string, unknown>;
  /**
   * 这一步里模型的思考片段（reasoning 流），单步截断 2000 字。
   * 旧数据无该字段；只在模型真的产出 reasoning 时写入。
   */
  thinking?: string;
  calls?: RefSearchCall[];
}

export interface RefCandidate {
  /** 通道来源：fast = 确定性五步；deep = LLM 深度查找（REQ-20261116-005）。前端据此决定默认勾选策略 */
  origin: 'fast' | 'deep';
  /** 候选文档所在库（视图检索时是成员库，不是视图名）；单库时等于请求 scope */
  scope: string;
  group: string;
  name: string;
  /** fast：同批次 min-max 归一化后的相对分（0~1）；deep：源库内最后一次命中分（0 = 未检索到） */
  score: number;
  /** 源库内分数名次（1 = 库内最高）；deep 通道无检索分时省略 */
  rankInScope?: number;
  /** 原始检索分（跨库不可比，仅供排障） */
  rawScore?: number;
  why: string;
  matchedKeywords: string[];
  weak: boolean;
  /** 该文档自身的检索可见性（**不是**事件阶段档位）；被引文档被删时兜底 full，与 listRefs 同口径 */
  visibility: Visibility;
  /** `visibility='hidden'` 时给出原因与来源事件，供 UI 强提示（未收口可加入、已收口禁止） */
  visibilityReason?: { kind: 'event-open' | 'event-closed'; eventId: string; shortId: number; title: string };
  /** 去重前的 chunk 命中数（同一文档可能多个 chunk 命中） */
  chunkHits: number;
}

/** 0 候选的原因：前端据此写不一样的空态文案，不许一律「没有相关文档」 */
export type RefSearchReason = 'no-keywords' | 'empty-scope' | 'no-hits' | 'all-excluded';

export interface RefSearchResult {
  candidates: RefCandidate[];
  steps: RefSearchStep[];
  excluded: { associated: string[]; added: string[] };
  /**
   * 参与检索的**不同物理库**的文档数之和（视图按成员库展开，重叠不重复计）。
   * ⚠️ 不等于 `totalByScope` 各行相加：事件库常常同时是某个视图的成员。
   */
  total: number;
  /**
   * 按 target 的文档数（视图显示成员库之和）。
   * ⚠️ 各行相加**不等于** `total` —— 视图成员与事件库重叠时会被算两遍。
   */
  totalByScope?: Array<{ scope: string; docs: number }>;
  /** 本次实际参与检索的单元（库名或视图名），顺序 = [事件库, ...extraScopes] */
  targets?: string[];
  /** 部分 target 检索失败（其余结果仍有效；全部失败才是 503） */
  targetErrors?: Array<{ name: string; error: string }>;
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
  /** `scope`：视图检索时是**成员库**（用它回指源库，不能写视图名）；单库时缺省 */
  hits: Array<{ group: string; name: string; score: number; scope?: string }>;
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
  /**
   * 视图名 → 成员库；不是视图返回 `null`。
   *
   * 只有"按 target 统计文档数"需要它：视图不是物理库，`readAllGroupCaches(视图名)`
   * 恒为空，直接用会把视图算成 0 篇。检索本身不需要（`executeSearch` 内部已展开）。
   *
   * 缺省实现读 `views.json`（每次查找懒加载一次）；测试注入以免依赖本机配置。
   */
  viewMembers?: (name: string) => string[] | null;
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
  refs: Array<EventRefDoc & { stale: boolean; staleReason?: 'doc-deleted' | 'scope-missing'; visibility: Visibility }>;
}

/**
 * 列出引用；被引文档已不存在时标 `stale`（不静默清理）。
 *
 * ★ 跨库（REQ-20261116-005）：可见性必须按**源库**解析，且 `stale` 要区分两种原因 ——
 *   「文档被删」与「源库已不存在/无权限」的用户下一步动作完全不同（找文档 vs 找库），
 *   合成一个布尔只能给含糊文案。
 */
export function listRefs(scope: string, eventRef: string): ListRefsResult {
  const event = mustEvent(scope, eventRef);
  const refs = readRefs(scope, event.id);
  if (refs.length === 0) return { refs: [] };

  let knownScopes: Set<string>;
  try {
    knownScopes = new Set(listAllScopes());
  } catch {
    knownScopes = new Set([scope]);
  }
  const cachesByScope = new Map<string, ReturnType<typeof readAllGroupCaches>>();
  const cachesOf = (s: string): ReturnType<typeof readAllGroupCaches> => {
    let c = cachesByScope.get(s);
    if (!c) {
      c = readAllGroupCaches(s);
      cachesByScope.set(s, c);
    }
    return c;
  };

  return {
    refs: refs.map((ref) => {
      const src = ref.sourceScope ?? scope;
      if (!knownScopes.has(src)) {
        return { ...ref, stale: true, staleReason: 'scope-missing' as const, visibility: 'full' as Visibility };
      }
      const rel = cachesOf(src).get(ref.group)?.hot_relations.find((r) => r.text === ref.name);
      if (!rel) {
        return { ...ref, stale: true, staleReason: 'doc-deleted' as const, visibility: 'full' as Visibility };
      }
      const resolved = resolveVisibilityOfRelation(src, rel);
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
  opts: { targets?: string[]; topK?: number; limit?: number; threshold?: number } = {},
): Promise<RefSearchResult> {
  const started = Date.now();
  const steps: RefSearchStep[] = [];

  const event = mustEvent(scope, eventRef);
  const type = getType(scope, event.typeId);
  const { visibility } = resolveStageVisibility(type, event.stageKey);

  /**
   * 检索单元：**事件所在库恒在首位**（调用方已单独鉴权过它），其余来自 find 配置。
   * 去重是必须的：配置里显式写了当前库也不能查两遍。
   */
  const requested = (opts.targets ?? []).map((t) => t.trim()).filter(Boolean);
  const targets = [...new Set([scope, ...requested])];

  // ① 理解事件
  const step1Start = Date.now();
  steps.push({
    name: 'understand',
    // 不夹到 ≥1ms：这几步常是亚毫秒，抬成 1ms 就是在面板上编数字（前端把 0 渲染成 `<1ms`）
    ms: Date.now() - step1Start,
    metrics: { stages: type?.stages.length ?? 0, visibility, targets: targets.length },
  });

  const members = collectMembers(scope, event.id);
  const added = readRefs(scope, event.id);
  /**
   * 分片按库各读一次并缓存：文档总数、逐候选可见性、源库 lookup 都要用。
   * 逐候选读会在「库数 × 候选数」上放大（v1 单库时一次读就够）。
   */
  const cachesByScope = new Map<string, ReturnType<typeof readAllGroupCaches>>();
  const cachesOf = (s: string): ReturnType<typeof readAllGroupCaches> => {
    let c = cachesByScope.get(s);
    if (!c) {
      c = readAllGroupCaches(s);
      cachesByScope.set(s, c);
    }
    return c;
  };
  /**
   * 视图目标的文档数必须按**成员库求和**：视图不是物理库，`readAllGroupCaches(视图名)`
   * 恒为空 —— 直接统计会把"配了视图"显示成 0 篇，`total === 0` 时还会误判 `empty-scope`。
   */
  let viewsLazy: Record<string, { members: string[] }> | null = null;
  const viewMembersOf = (name: string): string[] | null => {
    if (deps.viewMembers) return deps.viewMembers(name);
    if (viewsLazy === null) {
      try {
        viewsLazy = readViews(loadConfig());
      } catch {
        // views.json 读不出来：按"不是视图"处理（检索阶段的真实失败会进 targetErrors）
        viewsLazy = {};
      }
    }
    const view = viewsLazy[name];
    return view && Array.isArray(view.members) ? view.members : null;
  };
  // 成员库的 caches 顺带进缓存：后面的候选可见性 / 源库 lookup 直接复用
  const { rows: totalByScope, total } = countDocsByTargets(targets, {
    viewMembers: viewMembersOf,
    cachesOf: (s) => cachesOf(s) as unknown as Map<string, { hot_relations: unknown[] }>,
  });

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

  // ③ 多库检索：**逐 target 调用**，单个库失败只标记不整体失败
  //    （一次多库请求的局部失败会整体降级，且无法分库统计）
  const searchStart = Date.now();
  const topK = Math.min(Math.max(opts.topK ?? TOP_K_DEFAULT, 1), 50);
  const hits: Array<{ group: string; name: string; score: number; sourceScope: string }> = [];
  const targetErrors: Array<{ name: string; error: string }> = [];
  let mode: 'hybrid' | 'fulltext' = 'hybrid';
  let degraded = false;
  let degradedReason: string | undefined;
  let succeededTargets = 0;

  if (keywords.length > 0) {
    for (const target of targets) {
      try {
        const raw = await deps.search({ scope: target, query, topK });
        const outcome: RefSearchOutcome = Array.isArray(raw) ? { hits: raw } : raw;
        succeededTargets += 1;
        // 取"最差"的 mode：任一库降级就必须如实显示降级（不能因主库正常就写 hybrid）
        if ((outcome.mode ?? 'hybrid') === 'fulltext') mode = 'fulltext';
        if (outcome.degraded) degraded = true;
        if (outcome.degradedReason && !degradedReason) degradedReason = outcome.degradedReason;
        for (const h of outcome.hits) {
          if (!h.group || !h.name) continue;   // 辅助通道命中无 relation，定位不到文档
          // 视图检索时 `hit.scope` 是**成员库**，必须用它回指（不是视图名）
          hits.push({ group: h.group, name: h.name, score: h.score, sourceScope: h.scope ?? target });
        }
      } catch (err) {
        targetErrors.push({ name: target, error: (err as Error).message });
      }
    }
    if (succeededTargets === 0) {
      throw new GovernanceError(
        'SEARCH_UNAVAILABLE',
        `向量检索不可用：${targetErrors[0]?.error ?? '未知错误'}`,
        { targets },
      );
    }
  }
  const searchMs = Date.now() - searchStart;

  // ③b 文档聚合：search 返回的是 **chunk 级** 命中，同篇文档多 chunk 会重复占位，
  //     并把它在 min-max 里的权重叠高 —— 按 (源库, group, name) 收敛，取最高分、记命中数
  const byDoc = new Map<string, { sourceScope: string; group: string; name: string; score: number; chunkHits: number }>();
  for (const h of hits) {
    const key = `${h.sourceScope}\u0000${h.group}\u0000${h.name}`;
    const prev = byDoc.get(key);
    if (!prev) {
      byDoc.set(key, { sourceScope: h.sourceScope, group: h.group, name: h.name, score: h.score, chunkHits: 1 });
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
        metrics: { total, hits: 0, docs: 0, mode, targets: targets.length },
        detail: { note: '标题未提取到线索词，跳过检索' },
      }
    : {
        name: 'search',
        ms: searchMs,
        metrics: {
          total,
          hits: hits.length,
          docs: docs.length,
          mode,
          targets: targets.length,
          ...(degraded ? { degraded: 1 } : {}),
          ...(targetErrors.length > 0 ? { targetErrors: targetErrors.length } : {}),
        },
        // 展开可见的参数：与 demo 的「query / mode / scope / 命中」同口径，全部是真实值
        detail: {
          query,
          mode,
          scope,
          targets,
          ...(degraded ? { degradedReason: degradedReason ?? '语义检索不可用，已降级为全文检索' } : {}),
          ...(targetErrors.length > 0 ? { targetErrors } : {}),
        },
        calls: [{
          kind: 'tool',
          name: 'ki_search',
          label: '语义检索',
          ms: searchMs,
          ...(mode === 'fulltext'
            ? { note: targets.length > 1 ? `范围：${targets.join('、')}；语义侧不可用，本次为全文检索` : '语义侧不可用，本次为全文检索' }
            : (targets.length > 1 ? { note: `范围：${targets.join('、')}` } : {})),
        }],
      });

  // ④ 排除：已关联（Relation.eventId）+ 已加入（refs）。**两者都必须带库维度**
  //    关联文档恒在事件库；引用按 `refKey`（sourceScope ?? 事件库）——
  //    只用 group+name 会把另一库的同名文档当成"已加入"而静默剔除。
  const excludeStart = Date.now();
  const associatedKeys = new Set(members.map((m) => `${scope}\u0000${m.group}\u0000${m.name}`));
  const addedKeys = new Set(added.map((r) => refKey(r)));
  const remaining = docs.filter((h) => {
    const key = `${h.sourceScope}\u0000${h.group}\u0000${h.name}`;
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

  /**
   * 库内排名：跨库分数**不可比**（不同 embedding 空间 + 全批次 min-max 的压缩效应），
   * 给"该文档在自己库里排第几"作参照，比让用户拿 0.87 横向比较可靠。
   */
  const rankByScope = new Map<string, Map<string, number>>();
  {
    const grouped = new Map<string, typeof remaining>();
    for (const h of remaining) {
      const arr = grouped.get(h.sourceScope) ?? [];
      arr.push(h);
      grouped.set(h.sourceScope, arr);
    }
    for (const [src, arr] of grouped) {
      const sorted = [...arr].sort((a, b) => b.score - a.score);
      rankByScope.set(src, new Map(sorted.map((h, i) => [`${h.group}\u0000${h.name}`, i + 1])));
    }
  }

  /** 源库事件表按库读一次（hidden 候选要说明"被哪个事件锁住"，不能逐候选全量读） */
  const eventsByScope = new Map<string, ReturnType<typeof readAllEvents>>();
  const eventsOf = (s: string): ReturnType<typeof readAllEvents> => {
    let list = eventsByScope.get(s);
    if (!list) {
      list = readAllEvents(s);
      eventsByScope.set(s, list);
    }
    return list;
  };

  const candidates: RefCandidate[] = remaining
    .map((h) => {
      const score = normalize(h.score);
      const matched = keywords.filter((k) => h.name.includes(k) || h.group.includes(k)).slice(0, 3);
      const whyParts: string[] = [];
      if (matched.length > 0) whyParts.push(`命中「${matched.join(' / ')}」`);
      if (memberGroups.has(h.group)) whyParts.push(`与关联文档同属「${h.group}」`);
      // 可见性取**文档自身**，且必须按**源库**解析（用事件库解析会把跨库文档误判成 full）
      const rel = cachesOf(h.sourceScope).get(h.group)?.hot_relations.find((r) => r.text === h.name);
      const docVisibility: Visibility = rel ? resolveVisibilityOfRelation(h.sourceScope, rel).mode : 'full';
      const visibilityReason = docVisibility === 'hidden' && rel?.eventId
        ? (() => {
          const owner = findEventIn(eventsOf(h.sourceScope), rel.eventId);
          if (!owner) return undefined;
          return {
            kind: (isEventClosed(owner) ? 'event-closed' : 'event-open') as 'event-closed' | 'event-open',
            eventId: owner.id,
            shortId: owner.shortId,
            title: owner.title,
          };
        })()
        : undefined;
      return {
        origin: 'fast' as const,
        scope: h.sourceScope,
        group: h.group,
        name: h.name,
        score: Number(score.toFixed(2)),
        rankInScope: rankByScope.get(h.sourceScope)?.get(`${h.group}\u0000${h.name}`),
        rawScore: h.score,
        why: whyParts.join(' · ') || '语义相似',
        matchedKeywords: matched,
        weak: score < threshold,
        visibility: docVisibility,
        ...(visibilityReason ? { visibilityReason } : {}),
        chunkHits: h.chunkHits,
      };
    })
    // 后两级排序：分数相同时不依赖 Map 插入顺序，保证同一输入结果稳定可断言
    .sort((a, b) => b.score - a.score
      || a.scope.localeCompare(b.scope)
      || `${a.group}\u0000${a.name}`.localeCompare(`${b.group}\u0000${b.name}`))
    .slice(0, limit);

  steps.push({
    name: 'rank',
    ms: Date.now() - rankStart,
    metrics: { candidates: candidates.length, threshold, targets: targets.length },
  });

  // 0 候选的原因：四种情况对用户意味着完全不同的下一步动作，不能合并成一句空话。
  // ★ `targetErrors` 非空时**不判 empty-scope** ——「查不了」≠「没内容」。
  const allTargetsOk = targetErrors.length === 0;
  const reason: RefSearchReason | undefined = keywords.length === 0
    ? 'no-keywords'
    : total === 0 && allTargetsOk
      ? 'empty-scope'
      : hits.length === 0
        ? (allTargetsOk ? 'no-hits' : undefined)
        : remaining.length === 0
          ? 'all-excluded'
          : undefined;

  return {
    candidates,
    steps,
    excluded: {
      // 键形如 `库\0group\0name`；对外仍只暴露**文档名**（面板文案与旧契约不变）
      associated: [...associatedKeys].map((k) => k.split('\u0000')[2] ?? ''),
      added: [...addedKeys].map((k) => k.split('\u0000')[2] ?? ''),
    },
    total,
    totalByScope,
    targets,
    ...(targetErrors.length > 0 ? { targetErrors } : {}),
    durationMs: Date.now() - started,
    query,
    mode,
    ...(degraded ? { degraded: true } : {}),
    ...(degradedReason ? { degradedReason } : {}),
    ...(reason ? { reason } : {}),
  };
}

export interface AddRefsInput {
  docs: Array<{ sourceScope?: string; group: string; name: string; score?: number }>;
  addedBy: 'ai' | 'manual';
  /**
   * 授权名字全集（含视图授权合并结果）。
   *
   * 由 HTTP 层从鉴权上下文注入（与 `assertScope` 同一来源）；缺省 = 跳过跨库鉴权，
   * 仅用于 CLI / 内部调用与测试 —— **HTTP 路由必须传**，否则跨库引用成了提权口子。
   */
  tokenScopes?: string[];
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

  // 关联文档恒在事件库，故键里固定用 scope
  const associated = new Set(collectMembers(scope, event.id).map((m) => `${scope}\u0000${m.group}\u0000${m.name}`));
  const eventsByScope = new Map<string, ReturnType<typeof readAllEvents>>();
  const eventsOf = (s: string): ReturnType<typeof readAllEvents> => {
    let list = eventsByScope.get(s);
    if (!list) {
      list = readAllEvents(s);
      eventsByScope.set(s, list);
    }
    return list;
  };
  const cachesByScope = new Map<string, ReturnType<typeof readAllGroupCaches>>();
  const cachesOf = (s: string): ReturnType<typeof readAllGroupCaches> => {
    let c = cachesByScope.get(s);
    if (!c) {
      c = readAllGroupCaches(s);
      cachesByScope.set(s, c);
    }
    return c;
  };

  const now = Date.now();
  const accepted: EventRefDoc[] = [];
  const skipped: string[] = [];

  for (const doc of input.docs) {
    const src = doc.sourceScope?.trim() || scope;

    // ① 跨库鉴权：只能引用授权范围内的库（配置只能收窄，不能提权）
    if (input.tokenScopes && !isScopeAccessAllowed(input.tokenScopes, src)) {
      throw new GovernanceError('FIND_TARGET_NOT_AUTHORIZED', `无权引用库「${src}」中的文档`, { sourceScope: src });
    }

    // ② 已作为关联文档（同一篇不能既当关联又当参考）
    if (associated.has(`${src}\u0000${doc.group}\u0000${doc.name}`)) {
      throw new GovernanceError(
        'REF_ALREADY_ASSOCIATED',
        `「${doc.name}」已作为关联文档挂在事件 #${event.shortId} 上，无需再加为参考文档`,
        { group: doc.group, name: doc.name, sourceScope: src },
      );
    }

    // ③ 存在性：伪造路径会写进 refs.json 变成永远解析不到的脏引用
    const rel = cachesOf(src).get(doc.group)?.hot_relations.find((r) => r.text === doc.name);
    if (!rel) {
      throw new GovernanceError(
        'REF_DOC_NOT_FOUND',
        `「${doc.group}/${doc.name}」在库「${src}」中不存在`,
        { sourceScope: src, group: doc.group, name: doc.name },
      );
    }

    // ④ 可检索性：被**已收口**事件锁在不可检索阶段 → 加进来也永远读不到；
    //    被**未收口**事件临时锁住 → 放行（事件流转到可检索阶段后即可用），前端负责强提示
    const resolved = resolveVisibilityOfRelation(src, rel);
    if (resolved.mode === 'hidden' && rel.eventId) {
      const owner = findEventIn(eventsOf(src), rel.eventId);
      if (!owner || isEventClosed(owner)) {
        throw new GovernanceError(
          'REF_DOC_NOT_SEARCHABLE',
          `「${doc.name}」被已收口事件${owner ? ` #${owner.shortId}` : ''}锁在不可检索阶段，加入后 AI 也读不到`,
          { sourceScope: src, eventId: owner?.id ?? null },
        );
      }
    }

    accepted.push({
      scope,
      ...(src !== scope ? { sourceScope: src } : {}),
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

/**
 * 移除一条引用。
 *
 * 两种调用形态都收：
 *   · `removeRef(scope, event, { sourceScope?, group, name })` —— 新（可区分跨库同名）；
 *   · `removeRef(scope, event, group, name)` —— 旧（按事件库匹配），保持既有调用方与测试可用。
 *
 * @param target.sourceScope 缺省 = 事件所在库（兼容老前端；老数据没有该字段）
 */
export function removeRef(
  scope: string,
  eventRef: string,
  target: { sourceScope?: string; group: string; name: string },
): boolean;
export function removeRef(scope: string, eventRef: string, group: string, name: string): boolean;
export function removeRef(
  scope: string,
  eventRef: string,
  targetOrGroup: { sourceScope?: string; group: string; name: string } | string,
  name?: string,
): boolean {
  const target = typeof targetOrGroup === 'string'
    ? { group: targetOrGroup, name: name ?? '' }
    : targetOrGroup;
  const event = mustEvent(scope, eventRef);
  const removed = removeRefDoc(scope, event.id, target, Date.now());
  if (!removed) {
    throw new GovernanceError('REF_NOT_FOUND', `引用不存在：${target.group}/${target.name}`);
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
export interface DocSearchHit {
  group: string;
  name: string;
  visibility: Visibility;
  /** 该文档已绑在**另一个未收口事件**上时给出（前端据此禁用并标注，后端仍兜底拒绝） */
  event?: { id: string; shortId: number; title: string };
}

export function searchDocsForAdd(
  scope: string,
  q: string,
  limit = 20,
  opts: { eventId?: string } = {},
): DocSearchHit[] {
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

  /**
   * 一次读全事件与类型：此前循环里逐条调 `resolveVisibilityOfRelation`，
   * 每条都全量读一遍事件与类型（20 条命中 = 20 次全量读）。规则仍复用
   * `resolveVisibility`，不另写一份判定。
   */
  const allEvents = readAllEvents(scope);
  const eventsById = new Map(allEvents.map((e) => [e.id, e]));
  const typesById = new Map(readEventTypes(scope).map((t) => [t.id, t]));
  const lookupEvent = (id: string): { stageKey: string; typeId: string } | null => {
    const e = eventsById.get(id);
    return e ? { stageKey: e.stageKey, typeId: e.typeId } : null;
  };
  const lookupType = (id: string): { stages: Array<{ key: string; visibility: Visibility }> } | null => {
    const t = typesById.get(id);
    return t ? { stages: t.stages.map((s) => ({ key: s.key, visibility: s.visibility })) } : null;
  };

  const out: DocSearchHit[] = [];
  for (const [group, doc] of readAllGroupCaches(scope)) {
    for (const rel of doc.hot_relations) {
      if (excluded?.has(`${group}\u0000${rel.text}`)) continue;
      // query 为空时不过滤（列全部可加入的），非空时按名 / 路径包含匹配
      if (query && !rel.text.toLowerCase().includes(query) && !group.toLowerCase().includes(query)) continue;

      const visibility = resolveVisibility({ relation: rel, lookupEvent, lookupType }).mode;
      const owner = rel.eventId && rel.eventId !== opts.eventId ? eventsById.get(rel.eventId) : undefined;
      const boundToOther = owner && !isEventClosed(owner)
        ? { event: { id: owner.id, shortId: owner.shortId, title: owner.title } }
        : {};
      out.push({ group, name: rel.text, visibility, ...boundToOther });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
