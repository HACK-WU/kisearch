/**
 * 一次性问答执行器（REQ-20261113-001 · S-01 §8 + 二期 S-03）
 *
 * 一期不变量：
 *   ① 多轮检索后正常合成：answer 拼接、sources 透传、rounds 计数
 *   ② `llm.askMaxRounds` 生效：达上限强制作答并标 `round-limit`
 *   ③ 调用方已中止 → `ASK_TIMEOUT` 且**零上游请求**
 *   ⑤ `reasoning` 只转发不返回（N12），不得混进 answer
 *   ⑥ `llm.supportsTools=false` → `ASK_TOOLS_UNSUPPORTED` 且**零上游请求**
 *
 * 二期不变量（S-03）：
 *   ④ **不污染 web 列表**：只产生 `ka-*` 短会话，绝不产生 `c-*`
 *   ⑦ 续接：传回 `contextId` 时历史被回放（第二轮请求里能看到第一轮的问题与答案）
 *   ⑧ 过期 ID → `ASK_CONTEXT_EXPIRED`，删文件且零上游请求
 *   ⑨ 非本人 ID → `ASK_CONTEXT_FORBIDDEN`（不泄露"曾存在"）
 *   ⑩ 不存在 ID → `ASK_CONTEXT_NOT_FOUND`，零上游请求
 *   ⑪ 超预算 → `ASK_CONTEXT_BUDGET_EXCEEDED`
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/ask-runner.test.ts
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

interface MockStep {
  tool?: { name?: string; args?: Record<string, unknown> };
  content?: string;
  reasoning?: string;
}

interface CapturedRequest {
  hasTools: boolean;
  toolNames: string[];
  /** 本轮上游请求的 messages（只留 role + content，供续接用例断言历史被回放） */
  messages: Array<{ role: string; content: string }>;
}

interface AskResultShape {
  ok: boolean; answer: string; sources: unknown[]; sourcesTotal: number; rounds: number; elapsedMs: number;
  truncated: boolean; truncatedReason?: string; degraded?: unknown; usage?: unknown;
  contextId: string; expiresAt: string; resumed: boolean;
  error?: { code: string; message: string; retryable: boolean };
}

interface Harness {
  captured: CapturedRequest[];
  chatDir: string;
  runAsk: (input: {
    scope: string; question: string; contextId?: string; principalKey?: string;
    capabilities?: ReadonlySet<string>; signal?: AbortSignal;
  }) => Promise<AskResultShape>;
  cleanup: () => Promise<void>;
}

let callSeq = 0;

function sseFrame(step: MockStep): string {
  const delta: Record<string, unknown> = {};
  const choice: Record<string, unknown> = { delta };
  if (step.reasoning) delta.reasoning_content = step.reasoning;
  if (step.content) delta.content = step.content;
  if (step.tool) {
    callSeq += 1;
    delta.tool_calls = [{
      index: 0,
      id: `call-${callSeq}`,
      type: 'function',
      function: {
        name: step.tool.name ?? 'ki_search',
        arguments: JSON.stringify(step.tool.args ?? { query: 'first' }),
      },
    }];
    choice.finish_reason = 'tool_calls';
  } else {
    choice.finish_reason = 'stop';
  }
  return `data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`;
}

async function createHarness(
  plan: (round: number) => MockStep,
  configExtra = '',
): Promise<Harness> {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ask-runner-'));
  const previousConfig = process.env.KI_CONFIG_PATH;
  const captured: CapturedRequest[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      let hasTools = false;
      let toolNames: string[] = [];
      let messages: Array<{ role: string; content: string }> = [];
      try {
        const parsed = JSON.parse(body) as {
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        toolNames = (parsed.tools ?? []).map((t) => t.function?.name ?? '');
        messages = (parsed.messages ?? []).map((m) => ({
          role: String(m.role ?? ''),
          content: typeof m.content === 'string' ? m.content : '',
        }));
      } catch { /* mock 只关心 tools/messages */ }
      captured.push({ hasTools, toolNames, messages });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sseFrame(plan(captured.length - 1)));
    })().catch((error) => res.destroy(error));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const chatDir = path.join(temporaryRoot, 'chat');
  fs.mkdirSync(chatDir, { recursive: true });
  const configPath = path.join(temporaryRoot, 'config.yaml');
  fs.writeFileSync(configPath, [
    `dataDir: ${temporaryRoot}/data`,
    `chatDir: ${chatDir}`,
    'llm:',
    `  baseURL: http://127.0.0.1:${port}/v1`,
    '  model: mock',
    '  apiKey: mock-key',
    '  kbDisclosureAck: true',
    ...(configExtra ? [configExtra] : []),
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(chatDir, 'prompt-config.json'), JSON.stringify({
    version: 1,
    prompt: { content: '基础提示词' },
    skills: [],
    tools: { ki_search: true },
  }));
  process.env.KI_CONFIG_PATH = configPath;

  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: {
      '../mcp-tool-registry.js': fileURLToPath(new URL('./fixtures/generation-search.ts', import.meta.url)),
    },
  });
  const { runAsk } = await jiti.import<{ runAsk: Harness['runAsk'] }>('../../src/lib/chat/ask/ask-runner.ts');

  return {
    captured,
    chatDir,
    runAsk,
    cleanup: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      if (previousConfig === undefined) delete process.env.KI_CONFIG_PATH;
      else process.env.KI_CONFIG_PATH = previousConfig;
    },
  };
}

/** 前 N 轮检索、之后收尾的常规剧本 */
const retrievalThenAnswer = (rounds: number) => (round: number): MockStep =>
  round < rounds ? { tool: { args: { query: 'first' } } } : { content: '最终答案' };

/** 在 scope 目录里直接落一个短会话（构造任意 updatedAt / ownerKey） */
function writeSessionFile(
  harness: Harness,
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): string {
  // ⚠️ 短会话落在 `{chatDir}/{scope}/`（与 `c-*` 会话同目录），不是 chatDir 根
  const scopeDir = path.join(harness.chatDir, 'default');
  fs.mkdirSync(scopeDir, { recursive: true });
  const filePath = path.join(scopeDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1, id, scope: 'default', ownerKey: 'local',
    createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T10:00:00.000Z',
    messages: [],
    ...overrides,
  }));
  return filePath;
}

it('① 多轮检索后合成：answer 拼接、sources 透传、rounds 按工具调用计数', async () => {
  const h = await createHarness(retrievalThenAnswer(3));
  try {
    const result = await h.runAsk({ scope: 'default', question: '问题' });
    assert.equal(result.ok, true);
    assert.equal(result.answer, '最终答案');
    assert.equal(result.rounds, 3, '3 次 tool_end ⇒ rounds = 3');
    assert.ok(result.sources.length > 0, '检索命中必须透传 sources');
    assert.ok(result.sourcesTotal >= result.sources.length,
      'sourcesTotal 是净化**前**条数，必须 ≥ 返回条数（调用方据此判断是否被截断）');
    assert.equal(h.captured.length, 4, '3 轮工具 + 1 次收尾');
    assert.equal(result.truncated, false);
  } finally {
    await h.cleanup();
  }
});

it('② askMaxRounds 生效：达上限拿掉 tools 强制作答，标 round-limit', async () => {
  const h = await createHarness(() => ({ tool: { args: { query: 'first' } } }), '  askMaxRounds: 2');
  try {
    const result = await h.runAsk({ scope: 'default', question: '问题' });
    assert.equal(h.captured.length, 3, '2 轮工具 + 1 次强制作答');
    assert.equal(h.captured[2]!.hasTools, false, '第 3 次必须不带 tools');
    assert.equal(result.truncated, true);
    assert.equal(result.truncatedReason, 'round-limit');
    assert.equal(result.rounds, 2);
  } finally {
    await h.cleanup();
  }
});

it('③ 调用方已中止：ASK_TIMEOUT 且零上游请求', async () => {
  const h = await createHarness(retrievalThenAnswer(3));
  try {
    const result = await h.runAsk({
      scope: 'default', question: '问题', signal: AbortSignal.abort(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ASK_TIMEOUT');
    assert.equal(result.error?.retryable, true);
    assert.equal(h.captured.length, 0, '已中止时不得发起上游请求');
    // 新建的空会话必须被清理：否则每次中止/失败都会在盘上留一个空文件，只能等 GC
    const scopeDir = path.join(h.chatDir, 'default');
    const left = fs.existsSync(scopeDir)
      ? fs.readdirSync(scopeDir).filter((n) => n.startsWith('ka-'))
      : [];
    assert.deepEqual(left, [], '无答案的失败不得留下空会话文件');
  } finally {
    await h.cleanup();
  }
});

it('④ 不污染 web 列表：只产生 ka-* 短会话，绝不产生 c-*', async () => {
  const h = await createHarness(retrievalThenAnswer(2));
  try {
    const scopeDir = path.join(h.chatDir, 'default');
    const before = fs.existsSync(scopeDir) ? fs.readdirSync(scopeDir).sort() : [];
    const result = await h.runAsk({ scope: 'default', question: '问题' });
    assert.equal(result.ok, true);
    assert.match(result.contextId, /^ka-/, '必须返回短会话 id，供下次追问');
    assert.ok(result.expiresAt.length > 0, '必须返回过期时刻');
    const after = fs.readdirSync(scopeDir).sort();
    assert.deepEqual(after, [...before, `${result.contextId}.json`].sort(),
      '只应多出这一个短会话文件（不得有临时文件残留）');
    assert.ok(!after.some((n) => n.startsWith('c-')),
      '不得产生 c-* 会话 —— 那会出现在 web 会话列表里（P0 护栏）');
  } finally {
    await h.cleanup();
  }
});

it('⑤ reasoning 只转发不返回：不得混进 answer', async () => {
  const h = await createHarness(() => ({ reasoning: '这是内部思考', content: '这是答案' }));
  try {
    const result = await h.runAsk({ scope: 'default', question: '问题' });
    assert.equal(result.ok, true);
    assert.equal(result.answer, '这是答案');
    assert.ok(!result.answer.includes('内部思考'), 'N12：reasoning 永不外传');
    assert.equal((result as unknown as Record<string, unknown>).reasoning, undefined);
  } finally {
    await h.cleanup();
  }
});

it('⑥ supportsTools=false：直接拒绝，不降级为纯聊天且零上游请求', async () => {
  const h = await createHarness(retrievalThenAnswer(1), '  supportsTools: false');
  try {
    const result = await h.runAsk({ scope: 'default', question: '问题' });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ASK_TOOLS_UNSUPPORTED');
    assert.equal(result.error?.retryable, false);
    assert.equal(result.answer, '', '不得返回无知识库依据的纯聊天答案');
    assert.equal(result.contextId, '', '前置失败不建立短会话');
    assert.equal(h.captured.length, 0);
  } finally {
    await h.cleanup();
  }
});

it('⑦ 续接：传回 contextId 时历史被回放（第二轮能看到第一轮的问与答）', async () => {
  const h = await createHarness((round) => (
    round === 0 ? { content: '第一轮答案：用 alert_id 关联' } : { content: '第二轮答案：补充了 token 校验' }
  ));
  try {
    const first = await h.runAsk({ scope: 'default', question: '处理记录ID 和告警ID 怎么关联？' });
    assert.equal(first.ok, true);
    assert.equal(first.resumed, false, '首轮不是续接');

    const second = await h.runAsk({
      scope: 'default',
      question: '那 token 校验呢？',
      contextId: first.contextId,
    });
    assert.equal(second.ok, true);
    assert.equal(second.resumed, true, '第二轮必须标记为续接');
    assert.equal(second.contextId, first.contextId, '续接必须复用同一个 id');
    assert.ok(
      Date.parse(second.expiresAt) >= Date.parse(first.expiresAt),
      '每次交互后过期时刻必须顺延（滑动 TTL）',
    );

    const secondRequest = h.captured[1]!;
    const joined = secondRequest.messages.map((m) => m.content).join('\n');
    assert.match(joined, /处理记录ID 和告警ID 怎么关联/, '历史问题必须回放');
    assert.match(joined, /第一轮答案：用 alert_id 关联/, '历史答案必须回放');
    assert.match(joined, /那 token 校验呢/, '本轮问题也必须在请求里');
  } finally {
    await h.cleanup();
  }
});

it('⑧ 过期 contextId → ASK_CONTEXT_EXPIRED：删文件且零上游请求', async () => {
  const h = await createHarness(() => ({ content: '不应被调用' }));
  try {
    const staleId = 'ka-stale-0001';
    const filePath = writeSessionFile(h, staleId, { updatedAt: '2026-01-01T00:00:00.000Z' });
    const result = await h.runAsk({ scope: 'default', question: 'x', contextId: staleId });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ASK_CONTEXT_EXPIRED');
    assert.equal(h.captured.length, 0, '过期必须在发起上游请求之前就拒绝');
    assert.ok(!fs.existsSync(filePath), '判定过期后必须删除文件，不留脏数据');
  } finally {
    await h.cleanup();
  }
});

it('⑨ 非本人 contextId → ASK_CONTEXT_FORBIDDEN（先判归属，不泄露是否过期）', async () => {
  const h = await createHarness(() => ({ content: '不应被调用' }));
  try {
    const otherId = 'ka-other-0001';
    writeSessionFile(h, otherId, { ownerKey: 'tok-other', updatedAt: '2026-01-01T00:00:00.000Z' });
    const result = await h.runAsk({ scope: 'default', question: 'x', contextId: otherId, principalKey: 'tok-mine' });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ASK_CONTEXT_FORBIDDEN',
      '归属判定在过期判定之前 —— 否则用别人的过期 ID 能探出"曾经存在"');
    assert.equal(h.captured.length, 0);
  } finally {
    await h.cleanup();
  }
});

it('⑩ 不存在的 contextId → ASK_CONTEXT_NOT_FOUND：绝不静默当新会话', async () => {
  const h = await createHarness(() => ({ content: '不应被调用' }));
  try {
    const result = await h.runAsk({ scope: 'default', question: 'x', contextId: 'ka-missing-0001' });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ASK_CONTEXT_NOT_FOUND');
    assert.equal(result.answer, '', '不得基于空历史作答（N9）');
    assert.equal(h.captured.length, 0);
  } finally {
    await h.cleanup();
  }
});

it('⑪ 上下文超预算 → ASK_CONTEXT_BUDGET_EXCEEDED', async () => {
  const h = await createHarness(() => ({ content: '不应被调用' }));
  try {
    const fullId = 'ka-full-0001';
    const fresh = new Date().toISOString();
    writeSessionFile(h, fullId, {
      updatedAt: fresh,
      messages: Array.from({ length: 19 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `第 ${i} 条`,
        at: fresh,
      })),
    });
    const result = await h.runAsk({ scope: 'default', question: '再来一轮', contextId: fullId });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ASK_CONTEXT_BUDGET_EXCEEDED');
    assert.equal(h.captured.length, 0);
  } finally {
    await h.cleanup();
  }
});
