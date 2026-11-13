/**
 * tool-loop 的**轮次上限与时间预算**入参（REQ-20261113-001 · S-01 §4a.3）
 *
 * 锁住三条不变量：
 *   ① 不传新入参 ⇒ 行为与改动前一致（轮次沿用 runtime = Infinity，不产生 warning）
 *   ② `maxToolRounds` 生效 ⇒ 达上限后**拿掉 tools 再调一次**（强制作答），
 *      且 `done.warning === 'tool-rounds-exhausted'`
 *   ③ `budgetMs` 到点 ⇒ 走同一条强制作答路径，但标 `done.budgetExhausted === true`
 *      而**不**标 warning（"时间用尽"≠"轮数用尽"，归因不能混）
 *
 * 手法：真实 `runToolLoop` + mock 上游。让模型反复调**未知工具**
 * （`ki_probe_hallucination`）——tool-loop 对未知工具同样计一轮并回 tool 消息
 * （实现细节 a），因此**不需要碰向量库**，也无需 jiti alias 夹具。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/tool-loop-budget.test.ts
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runToolLoop } from '../../src/lib/chat/retrieval/tool-loop.js';
import { resetConfigCache } from '../../src/lib/config.js';
import type { ChatEvent, ConversationFile } from '../../src/lib/chat/chat-contract.js';

const UNKNOWN_TOOL = 'ki_probe_hallucination';

interface CapturedRequest {
  /** 本次上游请求是否带 tools（强制作答时 tool-loop 会传 undefined） */
  hasTools: boolean;
  toolNames: string[];
}

interface Harness {
  captured: CapturedRequest[];
  run: (extra?: { maxToolRounds?: number; budgetMs?: number }) => Promise<ChatEvent[]>;
  cleanup: () => Promise<void>;
}

/**
 * 起 mock 上游 + 临时配置。
 * @param toolCallRounds 前 N 次请求返回"未知工具调用"，之后返回普通文本（默认无限调工具）
 */
async function setupHarness(toolCallRounds = Number.POSITIVE_INFINITY): Promise<Harness> {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-loop-budget-'));
  const previousConfig = process.env.KI_CONFIG_PATH;
  const captured: CapturedRequest[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      let hasTools = false;
      let toolNames: string[] = [];
      try {
        const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
        hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        toolNames = (parsed.tools ?? []).map((t) => t.function?.name ?? '');
      } catch { /* 忽略：mock 只关心 tools 是否存在 */ }
      captured.push({ hasTools, toolNames });

      const round = captured.length - 1; // 0-based
      const payload = round < toolCallRounds
        ? {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0, id: `call-${round + 1}`, type: 'function',
                function: { name: UNKNOWN_TOOL, arguments: JSON.stringify({ probe: round + 1 }) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }
        : { choices: [{ delta: { content: '最终答案' }, finish_reason: 'stop' }] };

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
    })().catch((error) => res.destroy(error));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const configPath = path.join(temporaryRoot, 'config.yaml');
  fs.writeFileSync(configPath, [
    `dataDir: ${temporaryRoot}/data`,
    `chatDir: ${temporaryRoot}/chat`,
    'llm:',
    `  baseURL: http://127.0.0.1:${port}/v1`,
    '  model: mock',
    '  apiKey: mock-key',
    '  kbDisclosureAck: true',
    '',
  ].join('\n'));
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();

  const conv: ConversationFile = {
    version: 1, id: 'ka-budget-test', scope: 'default', title: '', systemPrompt: '',
    archived: false, archivedAt: null, createdAt: '', updatedAt: '', seq: 0,
    messageCount: 0, lastMessagePreview: '', messages: [],
  };

  return {
    captured,
    run: async (extra) => {
      const events: ChatEvent[] = [];
      for await (const ev of runToolLoop({
        scope: 'default', conv, userText: 'question', convSystemPrompt: '',
        ...extra,
      })) events.push(ev);
      return events;
    },
    cleanup: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      if (previousConfig === undefined) delete process.env.KI_CONFIG_PATH;
      else process.env.KI_CONFIG_PATH = previousConfig;
      resetConfigCache();
    },
  };
}

it('不传新入参：轮次沿用 runtime（Infinity），不产生任何收口标记', async () => {
  const h = await setupHarness(2); // 前 2 轮调工具，第 3 次收尾
  try {
    const events = await h.run();
    const done = events.find((e) => e.type === 'done');
    assert.ok(done?.type === 'done');
    assert.equal(done.warning, undefined, 'Infinity 不应触发 tool-rounds-exhausted');
    assert.equal(done.budgetExhausted, undefined, '未传 budgetMs 不应出现该字段');
    assert.equal(h.captured.length, 3);
    assert.ok(h.captured.every((c) => c.hasTools), '未达上限时每次都应带 tools');
  } finally {
    await h.cleanup();
  }
});

it('maxToolRounds 生效：达上限后拿掉 tools 强制作答，并标 tool-rounds-exhausted', async () => {
  const h = await setupHarness(); // 模型永远调工具
  try {
    const events = await h.run({ maxToolRounds: 2 });
    const done = events.find((e) => e.type === 'done');
    assert.ok(done?.type === 'done');
    assert.equal(h.captured.length, 3, '2 轮工具 + 1 次强制作答');
    assert.equal(h.captured[0]!.hasTools, true);
    assert.equal(h.captured[1]!.hasTools, true);
    assert.equal(h.captured[2]!.hasTools, false, '第 3 次必须拿掉 tools（强制作答，不是截断）');
    assert.equal(done.warning, 'tool-rounds-exhausted');
    assert.equal(done.budgetExhausted, undefined, '轮次触发不应同时标预算');
    // 未知工具也要回 tool 消息（实现细节 a），否则循环不收敛
    assert.equal(events.filter((e) => e.type === 'tool_end').length, 2);
  } finally {
    await h.cleanup();
  }
});

it('budgetMs 到点：走同一条强制作答路径，但只标 budgetExhausted（不冒充轮次）', async () => {
  const h = await setupHarness(); // 模型永远调工具
  try {
    const events = await h.run({ budgetMs: 0, maxToolRounds: 6 });
    const done = events.find((e) => e.type === 'done');
    assert.ok(done?.type === 'done');
    assert.equal(h.captured.length, 1, '预算为 0 ⇒ 首轮即收口，不发起任何工具轮');
    assert.equal(h.captured[0]!.hasTools, false);
    assert.equal(done.budgetExhausted, true);
    assert.equal(done.warning, undefined, '预算用尽不得报成 tool-rounds-exhausted');
    assert.equal(events.filter((e) => e.type === 'tool_start').length, 0);
  } finally {
    await h.cleanup();
  }
});
