/**
 * 用户上传图片 → 上游 messages 的挂载（REQ-20261123-006）
 *
 * ═══ 本文件守的是什么 ═══
 * 图片走的是「本轮 user 消息的 content parts」，不是文本 —— 挂错的表现全都是**静默**的：
 *   ① 本轮图没挂上 → 模型答得像没看图（不报错，用户只会觉得"它没看懂"）；
 *   ② 历史轮图被重发 → 上游无状态，每轮都重传，image_tokens 与带宽按轮数放大；
 *   ③ 图已被清理却装作没这回事 → 模型对残缺输入瞎猜；
 *   ④ **纯聊天降级路径漏读图** —— `llm.supportsTools === false` / 上游报工具不支持 /
 *      未配置模型时都会走该路径，而读图能力与工具能力正交。这里曾整条路径不读图，
 *      且会把占位符「[图片×N（已省略）]」缀到**本轮**（那是给历史轮用的），
 *      模型于是以为图被省略、实际一张都没到（auto-review 发现，已修）。
 *
 * 手法：真实 `runToolLoop` + mock 上游（同 `tool-loop-budget.test.ts`），不碰向量库。
 * 图片字节直接写在 `{chatDir}/{scope}/assets/{convId}__{id}.{ext}`，与生产路径一致。
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/user-image-upstream.test.ts`
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runToolLoop } from '../../src/lib/chat/retrieval/tool-loop.js';
import { resetConfigCache } from '../../src/lib/config.js';
import type {
  ChatEvent,
  ChatImageRef,
  ChatMessage,
  ConversationFile,
} from '../../src/lib/chat/chat-contract.js';

/** 会话 id 必须是 `c-*` 形态：`chat-store` 的 `assertValidId` 会拒掉其它形状（纵深防御） */
const CONV_ID = 'c-imgtest';
const SCOPE = 'default';

/** 上游收到的 messages 里我们关心的形状（只取断言要用的字段） */
interface UpstreamMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

interface Harness {
  upstream: { messages: UpstreamMessage[] }[];
  run: (userText: string) => Promise<ChatEvent[]>;
  cleanup: () => Promise<void>;
}

/** 本轮 / 历史用的图片元数据（id 必须落在 `[A-Za-z0-9-]{8,40}` 内） */
const image = (id: string): ChatImageRef => ({ id, mime: 'image/png', bytes: 8 });

/**
 * 起 mock 上游 + 临时配置（`supportsTools: false` ⇒ 必经纯聊天降级路径）。
 *
 * @param messages 会话消息（末条必须是本轮 user，且 content 与 `run` 的 userText 一致）
 * @param writeFiles 要落盘的图片 id（不落盘 = 模拟"图已被清理"）
 */
async function setup(messages: ChatMessage[], writeFiles: string[]): Promise<Harness> {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-user-image-'));
  const previousConfig = process.env.KI_CONFIG_PATH;
  const upstream: { messages: UpstreamMessage[] }[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      try {
        const parsed = JSON.parse(body) as { messages?: UpstreamMessage[] };
        upstream.push({ messages: parsed.messages ?? [] });
      } catch {
        upstream.push({ messages: [] });
      }
      const payload = { choices: [{ delta: { content: '答案' }, finish_reason: 'stop' }] };
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
    '  supportsTools: false',
    '  supportsImages: true',
    '',
  ].join('\n'));
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();

  const assetsDir = path.join(temporaryRoot, 'chat', SCOPE, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const id of writeFiles) {
    fs.writeFileSync(path.join(assetsDir, `${CONV_ID}__${id}.png`), Buffer.from('fake-png'));
  }

  const conv: ConversationFile = {
    version: 1,
    id: CONV_ID,
    scope: SCOPE,
    title: '',
    systemPrompt: '',
    archived: false,
    archivedAt: null,
    createdAt: '',
    updatedAt: '',
    seq: 0,
    messageCount: messages.length,
    lastMessagePreview: '',
    messages,
  };

  return {
    upstream,
    run: async (userText: string) => {
      const events: ChatEvent[] = [];
      for await (const ev of runToolLoop({
        scope: SCOPE,
        conv,
        userText,
        convSystemPrompt: '',
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

/** 取末条（本轮 user）消息 */
function lastUser(messages: UpstreamMessage[]): UpstreamMessage {
  const found = [...messages].reverse().find((m) => m.role === 'user');
  assert.ok(found, '上游 messages 里应至少有一条 user');
  return found;
}

it('纯聊天降级路径：本轮图挂成 image_url parts，历史轮的图不重发只留占位', async () => {
  const history = image('hist00001');
  const current = image('cur000001');
  const messages: ChatMessage[] = [
    { id: 'm1', role: 'user', content: '第一问', at: '', images: [history] },
    { id: 'm2', role: 'assistant', content: '第一答', at: '' },
    { id: 'm3', role: 'user', content: '第二问', at: '', images: [current] },
  ];
  // 历史图的文件**故意不落盘**：本路径只读本轮，历史轮连读都不该尝试
  const h = await setup(messages, [current.id]);
  try {
    const events = await h.run('第二问');

    // 确实是降级路径（否则下面的断言在验另一条路径）
    const degraded = events.find((e) => e.type === 'degraded');
    assert.ok(degraded && degraded.type === 'degraded');
    assert.equal(degraded.reason, 'tools-unsupported');

    assert.equal(h.upstream.length, 1, '降级路径只应调一次上游');
    const sent = h.upstream[0]!.messages;

    // ① 本轮：content 是数组，含 image_url + text（图在前）
    const currentMsg = lastUser(sent);
    assert.ok(Array.isArray(currentMsg.content), '本轮 user 的 content 必须是 parts 数组');
    const parts = currentMsg.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    assert.equal(parts[0]!.type, 'image_url');
    assert.match(parts[0]!.image_url?.url ?? '', /^data:image\/png;base64,/);
    assert.equal(parts[1]!.type, 'text');
    assert.ok((parts[1]!.text ?? '').includes('第二问'));

    // ② 历史轮：仍是字符串，且带"已省略"占位，不得出现 image_url
    const historyMsg = sent.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('第一问'));
    assert.ok(historyMsg, '历史 user 消息应存在');
    assert.ok((historyMsg.content as string).includes('[图片×1（已省略）]'));
    assert.equal(
      sent.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url' && p.image_url?.url.includes('hist00001'))),
      false,
      '历史图的字节不得出现在本次请求',
    );
  } finally {
    await h.cleanup();
  }
});

it('本轮图已被清理：不挂 parts，但在文本里告诉模型「未能读取」', async () => {
  const current = image('missing01');
  const messages: ChatMessage[] = [
    { id: 'm1', role: 'user', content: '看图', at: '', images: [current] },
  ];
  const h = await setup(messages, []); // 不落盘 = 文件不存在
  try {
    await h.run('看图');
    assert.equal(h.upstream.length, 1);
    const currentMsg = lastUser(h.upstream[0]!.messages);

    assert.equal(typeof currentMsg.content, 'string', '读不到图时不得挂空 parts 数组');
    assert.ok((currentMsg.content as string).includes('1 张图片未能读取'));
  } finally {
    await h.cleanup();
  }
});

it('无图会话：末条 user 仍是纯字符串（老行为零变化）', async () => {
  const messages: ChatMessage[] = [
    { id: 'm1', role: 'user', content: '普通提问', at: '' },
  ];
  const h = await setup(messages, []);
  try {
    await h.run('普通提问');
    const currentMsg = lastUser(h.upstream[0]!.messages);
    assert.equal(typeof currentMsg.content, 'string');
    assert.equal(currentMsg.content, '普通提问');
  } finally {
    await h.cleanup();
  }
});
