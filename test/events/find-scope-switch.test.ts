/**
 * 「AI 查找」自选 scope 回归（2026-11-25，与 `ki_recall` 同口径）。
 *
 * 用户口径：**AI 查找也能看其他库**，传入的 scope 只是默认值。
 * 这里锁两件事（都是真机上会"看起来不支持换库"的卡点）：
 *   ① 模型换了库 → 候选**不得被范围校验误剔除**（allowed 要按实际用过的 scope 放行）；
 *   ② 调用方没传 `tokenScopes`（未开启）→ 跨库候选仍按越界剔除（旧行为不被无意放开）。
 *
 * 运行：npx jiti test/events/find-scope-switch.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runDeepFindCore } from '../../src/lib/events/deep-find-core.js';

const EVENT = {
  id: 'evt_1',
  typeId: 'et_1',
  title: '事件标题',
  description: '',
  stageKey: 'st_1',
} as never;

const viewOf = (): string[] | null => null;

/** 两轮工具 + 一轮结论：先 ki_search(kisearch)，再读 kisearch 的正文，最后给该库的候选 */
function makeStream(): (messages: unknown[], opts?: Record<string, unknown>) => AsyncGenerator<unknown> {
  let round = 0;
  return (async function* gen() {
    round += 1;
    if (round === 1) {
      yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'ki_search', arguments: JSON.stringify({ query: 'q', scope: 'kisearch' }) }] };
      return;
    }
    if (round === 2) {
      yield {
        type: 'tool_calls',
        calls: [{ id: 'c2', name: 'ki_get_module_info', arguments: JSON.stringify({ group: 'g', relation: 'r', scope: 'kisearch' }) }],
      };
      return;
    }
    yield {
      type: 'content',
      text: JSON.stringify({
        summary: '结论',
        candidates: [{ scope: 'kisearch', group: 'g', name: 'r', why: '为什么', confidence: 0.9 }],
        uncertainties: [],
        needMore: [],
      }),
    };
  }) as never;
}

/** 假工具执行器：把模型传的 scope 原样当作"实际生效范围"（含 read 回填） */
const runTool = (async (name: string, a: Record<string, unknown>) => {
  const sc = String(a.scope ?? 'kb-a');
  if (name === 'ki_get_module_info') {
    return { text: JSON.stringify({ doc: {} }), read: { scope: sc, group: 'g', name: 'r', truncated: false }, scopeUsed: [sc] };
  }
  return { text: JSON.stringify({ results: [] }), scopeUsed: [sc] };
}) as never;

function baseArgs(extra: Record<string, unknown> = {}) {
  return {
    event: EVENT,
    eventType: null,
    members: [],
    refs: [],
    targets: ['kb-a'],
    viewOf,
    prompt: 'p',
    skills: [],
    usedKeys: new Set<string>(),
    llm: {},
    stream: makeStream(),
    runTool,
    // 存在性校验读 group cache：注入一份含目标文档的缓存，避免依赖真实 kb 目录
    cachesOf: () => new Map([['g', { hot_relations: [{ text: 'r' }] }]]),
    now: () => 0,
    ...extra,
  } as never;
}

describe('① 开启自选（传了 tokenScopes）', () => {
  it('模型换库读到的候选必须保留，不得被判越界', async () => {
    const r = await runDeepFindCore(baseArgs({ tokenScopes: ['kb-a', 'kisearch'] }));
    assert.equal(r.candidates.length, 1, '跨库候选应保留');
    assert.equal(r.candidates[0]!.scope, 'kisearch');
    assert.equal(r.unconfirmed.length, 0, '不应产生越界未确认项');
    assert.deepEqual(r.scopesUsed, ['kisearch'], '必须回显实际用过的 scope（前端据此展示）');
  });
});

describe('② 未开启（没传 tokenScopes）', () => {
  it('跨库候选按越界剔除（旧行为不被无意放开）', async () => {
    const r = await runDeepFindCore(baseArgs());
    assert.equal(r.candidates.length, 0, '范围锁定时候选应被剔除');
    assert.ok(r.unconfirmed.length > 0, '应记入未确认，便于回溯');
    assert.deepEqual(r.scopesUsed, ['kisearch'], '即使候选被剔除，也要如实记录实际查过的范围');
  });
});
