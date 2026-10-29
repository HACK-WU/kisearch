/** Cancellation while a read-only search is unresolved must release generation ownership. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import type { ChatEvent } from '../../src/lib/chat/chat-contract.js';

it('normal and fallback tool waits cancel promptly, pair progress, and do not resume from late results', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-tool-cancel-'));
  const previousConfig = process.env.KI_CONFIG_PATH;
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { '../mcp-tool-registry.js': fileURLToPath(new URL('./fixtures/generation-search.ts', import.meta.url)) },
  });
  const { waitingSearch } = await jiti.import<typeof import('./fixtures/generation-search.js')>('./fixtures/generation-search.ts');
  let requests = 0;
  let citationMode = false;
  // 引用阶段用独立计数（阶段 2 纯聊天也消耗一次上游请求，全局 requests 不再对齐该阶段）
  let citedRequests = 0;
  let releaseModel = (): void => {};
  let modelGate = Promise.resolve();
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/v1/chat/completions') {
        for await (const _chunk of req) { /* consume request */ }
        requests += 1;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (citationMode) {
          citedRequests += 1;
          const citationFrames = citedRequests === 1
            ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-first', type: 'function', function: { name: 'ki_search', arguments: '{"query":"first"}' } }] }, finish_reason: 'tool_calls' }] }]
            : [{ choices: [{ delta: { content: '引用文档 a 的部分回答' } }] }];
          res.write(citationFrames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
          if (citedRequests > 1) await modelGate;
          res.end('data: [DONE]\n\n');
          return;
        }
        const frames = [
          { choices: [{ delta: { content: '已产生正文' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-wait', type: 'function', function: { name: 'ki_search', arguments: '{"query":"wait"}' } }] }, finish_reason: 'tool_calls' }] },
        ];
        res.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n');
        return;
      }
      await routes.handleChatRoutes(req, res, url, { authScopes: null, configSnapshot: config.loadConfig() });
    })().catch((error) => res.destroy(error));
  });
  const routes = await jiti.import<typeof import('../../src/lib/chat/chat-routes.js')>('../../src/lib/chat/chat-routes.ts');
  const config = await jiti.import<typeof import('../../src/lib/config.js')>('../../src/lib/config.ts');
  const store = await jiti.import<typeof import('../../src/lib/chat/chat-store.js')>('../../src/lib/chat/chat-store.ts');
  const loops = await jiti.import<typeof import('../../src/lib/chat/retrieval/tool-loop.js')>('../../src/lib/chat/retrieval/tool-loop.ts');
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'generation should stop while search remains unresolved');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const configPath = path.join(temporaryRoot, 'config.yaml');
    const configText = `dataDir: ${temporaryRoot}/data\nchatDir: ${temporaryRoot}/chat\nllm:\n  baseURL: ${base}/v1\n  model: mock\n  apiKey: mock-key\n  kbDisclosureAck: true\n`;
    fs.writeFileSync(configPath, configText);
    process.env.KI_CONFIG_PATH = configPath;
    const conv = await store.createConversation('default', {});
    const ctrl = new AbortController();
    const response = await fetch(`${base}/api/chat/conversations/${conv.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'wait' }), signal: ctrl.signal,
    });
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('"type":"tool_start"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
    }
    await waitFor(() => waitingSearch.entered);
    ctrl.abort();
    await waitFor(() => !routes.isGenerating(conv.id));
    const saved = await store.readConversation('default', conv.id);
    assert.equal(saved!.messages.at(-1)?.aborted, true);
    assert.deepEqual(saved!.messages.at(-1)?.progress?.map((step) => step.phase), ['start', 'end']);
    assert.equal(saved!.messages.at(-1)?.progress?.at(-1)?.error, '已停止');
    assert.equal(requests, 1);
    waitingSearch.release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests, 1, 'late search must not make another upstream request');

    // The fallback (supportsTools: false) is a pure-chat path since batch 2 (D2):
    // no tool execution happens, so nothing can hang — verify the shape instead.
    fs.writeFileSync(configPath, `${configText}  supportsTools: false\n`);
    waitingSearch.entered = false;
    const events: ChatEvent[] = [];
    const input = { scope: 'default', conv: saved!, userText: 'wait', convSystemPrompt: '', signal: new AbortController().signal };
    for await (const event of loops.runToolLoop(input)) events.push(event);
    assert.ok(!events.some((event) => event.type === 'tool_start' || event.type === 'tool_end'), '纯聊天路径不得出现工具事件');
    assert.equal(events.find((event) => event.type === 'degraded')?.reason, 'tools-unsupported');
    assert.equal(events.at(-1)?.type, 'done');
    assert.equal(waitingSearch.entered, false, '纯聊天路径不得执行任何检索');
    assert.equal(requests, 2, '纯聊天路径恰好再发 1 次上游请求');

    citationMode = true;
    fs.writeFileSync(configPath, configText);
    modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
    const citedConv = await store.createConversation('default', {});
    const citedCtrl = new AbortController();
    const citedResponse = await fetch(`${base}/api/chat/conversations/${citedConv.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'first' }), signal: citedCtrl.signal,
    });
    const citedReader = citedResponse.body!.getReader();
    let citedText = '';
    while (!citedText.includes('引用文档')) {
      const chunk = await citedReader.read();
      assert.equal(chunk.done, false);
      citedText += new TextDecoder().decode(chunk.value);
    }
    citedCtrl.abort();
    await waitFor(() => !routes.isGenerating(citedConv.id));
    const citedSaved = await store.readConversation('default', citedConv.id);
    assert.equal(citedSaved!.messages.at(-1)?.aborted, true);
    assert.deepEqual(citedSaved!.messages.at(-1)?.sources?.map((source) => source.doc), ['a', 'b', 'c', 'd', 'e']);
    releaseModel();
  } finally {
    releaseModel();
    waitingSearch.release?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.KI_CONFIG_PATH;
    else process.env.KI_CONFIG_PATH = previousConfig;
  }
});
