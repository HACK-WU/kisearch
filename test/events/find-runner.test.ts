/**
 * find-runner.test.ts —— 「AI 查找」深度通道（REQ-20261116-005 二期 · S-03）
 *
 * 2026-11-19：旧执行器 `runDeepFind` 已删除，用例全部改走**生产入口**
 * `runDeepFindAsSearchResult`（find-service → deep-find-core → 共享内核）。
 * 这样断言的是真实链路，而不是一份已经不再被调用的实现。
 *
 * 覆盖六组：
 *   ① 门禁 4 路 + 并发（同事件排队 / 队列满 / 排队中止 / 跨事件执行位）；
 *   ② 候选三重校验：越界库 / 文档不存在 / 已作为参考 → 进 `unconfirmed` 并剔除；
 *   ③ 工具失败不中断（错误串回给模型，后续轮次继续）；
 *   ④ 预算已取消：轮次与候选数都不设限；
 *   ⑤ 硬超时（45s，不被 llm.requestTimeoutMs 夹取）+ 检索模式聚合；
 *   ⑥ 服务层形状（与快速通道同形）+ 工具调用次数上限。
 *
 * 运行：npx jiti test/events/find-runner.test.ts
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from '../test-config.js';
import { initScope } from '../../src/lib/store.js';
import { getKbDir } from '../../src/lib/scope.js';
import { loadGroupCache, writeGroupCache } from '../../src/lib/group-cache.js';
import type { Relation } from '../../src/lib/scoring.js';
import type { KiConfig } from '../../src/lib/config.js';
import { defaultFindConfig, promptConfigPath } from '../../src/lib/chat/prompt-config.js';
import { createEvent } from '../../src/lib/events/event-service.js';
import { addRefs } from '../../src/lib/events/refs-service.js';
import {
  deepFindConcurrency,
  resetFindConcurrencyForTest,
  type DeepFindDeps,
} from '../../src/lib/events/find-runner.js';
import { runDeepFindAsSearchResult } from '../../src/lib/events/find-service.js';
import { GovernanceError } from '../../src/lib/governance-errors.js';
import type { ChatTurn, LlmStatus, StreamPart } from '../../src/lib/chat/llm-client.js';

const scope = `find-run-${Date.now()}`;
/** 第二个库：只作为「视图成员」出现，不进 targets —— 用于回归「视图成员被判越界」 */
const scopeB = `${scope}-b`;
const ART_C = '视图成员文档';
const GROUP = '部署运维';
const ART_A = '发布与回滚手册';
const ART_B = '值班检查清单';

let cfg: KiConfig;

function okStatus(): LlmStatus {
  return {
    enabled: true,
    why: null,
    supportsImages: false,
    supportsTools: true,
    ackRequired: false,
    model: 'fake-model',
    baseURL: 'http://localhost',
    contextChars: 1_000_000,
    maxToolRounds: Infinity,
    askMaxRounds: 6,
    askSessionTtlMs: 600_000,
  };
}

function seedIn(s: string, name: string): void {
  const rel: Relation = {
    id: `rel_${name.length}_${name.replace(/\W/g, '')}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
  };
  const doc = loadGroupCache(s, GROUP) ?? { version: 1, scope: s, hot_relations: [], keywords: [], updatedAt: null };
  doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
  doc.hot_relations.push(rel);
  writeGroupCache(s, GROUP, doc);
}

function seed(name: string): void {
  seedIn(scope, name);
}

/** 一轮只回工具调用；最后一轮回候选 JSON */
function scriptedStream(script: Array<{ text?: string; calls?: Array<{ name: string; args: unknown }> }>) {
  let turn = 0;
  const seen: ChatTurn[][] = [];
  const fn = async function* (messages: ChatTurn[]): AsyncGenerator<StreamPart> {
    seen.push(messages.map((m) => ({ ...m })));
    const step = script[Math.min(turn, script.length - 1)]!;
    turn += 1;
    if (step.calls) {
      yield {
        type: 'tool_calls',
        calls: step.calls.map((c, i) => ({ id: `c${turn}-${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
      };
      return;
    }
    yield { type: 'content', text: step.text ?? '' };
  };
  return { fn, seen, turns: () => turn };
}

function baseConfig(over: Partial<ReturnType<typeof defaultFindConfig>> = {}) {
  const d = defaultFindConfig();
  return { ...d, ...over };
}

/**
 * 工具执行器默认实现：读正文一律"读到了"（真伪由 `deep-find-core` 的存在性校验判），
 * 检索一律返回空结果。用例需要别的行为时自行覆盖。
 */
const defaultTool: NonNullable<DeepFindDeps['runTool']> = async (name, args) => {
  if (name === 'ki_get_module_info') {
    return {
      text: JSON.stringify({ doc: { content: '正文' } }),
      read: {
        scope: String(args.scope ?? scope),
        group: String(args.group ?? ''),
        name: String(args.relation ?? ''),
        truncated: false,
      },
    };
  }
  return { text: JSON.stringify({ results: [] }), ...(name === 'ki_search' ? { searchMode: 'hybrid' as const } : {}) };
};

/** `stream` 传的是 `deps.llm`（保留旧用例的叫法，改动最小） */
function deps(over: Partial<DeepFindDeps> & { stream?: NonNullable<DeepFindDeps['llm']> }): DeepFindDeps {
  const { stream, ...rest } = over;
  return {
    targets: [scope],
    kiConfig: cfg,
    runTool: defaultTool,
    ...(stream ? { llm: stream } : {}),
    ...rest,
  };
}

// 并发限制是模块级状态：每个用例前复位，否则前一个用例收窄的上限会漏给下一个
beforeEach(() => {
  resetFindConcurrencyForTest();
});

before(() => {
  registerTestScope(scope);
  initScope(scope);
  registerTestScope(scopeB);
  initScope(scopeB);
  seed(ART_A);
  seed(ART_B);
  seedIn(scopeB, ART_C);
  cfg = {
    dataDir: path.dirname(getKbDir(scope)),
    chatDir: path.join(path.dirname(getKbDir(scope)), 'chat'),
    // 2026-11-18：每日额度已整体取消，配置里不再有 analysisDailyLimit
    llm: { baseURL: 'http://localhost', model: 'fake-model', apiKey: 'k' },
  } as KiConfig;
});

after(() => {
  resetFindConcurrencyForTest();
  for (const s of [scope, scopeB]) {
    const kbDir = getKbDir(s);
    if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  }
  cleanupTestConfig();
});

describe('① 门禁', () => {
  it('模型未就绪 / 未确认外发 / 不支持工具 / 工具全关 各有独立错误码', async () => {
    const ev = await createEvent(scope, { title: '门禁验证', typeId: 'et_1' });
    const noop = { stream: scriptedStream([{ text: '[]' }]).fn, status: () => okStatus() };

    await assert.rejects(
      () => runDeepFindAsSearchResult(scope, ev.id, deps({ stream: { ...noop, status: () => ({ ...okStatus(), enabled: false, why: '未配置模型' }) } })),
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_LLM_UNAVAILABLE',
    );
    await assert.rejects(
      () => runDeepFindAsSearchResult(scope, ev.id, deps({ stream: { ...noop, status: () => ({ ...okStatus(), ackRequired: true }) } })),
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_DISCLOSURE_REQUIRED',
    );
    await assert.rejects(
      () => runDeepFindAsSearchResult(scope, ev.id, deps({ stream: { ...noop, status: () => ({ ...okStatus(), supportsTools: false }) } })),
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_TOOLS_UNSUPPORTED',
    );
    await assert.rejects(
      () => runDeepFindAsSearchResult(scope, ev.id, deps({
        stream: noop,
        config: baseConfig({
          tools: { ki_search: false, ki_get_module_info: false, ki_group_list: false, ki_tag_list: false },
        }),
      })),
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_TOOLS_ALL_DISABLED',
    );
  });

  it('同一事件并发 → 排队执行（不拒绝），先到的先跑、后到的等它结束', async () => {
    const ev = await createEvent(scope, { title: '并发验证', typeId: 'et_1' });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstDone = false;
    const hanging = async function* (): AsyncGenerator<StreamPart> {
      await gate;
      firstDone = true;
      yield { type: 'content', text: '[]' };
    };
    const first = runDeepFindAsSearchResult(scope, ev.id, deps({ stream: { stream: hanging, status: () => okStatus() } }));
    // 第二个请求此刻应处于排队（既不抛错，也还没开始跑）
    const secondScript = scriptedStream([
      { calls: [{ name: 'ki_search', args: { query: '回滚' } }] },
      { text: '[]' },
    ]);
    const second = runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: secondScript.fn, status: () => okStatus() },
    }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(deepFindConcurrency().queued, 1, '同事件的第二个请求应在排队，而不是被拒绝');
    assert.equal(firstDone, false, '第一个还没结束，第二个不能抢跑');
    release();
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.candidates.length, 0);
    assert.equal(r2.candidates.length, 0, '排队后应正常执行并返回，而不是 409');
    assert.ok(
      Number(r2.steps[0]?.metrics.queuedMs ?? 0) > 0,
      '排队耗时必须如实透出（否则用户会以为检索本身慢）',
    );
  });

  it('队列满 → FIND_BUSY；排队超时 → FIND_QUEUE_TIMEOUT', async () => {
    resetFindConcurrencyForTest();
    const ev = await createEvent(scope, { title: '队列上限验证', typeId: 'et_1' });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hanging = async function* (): AsyncGenerator<StreamPart> {
      await gate;
      yield { type: 'content', text: '[]' };
    };
    const first = runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: hanging, status: () => okStatus() },
      limits: { maxConcurrent: 1, queueMax: 0 },
    }));
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(
      () => runDeepFindAsSearchResult(scope, ev.id, deps({ stream: { stream: scriptedStream([{ text: '[]' }]).fn, status: () => okStatus() } })),
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_BUSY',
      '队列容量为 0 时应直接拒绝（不是无限堆积）',
    );
    release();
    await first;

    // 排队超时：容量 1、队列 1、等待 60ms → 第二个必然等超时
    resetFindConcurrencyForTest();
    let release2 = (): void => {};
    const gate2 = new Promise<void>((resolve) => { release2 = resolve; });
    const hanging2 = async function* (): AsyncGenerator<StreamPart> {
      await gate2;
      yield { type: 'content', text: '[]' };
    };
    const third = runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: hanging2, status: () => okStatus() },
      limits: { maxConcurrent: 1, queueMax: 2, queueWaitMs: 60 },
    }));
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(
      () => runDeepFindAsSearchResult(scope, ev.id, deps({ stream: { stream: scriptedStream([{ text: '[]' }]).fn, status: () => okStatus() } })),
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_QUEUE_TIMEOUT',
    );
    release2();
    await third;
  });
});

describe('①a 视图成员库不算越界（真机缺陷回归）', () => {
  it('targets 只写了视图名时，模型给的成员库候选应通过校验', async () => {
    const ev = await createEvent(scope, { title: '视图成员候选', typeId: 'et_1' });
    const script = scriptedStream([
      { calls: [{ name: 'ki_get_module_info', args: { scope: scopeB, group: GROUP, relation: ART_C } }] },
      { text: JSON.stringify({ summary: '视图成员', candidates: [{ scope: scopeB, group: GROUP, name: ART_C, why: '视图成员的正文' }] }) },
    ]);
    const r = await runDeepFindAsSearchResult(scope, ev.id, {
      targets: [scope, 'v-test'],
      kiConfig: cfg,
      runTool: defaultTool,
      llm: { stream: script.fn, status: () => okStatus() },
      // 视图 v-test 的唯一成员就是 scopeB
      viewMembers: (n) => (n === 'v-test' ? [scopeB] : null),
    });
    assert.equal(r.candidates.length, 1, '视图成员库的候选不得被判 out-of-scope');
    assert.equal(r.candidates[0]?.scope, scopeB);
    assert.equal(r.unconfirmed.some((u) => u.reason === 'out-of-scope'), false);
  });
});

describe('①b 排队中的中止', () => {
  it('排队时前端断开 → FIND_CANCELED，且不占队列（不能留下幽灵等待）', async () => {
    const ev = await createEvent(scope, { title: '排队中止验证', typeId: 'et_1' });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hanging = async function* (): AsyncGenerator<StreamPart> {
      await gate;
      yield { type: 'content', text: '[]' };
    };
    const first = runDeepFindAsSearchResult(scope, ev.id, deps({ stream: { stream: hanging, status: () => okStatus() } }));
    const ctrl = new AbortController();
    const second = runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: scriptedStream([{ text: '[]' }]).fn, status: () => okStatus() },
      signal: ctrl.signal,
    }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(deepFindConcurrency().queued, 1);
    ctrl.abort();
    await assert.rejects(
      () => second,
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_CANCELED',
    );
    assert.equal(deepFindConcurrency().queued, 0, '中止后必须出队');
    release();
    await first;
  });
});

describe('①c 跨事件并发闸门', () => {
  it('执行位占满时，另一个事件要排队（不是直接跑）', async () => {
    const evA = await createEvent(scope, { title: '并发 A', typeId: 'et_1' });
    const evB = await createEvent(scope, { title: '并发 B', typeId: 'et_1' });
    let releaseA = (): void => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const hangingA = async function* (): AsyncGenerator<StreamPart> {
      await gateA;
      yield { type: 'content', text: '[]' };
    };
    // 只用 1 个执行位：B 必须排队（两者 key 不同，排队原因只能是容量）
    const a = runDeepFindAsSearchResult(scope, evA.id, deps({
      stream: { stream: hangingA, status: () => okStatus() },
      limits: { maxConcurrent: 1, queueMax: 4, queueWaitMs: 5_000 },
    }));
    await new Promise((r) => setTimeout(r, 20));
    let bStarted = false;
    const bStream = async function* (): AsyncGenerator<StreamPart> {
      bStarted = true;
      yield { type: 'content', text: '[]' };
    };
    const b = runDeepFindAsSearchResult(scope, evB.id, deps({ stream: { stream: bStream, status: () => okStatus() } }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(deepFindConcurrency().active, 1, '执行位只有一个');
    assert.equal(deepFindConcurrency().queued, 1, '不同事件在容量不足时也要排队');
    assert.equal(bStarted, false, 'B 不能抢跑');
    releaseA();
    await Promise.all([a, b]);
    assert.equal(bStarted, true, 'A 结束后 B 应被放行');
  });
});

describe('①d 工具执行失败不中断', () => {
  it('工具抛错 → 以错误串回填给模型（不向用户抛），后续轮次继续', async () => {
    const ev = await createEvent(scope, { title: '工具失败验证', typeId: 'et_1' });
    const script = scriptedStream([
      {
        calls: [
          { name: 'ki_search', args: { query: '回滚' } },
          { name: 'ki_get_module_info', args: { scope, group: GROUP, relation: ART_B } },
        ],
      },
      { text: JSON.stringify({ summary: '工具失败后仍收敛', candidates: [{ scope: scope, group: GROUP, name: ART_B, why: '凭清单判断' }] }) },
    ]);
    const r = await runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
      runTool: async (name, args) => {
        if (name === 'ki_search') throw new Error('向量引擎暂不可用');
        return defaultTool(name, args);
      },
    }));
    const toolMsgs = script.seen[1]!.filter((m) => m.role === 'tool').map((m) => String(m.content));
    assert.ok(
      toolMsgs.some((t) => t.includes('向量引擎暂不可用')),
      `失败原因要回给模型让它换策略：${toolMsgs.join(' | ')}`,
    );
    assert.equal(r.candidates.length, 1, '单次工具失败不得让整次查找失败');
    const failed = r.steps[0]?.calls?.find((c) => c.name === 'ki_search');
    assert.equal(failed?.note, '调用返回错误', '失败调用也要留在过程记录里（可观测）');
  });
});

describe('② ③ 三重校验', () => {
  it('越界库 / 文档不存在 / 未读过 → 各自进 unconfirmed 或直接丢弃', async () => {
    const ev = await createEvent(scope, { title: '发布后回滚失败', typeId: 'et_1' });

    const script = scriptedStream([
      {
        calls: [
          { name: 'ki_search', args: { query: '回滚', scope: 'evil-scope' } },
          { name: 'ki_get_module_info', args: { scope, group: GROUP, relation: ART_A } },
          { name: 'ki_get_module_info', args: { scope: 'evil-scope', group: GROUP, relation: '别的库文档' } },
          { name: 'ki_get_module_info', args: { scope, group: GROUP, relation: '并不存在的文档' } },
        ],
      },
      {
        text: [
          '```json',
          JSON.stringify({
            summary: '三重校验',
            candidates: [
              { scope: scope, group: GROUP, name: ART_A, why: '命中回滚步骤' },
              { scope: 'evil-scope', group: GROUP, name: '别的库文档', why: '越界' },
              { scope: scope, group: GROUP, name: '并不存在的文档', why: '编的' },
            ],
          }),
          '```',
        ].join('\n'),
      },
    ]);

    const result = await runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
    }));

    assert.equal(result.candidates.length, 1, '只有真实存在且在范围内的那篇留下');
    const kept = result.candidates[0]!;
    assert.equal(kept.origin, 'deep');
    assert.equal(kept.scope, scope);
    assert.equal(kept.name, ART_A);
    assert.equal(kept.chunkHits, 0, '深度通道没有 chunk 聚合，用 0 表示未统计');
    assert.deepEqual(
      result.unconfirmed.map((u) => u.reason).sort(),
      ['not-found', 'out-of-scope'],
    );
    assert.equal(result.unconfirmedCount, 2);

    const toolStep = result.steps.find((s) => s.name === 'tools')!;
    assert.equal(toolStep.calls?.length, 4, '每个工具调用都要有一条真实调用行');
  });
});

describe('③b 已用过的文档', () => {
  it('已经在参考文档里的再出现 → unconfirmed: already-used', async () => {
    const ev = await createEvent(scope, { title: '是否已加入验证', typeId: 'et_1' });
    addRefs(scope, ev.id, { docs: [{ group: GROUP, name: ART_A }], addedBy: 'manual' });
    const script = scriptedStream([
      { calls: [{ name: 'ki_get_module_info', args: { scope, group: GROUP, relation: ART_A } }] },
      { text: JSON.stringify({ summary: '重复', candidates: [{ scope: scope, group: GROUP, name: ART_A, why: '重复' }] }) },
    ]);
    const result = await runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
    }));
    assert.equal(result.candidates.length, 0);
    assert.equal(result.unconfirmed[0]?.reason, 'already-used');
  });
});

describe('④ 预算已取消（2026-11-18）', () => {
  it('轮次不再设限：连续 3 轮工具调用仍然跑完，不产生 partial', async () => {
    const ev = await createEvent(scope, { title: '轮次不设限验证', typeId: 'et_1' });
    // 旧实现 4 轮封顶；这里连跑 3 轮工具后正常收尾，证明不再有轮次闸门
    const script = scriptedStream([
      { calls: [{ name: 'ki_search', args: { query: '回滚' } }] },
      { calls: [{ name: 'ki_search', args: { query: '回滚 2' } }] },
      { calls: [
        { name: 'ki_search', args: { query: '回滚 3' } },
        { name: 'ki_get_module_info', args: { scope, group: GROUP, relation: ART_B } },
      ] },
      { text: JSON.stringify({ summary: '命中', candidates: [{ scope: scope, group: GROUP, name: ART_B, why: '命中' }] }) },
    ]);
    const result = await runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
    }));
    assert.equal(result.partial, undefined, '不该因轮次被强制收尾');
    assert.equal(result.candidates.length, 1);
  });

  it('候选不再截断：多条候选全部返回，且没有 truncated 记录', async () => {
    const ev = await createEvent(scope, { title: '候选不截断验证', typeId: 'et_1' });
    const script = scriptedStream([
      { calls: [
        { name: 'ki_get_module_info', args: { scope, group: GROUP, relation: ART_A } },
        { name: 'ki_get_module_info', args: { scope, group: GROUP, relation: ART_B } },
      ] },
      {
        text: JSON.stringify({
          summary: '两条都留下',
          candidates: [
            { scope: scope, group: GROUP, name: ART_A, why: 'a' },
            { scope: scope, group: GROUP, name: ART_B, why: 'b' },
          ],
        }),
      },
    ]);
    const result = await runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
    }));
    assert.equal(result.candidates.length, 2);
    assert.equal(result.unconfirmed.length, 0, '不该再产生 truncated 记录');
  });
});

describe('⑤ 硬超时', () => {
  /** 挂起的模型调用：收到 abort 才结束（已 abort 时立刻抛，避免收口轮再次挂死） */
  const hang = async function* (_m: ChatTurn[], opts?: { signal?: AbortSignal }): AsyncGenerator<StreamPart> {
    if (opts?.signal?.aborted) throw new Error('aborted');
    await new Promise<void>((resolve) => {
      opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    throw new Error('aborted');
  };

  it('超时且无候选 → FIND_TIMEOUT（不返回空成功）', async () => {
    const ev = await createEvent(scope, { title: '超时验证', typeId: 'et_1' });
    // 硬超时定时器是 unref 的（生产里不该撑着进程），测试需要一个活跃 handle 让它真的触发
    const keepAlive = setTimeout(() => {}, 5_000);
    try {
      await assert.rejects(
        () => runDeepFindAsSearchResult(scope, ev.id, deps({
          stream: { stream: hang as never, status: () => okStatus() },
          // 超时已不可配：走单测注入口把 45s 缩到 1s
          hardTimeoutMs: 1_000,
        })),
        (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_TIMEOUT',
      );
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('硬超时固定 45s：不被 llm.requestTimeoutMs 夹取（配置 5s、注入 1s → 约 1s 结束）', async () => {
    const ev = await createEvent(scope, { title: '超时来源验证', typeId: 'et_1' });
    const keepAlive = setTimeout(() => {}, 5_000);
    const started = Date.now();
    try {
      await assert.rejects(
        () => runDeepFindAsSearchResult(scope, ev.id, deps({
          stream: { stream: hang as never, status: () => okStatus() },
          hardTimeoutMs: 1_000,
          kiConfig: {
            ...cfg,
            llm: { ...(cfg.llm as object), requestTimeoutMs: 5_000 } as KiConfig['llm'],
          },
        })),
        (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_TIMEOUT',
      );
      assert.ok(Date.now() - started < 4_000, '必须在 1s 级结束：硬超时来自 FIND_HARD_TIMEOUT_MS 而非单轮请求超时');
    } finally {
      clearTimeout(keepAlive);
    }
  });
});

describe('⑤b 检索模式聚合', () => {
  it('引擎实际降级为全文 → 聚合 mode 必须是 fulltext（不许照抄入参）', async () => {
    const ev = await createEvent(scope, { title: '降级模式验证', typeId: 'et_1' });
    const script = scriptedStream([
      { calls: [{ name: 'ki_search', args: { query: '回滚' } }] },
      { text: '[]' },
    ]);
    const r = await runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
      // 引擎如实返回 mode=fulltext（语义侧不可用）
      runTool: async () => ({ text: JSON.stringify({ results: [] }), searchMode: 'fulltext' }),
    }));
    assert.equal(r.mode, 'fulltext', '降级必须如实透出，否则面板会把全文检索显示成语义+全文');
  });

  it('未发生任何检索时不声称降级（按 hybrid）', async () => {
    const ev = await createEvent(scope, { title: '无检索验证', typeId: 'et_1' });
    const script = scriptedStream([{ text: '[]' }]);
    const r = await runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
    }));
    assert.equal(r.mode, 'hybrid');
  });
});

describe('⑥ 服务层形状（与快速通道同形，前端一套渲染）', () => {
  it('补全 total / totalByScope / targets / excluded，无候选时 reason=no-hits 且 parsed 如实', async () => {
    const ev = await createEvent(scope, { title: '服务层形状验证', typeId: 'et_1' });
    const script = scriptedStream([{ text: '模型说：我没有找到相关文档（不是 JSON）' }]);
    const result = await runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
    }));

    assert.deepEqual(result.targets, [scope]);
    assert.ok(result.totalByScope?.[0]?.docs >= 2, `库统计要有值：${JSON.stringify(result.totalByScope)}`);
    assert.equal(result.total, result.totalByScope?.[0]?.docs);
    assert.equal(result.reason, 'no-hits', '无候选走 no-hits，具体原因靠 parsed 区分');
    assert.equal(result.parsed, false, '模型输出不是 JSON 时必须如实标 parsed:false');
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(result.steps, [], '一次工具都没调 → 没有过程步骤（旧实现的 understand/verify 已随旧函数删除）');
    assert.deepEqual(result.excluded.associated, []);
  });

  it('候选与 excluded 口径：已关联文档只给文档名', async () => {
    const ev = await createEvent(scope, {
      title: 'excluded 口径验证',
      typeId: 'et_1',
      docs: [{ group: GROUP, name: ART_A }],
    });
    const script = scriptedStream([
      { calls: [{ name: 'ki_get_module_info', args: { scope, group: GROUP, relation: ART_B } }] },
      { text: JSON.stringify({ summary: '命中', candidates: [{ scope: scope, group: GROUP, name: ART_B, why: '命中' }] }) },
    ]);
    const r = await runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
    }));
    assert.deepEqual(r.excluded.associated, [ART_A], 'excluded 与快速通道同口径：只给文档名');
    assert.equal(r.candidates.length, 1);
  });
});

/**
 * ⑦ 生效门：`find.maxToolCalls` 从配置真的一路走到内核（2026-11-19）。
 *
 * 为什么要过服务层而不是只测 `deep-find-core`：本仓已出现过「配置项存在、设置页能改、
 * 但生效路径根本不读它」的事故（`find.tools` 四开关，见事件 #43）。这里直接把提示词文件
 * 写成带上限的样子，验证「读配置 → 装配 → 内核限流 → 结果标 budget」整条链。
 */
describe('⑦ 工具调用次数上限：配置 → 服务 → 内核', () => {
  it('上限 2：一轮并发 3 个调用只执行 2 次；结果标 budget 且提示词带预算', async () => {
    const file = promptConfigPath(cfg);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, find: { maxToolCalls: 2 } }));
    try {
      const ev = await createEvent(scope, { title: '工具调用上限验证', typeId: 'et_1' });
      const script = scriptedStream([
        {
          calls: [
            { name: 'ki_search', args: { query: '回滚' } },
            { name: 'ki_search', args: { query: '发布' } },
            { name: 'ki_search', args: { query: '值班' } },
          ],
        },
        // 第 2 次请求若被当成"正常一轮"，这里会真的再执行一次工具 → 下面的 calls 断言会红
        { calls: [{ name: 'ki_search', args: { query: '再次' } }] },
        { text: '[]' },
      ]);
      const r = await runDeepFindAsSearchResult(scope, ev.id, deps({
        stream: { stream: script.fn, status: () => okStatus() },
      }));

      assert.equal(r.steps[0]?.metrics?.calls, 2, '上限 2 ⇒ 一轮并发 3 个调用也只能执行 2 次');
      assert.equal(r.partial?.reason, 'budget', '面板据此说"次数用满"而不是"超时"');
      assert.equal(r.partial?.usedCalls, 2);

      const systemPrompt = String(script.seen[0]?.[0]?.content ?? '');
      assert.match(systemPrompt, /最多可以调用 2 次工具/, '上限必须提前告知模型');

      // 达上限后不得再发"完整一轮"请求：只剩收口那一次（少了这条断言，删掉 break 也不会红）
      assert.equal(script.turns(), 2, '达上限后只允许再请求一次（收口轮）');

      // 每个被拒的调用都必须回一条 tool 消息：少一条上游会因 tool_calls/tool 不配对直接 400
      const closingMessages = script.seen[1] ?? [];
      const toolMessages = closingMessages.filter((m) => m.role === 'tool');
      assert.equal(toolMessages.length, 3, '3 个调用 = 2 条执行结果 + 1 条"已达上限"');
      assert.ok(
        toolMessages.some((m) => String(m.content).includes('已达上限')),
        `被拒的调用要如实回错误文本，实际：${JSON.stringify(toolMessages.map((m) => m.content))}`,
      );
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('配额在轮末恰好用满（没有任何调用被拒）也必须收口并标 budget', async () => {
    const file = promptConfigPath(cfg);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, find: { maxToolCalls: 2 } }));
    try {
      const ev = await createEvent(scope, { title: '恰好用满验证', typeId: 'et_1' });
      // 一轮正好 2 个调用（= 上限），没有第 3 个去触发拒绝分支
      const script = scriptedStream([
        { calls: [{ name: 'ki_search', args: { query: '回滚' } }, { name: 'ki_search', args: { query: '发布' } }] },
        { text: '[]' },
      ]);
      const r = await runDeepFindAsSearchResult(scope, ev.id, deps({
        stream: { stream: script.fn, status: () => okStatus() },
      }));
      assert.equal(r.steps[0]?.metrics?.calls, 2);
      // 少了轮首补判：这里会变成 timeout（实际既没超时也没"被拒"），用户看到的原因就是错的
      assert.equal(r.partial?.reason, 'budget', '恰好用满同样属于"次数用尽"');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('配置文件不存在时按默认 15 次下发（配置域默认值，不允许「不限制」）', async () => {
    const ev = await createEvent(scope, { title: '默认上限验证', typeId: 'et_1' });
    const script = scriptedStream([
      { calls: [{ name: 'ki_search', args: { query: '回滚' } }] },
      { text: '[]' },
    ]);
    await runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
    }));
    const systemPrompt = String(script.seen[0]?.[0]?.content ?? '');
    assert.match(systemPrompt, /最多可以调用 15 次工具/, '配置缺字段也必须给模型一个具体次数');
  });
});
