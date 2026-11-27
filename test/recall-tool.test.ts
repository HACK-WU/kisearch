/**
 * `ki_recall` 工具层单测（REQ-20261118-004 · S-02）
 *
 * 覆盖五组：
 *   ① 入参校验：task / hints / scope 必填（漏传回可用清单）
 *   ② 范围预检：点名不存在 → 直接报错，**不发起任何检索**
 *   ③ 门禁三态：模型未配 / 外发未确认 / 不支持 tools → 直接不可用，文案均含 `ki_search` 出路
 *   ④ 成功路径：模型读正文后给候选 → summary/candidates/evidence/nextActions 齐备；
 *      未读过的候选被剔除；只读到片段 → evidence='snippet' 且 partial
 *   ⑤ 频控：超过每分钟上限 → THROTTLED + retryAfterSec
 *
 * 运行：npx jiti test/recall-tool.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ChatTurn, LlmStreamPart } from '../src/lib/chat/llm-client.js';
import { FIND_DEFAULT_TOOL_CALLS } from '../src/lib/chat/prompt-config.js';
import { RECALL_TOOL_CODES } from '../src/lib/recall/codes.js';
import { makeRecallToolRunner } from '../src/lib/recall/tool-runner.js';
import { executeRecall, resolveRecallSection, type RecallArgs, type RecallToolDeps } from '../src/lib/mcp-tools/recall.js';
import type { KiConfig } from '../src/lib/config.js';
import type { RecallRuntimeCfg, RecallToolOutcome } from '../src/lib/recall/run-recall.js';

const RECALL_CFG: RecallRuntimeCfg = {
  prompt: '测试用提示词',
  tools: { ki_search: true, ki_get_module_info: true, ki_group_list: false, ki_scope_list: false, ki_tag_list: false },
  maxRounds: 4,
  toolResponseChars: 8000,
  skills: [],
};

/** 组装一份「模型已配置且已确认外发」的配置 */
function makeConfig(over: Partial<NonNullable<KiConfig['llm']>> = {}): KiConfig {
  return {
    dataDir: '/tmp/kb',
    chatDir: '/tmp/chat',
    llm: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', kbDisclosureAck: true, supportsTools: true, ...over },
  } as KiConfig;
}

type StreamFn = (messages: ChatTurn[], opts?: Record<string, unknown>) => AsyncGenerator<LlmStreamPart>;

/** 第 1 轮发起一次工具调用，第 2 轮返回最终 JSON */
function twoRoundStream(finalJson: unknown, toolName = 'ki_get_module_info', toolArgs: Record<string, unknown> = { group: '错误库', relation: 'doc-a' }): StreamFn {
  let round = 0;
  return async function* gen() {
    round += 1;
    if (round === 1) {
      yield { type: 'tool_calls', calls: [{ id: 'c1', name: toolName, arguments: JSON.stringify(toolArgs) }] };
      return;
    }
    yield { type: 'content', text: JSON.stringify(finalJson) };
  } as unknown as StreamFn;
}

/** 只返回最终 JSON（不调工具） */
function finalOnlyStream(finalJson: unknown): StreamFn {
  return async function* gen() {
    yield { type: 'content', text: JSON.stringify(finalJson) };
  } as unknown as StreamFn;
}

function baseDeps(over: Partial<RecallToolDeps> = {}): RecallToolDeps {
  return {
    tokenScopes: null,
    kiConfig: makeConfig(),
    scopeDeps: { listScopes: () => ['kb-a'], listViews: () => ({}) },
    principalKey: 'test',
    recallCfg: RECALL_CFG,
    runtime: { throttlePerMinute: 100, hardTimeoutMs: 5000 },
    now: () => Date.now(),
    ...over,
  };
}

const ARGS: RecallArgs = {
  scope: 'kb-a',
  task: '删除文档后还能搜到，怀疑向量残留，要查删除链路的兜底逻辑',
  hints: ['delete-relation'],
};

function parse(res: Awaited<ReturnType<typeof executeRecall>>): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

describe('① 入参校验', () => {
  it('task 为空 → RECALL_TASK_INVALID', async () => {
    const r = parse(await executeRecall({ ...ARGS, task: '   ' }, baseDeps()));
    assert.equal(r.ok, false);
    assert.equal(r.code, RECALL_TOOL_CODES.TASK_INVALID);
  });

  it('hints 超过上限 → RECALL_HINTS_INVALID', async () => {
    const r = parse(await executeRecall({ ...ARGS, hints: Array.from({ length: 99 }, (_, i) => `h${i}`) }, baseDeps()));
    assert.equal(r.code, RECALL_TOOL_CODES.HINTS_INVALID);
  });

  it('漏传 scope → RECALL_SCOPE_REQUIRED 且回可用清单', async () => {
    const r = parse(await executeRecall({ task: ARGS.task }, baseDeps()));
    assert.equal(r.code, RECALL_TOOL_CODES.SCOPE_REQUIRED);
    assert.deepEqual(r.available, ['kb-a'], '必须回可用清单，让调用方一次自愈');
    assert.match(String(r.message), /不会.*替你挑库/);
  });
});

describe('② 范围预检', () => {
  it('scope 不存在 → RECALL_SCOPE_UNKNOWN，且不发起检索', async () => {
    let searched = 0;
    const r = parse(await executeRecall(
      { ...ARGS, scope: 'typo-kb' },
      baseDeps({ search: (async () => { searched += 1; return []; }) as never }),
    ));
    assert.equal(r.code, RECALL_TOOL_CODES.SCOPE_UNKNOWN);
    assert.equal(searched, 0, '预检失败不得先检索一遍');
  });
});

describe('③ 门禁三态（未过即不可用，不降级）', () => {
  it('模型未配置 → MODEL_UNAVAILABLE + ki_search 出路', async () => {
    const cfg = { dataDir: '/tmp/kb', chatDir: '/tmp/chat' } as KiConfig;
    const r = parse(await executeRecall(ARGS, baseDeps({ kiConfig: cfg })));
    assert.equal(r.code, RECALL_TOOL_CODES.MODEL_UNAVAILABLE);
    assert.match(String(r.message), /ki_search/);
  });

  it('外发未确认 → DISCLOSURE_REQUIRED + ki_search 出路', async () => {
    const r = parse(await executeRecall(ARGS, baseDeps({ kiConfig: makeConfig({ kbDisclosureAck: false }) })));
    assert.equal(r.code, RECALL_TOOL_CODES.DISCLOSURE_REQUIRED);
    assert.match(String(r.message), /ki_search/);
  });

  it('模型不支持 tools → TOOLS_UNSUPPORTED + ki_search 出路', async () => {
    const r = parse(await executeRecall(ARGS, baseDeps({ kiConfig: makeConfig({ supportsTools: false }) })));
    assert.equal(r.code, RECALL_TOOL_CODES.TOOLS_UNSUPPORTED);
    assert.match(String(r.message), /ki_search/);
  });
});

describe('④ 成功路径', () => {
  it('读过正文的候选 → evidence=full，summary/nextActions 齐备', async () => {
    const stream = twoRoundStream({
      summary: '最该先读错误库那篇排查记录。',
      candidates: [{ scope: 'kb-a', group: '错误库', name: 'doc-a', why: '完整记录了删除链路的三层兜底判据' }],
      uncertainties: ['两篇记录口径略有差异'],
      needMore: [],
    });
    const runTool = async (): Promise<RecallToolOutcome> => ({
      text: '{"doc":{"content":"正文"}}',
      read: { scope: 'kb-a', group: '错误库', name: 'doc-a', truncated: false },
    });
    const r = parse(await executeRecall(ARGS, baseDeps({ stream, runTool })));
    assert.equal(r.ok, true);
    assert.equal(r.summary, '最该先读错误库那篇排查记录。');
    const cands = r.candidates as Array<Record<string, unknown>>;
    assert.equal(cands.length, 1);
    assert.equal(cands[0]!.evidence, 'full');
    const actions = r.nextActions as Array<Record<string, unknown>>;
    assert.equal(actions.length, 1);
    assert.deepEqual((actions[0]!.args as Record<string, unknown>).group, '错误库');
    assert.equal(r.partial, undefined, '读到全文不算不完整');
  });

  it('模型编造的候选（没读过）→ 被剔除并计入 dropped', async () => {
    const stream = finalOnlyStream({
      summary: '看起来有相关的。',
      candidates: [{ scope: 'kb-a', group: '错误库', name: 'never-read', why: '应该相关' }],
      uncertainties: [],
      needMore: [],
    });
    const r = parse(await executeRecall(ARGS, baseDeps({ stream })));
    assert.equal(r.ok, true);
    assert.deepEqual(r.candidates, [], '没读过正文的候选一律不得返回');
    assert.equal(r.dropped, 1);
  });

  it('只读到片段（截断）→ evidence=snippet 且部分结果', async () => {
    const stream = twoRoundStream({
      summary: '只看到片段。',
      candidates: [{ scope: 'kb-a', group: '错误库', name: 'doc-a', why: '疑似相关（仅片段）' }],
      uncertainties: [],
      needMore: [],
    });
    const runTool = async (): Promise<RecallToolOutcome> => ({
      text: '{"doc":{"content":"片段"}}',
      read: { scope: 'kb-a', group: '错误库', name: 'doc-a', truncated: true },
    });
    const r = parse(await executeRecall(ARGS, baseDeps({ stream, runTool })));
    const cands = r.candidates as Array<Record<string, unknown>>;
    assert.equal(cands.length, 1);
    assert.equal(cands[0]!.evidence, 'snippet');
    assert.equal(r.partial, true, '只读到片段必须标明不完整');
  });
});

describe('⑤ 频控', () => {
  it('超过每分钟上限 → THROTTLED + retryAfterSec', async () => {
    const deps = baseDeps({
      // 独立调用方键：频控窗口按 principalKey 计，别被本文件前面的用例污染
      principalKey: 'throttle-test',
      runtime: { throttlePerMinute: 1, hardTimeoutMs: 5000 },
      stream: finalOnlyStream({ summary: 's', candidates: [], uncertainties: [], needMore: [] }),
    });
    const first = parse(await executeRecall(ARGS, deps));
    assert.equal(first.ok, true);
    const second = parse(await executeRecall(ARGS, deps));
    assert.equal(second.code, RECALL_TOOL_CODES.THROTTLED);
    assert.equal(second.retryable, true);
    assert.ok(typeof second.retryAfterSec === 'number');
  });
});

/**
 * ⑥ 工具调用预算（2026-11-25 · A 方案）
 *
 * 背景：页面「AI 查找 · 工具调用次数」与 MCP `ki_recall` 是同一套配置。
 * 改动前该值只存在于页面侧，预取落进内核唯一的「不限制」档 —— 这两例就是锁这个口径。
 */
describe('⑥ 工具调用预算（与「AI 查找」共用 find 域）', () => {
  it('find.maxToolCalls 生效；缺失时按默认 15', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-recall-cfg-'));
    try {
      const file = path.join(dir, 'prompt-config.json');
      fs.writeFileSync(file, JSON.stringify({ version: 1, find: { maxToolCalls: 7 } }));
      assert.equal(resolveRecallSection({ dataDir: dir, chatDir: dir } as KiConfig).maxToolCalls, 7,
        '预取必须读页面同一个 find 域');

      fs.writeFileSync(file, JSON.stringify({ version: 1, find: {} }));
      assert.equal(resolveRecallSection({ dataDir: dir, chatDir: dir } as KiConfig).maxToolCalls, FIND_DEFAULT_TOOL_CALLS,
        '缺字段按 15：预取不再是不限制档');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('预算既写进系统提示词，内核也真按它截断', async () => {
    let systemPrompt = '';
    let executed = 0;
    let round = 0;
    const stream: StreamFn = (async function* (messages: ChatTurn[]) {
      round += 1;
      if (round === 1) {
        systemPrompt = String(messages[0]?.content ?? '');
        yield {
          type: 'tool_calls',
          calls: [
            { id: 'c1', name: 'ki_search', arguments: JSON.stringify({ query: 'a' }) },
            { id: 'c2', name: 'ki_search', arguments: JSON.stringify({ query: 'b' }) },
          ],
        };
        return;
      }
      yield { type: 'content', text: JSON.stringify({ summary: 's', candidates: [], uncertainties: [], needMore: [] }) };
    }) as unknown as StreamFn;

    const res = await executeRecall(ARGS, baseDeps({
      recallCfg: { ...RECALL_CFG, maxToolCalls: 2 },
      stream,
      runTool: async () => {
        executed += 1;
        return { text: JSON.stringify({ results: [] }) };
      },
    }));

    assert.equal(parse(res).ok, true);
    assert.match(systemPrompt, /最多可以调用 2 次工具/, '预算必须写进系统提示词，模型才能提前规划');
    assert.equal(executed, 2, '配额 2 只能真执行 2 次');
  });

  it('超时取「find.timeoutMs」与部署级 cap 的较小值，文案给实际秒数', async () => {
    // 慢 stream：1.5s 才产出，超时 1s 必先触发（收尾后它自己结束，不留未决 promise）
    const slow: StreamFn = (async function* () {
      await new Promise((r) => setTimeout(r, 1_500));
      yield { type: 'content', text: '{}' };
    }) as unknown as StreamFn;
    const r = parse(await executeRecall(ARGS, baseDeps({
      recallCfg: { ...RECALL_CFG, timeoutMs: 1_000 },
      runtime: { throttlePerMinute: 100, hardTimeoutMs: 60_000 },
      stream: slow,
    })));
    assert.equal(r.code, RECALL_TOOL_CODES.TIMEOUT);
    assert.match(String(r.message), /超过 1 秒/);
  });
});

/**
 * ⑦ scope 自选（2026-11-25 批 3 · Q3/Q4）
 *
 * 口径：调用方传入的 scope 只是默认值；模型可自选，**每次调用**都校验，失败报错不回落。
 * 这里直接测执行器（不经模型），锁住「scope 真的传到执行层 + 视图展开 + 审计记实际值」。
 */
describe('⑦ scope 自选：默认范围 + 逐次校验 + 视图展开', () => {
  const VIEWS: Record<string, string[]> = { 'team-view': ['kb-b', 'kb-c'] };

  /** 造一个执行器：search / getModuleInfo 用假实现，记录实际收到的 scope */
  function makeRunner(calls: string[]) {
    return makeRecallToolRunner({
      targets: ['kb-a'],
      toolChars: 8000,
      resolveScope: (requested) => {
        if (requested.includes('bad')) {
          return { error: '这些 scope 不可用：bad（missing）。可用库：kb-a、kb-b、kb-c' };
        }
        const physical: string[] = [];
        for (const name of requested) {
          const members = VIEWS[name];
          if (members) physical.push(...members);
          else physical.push(name);
        }
        return { physical, display: requested };
      },
      scopeCatalog: () => ({ scopes: ['kb-a', 'kb-b', 'kb-c'], views: VIEWS }),
      impl: {
        search: (async (args: { scope: string }) => {
          calls.push(args.scope);
          return { results: [], mode: 'fulltext' as const };
        }) as never,
        getModuleInfo: (async (args: { scope: string }) => {
          calls.push(args.scope);
          return args.scope === 'kb-b'
            ? { ok: true, scope: 'kb-b', group: 'g', relation: 'r', content: 'x' }
            : { ok: false, error: 'not found' };
        }) as never,
        // 聚合语义工具的执行层：记录收到的 scope 与 depth（降级断言用）
        queryGroup: (async (args: { scope: string; depth?: number }) => {
          calls.push(`tree:${args.scope}`);
          return { ok: true, scope: args.scope, output: `TREE(${args.scope},depth=${args.depth ?? '-'})` };
        }) as never,
        tagList: (async (args: { scope: string }) => {
          calls.push(`tag:${args.scope}`);
          return { ok: true, tags: [{ tag: `t-${args.scope}`, count: 1 }] };
        }) as never,
      },
    });
  }

  it('不传 scope → 用默认范围；传了 → 按它查并记生效 scope', async () => {
    const calls: string[] = [];
    const runner = makeRunner(calls);

    const r1 = await runner('ki_search', { query: 'q' });
    assert.deepEqual(r1.scopeUsed, ['kb-a'], '未传 scope 用默认范围');
    assert.deepEqual(calls, ['kb-a']);

    calls.length = 0;
    const r2 = await runner('ki_search', { query: 'q', scope: 'kb-b' });
    assert.deepEqual(r2.scopeUsed, ['kb-b'], '传了就用它');
    assert.deepEqual(calls, ['kb-b'], 'scope 必须真的传到执行层');
  });

  it('传视图 → 展开成员后检索，审计记视图名', async () => {
    const calls: string[] = [];
    const runner = makeRunner(calls);
    const r = await runner('ki_search', { query: 'q', scope: 'team-view' });
    assert.equal(calls[0], 'kb-b,kb-c', '视图展开成成员库');
    assert.deepEqual(r.scopeUsed, ['team-view'], '审计记模型给的名字（视图）');
  });

  it('传不可用 scope → 报错且不执行（不回落默认）', async () => {
    const calls: string[] = [];
    const runner = makeRunner(calls);
    const r = await runner('ki_search', { query: 'q', scope: 'bad' });
    assert.match(r.text, /不可用/);
    assert.match(r.text, /可用库/, '错误里要有可用清单，让模型自愈');
    assert.deepEqual(calls, [], '校验失败不得带着默认范围偷偷执行');
  });

  it('读正文在视图展开后逐个试，命中即止并回填真实库', async () => {
    const calls: string[] = [];
    const runner = makeRunner(calls);
    const r = await runner('ki_get_module_info', { group: 'g', relation: 'r', scope: 'team-view' });
    assert.deepEqual(calls, ['kb-b'], 'kb-b 命中即停，不再试 kb-c');
    assert.equal(r.read?.scope, 'kb-b');
  });

  /**
   * 事件 #112：`ki_group_list` / `ki_tag_list` 是**聚合语义**（全貌），
   * 此前复用 `tryEachPhysical`（命中即止）只查首个成员库，且把 `scopeUsed`
   * 记成命中库名 —— 调用方看不出漏了成员。以下两例锁死修复后的口径。
   */
  it('列树在视图下逐成员收集（聚合语义，不得命中即止）', async () => {
    const calls: string[] = [];
    const runner = makeRunner(calls);
    const r = await runner('ki_group_list', { scope: 'team-view' });
    assert.deepEqual(calls, ['tree:kb-b', 'tree:kb-c'], '两个成员都要查');
    assert.deepEqual(r.scopeUsed, ['team-view'], '审计记视图名，不记命中库');
    const payload = JSON.parse(r.text) as {
      view: string;
      members: string[];
      degraded?: string[];
      buckets: { scope: string; output?: string; degraded?: boolean }[];
    };
    assert.equal(payload.view, 'team-view');
    assert.deepEqual(payload.members, ['kb-b', 'kb-c']);
    assert.deepEqual(payload.degraded, ['kb-c'], '第二成员降级：只给顶层 Group 名');
    assert.match(String(payload.buckets[1]?.output), /depth=1/, '降级成员按 depth=1 查询');
    assert.equal(payload.buckets[0]?.degraded, undefined, '首成员仍是完整树');
  });

  it('列标签在视图下合并累加（不分桶，标来源库）', async () => {
    const calls: string[] = [];
    const runner = makeRunner(calls);
    const r = await runner('ki_tag_list', { scope: 'team-view' });
    assert.deepEqual(calls, ['tag:kb-b', 'tag:kb-c'], '两个成员都要读');
    assert.deepEqual(r.scopeUsed, ['team-view'], '审计记视图名');
    const payload = JSON.parse(r.text) as { count: number; tags: { tag: string; scopes: string[] }[] };
    assert.equal(payload.count, 2, '两个库的 tag 合并成 2 条');
    assert.deepEqual(payload.tags.map(t => t.scopes), [['kb-b'], ['kb-c']], '每条标明来源库');
  });

  it('未传 scope 时 scopesUsed 用入参原名（视图不被记成成员库）', async () => {
    const calls: string[] = [];
    const runner = makeRecallToolRunner({
      targets: ['kb-b', 'kb-c'],
      defaultDisplay: ['team-view'],
      toolChars: 4000,
      impl: {
        search: (async (args: { scope: string }) => {
          calls.push(args.scope);
          return { results: [], mode: 'fulltext' as const };
        }) as never,
      },
    });
    const r = await runner('ki_search', { query: 'q' });
    assert.deepEqual(r.scopeUsed, ['team-view'], '审计与展示都该用入参原名');
    assert.deepEqual(calls, ['kb-b,kb-c'], '检索仍用展开后的物理库');
  });

  it('ki_scope_list 回可用库与视图（模型自选的唯一目录）', async () => {
    const calls: string[] = [];
    const runner = makeRunner(calls);
    const r = await runner('ki_scope_list', {});
    const payload = JSON.parse(r.text) as { scopes: string[]; views: Array<{ name: string; members: string[] }> };
    assert.deepEqual(payload.scopes, ['kb-a', 'kb-b', 'kb-c']);
    assert.equal(payload.views[0]?.name, 'team-view');
  });
});
