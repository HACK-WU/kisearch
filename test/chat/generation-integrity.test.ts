/** Real HTTP/SSE regressions for generation ownership, history and cancellation. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleChatRoutes, isGenerating } from '../../src/lib/chat/chat-routes.js';
import { appendMessage, createConversation, readConversation, withConvLock } from '../../src/lib/chat/chat-store.js';
import { loadConfig } from '../../src/lib/config.js';
import { defaultPromptConfig } from '../../src/lib/chat/prompt-config.js';

type Turn = { role: string; content: string; tool_calls?: unknown };
let base = '';
let mode: 'normal' | 'partial' | 'empty' | 'failure' | 'tool' = 'normal';
let captured: Array<{ messages: Turn[] }> = [];
let scopes: string[] | null = null;
let releaseUpstream = (): void => {};
let upstreamGate = Promise.resolve();
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-generation-integrity-'));
const previousConfig = process.env.KI_CONFIG_PATH;
const configPath = path.join(temporaryRoot, 'config.yaml');
const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', base);
    if (url.pathname === '/v1/chat/completions') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      captured.push(JSON.parse(raw));
      if (mode === 'failure') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock upstream unavailable' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (value: unknown): void => { res.write(`data: ${JSON.stringify(value)}\n\n`); };
      if (mode === 'tool' && captured.length === 1) {
        frame({ choices: [{ delta: { content: '第一项确认：7。' } }] });
        // Invalid query returns a tool error without requiring a real KB fixture.
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'kb_search', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
      } else {
        if (mode !== 'empty') frame({ choices: [{ delta: { content: mode === 'partial' ? '部分回答' : '新回答' } }] });
        else res.flushHeaders();
        if (mode === 'partial' || mode === 'empty') await upstreamGate;
        if (!res.destroyed) {
          if (mode === 'partial') frame({ choices: [{ delta: { content: '不应继续' } }] });
          frame({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        }
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    await handleChatRoutes(req, res, url, { authScopes: scopes, configSnapshot: loadConfig() });
  })().catch((error) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fs.writeFileSync(configPath, `dataDir: ${temporaryRoot}/data\nchatDir: ${temporaryRoot}/chat\nllm:\n  baseURL: ${base}/v1\n  model: mock-model\n  apiKey: mock-key\n  kbDisclosureAck: true\n`);
  process.env.KI_CONFIG_PATH = configPath;
});
after(async () => {
  releaseUpstream();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  if (previousConfig === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = previousConfig;
});

function reset(nextMode: typeof mode = 'normal'): void {
  mode = nextMode;
  captured = [];
  scopes = null;
  upstreamGate = new Promise<void>((resolve) => { releaseUpstream = resolve; });
}
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'condition should settle within 2 seconds');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function seed(): Promise<string> {
  const conv = await createConversation('default', {});
  for (const [role, content] of [['user', '问题 Q'], ['assistant', '旧回答 A']] as const) {
    await appendMessage('default', conv.id, { id: '', role, content, at: '' });
  }
  return conv.id;
}
const post = (id: string, suffix: string, text?: string, signal?: AbortSignal) => fetch(`${base}/api/chat/conversations/${id}/${suffix}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(text ? { text } : {}), signal,
});
const disk = async (id: string) => (await readConversation('default', id))!;
async function stopAt(id: string, suffix: string, marker: string): Promise<void> {
  const ctrl = new AbortController();
  const response = await post(id, suffix, '新问题', ctrl.signal);
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let received = '';
  while (!received.includes(marker)) {
    const part = await reader.read();
    assert.equal(part.done, false, 'stream should reach the cancellation marker');
    received += new TextDecoder().decode(part.value);
  }
  ctrl.abort();
  await waitFor(() => !isGenerating(id));
  releaseUpstream();
}

describe('generation integrity through real HTTP', { concurrency: false }, () => {
  it('reserves ownership before waiting for a store lock', async () => {
    reset();
    const conv = await createConversation('default', {});
    let unlock = (): void => {};
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const held = withConvLock(conv.id, () => gate);
    const first = post(conv.id, 'messages', 'question one');
    try {
      await waitFor(() => isGenerating(conv.id));
      const second = await post(conv.id, 'messages', 'question two');
      assert.equal(second.status, 409);
      assert.equal((await second.json()).code, 'CONVERSATION_GENERATING');
    } finally { unlock(); }
    await held;
    const response = await first;
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual((await disk(conv.id)).messages.map((m) => m.content), ['question one', '新回答']);
    assert.equal(isGenerating(conv.id), false);
  });

  it('releases ownership when the preparation write fails', async () => {
    reset();
    const conv = await createConversation('default', {});
    let unlock = (): void => {};
    const held = withConvLock(conv.id, () => new Promise<void>((resolve) => { unlock = resolve; }));
    const responsePending = post(conv.id, 'messages', 'not persisted');
    try {
      await waitFor(() => isGenerating(conv.id));
      fs.unlinkSync(path.join(temporaryRoot, 'chat/default', `${conv.id}.json`));
    } finally { unlock(); }
    await held;
    assert.equal((await responsePending).status, 404);
    assert.equal(isGenerating(conv.id), false);
  });

  it('regenerate excludes only the replaced answer from upstream history', async () => {
    reset();
    const id = await seed();
    await appendMessage('default', id, { id: '', role: 'user', content: '第二个问题', at: '' });
    await appendMessage('default', id, { id: '', role: 'assistant', content: '第二个旧回答', at: '' });
    await (await post(id, 'regenerate')).text();
    assert.deepEqual(captured[0].messages.filter((m) => m.role !== 'system').map((m) => m.content), ['问题 Q', '旧回答 A', '第二个问题']);
    assert.deepEqual((await disk(id)).messages.map((m) => m.content), ['问题 Q', '旧回答 A', '第二个问题', '新回答']);
  });

  it('regenerate after a failed next question appends its answer without deleting earlier turns', async () => {
    reset('failure');
    const id = await seed();
    assert.ok((await (await post(id, 'messages', '第二个问题')).text()).includes('"type":"error"'));
    assert.deepEqual((await disk(id)).messages.map((m) => m.content), ['问题 Q', '旧回答 A', '第二个问题']);
    reset();
    await (await post(id, 'regenerate')).text();
    assert.deepEqual(captured[0].messages.filter((m) => m.role !== 'system').map((m) => m.content), ['问题 Q', '旧回答 A', '第二个问题']);
    assert.deepEqual((await disk(id)).messages.map((m) => m.content), ['问题 Q', '旧回答 A', '第二个问题', '新回答']);
  });

  it('tool continuation remembers the text already shown to the user', async () => {
    reset('tool');
    const conv = await createConversation('default', {});
    const text = await (await post(conv.id, 'messages', '两个问题')).text();
    const toolAssistant = captured[1].messages.find((m) => m.tool_calls);
    assert.equal(toolAssistant?.content, '第一项确认：7。');
    const end = text.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.slice(6))).find((event) => event.type === 'tool_end');
    const toolBody = captured[1].messages.find((m) => m.role === 'tool');
    assert.equal(end.response.text, toolBody?.content);
    assert.match(JSON.parse(end.response.text).error, /query/);
    assert.deepEqual((await disk(conv.id)).messages.at(-1)?.progress?.find((p) => p.phase === 'end')?.response, end.response);
    assert.equal((await disk(conv.id)).messages.at(-1)?.content, '第一项确认：7。新回答');
  });

  it('stopping a normal POST preserves only partial text and marks it aborted', async () => {
    reset('partial');
    const conv = await createConversation('default', {});
    await stopAt(conv.id, 'messages', '部分回答');
    const saved = await disk(conv.id);
    assert.deepEqual(saved.messages.map((m) => m.content), ['新问题', '部分回答']);
    assert.equal(saved.messages.at(-1)?.aborted, true);
  });

  it('stopping regenerate replaces the old assistant with the partial answer', async () => {
    reset('partial');
    const id = await seed();
    await stopAt(id, 'regenerate', '部分回答');
    const saved = await disk(id);
    assert.deepEqual(saved.messages.map((m) => m.content), ['问题 Q', '部分回答']);
    assert.equal(saved.messages.at(-1)?.aborted, true);
  });

  it('stopping regenerate before content retains the original answer', async () => {
    reset('empty');
    const id = await seed();
    await stopAt(id, 'regenerate', '"type":"meta"');
    assert.deepEqual((await disk(id)).messages.map((m) => m.content), ['问题 Q', '旧回答 A']);
  });

  it('upstream failure after edit leaves the committed truncated history and confirms discardedCount', async () => {
    reset('failure');
    const id = await seed();
    await appendMessage('default', id, { id: '', role: 'user', content: '后续问题', at: '' });
    await appendMessage('default', id, { id: '', role: 'assistant', content: '后续回答', at: '' });
    const user = (await disk(id)).messages[0];
    const response = await fetch(`${base}/api/chat/conversations/${id}/messages/${user.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '改后的问题' }),
    });
    const events = (await response.text()).split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.slice(6)));
    assert.equal(events[0].type, 'meta');
    assert.equal(events[0].userMessageId, user.id);
    assert.equal(events[0].discardedCount, 3);
    assert.ok(events.some((event) => event.type === 'error'));
    assert.deepEqual((await disk(id)).messages.map((m) => m.content), ['改后的问题']);
    assert.equal(isGenerating(id), false);
  });

  it('fallback upstream failure emits an error without saving a successful assistant', async () => {
    reset('failure');
    const originalConfig = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, `${originalConfig}  supportsTools: false\n`);
    try {
      const conv = await createConversation('default', {});
      const events = (await (await post(conv.id, 'messages', '检索问题')).text())
        .split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.slice(6)));
      assert.ok(events.some((event) => event.type === 'degraded'));
      assert.ok(events.some((event) => event.type === 'error' && event.code === 'LLM_UPSTREAM_ERROR'));
      assert.ok(!events.some((event) => event.type === 'done'));
      assert.deepEqual((await disk(conv.id)).messages.map((m) => m.role), ['user']);
    } finally { fs.writeFileSync(configPath, originalConfig); }
  });

  it('limited scope cannot acknowledge global disclosure; all-scope and local callers can', async () => {
    reset();
    const originalConfig = fs.readFileSync(configPath, 'utf8');
    const unacknowledged = originalConfig.replace('kbDisclosureAck: true', 'kbDisclosureAck: false');
    const acknowledge = () => fetch(`${base}/api/chat/config/ack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ack: true }),
    });
    try {
      fs.writeFileSync(configPath, unacknowledged);
      scopes = ['default'];
      assert.equal((await acknowledge()).status, 403);
      assert.equal(fs.readFileSync(configPath, 'utf8'), unacknowledged);
      scopes = ['all'];
      assert.equal((await acknowledge()).status, 200);
      assert.match(fs.readFileSync(configPath, 'utf8'), /kbDisclosureAck: true/);
      fs.writeFileSync(configPath, unacknowledged);
      scopes = null;
      assert.equal((await acknowledge()).status, 200);
      assert.match(fs.readFileSync(configPath, 'utf8'), /kbDisclosureAck: true/);
    } finally { fs.writeFileSync(configPath, originalConfig); }
  });

  it('limited scope tokens cannot modify global prompts; local and all-scope callers can', async () => {
    reset();
    const cfg = defaultPromptConfig();
    const put = () => fetch(`${base}/api/chat/prompt-config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    scopes = ['default'];
    assert.equal((await put()).status, 403);
    assert.equal(fs.existsSync(path.join(temporaryRoot, 'chat/prompt-config.json')), false);
    scopes = ['all'];
    assert.equal((await put()).status, 200);
    scopes = null;
    assert.equal((await put()).status, 200);
  });
});
