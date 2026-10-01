/**
 * SR-01 路由级端到端：编辑重发 / 重新生成（API-12 / API-11 · R24 / R23 / N21）
 *
 * ═══ ★ 为什么必须有这个文件 ═══
 * `acceptance-sr01.test.ts` 的 R23/R24 只测 **store 级原语**
 * （`replaceLastAssistant` / `truncateAfterAndEdit` 各自单测，各自都是对的）。
 * 而实测暴露的缺陷恰恰在**两者的接线处**：
 *
 *   `chat-routes.runGeneration` 对 `mode === 'edit'` 也调用 `replaceLastAssistant`
 *   → 它从「最后一条 assistant」起截断，把 `truncateAfterAndEdit` 刚保留的 u' 一并删除：
 *       [u1, a1, u2] --truncate--> [u1, a1, u2'] --replaceLastAssistant--> [u1, a2]
 *
 * 这个缺陷**形状断言（contain-parity / contract-sr01）与 store 级单测都结构性覆盖不到** ——
 * 只有把「真实 HTTP 路由 + 真实上游 SSE + 真实落盘」串起来才能发现。
 *
 * ═══ 手法 ═══
 * 起一个本地 http server，同时扮演两个角色：
 *   ① daemon 侧 `/api/chat/*`   → 挂 `handleChatRoutes`
 *   ② 上游模型侧 `/v1/chat/completions` → OpenAI 兼容 SSE（纯 content，**不返回 tool_calls**，
 *      因此工具循环一轮即收敛，不需要 mock 检索）
 * 断言一律**读磁盘**（`readConversation`），而不是读 SSE 文本 —— 缺陷正是"事件对、落盘错"。
 *
 * 运行：`npx jiti test/chat/e2e-sr01-edit.test.ts`
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** 取非常用端口，避免与本机 daemon(7423) 及 e2e-sr02(7489) 冲突 */
const PORT = 7491;
const BASE = `http://127.0.0.1:${PORT}`;

/** 上游固定回答（断言用；与 mock-sse 无关，此处只证"落盘链路"） */
const MOCK_ANSWER = '（e2e mock 回答）';

// ─────────────────────────────────────────────────────────────
// 测试隔离：临时 config（显式 dataDir / chatDir + 就绪的 llm 段）
// ★ 必须在首次 `loadConfig()` 之前设置；本文件首次加载发生在请求处理内部，
//   故顶层的 env 设置必然更早（同款做法见 acceptance-sr01.test.ts）。
// ─────────────────────────────────────────────────────────────
const TMP_ROOT = mkdtempSync(path.join(tmpdir(), 'ki-e2e-sr01-edit-'));
const TMP_CONFIG = path.join(TMP_ROOT, 'config.yaml');
const CHAT_DIR = path.join(TMP_ROOT, 'chat');

writeFileSync(
  TMP_CONFIG,
  [
    `dataDir: ${path.join(TMP_ROOT, 'data')}`,
    `chatDir: ${CHAT_DIR}`,
    'llm:',
    `  baseURL: ${BASE}/v1`,
    '  model: mock-llm',
    '  apiKey: mock-key',
    // T12：已确认内容外发 → ackRequired=false（否则 requireGenerationReady 会 403）
    '  kbDisclosureAck: true',
    '',
  ].join('\n'),
  'utf-8',
);
process.env.KI_CONFIG_PATH = TMP_CONFIG;

/** 上游 SSE 帧（OpenAI 兼容：delta.content → 归一化为 content 分片） */
function upstreamSse(): string {
  const frames: unknown[] = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: MOCK_ANSWER } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    },
  ];
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => resolve(raw));
  });
}

let server: Server;

before(async () => {
  const { handleChatRoutes } = await import('../../src/lib/chat/chat-routes.js');
  const { loadConfig } = await import('../../src/lib/config.js');

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', BASE);

        // ── ② 上游模型侧 ──
        if (url.pathname === '/v1/chat/completions') {
          await readBody(req);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
          });
          res.end(upstreamSse());
          return;
        }

        // ── ① daemon 侧 ──
        const cfg = loadConfig();
        const handled = await handleChatRoutes(req, res, url, {
          authScopes: null, // 鉴权未启用：全部 scope 可见（P1/P3 的越权路径由 permissions-sr01 覆盖）
          configSnapshot: cfg,
          configPath: TMP_CONFIG,
        });
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'not found' }));
        }
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', () => resolve()));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** 建一条含两轮的会话：[u1, a1, u2]，返回会话 id 与 u2 的 id */
async function seedConversation(): Promise<{ convId: string; u2Id: string }> {
  const store = await import('../../src/lib/chat/chat-store.js');
  const c = await store.createConversation('kisearch', { title: 'e2e-edit' });
  await store.appendMessage('kisearch', c.id, { id: '', role: 'user', content: 'u1 原问题', at: '' });
  await store.appendMessage('kisearch', c.id, { id: '', role: 'assistant', content: 'a1 原回答', at: '' });
  const after2 = await store.appendMessage('kisearch', c.id, { id: '', role: 'user', content: 'u2 原问题', at: '' });
  return { convId: c.id, u2Id: after2.messages.at(-1)!.id };
}

/** 读磁盘上的会话，拍平成 `role:content` 便于对比 */
async function readLines(convId: string): Promise<string[]> {
  const store = await import('../../src/lib/chat/chat-store.js');
  const conv = await store.readConversation('kisearch', convId);
  assert.ok(conv, '会话应存在');
  return conv.messages.map((m) => `${m.role}:${m.content}`);
}

describe('SR-01 路由级 e2e · 生成链路可用性（前置）', () => {
  it('API-08 发消息：200 + 落盘 assistant（若 req.close 过早 abort，本条会红）', async () => {
    const store = await import('../../src/lib/chat/chat-store.js');
    const c = await store.createConversation('kisearch', { title: 'e2e-send' });

    const res = await fetch(`${BASE}/api/chat/conversations/${c.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '你好' }),
    });
    assert.equal(res.status, 200, 'SSE 建立应返回 200');
    const sse = await res.text();

    assert.ok(sse.includes('"type":"meta"'), '必须收到 meta 首帧');
    assert.ok(sse.includes('"type":"content"'), '必须收到 content 分片');
    assert.ok(sse.includes('"type":"done"'), '必须收到 done 收尾');

    assert.deepEqual(await readLines(c.id), ['user:你好', `assistant:${MOCK_ANSWER}`]);
  });
});

describe('SR-01 路由级 e2e · ★ API-12 编辑重发不得丢失被编辑的 user 消息', () => {
  it('编辑第 2 轮 user 消息 → [u1, a1, u2\', a2]，u2\' 必须保留（本文件存在的理由）', async () => {
    const { convId, u2Id } = await seedConversation();
    assert.deepEqual(await readLines(convId), ['user:u1 原问题', 'assistant:a1 原回答', 'user:u2 原问题']);

    const res = await fetch(`${BASE}/api/chat/conversations/${convId}/messages/${u2Id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'u2 已编辑' }),
    });
    assert.equal(res.status, 200);
    const sse = await res.text();
    assert.ok(sse.includes('"type":"done"'), '必须收到 done 收尾');

    // ★ 核心断言：修复前此处得到 ['user:u1 原问题', 'assistant:a2']（u2' 与 a1 被一并删除）
    assert.deepEqual(await readLines(convId), [
      'user:u1 原问题',
      'assistant:a1 原回答',
      'user:u2 已编辑',
      `assistant:${MOCK_ANSWER}`,
    ]);
  });

  it('编辑第 1 轮 user 消息 → 截断其后全部，再追加新回答', async () => {
    const { convId } = await seedConversation();
    const store = await import('../../src/lib/chat/chat-store.js');
    const conv = await store.readConversation('kisearch', convId);
    const u1Id = conv!.messages[0]!.id;

    const res = await fetch(`${BASE}/api/chat/conversations/${convId}/messages/${u1Id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'u1 已编辑' }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.deepEqual(await readLines(convId), ['user:u1 已编辑', `assistant:${MOCK_ANSWER}`]);
  });

  it('编辑 assistant 消息 → 400 MESSAGE_INVALID（契约：只能编辑 user）', async () => {
    const { convId } = await seedConversation();
    const store = await import('../../src/lib/chat/chat-store.js');
    const conv = await store.readConversation('kisearch', convId);
    const a1Id = conv!.messages[1]!.id;

    const res = await fetch(`${BASE}/api/chat/conversations/${convId}/messages/${a1Id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, 'MESSAGE_INVALID');
    // 且不得改动落盘内容
    assert.deepEqual(await readLines(convId), ['user:u1 原问题', 'assistant:a1 原回答', 'user:u2 原问题']);
  });
});

describe('SR-01 路由级 e2e · API-11 重新生成（R23）', () => {
  it('末条是 assistant → 原位替换：messageCount 不变、u 消息不新增', async () => {
    const store = await import('../../src/lib/chat/chat-store.js');
    const c = await store.createConversation('kisearch', { title: 'e2e-regen' });
    await store.appendMessage('kisearch', c.id, { id: '', role: 'user', content: 'u1 原问题', at: '' });
    await store.appendMessage('kisearch', c.id, { id: '', role: 'assistant', content: 'a1 原回答', at: '' });
    const before = await readLines(c.id);

    const res = await fetch(`${BASE}/api/chat/conversations/${c.id}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    await res.text();

    const after = await readLines(c.id);
    assert.equal(after.length, before.length, 'messageCount 必须不变（R23）');
    assert.equal(after.filter((l) => l.startsWith('user:')).length, 1, '不得新增 user 消息');
    assert.deepEqual(after, ['user:u1 原问题', `assistant:${MOCK_ANSWER}`]);
  });

  it('★ 末条是 user（上轮生成未落盘）→ 追加回答，**不得**删除既有 user / assistant', async () => {
    const { convId } = await seedConversation(); // [u1, a1, u2]
    const res = await fetch(`${BASE}/api/chat/conversations/${convId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    await res.text();

    // ★ 修复前此处得到 ['user:u1 原问题'] —— u2 与 a1 被 replaceLastAssistant 一并删除
    assert.deepEqual(await readLines(convId), [
      'user:u1 原问题',
      'assistant:a1 原回答',
      'user:u2 原问题',
      `assistant:${MOCK_ANSWER}`,
    ]);
  });
});
