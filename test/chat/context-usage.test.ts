/**
 * 上下文用量（**字符口径**）· 事件与口径一致性（REQ-20261013-001 R1/R3）
 *
 * ═══ 本文件存在的理由 ═══
 * 「上下文用了多少」这个数字的全部价值在于**它等于真的发给上游的内容量**。
 * 而口径有三处极易写错（需求 §2.2）：
 *   ① 只取 role+content 的历史消息（`ChatMessage` 的 refs 字段**不再进上游**）
 *   ② 工具返回要计入（它确实追加进了 messages）
 *   ③ reasoning（思考过程）**永不进 messages** —— 它的长度很容易被误加进去
 * 任何一处写错，数字都"看起来合理"但实际偏大或偏小，静默不可观测。
 *
 * 因此这里沿用 `chat-refs.test.ts` 的手法：**mock 上游捕获真实请求体**，
 * 把 `context` 事件与"这一刻真正发出去的 messages"逐字节对齐。
 *
 * 断言：
 *   ① 单轮：`chars` === Σ(messages.content.length)
 *   ② reasoning 不计入（上游返回 reasoning_content 时数字不变）
 *   ③ 引用附录计入 user 且 `parts.refs` 是其子集
 *   ④ 工具轮次后基数增长，且第二轮仍与真实 messages 一致（覆盖写语义）
 *   ⑤ 压缩摘要作为独立 system 块注入；截断式（summary=null）不注入
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/context-usage.test.ts`
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runToolLoop, computeContextChars, projectNextContextChars, renderCompactionBlock } from '../../src/lib/chat/retrieval/tool-loop.js';
import { resolveLlmStatus } from '../../src/lib/chat/llm-client.js';
import { CHAT_BUDGET } from '../../src/lib/chat/chat-contract.js';
import type { ChatEvent, ChatRef, ConversationFile, ContextCharsParts } from '../../src/lib/chat/chat-contract.js';

interface UpstreamMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}

/** 上游请求体（只留断言需要的字段） */
interface Captured { messages: UpstreamMessage[] }

let captured: Captured[] = [];
/** 第 N 次上游请求要返回什么（默认：纯文本回答） */
let scripted: Array<'content' | 'unknown-tool' | 'reasoning'> = [];
let server: ReturnType<typeof createServer>;
let tmpRoot = '';

before(async () => {
  captured = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const j = JSON.parse(body) as Captured;
        captured.push({ messages: (j.messages ?? []) as UpstreamMessage[] });
      } catch { /* 忽略非 JSON */ }
      const mode = scripted[captured.length - 1] ?? 'content';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'reasoning') {
        // 思考过程：**只转发、不进 messages**（N12）→ 不应影响字符口径
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '这是一段很长很长的思考过程'.repeat(20) } }] })}\n\n`);
      }
      if (mode === 'unknown-tool') {
        res.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'nonexistent_tool', arguments: '{"x":1}' } }],
            },
          }],
        })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: mode === 'content' ? '收到' : '' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-chat-ctx-'));
  const cfgPath = path.join(tmpRoot, 'config.yaml');
  fs.writeFileSync(cfgPath, [
    `dataDir: ${path.join(tmpRoot, 'kb')}`,
    `vectorDir: ${path.join(tmpRoot, 'vector')}`,
    `chatDir: ${path.join(tmpRoot, 'chat')}`,
    'scopeMode: default',
    'scopes:',
    '  default: {}',
    'embedding:',
    '  provider: mock',
    '  baseURL: http://127.0.0.1:1/v1',
    '  model: mock-embedding',
    '  dimension: 8',
    '  apiKey: mock-key',
    'llm:',
    `  baseURL: http://127.0.0.1:${port}/v1`,
    '  model: mock-model',
    '  apiKey: mock-key',
    '  kbDisclosureAck: true',
  ].join('\n'), 'utf8');
  process.env.KI_CONFIG_PATH = cfgPath;
});

after(() => {
  server?.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.KI_CONFIG_PATH;
});

// ─── 工具 ───

function convOf(
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>,
  systemPrompt = '',
  compaction?: ConversationFile['compaction'],
): ConversationFile {
  return {
    version: 1, id: 'c-ctx', scope: 'default', title: 't', systemPrompt,
    archived: false, archivedAt: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    seq: 0, messageCount: messages.length, lastMessagePreview: '',
    messages: messages.map((m) => ({ ...m, at: '2026-01-01T00:00:00Z' })),
    ...(compaction ? { compaction } : {}),
  };
}

const u = (id: string, content: string) => ({ id, role: 'user' as const, content });
const a = (id: string, content: string) => ({ id, role: 'assistant' as const, content });

/** 真实发给上游的字符数（与实现口径**逐字节**对齐：content + tool_calls 的函数名与参数） */
function realChars(messages: readonly UpstreamMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += m.content.length;
    for (const c of m.tool_calls ?? []) n += c.function.name.length + c.function.arguments.length;
  }
  return n;
}

async function runTurn(
  conv: ConversationFile,
  userText: string,
  refs?: ChatRef[],
): Promise<{ contexts: Array<{ chars: number; parts: ContextCharsParts }>; captured: Captured[] }> {
  captured = [];
  const contexts: Array<{ chars: number; parts: ContextCharsParts }> = [];
  for await (const ev of runToolLoop({
    scope: 'default', conv, userText, convSystemPrompt: conv.systemPrompt,
    ...(refs ? { refs } : {}),
    signal: new AbortController().signal,
  }) as AsyncGenerator<ChatEvent>) {
    if (ev.type === 'context') contexts.push({ chars: ev.chars, parts: ev.parts });
  }
  return { contexts, captured: [...captured] };
}

// ─── 用例 ───

describe('context 事件（字符口径）', () => {
  it('① 单轮：chars 等于真实发出的 messages 字符数；meta 是其前的首帧', async () => {
    scripted = ['content'];
    const conv = convOf([u('m1', '你好'), a('m2', '你好，有什么可以帮你？')]);
    const { contexts, captured: caps } = await runTurn(conv, '再问一句');
    assert.equal(contexts.length, 1, '无工具轮次应只发 1 次 context');
    assert.equal(caps.length, 1);
    assert.equal(contexts[0]!.chars, realChars(caps[0]!.messages));
  });

  it('② reasoning（思考过程）不计入 —— N12 不变量', async () => {
    scripted = ['reasoning'];
    const conv = convOf([u('m1', '你好')]);
    const { contexts, captured: caps } = await runTurn(conv, '带思考的提问');
    assert.equal(contexts.length, 1);
    const reasoningLen = '这是一段很长很长的思考过程'.repeat(20).length;
    const plain = realChars(caps[0]!.messages);
    assert.equal(contexts[0]!.chars, plain, 'chars 必须等于 messages 字符数（思考不计）');
    assert.ok(contexts[0]!.chars < plain + reasoningLen, '思考文本长度不得被计入');
  });

  it('③ 引用附录计入 user，且 parts.refs 是其子集（不重复计入总数）', async () => {
    scripted = ['content'];
    const conv = convOf([u('m1', '你好')]);
    const refs: ChatRef[] = [{ group: 'k8s', doc: '01-概述', text: 'Pod 是最小调度单元。' }];
    const { contexts, captured: caps } = await runTurn(conv, '看看这个', refs);
    const parts = contexts[0]!.parts;
    assert.equal(contexts[0]!.chars, realChars(caps[0]!.messages));
    assert.ok(parts.refs > 0, 'refs 分量应大于 0');
    assert.ok(parts.user >= parts.refs, 'refs 是 user 的子集');
    assert.equal(parts.refs + parts.system > 0, true);
    assert.equal(
      contexts[0]!.chars,
      parts.system + parts.user + parts.assistant + parts.tool,
      'chars = 四分量之和',
    );
  });

  it('④ 工具轮次后基数增长，且第二轮仍与真实 messages 一致（覆盖写，不累加）', async () => {
    scripted = ['unknown-tool', 'content'];
    const conv = convOf([u('m1', '你好')]);
    const { contexts, captured: caps } = await runTurn(conv, '帮我查一下');
    assert.equal(caps.length, 2, '应有两轮上游请求');
    assert.equal(contexts.length, 2, '每轮请求前各发一次 context');
    assert.equal(contexts[0]!.chars, realChars(caps[0]!.messages));
    assert.equal(contexts[1]!.chars, realChars(caps[1]!.messages));
    assert.ok(contexts[1]!.chars > contexts[0]!.chars, '追加工具结果后基数应变大');
    assert.ok(contexts[1]!.parts.tool > 0, '工具返回应计入 tool 分量');
    // ★ 覆盖写：最后一个 context 就是"下一轮将发送"的规模，不是两轮之和
    assert.ok(contexts[1]!.chars < contexts[0]!.chars * 2, '不得按轮累加');
  });

  it('⑤ 压缩摘要作为独立 system 块注入；截断式不注入', async () => {
    const summary = '用户此前问了 A 与 B；结论是 C。';
    const compaction: ConversationFile['compaction'] = {
      at: '2026-01-01T00:00:00Z', mode: 'summary', coveredCount: 3,
      summary, charsBefore: 900, charsAfter: 120, backup: 'c-ctx.compact-backup-1.json',
    };
    scripted = ['content'];
    const withSummary = await runTurn(convOf([u('m1', '你好')], '', compaction), '继续');
    const systemTexts = withSummary.captured[0]!.messages.filter((m) => m.role === 'system').map((m) => m.content);
    assert.ok(systemTexts.some((t) => t.includes(summary)), '摘要必须出现在 system 组');
    assert.equal(withSummary.contexts[0]!.chars, realChars(withSummary.captured[0]!.messages));

    const truncate: ConversationFile['compaction'] = { ...compaction, mode: 'truncate', summary: null };
    scripted = ['content'];
    const without = await runTurn(convOf([u('m1', '你好')], '', truncate), '继续');
    const sys2 = without.captured[0]!.messages.filter((m) => m.role === 'system').map((m) => m.content);
    assert.equal(sys2.some((t) => t.includes('早前对话摘要')), false, '截断式不得注入摘要块');
  });
});

describe('computeContextChars（纯函数）', () => {
  it('只取 role + content，assistant 的 tool_calls 计入', () => {
    const r = computeContextChars([
      { role: 'system', content: 'abc' },
      { role: 'user', content: 'de' },
      { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'fn', arguments: '{}' } }] },
      { role: 'tool', content: '1234' },
    ], 7);
    assert.deepEqual(r.parts, { system: 3, user: 2, assistant: 4, tool: 4, refs: 7 });
    assert.equal(r.chars, 3 + 2 + 4 + 4);
  });

  it('上限缺省 1000K：未配置 llm.contextChars 时回落到 CHAT_BUDGET.defaultContextChars', () => {
    const status = resolveLlmStatus(
      { llm: { baseURL: 'https://example.com/v1', model: 'm', apiKey: 'k' } },
      '',
    );
    assert.equal(status.contextChars, 1_000_000);
    assert.equal(CHAT_BUDGET.defaultContextChars, 1_000_000);

    const custom = resolveLlmStatus(
      { llm: { baseURL: 'https://example.com/v1', model: 'm', apiKey: 'k', contextChars: 6000 } },
      '',
    );
    assert.equal(custom.contextChars, 6000, '配置可覆盖上限');
  });

  it('projectNextContextChars：与 context 事件同口径（system 组 + 消息 + 摘要）', () => {
    const plain = projectNextContextChars(convOf([u('m1', 'x'.repeat(100))]));
    assert.ok(plain.chars > 100, `应含 system 组（实际 ${plain.chars}）`);
    assert.ok(plain.parts.system > 0, 'system 分量必须计入');

    const summary = '摘要内容'.repeat(10);
    const withSummary = projectNextContextChars(convOf([u('m1', 'x'.repeat(100))], '', {
      at: '2026-01-01T00:00:00Z', mode: 'summary', coveredCount: 2,
      summary, charsBefore: 999, charsAfter: 1, backup: 'b.json',
    }));
    assert.equal(
      withSummary.chars - plain.chars,
      summary.length + '【早前对话摘要】以下是本次会话更早内容的压缩摘要（用户手动压缩产生，原始消息已移出会话，可从备份撤销）：'.length
        + '\n'.length + '摘要仅作背景参考；若与最近消息冲突，一律以最近消息为准。'.length + '\n'.length,
      '差额应恰为摘要块（含固定说明）的字符数',
    );
  });

  it('renderCompactionBlock：无摘要 → null；有摘要 → 含冲突口径护栏', () => {
    assert.equal(renderCompactionBlock(undefined), null);
    assert.equal(renderCompactionBlock({ at: '', mode: 'truncate', coveredCount: 1, summary: null, charsBefore: 0, charsAfter: 0, backup: 'b' }), null);
    const block = renderCompactionBlock({ at: '', mode: 'summary', coveredCount: 1, summary: 'S', charsBefore: 0, charsAfter: 0, backup: 'b' });
    assert.ok(block && block.includes('S') && block.includes('以最近消息为准'));
  });
});
