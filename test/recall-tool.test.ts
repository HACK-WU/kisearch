/**
 * recall-tool.test.ts —— `ki_recall` 工具层（REQ-20261118-003 · S-02）
 *
 * 运行：npx jiti test/recall-tool.test.ts
 *
 * 守六条口径（对应设计 S-02 §9 的 V1~V4）：
 *   ① 入参校验：task/hints 越界 fail-loud，不自作主张截断；
 *   ② scope 必填：漏传时回「可用库/视图清单」，让调用方一次自愈；
 *   ③ 点名即报错：传入不存在的 scope 直接 SCOPE_UNKNOWN，且**不发起检索**（预检在检索之前）；
 *   ④ 一期不标 degraded（D-02-7）、显式 deep 报 MODE_UNAVAILABLE；
 *   ⑤ 缓存命中不打检索；频控与并发拒绝都带 retryAfterSec；
 *   ⑥ 成功形状可直接被 agent 消费：nextActions 的 scope 是物理库。
 *
 * 全部注入 fake，不联网、不落盘。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/lib/config.js';
import { executeRecall, type RecallToolDeps } from '../src/lib/mcp-tools/recall.js';
import { resetRecallRuntimeForTest, type RecallRuntimeConfig } from '../src/lib/recall/limits.js';
import { RECALL_TOOL_CODES } from '../src/lib/recall/codes.js';
import type { FastRecallDeps } from '../src/lib/recall/fast-recall.js';

const DOC = { group: '错误库', name: '删除文档后向量残留' };

const RUNTIME: RecallRuntimeConfig = {
  cacheTtlSec: 600,
  maxCandidates: 8,
  maxConcurrent: 4,
  throttlePerMinute: 20,
  hardTimeoutMs: 5000,
};

function makeCaches(scope: string): FastRecallDeps['cachesOf'] {
  return (name: string) => {
    const map = new Map<string, { hot_relations: Array<{ text: string; eventId?: string }> }>();
    if (name === scope) map.set(DOC.group, { hot_relations: [{ text: DOC.name }] });
    return map;
  };
}

function makeDeps(overrides: Partial<RecallToolDeps> = {}): { deps: RecallToolDeps; calls: () => number } {
  let count = 0;
  const deps: RecallToolDeps = {
    tokenScopes: null,
    kiConfig: loadConfig(),
    // 注入假的范围表：测试不依赖真实 kb 目录（'kb-a' 不是真库）
    scopeDeps: { listScopes: () => ['kb-a'], listViews: () => ({}) },
    runtime: RUNTIME,
    principalKey: `test-${Math.random().toString(36).slice(2)}`,
    now: () => 1_700_000_000_000,
    search: async ({ scope }) => {
      count += 1;
      return { hits: scope === 'kb-a' ? [{ ...DOC, score: 0.9 }] : [], mode: 'hybrid' };
    },
    cachesOf: makeCaches('kb-a'),
    ...overrides,
  };
  return { deps, calls: () => count };
}

beforeEach(() => {
  resetRecallRuntimeForTest();
});

describe('① 入参校验', () => {
  it('task 为空 / 超长 → RECALL_TASK_INVALID（不自动截断）', async () => {
    const { deps } = makeDeps();
    const empty = await executeRecall({ scope: 'kb-a', task: '   ' }, deps);
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, RECALL_TOOL_CODES.TASK_INVALID);

    const long = await executeRecall({ scope: 'kb-a', task: 'x'.repeat(2001) }, deps);
    assert.equal(long.ok, false);
    if (!long.ok) assert.equal(long.code, RECALL_TOOL_CODES.TASK_INVALID);
  });

  it('hints 超条数 → RECALL_HINTS_INVALID', async () => {
    const { deps } = makeDeps();
    const r = await executeRecall(
      { scope: 'kb-a', task: '删除文档后还能搜到', hints: Array.from({ length: 11 }, (_, i) => `h${i}`) },
      deps,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, RECALL_TOOL_CODES.HINTS_INVALID);
  });

  it('mode=deep → RECALL_MODE_UNAVAILABLE（不静默降级成 fast）', async () => {
    const { deps } = makeDeps();
    const r = await executeRecall({ scope: 'kb-a', task: '删除文档后还能搜到', mode: 'deep' }, deps);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, RECALL_TOOL_CODES.MODE_UNAVAILABLE);
      assert.equal(r.retryable, false);
    }
  });
});

describe('② scope 必填', () => {
  it('漏传 scope → 报错并回可用清单（含库名数组）', async () => {
    const { deps } = makeDeps();
    const r = await executeRecall({ task: '删除文档后还能搜到' }, deps);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, RECALL_TOOL_CODES.SCOPE_REQUIRED);
      assert.ok(Array.isArray(r.available?.scopes), '应回可用库清单');
      assert.equal(r.retryable, false);
    }
  });

  it('传入不存在的 scope → SCOPE_UNKNOWN，且不发起检索', async () => {
    const { deps, calls } = makeDeps();
    const r = await executeRecall({ scope: 'definitely-not-exist-kb', task: '删除文档后还能搜到' }, deps);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, RECALL_TOOL_CODES.SCOPE_UNKNOWN);
    assert.equal(calls(), 0, '预检失败不应浪费一次检索');
  });
});

describe('③ 成功形状', () => {
  it('返回候选 + nextActions，且 nextActions 的 scope 是物理库', async () => {
    const { deps } = makeDeps();
    const r = await executeRecall(
      { scope: ['kb-a'], task: '删除文档后还能搜到，怀疑向量没清干净', hints: ['delete-relation'] },
      deps,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.channel, 'fast');
    assert.equal(r.degraded, undefined, '一期 auto 不得标 degraded（D-02-7）');
    assert.ok(r.candidates.length >= 1);
    assert.ok(r.nextActions.length >= 1);
    assert.equal(r.nextActions[0]?.args.scope, 'kb-a');
    assert.equal(r.nextActions[0]?.args.relation, DOC.name);
    assert.equal(r.nextActions[0]?.args.max_chars, 8000);
    assert.ok(r.durationMs >= 0);
  });

  it('exclude 格式非法的条目只计数（ignoredExclude），不阻断', async () => {
    const { deps } = makeDeps();
    const r = await executeRecall(
      { scope: ['kb-a'], task: '删除文档后还能搜到', exclude: ['只有一段', `kb-a::${DOC.group}::${DOC.name}`] },
      deps,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ignoredExclude, 1);
  });
});

describe('④ 缓存与配额', () => {
  it('同参数第二次调用命中缓存，不再打检索', async () => {
    const { deps, calls } = makeDeps();
    const args = { scope: ['kb-a'], task: '删除文档后还能搜到，怀疑向量没清干净' };
    const first = await executeRecall(args, deps);
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.cached, undefined);

    const countAfterFirst = calls();
    const second = await executeRecall(args, deps);
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.cached, true);
    assert.equal(calls(), countAfterFirst, '缓存命中不应再检索');
  });

  it('cacheTtlSec=0 时关闭缓存（两次都真的检索）', async () => {
    const { deps, calls } = makeDeps({ runtime: { ...RUNTIME, cacheTtlSec: 0 } });
    const args = { scope: ['kb-a'], task: '删除文档后还能搜到' };
    await executeRecall(args, deps);
    const first = calls();
    await executeRecall(args, deps);
    assert.ok(calls() > first, '关闭缓存后应再次检索');
  });

  it('超频 → RECALL_THROTTLED 且带 retryAfterSec', async () => {
    const { deps } = makeDeps({ runtime: { ...RUNTIME, throttlePerMinute: 1 } });
    const args = { scope: ['kb-a'], task: '删除文档后还能搜到' };
    const first = await executeRecall(args, deps);
    assert.equal(first.ok, true);
    const second = await executeRecall(args, deps);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.code, RECALL_TOOL_CODES.THROTTLED);
      assert.ok((second.retryAfterSec ?? 0) > 0);
      assert.equal(second.retryable, true);
    }
  });

  it('并发满 → RECALL_BUSY（不排队）', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps } = makeDeps({
      runtime: { ...RUNTIME, maxConcurrent: 1, cacheTtlSec: 0 },
      search: async () => {
        await gate;
        return { hits: [{ ...DOC, score: 0.9 }], mode: 'hybrid' };
      },
    });

    const running = executeRecall({ scope: ['kb-a'], task: '删除文档后还能搜到' }, deps);
    // 让第一个调用先进入检索
    await new Promise((r) => setTimeout(r, 0));
    const second = await executeRecall({ scope: ['kb-a'], task: '另一件事的画像' }, deps);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.code, RECALL_TOOL_CODES.BUSY);
      assert.ok((second.retryAfterSec ?? 0) >= 1);
    }
    release?.();
    await running;
  });
});
