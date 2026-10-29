/**
 * 预算注入的**端到端**断言（REQ-20261015-001）
 *
 * 锁住 challenger 意见 1 的修复（🔴）：注入点必须在**执行必经点**
 * （`tool-loop` 的 `entry.parse()` 之后），而不是包装 `enabledChatToolEntries` 的返回值 ——
 * 后者永不执行（执行走 `getChatTool()` 的原始 entry），配置会**静默失效**。
 *
 * 手法：真实 `runToolLoop` + mock 上游（第一次返回工具调用，第二次结束），
 * 只把**检索执行**换成 fixture；断言 fixture 的 `run` 实际收到的 `limit`
 * 等于**配置值**（而非内置 5 或 undefined）。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/tool-budget-injection.test.ts
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

it('searchHitsPerCall 配置在执行必经点生效：未传 limit 的 ki_search 让执行层收到配置值', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-budget-inject-'));
  const previousConfig = process.env.KI_CONFIG_PATH;
  let requests = 0;
  const server = createServer((req, res) => {
    void (async () => {
      for await (const _chunk of req) { /* drain */ }
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = requests === 1
        // ★ 第一次：模型调用 ki_search **不带 limit**（正是"未配置时用默认值"的路径）
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'ki_search', arguments: JSON.stringify({ query: 'budget-probe' }) } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    })().catch((error) => res.destroy(error));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const chatDir = path.join(temporaryRoot, 'chat');
    fs.mkdirSync(chatDir, { recursive: true });
    const configPath = path.join(temporaryRoot, 'config.yaml');
    fs.writeFileSync(configPath, `dataDir: ${temporaryRoot}/data\nchatDir: ${chatDir}\nllm:\n  baseURL: http://127.0.0.1:${port}/v1\n  model: mock\n  apiKey: mock-key\n  kbDisclosureAck: true\n`);
    process.env.KI_CONFIG_PATH = configPath;
    // 用户覆盖值：检索条数默认 8（≠ 内置 5 —— 只有注入生效才会看到 8）
    fs.writeFileSync(path.join(chatDir, 'prompt-config.json'), JSON.stringify({
      version: 1,
      prompt: { content: '基础提示词' },
      skills: [{ id: 'builtin-retrieval', name: '知识库检索', content: '正文', description: '描述' }],
      tools: { ki_search: true },
      searchHitsPerCall: 8,
    }));

    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: { '../mcp-tool-registry.js': fileURLToPath(new URL('./fixtures/generation-search.ts', import.meta.url)) },
    });
    const { lastSearchArgs } = await jiti.import<typeof import('./fixtures/generation-search.js')>('./fixtures/generation-search.ts');
    const { runToolLoop } = await jiti.import<typeof import('../../src/lib/chat/retrieval/tool-loop.js')>('../../src/lib/chat/retrieval/tool-loop.ts');

    const conv = {
      version: 1 as const, id: 'c-budget', scope: 'default', title: '', systemPrompt: '',
      archived: false, archivedAt: null, createdAt: '', updatedAt: '', seq: 1, messageCount: 1,
      lastMessagePreview: '', messages: [{ id: 'm1', role: 'user' as const, content: 'question', at: '' }],
    };
    const events: ChatEvent[] = [];
    for await (const event of runToolLoop({ scope: 'default', conv, userText: 'question', convSystemPrompt: '' })) {
      events.push(event);
    }

    const args = lastSearchArgs();
    assert.ok(args, 'fixture 应记录到一次检索调用（注入缺失时这里会是 null 或 limit=5）');
    assert.equal(args!.limit, 8, '未传 limit 时执行层必须收到**配置的默认值 8**（而非内置 5）');
    // 未传时也应保持其他参数原样（注入不得污染调用）
    assert.equal(args!.query, 'budget-probe');

    const end = events.find((event) => event.type === 'tool_end');
    assert.ok(end?.type === 'tool_end');
    assert.equal(end.response!.limit, 10000, '默认返回上限 = 内置 10000（未配置 toolResponseChars）');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.KI_CONFIG_PATH;
    else process.env.KI_CONFIG_PATH = previousConfig;
  }
});
