/**
 * 用户手动引用文档片段 · 上游注入测试（REQ-20261009-002 需求 B）
 *
 * ═══ 本文件存在的理由 ═══
 * 「输入框引用文档」的价值全在于**引用真的进了模型上下文**；而这条链路跨了
 * 请求体解析（`chat-routes.parseRefs`）→ 落盘 → `ToolLoopInput.refs` → system 块注入，
 * 任何一跳断掉都只表现为"AI 好像没看见我引用的内容"——静默、不可观测。
 * 因此这里沿用 `multi-turn-context.test.ts` 的手法：**mock 上游捕获真实请求体**，
 * 对发往上游的 messages 做形状断言。
 *
 * 断言：
 *   ① 带 refs → system 组内含引用块（文档名 + 片段原文 + 编号 + 软提示措辞）
 *   ② 无 refs → 不注入（既有行为零变化）
 *   ③ ★ 不变量「返回数组末条恒为本轮 user」仍成立（degradedPath 的 splice 依赖它）
 *   ④ 引用块落在 system 组内、历史消息之前（不混进历史、不改变交替契约）
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runToolLoop } from '../../src/lib/chat/retrieval/tool-loop.js';
import { parseRefs } from '../../src/lib/chat/chat-routes.js';
import type { ChatRef, ConversationFile } from '../../src/lib/chat/chat-contract.js';

interface Captured { messages: { role: string; content: string }[] }

let captured: Captured[] = [];
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
        captured.push({ messages: (j.messages ?? []).map((m) => ({ role: m.role, content: m.content })) });
      } catch { /* 忽略非 JSON */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '收到' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-chat-refs-'));
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

function convOf(messages: { id: string; role: 'user' | 'assistant'; content: string }[], systemPrompt = ''): ConversationFile {
  return {
    version: 1, id: 'c-refs', scope: 'default', title: 't', systemPrompt,
    archived: false, archivedAt: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    seq: 0, messageCount: messages.length, lastMessagePreview: '',
    messages: messages.map((m) => ({ ...m, at: '2026-01-01T00:00:00Z' })),
  };
}

const u = (id: string, content: string) => ({ id, role: 'user' as const, content });
const a = (id: string, content: string) => ({ id, role: 'assistant' as const, content });

async function runTurn(conv: ConversationFile, userText: string, refs?: ChatRef[]): Promise<Captured> {
  captured = [];
  for await (const _ev of runToolLoop({
    scope: 'default', conv, userText, convSystemPrompt: conv.systemPrompt,
    ...(refs ? { refs } : {}),
    signal: new AbortController().signal,
  })) { /* 只关心上游请求体 */ }
  assert.equal(captured.length, 1, `本轮应恰好发出 1 次上游请求，实际 ${captured.length} 次`);
  return captured[0];
}

const systemTexts = (m: Captured): string[] => m.messages.filter((x) => x.role === 'system').map((x) => x.content);
const refsBlockOf = (m: Captured): string | undefined => systemTexts(m).find((t) => t.includes('用户指定的参考资料'));
const firstNonSystemIndex = (m: Captured): number => m.messages.findIndex((x) => x.role !== 'system');

const REF_A: ChatRef = { group: 'k8s', doc: '01-概述', text: 'Pod 是 Kubernetes 的最小调度单元。' };
const REF_B: ChatRef = { group: 'k8s/基础', doc: '02-容器', text: '容器共享同一网络命名空间。' };

// ─── 用例 ───

describe('用户引用 · 上游 system 注入', () => {
  it('★ 带引用 → system 组含引用块（文档名 + 片段原文 + 编号 + 软提示措辞）', async () => {
    const cap = await runTurn(convOf([u('m1', '这段什么意思？')]), '这段什么意思？', [REF_A]);
    const block = refsBlockOf(cap);
    assert.ok(block, `应注入引用块，实际 system 块 ${systemTexts(cap).length} 个`);
    assert.ok(block.includes('k8s / 01-概述'), '应含 group / doc 定位');
    assert.ok(block.includes(REF_A.text), '应含用户选中的片段原文');
    assert.ok(block.includes('引用 1：'), '应用编号围栏');
    assert.ok(/优先依据/.test(block), '应表达「优先依据」的软提示语义');
    assert.ok(/检索工具/.test(block), '应保留继续检索全库的许可（软提示 ≠ 硬限定）');
  });

  it('无引用 → 不注入引用块（既有行为零变化）', async () => {
    const cap = await runTurn(convOf([u('m1', 'Q1')]), 'Q1');
    assert.equal(refsBlockOf(cap), undefined, '不得凭空注入引用块');
    assert.ok(systemTexts(cap).length > 0, '既有 system 块（检索 skill 等）仍应存在');
  });

  it('★ 引用不得破坏「末条恒为本轮 user」不变量', async () => {
    const cap = await runTurn(convOf([u('m1', '本轮问题')]), '本轮问题', [REF_A, REF_B]);
    const last = cap.messages.at(-1)!;
    assert.equal(last.role, 'user', `末条应为 user，实际 ${last.role}`);
    assert.equal(last.content, '本轮问题');
  });

  it('引用块落在 system 组内、历史消息之前', async () => {
    const conv = convOf([u('m1', 'Q1'), a('m2', 'A1'), u('m3', 'Q2')]);
    const cap = await runTurn(conv, 'Q2', [REF_A]);
    const idx = cap.messages.findIndex((x) => x.content.includes('用户指定的参考资料'));
    assert.ok(idx >= 0 && idx < firstNonSystemIndex(cap), `引用块应在历史之前（块 idx=${idx}，首条非 system idx=${firstNonSystemIndex(cap)}）`);
  });

  it('多条引用按序编号且内容齐全', async () => {
    const cap = await runTurn(convOf([u('m1', 'Q1')]), 'Q1', [REF_A, REF_B]);
    const block = refsBlockOf(cap)!;
    const i1 = block.indexOf('引用 1：');
    const i2 = block.indexOf('引用 2：');
    assert.ok(i1 >= 0 && i2 > i1, '应出现编号 1 与 2 且顺序正确');
    assert.ok(block.includes(REF_A.text) && block.includes(REF_B.text), '两条片段原文都应注入');
    assert.ok(block.includes('k8s/基础 / 02-容器'), '第二条应带自己的 group / doc');
  });

  it('引用不混入历史消息角色序列（交替契约不变）', async () => {
    const conv = convOf([u('m1', 'Q1'), a('m2', 'A1'), u('m3', 'Q2')]);
    const cap = await runTurn(conv, 'Q2', [REF_A]);
    const roles = cap.messages.filter((x) => x.role !== 'system').map((x) => x.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user'], `非 system 角色序列应保持交替，实际 ${roles.join(',')}`);
  });
});

// ─── parseRefs 请求体校验（code review P1 补测：此前零覆盖）───

describe('parseRefs 请求体校验', () => {
  const ref = (over: Partial<ChatRef> = {}): Record<string, unknown> => ({ group: 'g', doc: 'd', text: '内容', ...over });

  it('缺省 / null / 空数组 → undefined（视为未引用）', () => {
    assert.equal(parseRefs({}), undefined);
    assert.equal(parseRefs({ refs: null }), undefined);
    assert.equal(parseRefs({ refs: [] }), undefined);
  });

  it('非数组 → 400', () => {
    assert.throws(() => parseRefs({ refs: 'oops' }), /必须是数组/);
  });

  it('条数超限 → 400（fail-loud，不静默截断）', () => {
    const refs = Array.from({ length: 6 }, () => ref());
    assert.throws(() => parseRefs({ refs }), /最多引用 5 段/);
  });

  it('字段类型不符 → 400', () => {
    assert.throws(() => parseRefs({ refs: [ref({ group: 1 })] }), /三个字符串字段/);
  });

  it('group/doc 空串或超长 → 400（元数据长度上限）', () => {
    assert.throws(() => parseRefs({ refs: [ref({ group: '   ' })] }), /必须指明/);
    assert.throws(() => parseRefs({ refs: [ref({ doc: 'x'.repeat(256) })] }), /过长/);
  });

  it('单条内容超长 → 400', () => {
    assert.throws(() => parseRefs({ refs: [ref({ text: 'x'.repeat(2001) })] }), /单条引用不得超过/);
  });

  it('全部引用合计超长 → 400', () => {
    // 边界自洽：单条 ≤2000 且合计 >6000 需要 ≥4 条（3×2000=6000 不触发）——顺带验证两上限不打架
    const refs = Array.from({ length: 4 }, () => ref({ text: 'x'.repeat(1501) }));
    assert.throws(() => parseRefs({ refs }), /合计不得超过/);
  });

  it('内容 trim 后为空 → 400', () => {
    assert.throws(() => parseRefs({ refs: [ref({ text: '   ' })] }), /内容为空/);
  });

  it('合法输入 → trim 后规范化返回', () => {
    const out = parseRefs({ refs: [ref({ group: ' g ', doc: ' d ', text: ' 内容 ' })] });
    assert.deepEqual(out, [{ group: 'g', doc: 'd', text: '内容' }]);
  });
});
