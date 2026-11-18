/**
 * recall-kernel.test.ts —— `ki_recall` 召回内核（REQ-20261118-003 · S-01）
 *
 * 运行：npx jiti test/recall-kernel.test.ts
 *
 * 守六条口径：
 *   ① 线索抽取：中文无标点长句能抽出 ≥3 个有区分度线索（不照搬 extractKeywords 的整句切法）；
 *   ② 范围必填：未传 scope 直接抛内核错误，**服务端不替调用方挑库**；
 *   ③ 点名即报错：显式传入却不存在/无权的项进 forbiddenRequested（区别于 find 的静默 skip）；
 *   ④ 可见性：hidden 不进候选，且**不得经 alsoIn 泄漏**；
 *   ⑤ 排序/配额：库内名次优先、每库 ≤3 条、跨库同名不合并只提示；
 *   ⑥ 不编造：检索全失败才抛错；画像无内容时不发起检索、返回 needMore。
 *
 * 全部注入 fake，不联网、不落盘、不依赖真实 scope。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Visibility } from '../src/lib/events/types.js';
import { extractRecallTerms } from '../src/lib/recall/keywords.js';
import { resolveRecallTargets } from '../src/lib/recall/targets.js';
import { runFastRecall, type FastRecallDeps } from '../src/lib/recall/fast-recall.js';
import { buildNextActions } from '../src/lib/recall/assemble.js';
import { RecallKernelError } from '../src/lib/recall/codes.js';
import { MAX_TARGETS } from '../src/lib/recall/types.js';

const SCOPES = ['kb-a', 'kb-b'];

function scopeDeps(extraScopes: string[] = SCOPES): { listScopes: () => string[]; listViews: () => Record<string, { members: string[] }> } {
  return { listScopes: () => extraScopes, listViews: () => ({}) };
}

interface DocRow { group: string; name: string; score: number }

function makeSearch(rows: Record<string, DocRow[]>, failScopes: string[] = []): {
  fn: FastRecallDeps['search'];
  calls: Array<{ scope: string; query: string; topK: number; mode?: string }>;
} {
  const calls: Array<{ scope: string; query: string; topK: number; mode?: string }> = [];
  const fn: FastRecallDeps['search'] = async ({ scope, query, topK, mode }) => {
    calls.push({ scope, query, topK, ...(mode ? { mode } : {}) });
    if (failScopes.includes(scope)) throw new Error('search down');
    return rows[scope] ?? [];
  };
  return { fn, calls };
}

function makeCaches(docs: Record<string, Array<{ group: string; name: string; eventId?: string }>>): FastRecallDeps['cachesOf'] {
  return (scope: string) => {
    const map = new Map<string, { hot_relations: Array<{ text: string; eventId?: string }> }>();
    for (const doc of docs[scope] ?? []) {
      const bucket = map.get(doc.group) ?? { hot_relations: [] };
      bucket.hot_relations.push({ text: doc.name, ...(doc.eventId ? { eventId: doc.eventId } : {}) });
      map.set(doc.group, bucket);
    }
    return map;
  };
}

function deps(overrides: Partial<FastRecallDeps> & Pick<FastRecallDeps, 'search' | 'cachesOf'>): FastRecallDeps {
  return {
    tokenScopes: null,
    scopeDeps: scopeDeps(),
    ...overrides,
  };
}

describe('① 线索抽取', () => {
  it('中文无标点长句能抽出 ≥3 个线索（block 切块 + n-gram 兜底）', () => {
    const task = '上传文件导入之后wiki目录里对应的源文件没有跟着一起更新需要确认上传通道到底会不会回写以及什么时候回写';
    const terms = extractRecallTerms({ task });
    assert.ok(terms.blocks.length >= 1, '应至少切出一个语义块');
    assert.ok(terms.blocks.length <= 4, '语义块不超过 4 个');
    assert.ok(terms.tokens.length >= 3, `线索应 ≥3，实际 ${terms.tokens.length}: ${terms.tokens.join(',')}`);
    for (const token of terms.tokens) {
      assert.ok(token.length >= 2, `线索过短：${token}`);
    }
  });

  it('hints 优先入池，错误码 / 标识符 / 路径都能抽出', () => {
    const terms = extractRecallTerms({
      task: '删除文档后还能搜到，怀疑向量没清干净',
      hints: ['delete-relation', '422', 'src/lib/delete-relation.ts'],
    });
    assert.equal(terms.tokens[0], 'delete-relation', 'hints 应排在最前');
    assert.ok(terms.tokens.includes('422'));
    assert.ok(terms.tokens.some((t) => t.includes('delete-relation.ts')));
  });

  it('纯符号任务抽出空线索（交给上层返回 needMore，不发起检索）', () => {
    const terms = extractRecallTerms({ task: '？？？！！！ ...' });
    assert.deepEqual(terms.blocks, []);
    assert.deepEqual(terms.tokens, []);
  });
});

describe('② 范围解析', () => {
  it('未传 scope → SCOPE_REQUIRED（服务端不替调用方挑库）', () => {
    assert.throws(
      () => resolveRecallTargets({ requested: [], tokenScopes: null, deps: scopeDeps() }),
      (err: unknown) => err instanceof RecallKernelError && err.code === 'SCOPE_REQUIRED',
    );
  });

  it('点名但不存在 / 无权 → 进 forbiddenRequested（不静默跳过）', () => {
    const r = resolveRecallTargets({
      requested: ['kb-a', 'nope', 'kb-c'],
      tokenScopes: ['kb-a'],
      deps: scopeDeps(['kb-a', 'kb-c']),
    });
    assert.deepEqual(r.targets, ['kb-a']);
    assert.equal(r.forbiddenRequested.find((s) => s.name === 'nope')?.reason, 'missing');
    assert.equal(r.forbiddenRequested.find((s) => s.name === 'kb-c')?.reason, 'forbidden');
    assert.equal(r.truncated, false);
  });

  it('视图展开为物理库（targets 回显视图名，检索用成员库）', () => {
    const r = resolveRecallTargets({
      requested: ['docs-view'],
      tokenScopes: null,
      deps: { listScopes: () => [], listViews: () => ({ 'docs-view': { members: ['kb-a', 'kb-b'] } }) },
    });
    assert.deepEqual(r.targets, ['docs-view'], 'targets 保留视图名用于回显');
    assert.deepEqual(r.physicalTargets, ['kb-a', 'kb-b'], '检索与可见性判定用成员库');
  });

  it(`超过 ${MAX_TARGETS} 个 target 时截断并标 truncated`, () => {
    const many = Array.from({ length: 8 }, (_, i) => `kb-${i}`);
    const r = resolveRecallTargets({ requested: many, tokenScopes: null, deps: scopeDeps(many) });
    assert.equal(r.targets.length, MAX_TARGETS);
    assert.equal(r.truncated, true);
    assert.equal(r.skipped.filter((s) => s.reason === 'truncated').length, many.length - MAX_TARGETS);
    assert.equal(r.forbiddenRequested.length, 0, '截断不是越权，不能混进 forbiddenRequested');
  });
});

describe('③ 确定性召回', () => {
  const docA = { group: '错误库', name: '删除文档后向量残留（delete-relation 三层兜底均未命中）' };
  const rows: Record<string, DocRow[]> = {
    'kb-a': [
      { ...docA, score: 0.9 },
      { group: '错误库', name: '另一篇低分', score: 0.5 },
      { group: '错误库', name: '再一篇更低', score: 0.3 },
    ],
    'kb-b': [{ ...docA, score: 0.8 }],
  };
  const caches = makeCaches({
    'kb-a': [docA, { group: '错误库', name: '另一篇低分' }, { group: '错误库', name: '再一篇更低' }],
    'kb-b': [docA],
  });

  it('按库内名次排序，跨库同名不合并、用 alsoIn 提示', async () => {
    const { fn } = makeSearch(rows);
    const r = await runFastRecall(
      { scope: ['kb-a', 'kb-b'], task: '删除文档后还能搜到，怀疑向量没清理干净', hints: ['delete-relation'], limit: 8 },
      deps({ search: fn, cachesOf: caches }),
    );

    assert.equal(r.candidates.length, 4, '两库同名文档各自保留');
    const first = r.candidates[0];
    assert.equal(first.scope, 'kb-a');
    assert.equal(first.rankInScope, 1);
    assert.equal(first.score, 1);
    assert.deepEqual(first.alsoIn, ['kb-b'], '同名文档提示另一个库');
    assert.ok(first.why.includes('本库第 1'));
    assert.ok(r.query.length > 0);
  });

  it('hidden 不进候选，且不经 alsoIn 泄漏', async () => {
    const { fn } = makeSearch(rows);
    const r = await runFastRecall(
      { scope: ['kb-a', 'kb-b'], task: '删除文档后还能搜到', limit: 8 },
      deps({
        search: fn,
        cachesOf: caches,
        // kb-b 的那篇同名文档被事件锁成 hidden
        resolveVisibility: (scope: string): Visibility => (scope === 'kb-b' ? 'hidden' : 'full'),
      }),
    );

    assert.equal(r.excludedHidden, 1);
    assert.ok(r.candidates.every((c) => c.scope !== 'kb-b'), 'hidden 所在库不得出现在候选');
    assert.ok(r.candidates.every((c) => c.alsoIn === undefined), 'hidden 不得经 alsoIn 泄漏');
  });

  it('每库配额 3 条', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ group: '错误库', name: `文档-${i}`, score: 1 - i * 0.1 }));
    const { fn } = makeSearch({ 'kb-a': many });
    const r = await runFastRecall(
      { scope: ['kb-a'], task: '删除文档后还能搜到', limit: 20 },
      deps({
        search: fn,
        cachesOf: makeCaches({ 'kb-a': many.map((m) => ({ group: m.group, name: m.name })) }),
        scopeDeps: scopeDeps(['kb-a']),
      }),
    );
    assert.equal(r.candidates.length, 3);
    assert.deepEqual(r.candidates.map((c) => c.rankInScope), [1, 2, 3]);
  });

  it('已读清单（exclude）生效并计入 dropped', async () => {
    const { fn } = makeSearch(rows);
    const r = await runFastRecall(
      {
        scope: ['kb-a', 'kb-b'],
        task: '删除文档后还能搜到',
        exclude: [`kb-a::${docA.group}::${docA.name}`],
        limit: 8,
      },
      deps({ search: fn, cachesOf: caches }),
    );
    assert.equal(r.dropped, 1);
    assert.ok(!r.candidates.some((c) => c.scope === 'kb-a' && c.name === docA.name));
  });

  it('画像无可检索内容 → 不发起检索并返回 needMore.symptom', async () => {
    const { fn, calls } = makeSearch({});
    const r = await runFastRecall(
      { scope: ['kb-a'], task: '？？？！', limit: 8 },
      deps({ search: fn, cachesOf: caches, scopeDeps: scopeDeps(['kb-a']) }),
    );
    assert.equal(calls.length, 0, '不应发起任何检索');
    assert.deepEqual(r.candidates, []);
    assert.equal(r.needMore[0]?.field, 'symptom');
  });

  it('全部检索失败才抛 ALL_TARGETS_FAILED', async () => {
    const { fn } = makeSearch({}, ['kb-a', 'kb-b']);
    await assert.rejects(
      () => runFastRecall(
        { scope: ['kb-a', 'kb-b'], task: '删除文档后还能搜到', limit: 8 },
        deps({ search: fn, cachesOf: caches }),
      ),
      (err: unknown) => err instanceof RecallKernelError && err.code === 'ALL_TARGETS_FAILED',
    );
  });

  it('scope 传视图时检索落到成员库（否则命中会被判成"已删除"全丢）', async () => {
    const { fn, calls } = makeSearch({ 'kb-a': [{ group: '错误库', name: '同名文档', score: 0.9 }] });
    const r = await runFastRecall(
      { scope: ['docs-view'], task: '删除文档后还能搜到', limit: 8 },
      {
        tokenScopes: null,
        search: fn,
        cachesOf: makeCaches({ 'kb-a': [{ group: '错误库', name: '同名文档' }] }),
        scopeDeps: { listScopes: () => [], listViews: () => ({ 'docs-view': { members: ['kb-a'] } }) },
      },
    );
    // 主检索 + 备检索（命中 <3 时触发）都在成员库上，且**只有**成员库
    assert.deepEqual([...new Set(calls.map((c) => c.scope))], ['kb-a'], '只在成员库上检索');
    assert.ok(calls.length >= 1);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.targets[0], 'docs-view', '回显仍是视图名');
    assert.equal(r.candidates[0]?.scope, 'kb-a', '候选必须带物理库，nextActions 才可用');
  });

  it('索引里已不存在的命中被丢弃（不推幽灵文档）', async () => {
    const { fn } = makeSearch({ 'kb-a': [{ group: '错误库', name: '曾存在但已删', score: 0.9 }] });
    const r = await runFastRecall(
      { scope: ['kb-a'], task: '删除文档后还能搜到', limit: 8 },
      deps({ search: fn, cachesOf: makeCaches({ 'kb-a': [] }), scopeDeps: scopeDeps(['kb-a']) }),
    );
    assert.deepEqual(r.candidates, []);
    assert.equal(r.dropped, 1);
  });
});

describe('④ 装配', () => {
  it('nextActions 的 scope 是物理库且参数可直接执行', () => {
    const actions = buildNextActions([
      {
        scope: 'kb-a',
        group: '错误库',
        name: '某文档',
        score: 1,
        rankInScope: 1,
        why: '命中：delete-relation · 本库第 1',
        visibility: 'full',
        weak: false,
        chunkHits: 0,
      },
    ]);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.tool, 'ki_get_module_info');
    assert.deepEqual(actions[0]?.args, {
      scope: 'kb-a',
      group: '错误库',
      relation: '某文档',
      max_chars: 8000,
    });
  });
});
