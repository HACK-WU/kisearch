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

import type { ChatTurn, LlmStreamPart } from '../src/lib/chat/llm-client.js';
import { RECALL_TOOL_CODES } from '../src/lib/recall/codes.js';
import { executeRecall, type RecallArgs, type RecallToolDeps } from '../src/lib/mcp-tools/recall.js';
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
