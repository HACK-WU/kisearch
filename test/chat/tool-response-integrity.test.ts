/** Real routes, disk history and upstream HTTP; only KB search data is controlled. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { runKbSearch } from './fixtures/response-search.js';
import { serializeToolResponse } from '../../src/lib/chat/retrieval/tool-response.js';

it('preserves the same actual bounded response in SSE, model input and reloaded history for both paths', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-tool-response-'));
  const previousConfig = process.env.KI_CONFIG_PATH;
  const configPath = path.join(tmp, 'config.yaml');
  process.env.KI_CONFIG_PATH = configPath;
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { './kb-search-tool.js': fileURLToPath(new URL('./fixtures/response-search.ts', import.meta.url)) } });
  const { handleChatRoutes } = await jiti.import<typeof import('../../src/lib/chat/chat-routes.js')>('../../src/lib/chat/chat-routes.ts');
  const { loadConfig, resetConfigCache } = await jiti.import<typeof import('../../src/lib/config.js')>('../../src/lib/config.ts');
  let captured: { messages: { role: string; content: string }[] }[] = [];
  let query = '';
  let supportsTools = true;
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      if (url.pathname === '/v1/chat/completions') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        captured.push(body);
        const call = supportsTools && !body.messages.some((m: { role: string }) => m.role === 'tool');
        const delta = call ? { tool_calls: [{ index: 0, id: 'call-response', type: 'function', function: { name: 'kb_search', arguments: JSON.stringify({ query }) } }] } : { content: 'answer' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } else {
        await handleChatRoutes(req, res, url, { authScopes: null, configSnapshot: loadConfig(), configPath });
      }
    })().catch((error) => res.destroy(error));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (supportsTools of [true, false]) {
      fs.writeFileSync(configPath, `dataDir: ${tmp}/data\nchatDir: ${tmp}/chat\nllm:\n  baseURL: ${base}/v1\n  model: mock\n  apiKey: mock\n  supportsTools: ${supportsTools}\n  kbDisclosureAck: true\n`);
      resetConfigCache();
      for (query of ['normal', 'large', 'error']) {
        captured = [];
        const created = await fetch(`${base}/api/chat/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'default' }) });
        assert.equal(created.status, 201);
        const { conv } = await created.json() as { conv: { id: string } };
        const stream = await fetch(`${base}/api/chat/conversations/${conv.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: query }) });
        assert.equal(stream.status, 200);
        const events = (await stream.text()).split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.slice(6)));
        assert.equal(events.at(-1).type, 'done');
        const end = events.find((event) => event.type === 'tool_end');
        const expected = serializeToolResponse(await runKbSearch('default', { query }));
        assert.deepEqual(end.response, expected);
        assert.ok(Array.from(end.response.text).length <= 10000);
        if (supportsTools) {
          assert.equal(captured.at(-1)!.messages.find((m) => m.role === 'tool')?.content, expected.text);
        } else {
          assert.ok(captured[0].messages.some((m) => m.content.includes(expected.text)));
        }
        const history = await fetch(`${base}/api/chat/conversations/${conv.id}`);
        const saved = await history.json() as { conv: { messages: { progress?: { phase: string; response?: unknown }[] }[] } };
        assert.deepEqual(saved.conv.messages.at(-1)?.progress?.find((p) => p.phase === 'end')?.response, expected);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.KI_CONFIG_PATH;
    else process.env.KI_CONFIG_PATH = previousConfig;
  }
});
