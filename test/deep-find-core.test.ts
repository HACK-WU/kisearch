/**
 * `deep-find-core`（共享内核版的 AI 查找）单测（REQ-20261118-004 合并）
 *
 * 只测「内核产物 → 面板契约」的映射，不测循环本身（那由 `recall-kernel` / `recall-tool` 覆盖）：
 *   ① 读过正文的候选 → 变成 RefCandidate（origin=deep / why 来自模型）
 *   ② 分片缓存里不存在的候选 → 进 unconfirmed(not-found)，不进 candidates
 *   ③ 已关联/已参考的文档 → 进 unconfirmed(already-used)
 *   ④ 越界 scope（视图名或不在 targets）→ 进 unconfirmed(out-of-scope)
 *   ⑤ 模型输出不可解析 → parsed=false（面板据此说"模型未给出结果"而不是"没有相关文档"）
 *   ⑥ 工具调用 → 聚合成一条 `tools` 步骤（面板的过程区）
 *
 * 运行：npx jiti test/deep-find-core.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ChatTurn, LlmStreamPart } from '../src/lib/chat/llm-client.js';
import { runDeepFindCore, type DeepFindCoreArgs } from '../src/lib/events/deep-find-core.js';

type StreamFn = (m: ChatTurn[], o?: Record<string, unknown>) => AsyncGenerator<LlmStreamPart>;

/** 第 1 轮读一篇正文，第 2 轮给最终 JSON */
function streamWithRead(collection: string, name: string, final: unknown): StreamFn {
  let round = 0;
  return async function* gen() {
    round += 1;
    if (round === 1) {
      yield {
        type: 'tool_calls',
        calls: [{ id: 'c1', name: 'ki_get_module_info', arguments: JSON.stringify({ group: collection, relation: name }) }],
      } as LlmStreamPart;
      return;
    }
    yield { type: 'content', text: JSON.stringify(final) } as LlmStreamPart;
  } as unknown as StreamFn;
}

function cachesWith(collection: string, name: string): (scope: string) => Map<string, { hot_relations: Array<{ text: string; eventId?: string }> }> {
  return () => new Map([[collection, { hot_relations: [{ text: name }] }]]);
}

function baseArgs(over: Partial<DeepFindCoreArgs> = {}): DeepFindCoreArgs {
  return {
    event: { id: 'evt-1', title: '删除后仍能搜到', description: '', scope: 'kb-a', stageKey: 's1' } as never,
    eventType: { name: 'bug 排查' },
    members: [],
    refs: [] as never,
    targets: ['kb-a'],
    viewOf: () => null,
    prompt: '测试提示词',
    skills: [{ name: 'refs-locate', content: '测试 skill 正文', enabled: true }],
    usedKeys: new Set<string>(),
    llm: { apiKey: 'k', baseURL: 'http://127.0.0.1:1/v1', model: 'm' },
    // 假工具：模拟"读到了正文"，否则内核的「必须读过」校验会剔除候选
    runTool: async (name, a) => ({
      text: '{"doc":{"content":"正文"}}',
      ...(name === 'ki_get_module_info'
        ? { read: { scope: 'kb-a', group: String(a.group ?? ''), name: String(a.relation ?? ''), truncated: false } }
        : {}),
    }),
    ...over,
  };
}

const OK_FINAL = {
  summary: '最该先读这篇。',
  candidates: [{ scope: 'kb-a', group: '错误库', name: 'doc-a', why: '直接讲了这个现象' }],
  uncertainties: [],
  needMore: [],
};

describe('① 映射：读过正文 → RefCandidate', () => {
  it('origin=deep、why 来自模型、steps 来自工具轨迹', async () => {
    const res = await runDeepFindCore(baseArgs({
      stream: streamWithRead('错误库', 'doc-a', OK_FINAL),
      cachesOf: cachesWith('错误库', 'doc-a'),
    }));
    assert.equal(res.candidates.length, 1);
    assert.equal(res.candidates[0]!.origin, 'deep');
    assert.equal(res.candidates[0]!.scope, 'kb-a');
    assert.equal(res.candidates[0]!.why, '直接讲了这个现象');
    assert.equal(res.parsed, true);
    assert.equal(res.steps.length, 1, '工具调用要聚合成一条过程步骤');
    assert.equal(res.steps[0]!.name, 'tools');
    assert.equal(res.unconfirmedCount, 0);
    // 结论要透传（面板的「查找总结」卡片数据源，2026-11-19）
    assert.equal(res.summary, '最该先读这篇。');
  });
});

describe('②~④ 三重校验', () => {
  it('缓存里不存在 → not-found', async () => {
    const res = await runDeepFindCore(baseArgs({
      stream: streamWithRead('错误库', 'ghost', {
        ...OK_FINAL,
        candidates: [{ scope: 'kb-a', group: '错误库', name: 'ghost', why: 'x' }],
      }),
      cachesOf: () => new Map(),
    }));
    assert.equal(res.candidates.length, 0);
    assert.equal(res.unconfirmed[0]!.reason, 'not-found');
  });

  it('已关联的文档 → already-used', async () => {
    const res = await runDeepFindCore(baseArgs({
      stream: streamWithRead('错误库', 'doc-a', OK_FINAL),
      cachesOf: cachesWith('错误库', 'doc-a'),
      usedKeys: new Set(['kb-a\u0000错误库\u0000doc-a']),
    }));
    assert.equal(res.candidates.length, 0);
    assert.equal(res.unconfirmed[0]!.reason, 'already-used');
  });

  it('视图名或不在 targets → out-of-scope', async () => {
    const res = await runDeepFindCore(baseArgs({
      stream: streamWithRead('错误库', 'doc-a', {
        ...OK_FINAL,
        candidates: [{ scope: 'kb-view', group: '错误库', name: 'doc-a', why: 'x' }],
      }),
      cachesOf: cachesWith('错误库', 'doc-a'),
      // 让"读到的库"落在视图名上：内核取已读库作候选 scope，随后被范围校验拦下
      runTool: async () => ({
        text: '{"doc":{"content":"正文"}}',
        read: { scope: 'kb-view', group: '错误库', name: 'doc-a', truncated: false },
      }),
    }));
    assert.equal(res.candidates.length, 0);
    assert.equal(res.unconfirmed[0]!.reason, 'out-of-scope');
  });
});

describe('⑤⑥ 不可解析与过程数据', () => {
  it('模型没给 JSON → parsed=false', async () => {
    const res = await runDeepFindCore(baseArgs({
      stream: (async function* gen() {
        yield { type: 'content', text: '我觉得有几篇文档挺相关的。' } as LlmStreamPart;
      }) as unknown as StreamFn,
      cachesOf: () => new Map(),
    }));
    assert.equal(res.parsed, false, '面板据此区分「模型没给结果」与「没有相关文档」');
    assert.equal(res.candidates.length, 0);
  });

  /*
   * 2026-11-20 补：内核此前把 `reasoning` 分片直接丢弃（契约声明了
   * `RefSearchStepDto.thinking`、前端也渲染思考块，实现从不产出）。
   */
  it('⑥ reasoning 流 → tools step 的 thinking / thinkingChars', async () => {
    let round = 0;
    const stream = (async function* gen() {
      round += 1;
      if (round === 1) {
        yield { type: 'reasoning', text: '先看错误库。' } as LlmStreamPart;
        yield {
          type: 'tool_calls',
          calls: [{ id: 'c1', name: 'ki_get_module_info', arguments: JSON.stringify({ group: '错误库', relation: 'doc-a' }) }],
        } as LlmStreamPart;
        return;
      }
      yield { type: 'reasoning', text: '这篇讲的就是它。' } as LlmStreamPart;
      yield { type: 'content', text: JSON.stringify(OK_FINAL) } as LlmStreamPart;
    }) as unknown as StreamFn;

    const res = await runDeepFindCore(baseArgs({
      stream,
      runTool: async () => ({
        text: '{"doc":{"content":"正文"}}',
        read: { scope: 'kb-a', group: '错误库', name: 'doc-a', truncated: false },
      }),
      cachesOf: cachesWith('错误库', 'doc-a'),
    }));

    assert.equal(res.steps.length, 1, '过程区仍只是一条 tools 步骤');
    assert.match(String(res.steps[0]!.thinking), /先看错误库/, '第 1 轮思考要带上');
    assert.match(String(res.steps[0]!.thinking), /这篇讲的就是它/, '第 2 轮思考要合并进来');
    assert.equal(res.steps[0]!.thinkingChars, '先看错误库。这篇讲的就是它。'.length);
  });

  it('⑥ 没调工具但有 reasoning：仍产出步骤，否则思考无处安放', async () => {
    const stream = (async function* gen() {
      yield { type: 'reasoning', text: '凭成员清单就能判断。' } as LlmStreamPart;
      yield { type: 'content', text: JSON.stringify({ ...OK_FINAL, candidates: [] }) } as LlmStreamPart;
    }) as unknown as StreamFn;

    const res = await runDeepFindCore(baseArgs({ stream, cachesOf: () => new Map() }));
    assert.equal(res.steps.length, 1);
    assert.equal(res.steps[0]!.metrics?.calls, 0);
    assert.match(String(res.steps[0]!.thinking), /凭成员清单/);
  });

  it('⑥ reasoning 超 2000 字截断，thinkingChars 保留原始长度', async () => {
    const long = '想'.repeat(3000);
    const stream = (async function* gen() {
      yield { type: 'reasoning', text: long } as LlmStreamPart;
      yield { type: 'content', text: JSON.stringify({ ...OK_FINAL, candidates: [] }) } as LlmStreamPart;
    }) as unknown as StreamFn;

    const res = await runDeepFindCore(baseArgs({ stream, cachesOf: () => new Map() }));
    assert.equal(String(res.steps[0]!.thinking).length, 2000, '与契约「单步截断 2000 字」同口径');
    assert.equal(res.steps[0]!.thinkingChars, 3000, '前端据此提示「已截断（原文 3000 字）」');
  });
});

describe('⑦ 工具调用次数上限（2026-11-19）', () => {
  /** 第 1 轮并发 3 个调用，第 2 轮给最终 JSON */
  function streamParallel3(final: unknown): StreamFn {
    let round = 0;
    return async function* gen() {
      round += 1;
      if (round === 1) {
        yield {
          type: 'tool_calls',
          calls: [1, 2, 3].map((i) => ({
            id: `c${i}`,
            name: 'ki_search',
            arguments: JSON.stringify({ query: `q${i}` }),
          })),
        } as LlmStreamPart;
        return;
      }
      yield { type: 'content', text: JSON.stringify(final) } as LlmStreamPart;
    } as unknown as StreamFn;
  }

  /** 抓系统提示词：第 1 轮调个工具，第 2 轮给 JSON */
  function streamCapturing(get: (sys: string) => void): StreamFn {
    let round = 0;
    return async function* gen(messages: ChatTurn[]) {
      get(String(messages[0]?.content ?? ''));
      round += 1;
      if (round === 1) {
        yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'ki_search', arguments: '{}' }] } as LlmStreamPart;
        return;
      }
      yield { type: 'content', text: JSON.stringify(OK_FINAL) } as LlmStreamPart;
    } as unknown as StreamFn;
  }

  it('上限=2：一轮并发 3 个调用只执行 2 次（按单次调用判，不按轮）', async () => {
    const res = await runDeepFindCore(baseArgs({
      maxToolCalls: 2,
      stream: streamParallel3(OK_FINAL),
      runTool: async () => ({ text: '{"ok":true}' }),
      cachesOf: () => new Map(),
    }));
    assert.equal(res.steps[0]!.metrics?.calls, 2, '并发超发是这里最容易出的错');
    assert.equal(res.partial?.reason, 'budget', '面板据此说"次数用满"而不是"超时"');
    assert.equal(res.partial?.usedCalls, 2);
    // 达上限后仍要能拿到结论：收口轮必须真的跑过（否则用户只会看到"模型没给出结果"）
    assert.equal(res.parsed, true, '收口轮要把已读证据收敛成可解析 JSON');
  });

  it('非整数 / 非有限值一律回落默认 15（提示词与限流必须同源）', async () => {
    for (const bad of [Number.POSITIVE_INFINITY, 2.5, Number.NaN]) {
      let sys = '';
      await runDeepFindCore(baseArgs({
        maxToolCalls: bad,
        stream: streamCapturing((s) => { sys = s; }),
        runTool: async () => ({ text: '{"ok":true}' }),
        cachesOf: () => new Map(),
      }));
      assert.match(sys, /最多可以调用 15 次工具/, `${String(bad)} 必须回落 15 次`);
      assert.equal(/Infinity|2\.5/.test(sys), false, `提示词里不得出现 ${String(bad)}`);
    }
  });

  it('上限写进系统提示词；漏传时按默认 15 次兜住（没有"不限制"档）', async () => {
    let sys = '';
    await runDeepFindCore(baseArgs({
      maxToolCalls: 3,
      stream: streamCapturing((s) => { sys = s; }),
      runTool: async () => ({ text: '{"ok":true}' }),
      cachesOf: () => new Map(),
    }));
    assert.match(sys, /最多可以调用 3 次工具/, '上限必须提前告知模型，让它先规划');
    assert.match(sys, /## 工具调用预算/);

    sys = '';
    const res = await runDeepFindCore(baseArgs({
      stream: streamCapturing((s) => { sys = s; }),
      runTool: async () => ({ text: '{"ok":true}' }),
      cachesOf: () => new Map(),
    }));
    assert.match(sys, /最多可以调用 15 次工具/, '漏传上限时按默认 15 次注入（查找没有"不限制"档）');
    assert.equal(res.partial, undefined, '只调了 1 次工具，不应产生 budget 收口');
  });
});
