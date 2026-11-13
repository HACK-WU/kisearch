/**
 * 一次性问答执行器（REQ-20261113-001 · S-01 §8 测试方案）
 *
 * 覆盖 6 条不变量：
 *   ① 多轮检索后正常合成：answer 拼接、sources 透传、rounds 计数
 *   ② `llm.askMaxRounds` 生效：达上限强制作答并标 `round-limit`
 *   ③ 调用方已中止 → `ASK_TIMEOUT` 且**零上游请求**
 *   ④ **不落盘**：`{chatDir}` 文件列表前后一致
 *   ⑤ `reasoning` 只转发不返回（N12），不得混进 answer
 *   ⑥ `llm.supportsTools=false` → `ASK_TOOLS_UNSUPPORTED` 且**零上游请求**（不降级为纯聊天）
 *
 * 手法：真实 `runAsk` + mock 上游；用 jiti 别名把 `../mcp-tool-registry.js` 换成
 * `fixtures/generation-search.ts`（与 `tool-budget-injection.test.ts` 同构），
 * 这样**检索不碰向量库**、也不依赖 daemon。
 *
 * 每个用例新建一个 jiti 实例：`moduleCache:false` 下模块实例彼此独立，
 * `loadConfig` 的进程内缓存因此不会跨用例串味（无需手动 reset）。
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
  /** 本轮回一个工具调用（默认 ki_search） */
  tool?: { name?: string; args?: Record<string, unknown> };
  content?: string;
  reasoning?: string;
}

interface Harness {
  captured: Array<{ hasTools: boolean; toolNames: string[] }>;
  chatDir: string;
  runAsk: (input: {
    scope: string; question: string; capabilities?: ReadonlySet<string>; signal?: AbortSignal;
  }) => Promise<{
    ok: boolean; answer: string; sources: unknown[]; sourcesTotal: number; rounds: number; elapsedMs: number;
    truncated: boolean; truncatedReason?: string; degraded?: unknown; usage?: unknown;
    error?: { code: string; message: string; retryable: boolean };
  }>;
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

/**
 * @param plan 第 N 次上游请求返回什么（0-based）
 * @param configExtra 追加到 config.yaml 的文本（如 `  askMaxRounds: 2`）
 */
async function createHarness(
  plan: (round: number) => MockStep,
  configExtra = '',
): Promise<Harness> {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ask-runner-'));
  const previousConfig = process.env.KI_CONFIG_PATH;
  const captured: Harness['captured'] = [];

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
      } catch { /* mock 只关心 tools 是否存在 */ }
      captured.push({ hasTools, toolNames });
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
  // 只读工具面：让 fixture 的 ki_search 真正可用（否则工具面为空 ⇒ 纯聊天）
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
    assert.ok(result.elapsedMs >= 0);
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
  } finally {
    await h.cleanup();
  }
});

it('④ 不落盘：chatDir 的文件列表在调用前后完全一致', async () => {
  const h = await createHarness(retrievalThenAnswer(2));
  try {
    const before = fs.readdirSync(h.chatDir).sort();
    const result = await h.runAsk({ scope: 'default', question: '问题' });
    assert.equal(result.ok, true);
    const after = fs.readdirSync(h.chatDir).sort();
    assert.deepEqual(after, before, '问答不得在会话目录留任何文件');
    assert.ok(!after.some((n) => n.startsWith('ka-')), '不得出现 ka- 前缀的会话文件');
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
    assert.equal((result as Record<string, unknown>).reasoning, undefined);
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
    assert.equal(h.captured.length, 0);
  } finally {
    await h.cleanup();
  }
});
