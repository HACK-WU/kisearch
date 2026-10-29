/** Two real LLM requests plus a search fixture verify citations across tool rounds. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import type { ChatEvent } from '../../src/lib/chat/chat-contract.js';

it('keeps later-round sources and deduplicates sources shared between rounds', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-citation-integrity-'));
  const previousConfig = process.env.KI_CONFIG_PATH;
  let requests = 0;
  const captured: { messages: { role: string; content: string }[] }[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      let body = '';
      for await (const chunk of req) body += chunk;
      captured.push(JSON.parse(body));
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = requests <= 2
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function', function: { name: 'ki_search', arguments: JSON.stringify({ query: requests === 1 ? 'first' : 'second' }) } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ delta: { content: 'answer citing i' }, finish_reason: 'stop' }] };
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    })().catch((error) => res.destroy(error));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const configPath = path.join(temporaryRoot, 'config.yaml');
    fs.writeFileSync(configPath, `dataDir: ${temporaryRoot}/data\nchatDir: ${temporaryRoot}/chat\nllm:\n  baseURL: http://127.0.0.1:${port}/v1\n  model: mock\n  apiKey: mock-key\n  kbDisclosureAck: true\n`);
    process.env.KI_CONFIG_PATH = configPath;
    // Only search execution is substituted; loop, projection, sources and HTTP parsing are real.
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: { '../mcp-tool-registry.js': fileURLToPath(new URL('./fixtures/generation-search.ts', import.meta.url)) },
    });
    const { runToolLoop } = await jiti.import<typeof import('../../src/lib/chat/retrieval/tool-loop.js')>('../../src/lib/chat/retrieval/tool-loop.ts');
    const conv = { version: 1 as const, id: 'c-citations', scope: 'default', title: '', systemPrompt: '', archived: false, archivedAt: null, createdAt: '', updatedAt: '', seq: 1, messageCount: 1, lastMessagePreview: '', messages: [{ id: 'm1', role: 'user' as const, content: 'question', at: '' }] };
    const events: ChatEvent[] = [];
    for await (const event of runToolLoop({ scope: 'default', conv, userText: 'question', convSystemPrompt: '' })) events.push(event);
    assert.equal(requests, 3);
    const ends = events.filter((event) => event.type === 'tool_end');
    const toolBodies = captured[2].messages.filter((message) => message.role === 'tool');
    assert.equal(ends.length, 2);
    for (let i = 0; i < ends.length; i++) {
      const response = ends[i].response!;
      assert.equal(response.text, toolBodies[i].content, 'UI and model receive exactly the same text');
      const raw = JSON.parse(response.text);
      assert.equal(raw.scope, 'default');
      assert.equal(raw.results.length, 5);
      assert.equal(raw.results[0].originalExcerpt, i === 0 ? 'evidence a' : 'evidence e');
      assert.equal(response.truncated, false);
    }
    const sources = events.find((event) => event.type === 'sources');
    assert.ok(sources?.type === 'sources');
    assert.deepEqual(sources.sources.map((source) => source.doc), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
    const done = events.at(-1);
    assert.ok(done?.type === 'done');
    assert.deepEqual(done.sources, sources.sources);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.KI_CONFIG_PATH;
    else process.env.KI_CONFIG_PATH = previousConfig;
  }
});
