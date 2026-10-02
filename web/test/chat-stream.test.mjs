import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');
// Unit boundary: React hooks retain one instance; UI/DOM rendering is covered by the browser journey.
// Actual hook, reducer and SSE parser run unchanged; only event sources / fetch are controlled.
function load(relative, dependencies = {}) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)((id) => dependencies[id] ?? require(id), mod, mod.exports);
  return mod.exports;
}
const hooks = { useCallback: (f) => f, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useEffect: () => {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function setup(events) {
  const { createChatStore } = load('src/chat/chatStore.ts');
  const store = createChatStore();
  const module = load('src/chat/useChatStream.ts', { react: hooks, '@/api/chatApi': { getConversation: async () => { throw new Error('unavailable in this test'); }, ...events }, '@/api/chatContract': { DEGRADED_LABELS: {} } });
  store.dispatch({ type: 'setActiveConv', convId: 'A' });
  return { store, api: module.useChatStream(store), getError: module.getStreamError };
}
const history = () => [
  { id: 'm1', role: 'user', content: 'old question' },
  { id: 'm2', role: 'assistant', content: 'old answer', sources: [{ doc: 'old' }] },
  { id: 'm3', role: 'user', content: 'later question' },
  { id: 'm4', role: 'assistant', content: 'later answer' },
];
describe('chat stream ownership and committed edit state', () => {
  it('rejects stale content, sources and errors after switching to another conversation', async () => {
    const oldGate = deferred(), newGate = deferred();
    const { store, api, getError } = setup({ streamMessage: async function* (id) {
      yield { type: 'meta', messageId: 'm2' };
      if (id === 'A') {
        await oldGate.promise;
        yield { type: 'content', text: 'OLD_A' };
        yield { type: 'sources', sources: [{ doc: 'OLD_A' }] };
        yield { type: 'error', code: 'OLD_ERROR', error: 'late A error' };
      } else {
        await newGate.promise;
        yield { type: 'content', text: 'NEW_B' };
        yield { type: 'done', messageId: 'm2', sources: [] };
      }
    } });
    const a = api.send('A', 'A question'); await tick();
    api.abort(); store.dispatch({ type: 'setActiveConv', convId: 'B' });
    const b = api.send('B', 'B question'); await tick();
    oldGate.resolve(); await a;
    assert.equal(store.getState().streaming.content, '');
    assert.equal(getError('A'), null); assert.equal(getError('B'), null);
    newGate.resolve(); assert.equal(await b, true);
    assert.equal(store.getState().messages.at(-1).content, 'NEW_B');
  });
  it('syncs edited user and truncation on meta even when generation fails', async () => {
    const { store, api, getError } = setup({ streamEditMessage: async function* () {
      yield { type: 'meta', messageId: 'm5', discardedCount: 3 };
      yield { type: 'content', text: 'partial edited answer' };
      yield { type: 'error', code: 'LLM_UPSTREAM_ERROR', error: 'failed' };
    } });
    store.dispatch({ type: 'setMessages', messages: history() });
    assert.equal(await api.editAndResend('A', 'm1', 'new question'), false);
    assert.deepEqual(store.getState().messages.map((m) => m.content), ['new question', 'partial edited answer']);
    assert.equal(getError('A').code, 'LLM_UPSTREAM_ERROR');
  });
  it('does not truncate optimistic history when edit fails before meta', async () => {
    const { store, api } = setup({ streamEditMessage: async function* () { throw new Error('HTTP 409'); } });
    const messages = history(); store.dispatch({ type: 'setMessages', messages });
    await api.editAndResend('A', 'm1', 'new question');
    assert.equal(store.getState().messages, messages);
  });
  it('keeps the old answer if regeneration stops without replacement content', async () => {
    const gate = deferred();
    const { store, api } = setup({ streamRegenerate: async function* () { yield { type: 'meta', messageId: 'm3' }; await gate.promise; } });
    const messages = history().slice(0, 2); store.dispatch({ type: 'setMessages', messages });
    const generation = api.regenerate('A'); await tick(); api.abort(); gate.resolve(); await generation;
    assert.equal(store.getState().messages, messages);
    assert.equal(store.getState().streaming.active, false);
  });
  it('keeps the persisted old reply and labels failed regeneration content as local only', async () => {
    const { store, api } = setup({ streamRegenerate: async function* () {
      yield { type: 'meta', messageId: 'm3' }; yield { type: 'content', text: 'replacement' };
      yield { type: 'error', code: 'LLM_TIMEOUT', error: 'timeout' };
    } });
    store.dispatch({ type: 'setMessages', messages: history().slice(0, 2) });
    await api.regenerate('A');
    assert.equal(store.getState().messages.length, 3);
    assert.equal(store.getState().messages[1].content, 'old answer');
    assert.equal(store.getState().messages.at(-1).content, 'replacement');
    assert.match(store.getState().messages.at(-1).id, /^local-assistant-/);
    assert.equal(store.getState().messages.at(-1).sources, undefined);
  });
  it('does not retain the replaced answer tool summaries when regeneration performs no tools', async () => {
    const { store, api } = setup({ streamRegenerate: async function* () {
      yield { type: 'meta', messageId: 'm3' };
      yield { type: 'content', text: 'new answer without tools' };
      yield { type: 'done', messageId: 'm3', sources: [] };
    } });
    const messages = history().slice(0, 2);
    messages[1].progress = [{ phase: 'start', name: 'old tool' }, { phase: 'end', hits: 1 }];
    store.dispatch({ type: 'setMessages', messages });
    await api.regenerate('A');
    assert.equal(store.getState().messages.at(-1).content, 'new answer without tools');
    assert.equal(store.getState().messages.at(-1).progress, undefined);
    assert.equal(store.getState().messages.at(-1).sources, undefined);
  });
  it('coordinates the accepted optimistic user id without overwriting stream content', async () => {
    const read = deferred(), stream = deferred();
    const { store, api } = setup({
      getConversation: () => read.promise,
      streamMessage: async function* () {
        yield { type: 'meta', messageId: 'm2' };
        yield { type: 'content', text: 'partial' };
        await stream.promise;
        yield { type: 'error', code: 'LLM_TIMEOUT', error: 'timeout' };
      },
    });
    const generation = api.send('A', 'accepted'); await tick();
    read.resolve({ conv: { messages: [{ id: 'm1', role: 'user', content: 'accepted', at: 'server-time' }] } });
    await tick();
    assert.equal(store.getState().messages[0].id, 'm1');
    assert.equal(store.getState().streaming.content, 'partial');
    stream.resolve(); await generation;
    assert.equal(store.getState().messages[0].id, 'm1');
  });
  it('uses the committed user id from meta even if history reads are unavailable', async () => {
    let reads = 0;
    const { store, api } = setup({
      getConversation: async () => { reads++; throw new Error('offline'); },
      streamMessage: async function* () {
        yield { type: 'meta', messageId: 'm2', userMessageId: 'm1' };
        yield { type: 'content', text: 'partial' };
        yield { type: 'error', code: 'LLM_TIMEOUT', error: 'timeout' };
      },
    });
    await api.send('A', 'accepted');
    assert.equal(store.getState().messages[0].id, 'm1');
    assert.equal(store.getState().messages[0].content, 'accepted');
    assert.equal(store.getState().messages.at(-1).content, 'partial');
    assert.equal(reads, 0);
  });
  it('rejects a late accepted-user reconciliation after another conversation is selected', async () => {
    const read = deferred(), stream = deferred();
    const { store, api } = setup({
      getConversation: () => read.promise,
      streamMessage: async function* () { yield { type: 'meta', messageId: 'm2' }; await stream.promise; },
    });
    const generation = api.send('A', 'accepted'); await tick();
    api.abort(); store.dispatch({ type: 'setActiveConv', convId: 'B' });
    read.resolve({ conv: { messages: [{ id: 'm1', role: 'user', content: 'accepted' }] } });
    await tick();
    assert.equal(store.getState().messages.length, 0);
    stream.resolve(); await generation;
  });
  it('does not allow regeneration retry for an unconfirmed rejected send', async () => {
    const { store, api, getError } = setup({ streamMessage: async function* () { throw Object.assign(new Error('HTTP 409'), { status: 409 }); } });
    await api.send('A', 'rejected');
    assert.equal(store.getState().messages.length, 0);
    assert.equal(getError('A').accepted, false);
    assert.equal(getError('A').retryable, false);
  });
  it('keeps a question explicitly unconfirmed when stopped before the server acknowledgement', async () => {
    const gate = deferred();
    const { store, api, getError } = setup({ streamMessage: async function* () { await gate.promise; } });
    const pending = api.send('A', 'possibly committed'); await tick();
    api.abort(); gate.resolve(); await pending;
    assert.equal(store.getState().messages[0].content, 'possibly committed');
    assert.match(store.getState().messages[0].id, /^local-user-/);
    assert.equal(getError('A').code, 'REQUEST_UNCONFIRMED');
    assert.equal(getError('A').retryable, false);
  });
  it('marks a graceful EOF without a terminal event as interrupted', async () => {
    const { store, api, getError } = setup({ streamMessage: async function* () { yield { type: 'meta', messageId: 'm2' }; yield { type: 'content', text: 'partial' }; } });
    assert.equal(await api.send('A', 'question'), false);
    assert.equal(store.getState().messages.at(-1).content, 'partial');
    assert.equal(getError('A').code, 'STREAM_INTERRUPTED');
  });
});

describe('actual SSE parser with controlled HTTP body', () => {
  it('does not emit already buffered frames after abort and cancels the reader', async () => {
    const priorFetch = globalThis.fetch; let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"meta","messageId":"m2"}\n\ndata: {"type":"content","text":"late"}\n\n')); },
      cancel() { cancelled = true; },
    }));
    try {
      const { streamMessage } = load('src/api/chatApi.ts');
      const ctrl = new AbortController(); const iterator = streamMessage('A', 'question', ctrl.signal);
      assert.equal((await iterator.next()).value.type, 'meta'); ctrl.abort();
      assert.equal((await iterator.next()).done, true); assert.equal(cancelled, true);
    } finally { globalThis.fetch = priorFetch; }
  });
});

it('preserves actual tool response text through SSE consumption and stream completion', async () => {
  const response = { text: '{"ok":true,"results":[{"originalExcerpt":"完整正文"}]}', originalChars: 50, truncated: false };
  const { store, api } = setup({ streamMessage: async function* () {
    yield { type: 'meta', messageId: 'm2' };
    yield { type: 'tool_start', name: 'kb_search', mode: 'hybrid', query: 'question' };
    yield { type: 'tool_end', hits: 1, durationMs: 3, response };
    yield { type: 'content', text: 'answer' };
    yield { type: 'done', messageId: 'm2', sources: [] };
  } });
  assert.equal(await api.send('A', 'question'), true);
  assert.deepEqual(store.getState().progressByMessage.m2[1].response, response);
});
