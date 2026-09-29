/**
 * 多轮对话上下文测试（REQ-20260924-001）
 *
 * ═══ 本文件存在的理由 ═══
 * 此前 test/chat 下 96 条断言中**没有一条**断言「路由驱动的一轮，真正发往上游的 messages 是什么」：
 *   - acceptance-sr01 用的是**手工构造**的 conv（天然绕开路由的写入时序）；
 *   - e2e-sr01-edit 断言的是**落盘**语义；
 *   - 事件序 / 返回值 / sources 投影都不包含上游请求体。
 * 因此「当前 user 消息被重复拼进上游」这类**接线处**缺陷在以上任何一层都不可见 —— 实测复现：
 *   第 1 轮上游 = [system, user:Q1, user:Q1]（Q1 两次）；第 2 轮再叠一次。
 * 后果：每轮多付一份 prompt token；且出现**连续同角色 user,user**，部分 OpenAI 兼容上游会直接 400。
 *
 * 本文件用本地 mock 上游**捕获真实请求体**，对上游 messages 做形状断言：
 *   ① system 在最前（skill 在前、会话 prompt 在后）
 *   ② 历史按序且完整累积
 *   ③ **本轮 user 恰好出现一次**
 *   ④ **不出现连续同角色**（user,user / assistant,assistant）
 *   ⑤ 只带 role + content（不夹带 sources / timing / usage / reasoning）
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runToolLoop, runPreRetrievalFallback } from '../../src/lib/chat/retrieval/tool-loop.js';

// ─── mock 上游：捕获请求体 ───

interface Captured { messages: { role: string; content: string }[] }

let captured: Captured[] = [];
let server: ReturnType<typeof createServer>;
let cfgPath = '';
let tmpRoot = '';

before(async () => {
  captured = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const j = JSON.parse(body) as Captured;
        captured.push({ messages: (j.messages ?? []).map((m) => ({ role: m.role, content: m.content })) });
      } catch { /* 忽略非 JSON */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 固定回一条 content + 终态；不带 tool_calls → 工具循环一轮收敛
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '收到' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-multiturn-'));
  cfgPath = path.join(tmpRoot, 'config.yaml');
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

function convOf(messages: { id: string; role: 'user' | 'assistant'; content: string }[], systemPrompt = '') {
  return {
    version: 1 as const, id: 'c-multiturn', scope: 'default', title: 't', systemPrompt,
    archived: false, archivedAt: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    seq: 0, messageCount: messages.length, lastMessagePreview: '',
    messages: messages.map((m) => ({ ...m, at: '2026-01-01T00:00:00Z' })),
  };
}

const u = (id: string, content: string) => ({ id, role: 'user' as const, content });
const a = (id: string, content: string) => ({ id, role: 'assistant' as const, content });

async function runTurn(conv: ReturnType<typeof convOf>, userText: string): Promise<Captured> {
  captured = [];
  for await (const _ev of runToolLoop({
    scope: 'default', conv, userText, convSystemPrompt: conv.systemPrompt,
    signal: new AbortController().signal,
  })) { /* 只关心上游请求体，事件本身由其他测试覆盖 */ }
  assert.equal(captured.length, 1, `本轮应恰好发出 1 次上游请求，实际 ${captured.length} 次`);
  return captured[0];
}

const rolesOf = (m: Captured) => m.messages.map((x) => x.role);
const countOf = (m: Captured, content: string) => m.messages.filter((x) => x.content === content).length;

/** 相邻同角色（system 除外）—— 交替契约的负向检查 */
function consecutiveSameRole(m: Captured): string[] {
  const bad: string[] = [];
  const msgs = m.messages.filter((x) => x.role !== 'system');
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].role === msgs[i - 1].role) bad.push(`${msgs[i - 1].role}→${msgs[i].role}（第 ${i} 与 ${i + 1} 条）`);
  }
  return bad;
}

// ─── 用例 ───

describe('多轮上下文 · 上游 messages 形状', () => {
  it('★ 首轮（路由形状：conv 已含本轮 user）→ 本轮 user 恰好一次，不得重复', async () => {
    // 路由 append-user 的传入形状：convAfterPrep 已包含刚落的 user 消息
    const cap = await runTurn(convOf([u('m1', 'Q1')]), 'Q1');
    assert.deepEqual(rolesOf(cap).filter((r) => r !== 'system'), ['user']);
    assert.equal(countOf(cap, 'Q1'), 1, `本轮 user 应恰好 1 次，实际 ${countOf(cap, 'Q1')} 次（上游：${JSON.stringify(rolesOf(cap))}）`);
    assert.ok(rolesOf(cap)[0] === 'system', 'system 必须在最前');
  });

  it('★ 第 2 轮 → 历史按序带上，本轮 user 仍恰好一次，且无连续同角色', async () => {
    const cap = await runTurn(convOf([u('m1', 'Q1'), a('m2', 'A1'), u('m3', 'Q2')]), 'Q2');
    assert.deepEqual(rolesOf(cap), ['system', 'user', 'assistant', 'user']);
    assert.equal(countOf(cap, 'Q1'), 1, '历史中的 Q1 应保留一次');
    assert.equal(countOf(cap, 'A1'), 1, '历史中的 A1 应保留一次');
    assert.equal(countOf(cap, 'Q2'), 1, `本轮 user 应恰好 1 次，实际 ${countOf(cap, 'Q2')} 次`);
    assert.deepEqual(consecutiveSameRole(cap), [], '不得出现连续同角色（部分 OpenAI 兼容上游会 400）');
  });

  it('★ 第 3 轮 → 历史完整累积且顺序正确（多轮不回退、不丢轮次）', async () => {
    const cap = await runTurn(
      convOf([u('m1', 'Q1'), a('m2', 'A1'), u('m3', 'Q2'), a('m4', 'A2'), u('m5', 'Q3')]),
      'Q3',
    );
    assert.deepEqual(rolesOf(cap), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    assert.deepEqual(
      cap.messages.filter((m) => m.role !== 'system').map((m) => m.content),
      ['Q1', 'A1', 'Q2', 'A2', 'Q3'],
      '历史顺序必须为 Q1→A1→Q2→A2→本轮 Q3',
    );
    assert.equal(countOf(cap, 'Q3'), 1);
    assert.deepEqual(consecutiveSameRole(cap), []);
  });

  it('兼容形状：conv 未含本轮 user（store/skill 级单测的构造方式）→ 仍会追加，且只追加一次', async () => {
    const cap = await runTurn(convOf([u('m1', 'Q1'), a('m2', 'A1')]), 'Q2');
    assert.deepEqual(rolesOf(cap), ['system', 'user', 'assistant', 'user']);
    assert.equal(countOf(cap, 'Q2'), 1, '兼容形状下本轮 user 也应恰好一次');
    assert.deepEqual(consecutiveSameRole(cap), []);
  });

  it('历史消息只带 role + content（sources / timing / usage 等一律不进上游）', async () => {
    const rich = convOf([u('m1', 'Q1')]);
    (rich.messages[0] as Record<string, unknown>).sources = [{ group: 'g', doc: 'd', lineStart: 1, lineEnd: 2, snippet: 's' }];
    (rich.messages[0] as Record<string, unknown>).timing = { ttfbMs: 1, firstContentMs: 2, totalMs: 3 };
    (rich.messages[0] as Record<string, unknown>).usage = { promptTokens: 1, completionTokens: 1 };
    (rich.messages[0] as Record<string, unknown>).aborted = true;
    const cap = await runTurn(rich, 'Q2');
    for (const m of cap.messages) {
      assert.deepEqual(Object.keys(m).sort(), ['content', 'role'], `上游消息只允许 role+content，实际字段 ${Object.keys(m).join(',')}`);
      assert.ok(!('reasoning' in m), 'N12：reasoning 不得进上游');
    }
  });

  it('systemPrompt 非空 → skill 在前、会话 prompt 在后（反幻觉规则不被用户 prompt 覆盖）', async () => {
    const cap = await runTurn(convOf([u('m1', 'Q1')], '我的自定义系统提示'), 'Q1');
    const sys = cap.messages.filter((m) => m.role === 'system');
    assert.equal(sys.length, 2, `期望 skill + 会话 prompt 两条 system，实际 ${sys.length} 条`);
    assert.ok(sys[0].content.includes('检索知识库'), 'system[0] 应为检索 skill（反幻觉规则）');
    assert.equal(sys[1].content, '我的自定义系统提示', 'system[1] 应为会话级 prompt');
    assert.equal(countOf(cap, 'Q1'), 1);
  });
});

describe('多轮上下文 · 降级路径（预检索）的上游 messages 形状', () => {
  /**
   * 为什么单列：`degradedPath` 用 `messages.splice(messages.length - 1, 0, …)` 把检索上下文
   * 插到「本轮 user 之前」——它**依赖 `buildUpstreamMessages` 的末条不变量**。
   * 本用例是该耦合的唯一守护：若守卫改成"末条是 user 就跳过"之类会吃掉本轮提问的写法，
   * 或 splice 位置被改坏，这里会立刻变红。
   *
   * 本用例的配置把 embedding 指向不可达地址（127.0.0.1:1）。**注意**：这并不必然让
   * `retrievalOk=false` —— master 的 `62b2190` 已把全文检索与 embedding 解耦，FTS 通道可用
   * 即判「检索可用」（语义侧降级由 note 表达）。故 `!retrievalOk` 那条分支在本环境**不易触发**，
   * 本用例对**两条分支都成立的结构性不变量**做断言（分支归属由注入文案识别）。
   */
  it('★ 注入的检索上下文紧邻本轮 user 之前，且本轮 user 恰好一次（守住 splice 依赖的不变量）', async () => {
    captured = [];
    for await (const _ev of runPreRetrievalFallback({
      scope: 'default',
      conv: convOf([u('m1', 'Q1'), a('m2', 'A1'), u('m3', 'Q2')]),
      userText: 'Q2',
      convSystemPrompt: '',
      signal: new AbortController().signal,
    })) { /* 事件序 / 降级标记由 data-flow / acceptance-sr01 覆盖 */ }

    assert.equal(captured.length, 1, `降级路径应恰好发出 1 次上游请求，实际 ${captured.length} 次`);
    const cap = captured[0];

    // ① 不变量：末条恒为本轮 user（splice 的插入位置依赖它）
    const last = cap.messages[cap.messages.length - 1];
    assert.equal(last.role, 'user', '末条必须是本轮 user 消息');
    assert.equal(last.content, 'Q2', '末条内容应为本轮提问原文');

    // ② 守卫不得把本轮提问吃掉
    assert.equal(countOf(cap, 'Q2'), 1, `本轮 user 应恰好一次，实际 ${countOf(cap, 'Q2')} 次`);

    // ③ 注入的检索上下文紧邻本轮 user 之前（不是插进历史中间）
    const injected = cap.messages[cap.messages.length - 2];
    assert.equal(injected.role, 'user', '注入的上下文应在末条之前一位');
    // 两条分支各自的指定文案：retrievalOk → 【自动检索结果】；!retrievalOk → 【提示】本次检索不可用
    const isAutoResult = injected.content.includes('自动检索结果');
    const isUnavailableHint = injected.content.includes('本次检索不可用');
    assert.ok(
      isAutoResult || isUnavailableHint,
      `注入内容应为两支之一的指定文案，实际：${injected.content.slice(0, 80)}`,
    );

    // ④ 历史仍在且顺序不变（注入不得打乱 system → 历史 → 本轮）
    assert.deepEqual(
      cap.messages.slice(1, 3).map((m) => m.content),
      ['Q1', 'A1'],
      '历史应保持 Q1→A1 顺序',
    );
    assert.equal(cap.messages[0].role, 'system', 'system 仍在最前');
  });
});
