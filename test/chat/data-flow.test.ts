/**
 * 数据走向预演测试（**骨架期应为【红】**）
 *
 * 目的：在放行并行**之前**，用可执行手段证明"**数据链能不能串**"——
 * 把契约失效模式的发现时机从拼接期提前到零成本窗口。
 *
 * 覆盖的链路（**全部用 mock 填满**，不依赖真实 zvec / 上游模型）：
 *   ① 正常：用户提问 → tool_start → 检索 → tool_end → 生成 → sources → done
 *   ② 降级：模型不支持工具 → degraded → 生成 → done
 *   ③ 检索不可用 → tool_end(error) → degraded → 生成 → done（N17）
 *   ④ 中止：已生成部分保留（N6）
 *
 * ⚠️ 骨架期红是**预期**：`runToolLoop` / `runPreRetrievalFallback` 为桩（抛 `STUB:SR-01:*`）。
 *   若此处出现 passed，反而说明桩返回了假值 → 必须归零。
 *
 * ⚠️ **本测试不按砖头分组**（它天然跨砖头：起于 SR-01 的检索、终于 SR-01 的落盘，
 *    但事件协议同时被 SR-02 消费）。拼接期换真实实现后须重跑。
 *
 * 运行：`npx jiti test/chat/data-flow.test.ts`
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startRetrievalUpstream } from './fixtures/retrieval-upstream.js';

const root = mkdtempSync(path.join(tmpdir(), 'ki-chat-data-flow-'));
const configPath = path.join(root, 'config.yaml');
const previousConfig = process.env.KI_CONFIG_PATH;
process.env.KI_CONFIG_PATH = configPath;
let closeUpstream: (() => Promise<void>) | undefined;
before(async () => { closeUpstream = await startRetrievalUpstream(root, configPath); });
after(async () => {
  await closeUpstream?.();
  rmSync(root, { recursive: true, force: true });
  if (previousConfig === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = previousConfig;
});

import type { ChatEvent } from '../../src/lib/chat/chat-contract.js';
import { CHAT_EVENT_ORDER_RULES } from '../../src/lib/chat/chat-contract.js';
import { runToolLoop } from '../../src/lib/chat/retrieval/tool-loop.js';
import { resetConfigCache } from '../../src/lib/config.js';
import {
  retrievalAnswerFlow,
  degradedFlow,
  retrievalUnavailableFlow,
  abortedFlow,
} from './fixtures/mock-sse.js';

/** 从 mock 事件序中提取规则违反项（骨架期用于校准断言；实现期用于校验真实事件） */
function validateOrder(events: ChatEvent[]): string[] {
  const problems: string[] = [];

  if (events[0]?.type !== 'meta') problems.push('首帧必须是 meta');

  const starts = events.filter((e) => e.type === 'tool_start').length;
  const ends = events.filter((e) => e.type === 'tool_end').length;
  if (CHAT_EVENT_ORDER_RULES.toolStartMustPairWithEnd && starts !== ends) {
    problems.push(`tool_start(${starts}) 与 tool_end(${ends}) 不成对`);
  }

  const sourcesCount = events.filter((e) => e.type === 'sources').length;
  if (CHAT_EVENT_ORDER_RULES.sourcesAtMostOnce && sourcesCount > 1) problems.push('sources 出现多次');

  const doneIdx = events.findIndex((e) => e.type === 'done');
  const srcIdx = events.findIndex((e) => e.type === 'sources');
  if (CHAT_EVENT_ORDER_RULES.sourcesBeforeDone && srcIdx >= 0 && doneIdx >= 0 && srcIdx > doneIdx) {
    problems.push('sources 必须在 done 之前');
  }

  const degCount = events.filter((e) => e.type === 'degraded').length;
  if (CHAT_EVENT_ORDER_RULES.degradedAtMostOnce && degCount > 1) problems.push('degraded 出现多次');

  return problems;
}

describe('数据走向预演 · mock 事件序自洽（骨架期即可绿，校准用）', () => {
  const flows: Array<[string, () => ChatEvent[]]> = [
    ['正常（带检索）', () => retrievalAnswerFlow() as ChatEvent[]],
    ['降级（模型不支持工具）', () => degradedFlow() as ChatEvent[]],
    ['检索不可用', () => retrievalUnavailableFlow() as ChatEvent[]],
    ['中止', () => abortedFlow() as ChatEvent[]],
  ];

  for (const [name, make] of flows) {
    it(`${name}：事件序符合 CHAT_EVENT_ORDER_RULES`, () => {
      assert.deepEqual(validateOrder(make()), []);
    });
  }

  it('降级链路必须带可见的 degraded 标记（N17 不得静默）', () => {
    assert.ok(degradedFlow().some((e) => e.type === 'degraded'));
    assert.ok(retrievalUnavailableFlow().some((e) => e.type === 'degraded'));
  });
});

describe('数据走向预演 · 真实链路（骨架期为红）', () => {
  const conv = {
    version: 1 as const, id: 'c-mock-0001', scope: 'kisearch', title: 't', systemPrompt: '',
    archived: false, archivedAt: null, createdAt: '', updatedAt: '', seq: 0,
    messageCount: 0, lastMessagePreview: '', messages: [],
  };

  it('真实工具循环：隔离知识库不可用时配对工具事件、明确降级、正常终答', async () => {
    const events: ChatEvent[] = [];
    for await (const e of runToolLoop({ scope: 'unregistered-fixture', conv, userText: 'ki_search 怎么用', convSystemPrompt: '' })) {
      events.push(e);
    }
    assert.deepEqual(validateOrder(events), []);
    assert.ok(events.some((e) => e.type === 'tool_start'));
    assert.ok(events.some((e) => e.type === 'tool_end'));
    assert.ok(events.some((e) => e.type === 'degraded'));
    assert.equal(events.at(-1)?.type, 'done');
  });

  it('降级链路：产出 degraded 事件（批次 2 D2：纯聊天，不执行工具）', async () => {
    // runPreRetrievalFallback 已退役；翻转 supportsTools=false 触发纯聊天降级路径
    const original = readFileSync(configPath, 'utf-8');
    // fixture 写出的 config 末行无换行 → 前置 \n 追加
    writeFileSync(configPath, `${original}\n  supportsTools: false\n`);
    resetConfigCache();
    try {
      const events: ChatEvent[] = [];
      for await (const e of runToolLoop({ scope: 'kisearch', conv, userText: 'x', convSystemPrompt: '' })) {
        events.push(e);
      }
      assert.ok(events.some((e) => e.type === 'degraded'));
      assert.ok(!events.some((e) => e.type === 'tool_start' || e.type === 'tool_end'), '纯聊天降级不执行工具');
      assert.deepEqual(validateOrder(events), []);
      assert.equal(events.at(-1)?.type, 'done');
    } finally {
      writeFileSync(configPath, original);
      resetConfigCache();
    }
  });
});
