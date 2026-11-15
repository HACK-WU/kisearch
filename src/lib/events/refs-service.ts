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

export interface RefSearchStep {
  name: 'understand' | 'extract' | 'search' | 'exclude' | 'rank';
  ms: number;
  metrics: Record<string, number | string>;
  detail?: Record<string, unknown>;
}

export interface RefCandidate {
  group: string;
  name: string;
  /** 同批次 min-max 归一化后的相对分（0~1），不是绝对相似度 */
  score: number;
  why: string;
  matchedKeywords: string[];
  weak: boolean;
}

export interface RefSearchResult {
  candidates: RefCandidate[];
  steps: RefSearchStep[];
  excluded: { associated: string[]; added: string[] };
  total: number;
  durationMs: number;
}

export interface RefSearchDeps {
  /** 语义检索（生产用 `executeSearch`）；返回 score 为原始量纲，本层负责归一化 */
  search: (args: { scope: string; query: string; topK: number }) => Promise<Array<{ group: string; name: string; score: number }>>;
}

// 极简停用词：只处理会在中文标题里高频出现、但对检索无区分度的词
const STOP_WORDS = new Set(['的', '了', '和', '与', '及', '在', '是', '有', '不', '为', '对', '把', '被', '一个', '记录', '问题', '排查']);

/** 从事件标题 + 关联文档名提取线索词（去重、去停用词、长度 ≥ 2） */
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
function countAllDocs(scope: string): number {
  let total = 0;
  for (const [, doc] of readAllGroupCaches(scope)) total += doc.hot_relations.length;
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
    ms: Math.max(1, Date.now() - step1Start),
    metrics: { stages: type?.stages.length ?? 0, visibility },
  });

  const members = collectMembers(scope, event.id);
  const added = readRefs(scope, event.id);

  // ② 提取线索
  const step2Start = Date.now();
  const keywords = extractKeywords(event.title, members.map((m) => m.name));
  steps.push({
    name: 'extract',
    ms: Math.max(1, Date.now() - step2Start),
    metrics: { keywords: keywords.length, sources: members.length },
    detail: { keywords },
  });

  // ③ 语义检索
  const searchStart = Date.now();
  const topK = Math.min(Math.max(opts.topK ?? TOP_K_DEFAULT, 1), 50);
  const total = countAllDocs(scope);
  const hits = keywords.length > 0
    ? await deps.search({ scope, query: keywords.join(' '), topK })
    : [];
  steps.push({
    name: 'search',
    ms: Date.now() - searchStart,
    metrics: { total, hits: hits.length, mode: 'hybrid' },
    ...(keywords.length === 0 ? { detail: { note: '标题未提取到线索词，跳过检索' } } : {}),
  });

  // ④ 排除：已关联（Relation.eventId）+ 已加入（refs）
  const excludeStart = Date.now();
  const associatedKeys = new Set(members.map((m) => `${m.group}\u0000${m.name}`));
  const addedKeys = new Set(added.map((r) => `${r.group}\u0000${r.name}`));
  const remaining = hits.filter((h) => {
    const key = `${h.group}\u0000${h.name}`;
    return !associatedKeys.has(key) && !addedKeys.has(key);
  });
  steps.push({
    name: 'exclude',
    ms: Math.max(1, Date.now() - excludeStart),
    metrics: { associated: associatedKeys.size, added: addedKeys.size, remaining: remaining.length },
  });

  // ⑤ 排序 + 归一化
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
      return {
        group: h.group,
        name: h.name,
        score: Number(score.toFixed(2)),
        why: whyParts.join(' · ') || '语义相似',
        matchedKeywords: matched,
        weak: score < threshold,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  steps.push({
    name: 'rank',
    ms: Math.max(1, Date.now() - rankStart),
    metrics: { candidates: candidates.length, threshold },
  });

  return {
    candidates,
    steps,
    excluded: { associated: [...associatedKeys].map((k) => k.split('\u0000')[1]), added: [...addedKeys].map((k) => k.split('\u0000')[1]) },
    total,
    durationMs: Date.now() - started,
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
      'REF_ALREADY_ADDED',
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

/** 供 UI「手动添加」用的文档搜索：按名精确/包含匹配，走向量反而引入噪声 */
export function searchDocsForAdd(scope: string, q: string, limit = 20): Array<{ group: string; name: string; visibility: Visibility }> {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const out: Array<{ group: string; name: string; visibility: Visibility }> = [];
  for (const [group, doc] of readAllGroupCaches(scope)) {
    for (const rel of doc.hot_relations) {
      if (!rel.text.toLowerCase().includes(query) && !group.toLowerCase().includes(query)) continue;
      out.push({ group, name: rel.text, visibility: resolveVisibilityOfRelation(scope, rel).mode });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
