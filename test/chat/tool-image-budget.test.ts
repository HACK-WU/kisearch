/**
 * 图片预算与旧图降级（REQ-20261123-008 · B4）
 *
 * ═══ 为什么必须用 mock 上游做端到端，而不是只测纯函数 ═══
 * 这两条约束都是**跨工具轮次**的时序性质：
 *   ① 旧图降级：第 N 轮取图前要把第 N-1 轮的图换成占位 —— 只有看"真正发给上游的 messages"
 *      才能证明它生效（我们自己的 chars 口径本来就不计图片，看不出差别）；
 *   ② 累计闸：同一次生成内 ≥7 张要拒 —— 需要模型连续多轮发起工具调用。
 * 纯函数单测能覆盖 demote 的字符串处理，但覆盖不了"调用时机对不对"。
 *
 * 手法沿用 `tool-budget-injection.test.ts`：真实 `runToolLoop` + mock 上游 SSE，
 * 记录每次请求体，断言 image part 数量。
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/tool-image-budget.test.ts`
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import type { ChatEvent } from '../../src/lib/chat/chat-contract.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const makePng = (): Buffer => Buffer.concat([PNG_MAGIC, Buffer.alloc(64, 7)]);

type ReqBody = { messages: Array<{ role: string; content: unknown }> };

/** 统计一份请求体里 image part 的总数 */
function countImageParts(body: ReqBody): number {
  let n = 0;
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type?: string }>) {
      if (p.type === 'image_url') n += 1;
    }
  }
  return n;
}

it('B4：旧图降级让上下文只保留最新一批图；累计超 6 张被拒', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-img-budget-'));
  const previousConfig = process.env.KI_CONFIG_PATH;
  const bodies: ReqBody[] = [];

  // 三轮工具调用：3 张 → 3 张 → 1 张（第三轮会撞上累计上限 6）
  // group 是 KB 内的相对路径：scope=demo ⇒ kbDir=dataDir/demo ⇒ assets 在 dataDir/demo/pic/assets
  const rounds: Array<{ group: string; refs: string[] }> = [
    { group: 'pic', refs: ['a.png', 'b.png', 'c.png'] },
    { group: 'pic', refs: ['a.png', 'b.png', 'c.png'] },
    { group: 'pic', refs: ['a.png'] },
  ];

  const server = createServer((req, res) => {
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      try {
        bodies.push(JSON.parse(raw) as ReqBody);
      } catch {
        bodies.push({ messages: [] });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const index = bodies.length - 1;
      if (index < rounds.length) {
        const r = rounds[index]!;
        const chunk = {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: `call-${index}`,
                type: 'function',
                function: { name: 'ki_get_image', arguments: JSON.stringify({ group: r.group, refs: r.refs }) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      } else {
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      }
    })().catch((error) => res.destroy(error));
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    // 造 KB：{dataDir}/demo/pic/assets/{a,b,c}.png
    const dataDir = path.join(temporaryRoot, 'data');
    const assetsDir = path.join(dataDir, 'demo', 'pic', 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    for (const name of ['a.png', 'b.png', 'c.png']) {
      fs.writeFileSync(path.join(assetsDir, name), makePng());
    }

    const chatDir = path.join(temporaryRoot, 'chat');
    fs.mkdirSync(chatDir, { recursive: true });
    const configPath = path.join(temporaryRoot, 'config.yaml');
    fs.writeFileSync(
      configPath,
      `dataDir: ${dataDir}\nchatDir: ${chatDir}\n`
        + `llm:\n  baseURL: http://127.0.0.1:${port}/v1\n  model: mock\n  apiKey: mock-key\n  kbDisclosureAck: true\n`,
    );
    process.env.KI_CONFIG_PATH = configPath;
    // 只开取图工具：避免其它工具被模型顺带调用
    fs.writeFileSync(path.join(chatDir, 'prompt-config.json'), JSON.stringify({
      version: 1,
      prompt: { content: '基础提示词' },
      skills: [],
      tools: { ki_get_image: true },
    }));

    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const { runToolLoop } = await jiti.import<typeof import('../../src/lib/chat/retrieval/tool-loop.js')>(
      '../../src/lib/chat/retrieval/tool-loop.ts',
    );

    const conv = {
      version: 1 as const, id: 'c-imgbudget', scope: 'demo', title: '', systemPrompt: '',
      archived: false, archivedAt: null, createdAt: '', updatedAt: '', seq: 1, messageCount: 1,
      lastMessagePreview: '', messages: [{ id: 'm1', role: 'user' as const, content: 'question', at: '' }],
    };
    const events: ChatEvent[] = [];
    for await (const event of runToolLoop({ scope: 'demo', conv, userText: 'question', convSystemPrompt: '' })) {
      events.push(event);
    }

    // ─── 断言 1：每轮请求里的图片数量 ───
    // #1（首次取图前）：0 张
    // #2（拿到 3 张后）：3 张
    // #3（再取 3 张 → 前一批被降级）：**仍是 3 张**，不是 6 张 ← 降级生效
    // #4（第 3 次被累计闸拒，不再新增图）：3 张
    assert.equal(bodies.length, 4, `应有 4 次上游请求，实际 ${bodies.length}`);
    assert.equal(countImageParts(bodies[0]!), 0, '首次请求不该有图');
    assert.equal(countImageParts(bodies[1]!), 3, '第一轮取 3 张后应有 3 张');
    assert.equal(
      countImageParts(bodies[2]!),
      3,
      '第二轮取图前应已把上一批降级 —— 否则这里会是 6 张（历史图被重复上传）',
    );
    assert.equal(countImageParts(bodies[3]!), 3, '被累计闸拒绝后不再新增图');

    // ─── 断言 2：累计闸（3 + 3 + 1 > 6）拒绝第三次 ───
    const toolEnds = events.filter((e) => e.type === 'tool_end');
    assert.equal(toolEnds.length, 3, `应有 3 次工具调用，实际 ${toolEnds.length}`);
    const last = toolEnds[2]!;
    assert.equal(last.type, 'tool_end');
    assert.ok(last.error, '第三次取图必须被拒并给出 error');
    assert.match(last.error!, /上限 6 张/);
    assert.match(last.error!, /剩余额度 0 张/);

    // ─── 断言 3：被拒也不影响本轮生成结束 ───
    assert.ok(events.some((e) => e.type === 'done'), '拒绝后仍应正常收尾');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.KI_CONFIG_PATH;
    else process.env.KI_CONFIG_PATH = previousConfig;
  }
});
