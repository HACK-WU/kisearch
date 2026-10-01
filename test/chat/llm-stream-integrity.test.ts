/** 流完整性与错误体取消：真实本地 HTTP 上游，完全不读用户配置或访问外网。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { streamChat, LlmTimeoutError, LlmUpstreamError, ToolsUnsupportedError, type LlmStreamPart, type StreamChatOptions } from '../../src/lib/chat/llm-client.js';

const frame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;
const content = (text: string, finish?: string) => ({ choices: [{ delta: { content: text }, ...(finish ? { finish_reason: finish } : {}) }] });
async function withUpstream(run: (res: ServerResponse) => void, check: (llm: NonNullable<StreamChatOptions['llm']>) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => { req.resume(); run(res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await check({ baseURL: `http://127.0.0.1:${port}`, apiKey: 'mock-key', model: 'mock-model' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
async function collect(llm: NonNullable<StreamChatOptions['llm']>, opts: StreamChatOptions = {}): Promise<LlmStreamPart[]> {
  const events: LlmStreamPart[] = [];
  for await (const event of streamChat([{ role: 'user', content: 'hello' }], { firstByteTimeoutMs: 1000, requestTimeoutMs: 1000, ...opts, llm })) events.push(event);
  return events;
}
function sse(res: ServerResponse): void { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); }

describe('LLM stream integrity', () => {
  it('keeps content, reasoning, usage and fragmented tool_calls with a valid terminal', async () => {
    await withUpstream((res) => {
      sse(res);
      res.write(frame({ choices: [{ delta: { reasoning_content: 'think', content: '答', tool_calls: [{ index: 0, id: 'call-1', function: { name: 'ki_search', arguments: '{"query":' } }] } }] }));
      res.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] }));
      res.end(frame({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 } } }) + 'data: [DONE]\n\n');
    }, async (llm) => {
      assert.deepEqual(await collect(llm), [
        { type: 'reasoning', text: 'think' }, { type: 'content', text: '答' },
        { type: 'tool_calls', calls: [{ id: 'call-1', name: 'ki_search', arguments: '{"query":"x"}' }] },
        { type: 'usage', promptTokens: 2, completionTokens: 3, reasoningTokens: 1 },
        { type: 'done', finishReason: 'tool_calls' },
      ]);
    });
  });
  it('accepts finish_reason without DONE and flushes a terminal tail frame and split UTF-8', async () => {
    await withUpstream((res) => {
      sse(res);
      const payload = Buffer.from(frame(content('图片🙂', 'stop')).trimEnd());
      const split = payload.indexOf(Buffer.from('🙂')) + 2;
      res.write(payload.subarray(0, split));
      res.end(payload.subarray(split));
    }, async (llm) => {
      assert.deepEqual(await collect(llm), [{ type: 'content', text: '图片🙂' }, { type: 'done', finishReason: 'stop' }]);
    });
  });
  it('accepts DONE without finish_reason, including CRLF framing', async () => {
    await withUpstream((res) => { sse(res); res.end(frame(content('ok')).replace(/\n/g, '\r\n') + 'data: [DONE]\r\n\r\n'); }, async (llm) => {
      assert.deepEqual(await collect(llm), [{ type: 'content', text: 'ok' }, { type: 'done', finishReason: 'stop' }]);
    });
  });
  it('rejects premature EOF and never emits done for partial output', async () => {
    await withUpstream((res) => { sse(res); res.end(frame(content('half answer'))); }, async (llm) => {
      const events: LlmStreamPart[] = [];
      await assert.rejects(async () => { for await (const event of streamChat([], { llm })) events.push(event); }, LlmUpstreamError);
      assert.deepEqual(events, [{ type: 'content', text: 'half answer' }]);
    });
  });
  it('rejects a malformed tail frame with no terminal instead of silently completing', async () => {
    await withUpstream((res) => { sse(res); res.end(frame(content('partial')) + 'data: {"choices":'); }, async (llm) => {
      await assert.rejects(collect(llm), (err: unknown) => err instanceof LlmUpstreamError && /提前结束/.test(err.message));
    });
  });
  it('keeps ordinary completed HTTP errors mapped to their existing retry behavior', async () => {
    await withUpstream((res) => { res.writeHead(401); res.end('invalid credentials'); }, async (llm) => {
      await assert.rejects(collect(llm), (err: unknown) => err instanceof LlmUpstreamError && err.retryable === false && /401/.test(err.message));
    });
  });
  it('rejects empty EOF', async () => {
    await withUpstream((res) => { sse(res); res.end(); }, async (llm) => { await assert.rejects(collect(llm), LlmUpstreamError); });
  });
  it('rejects an explicit SSE error even after content or finish_reason', async () => {
    await withUpstream((res) => { sse(res); res.end(frame(content('half', 'stop')) + frame({ error: { message: 'model overloaded' } })); }, async (llm) => {
      await assert.rejects(collect(llm), (err: unknown) => err instanceof LlmUpstreamError && /model overloaded/.test(err.message));
    });
  });
  it('recognizes unsupported tools in an SSE error for the existing fallback', async () => {
    await withUpstream((res) => { sse(res); res.end(frame({ error: { message: 'tools not supported' } })); }, async (llm) => {
      await assert.rejects(collect(llm), ToolsUnsupportedError);
    });
  });
  it('rejects HTTP 200 JSON error bodies rather than completing an empty answer', async () => {
    await withUpstream((res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"model overloaded"}}'); }, async (llm) => {
      await assert.rejects(collect(llm), (err: unknown) => err instanceof LlmUpstreamError && /model overloaded/.test(err.message));
    });
  });
  it('keeps the deadline active while reading a hanging 429 body', async () => {
    await withUpstream((res) => { res.writeHead(429); res.write('{"error":'); }, async (llm) => {
      await assert.rejects(collect(llm, { requestTimeoutMs: 80, firstByteTimeoutMs: 30 }), (err: unknown) => err instanceof LlmTimeoutError && err.phase === 'overall');
    });
  });
  it('lets the user cancel a hanging 429 body before the deadline', async () => {
    await withUpstream((res) => { res.writeHead(429); res.write('{"error":'); }, async (llm) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 40);
      try { assert.deepEqual(await collect(llm, { signal: controller.signal }), []); } finally { clearTimeout(timer); }
    });
  });
  it('caps error body reads even when the upstream never closes the response', async () => {
    await withUpstream((res) => { res.writeHead(500); res.write('x'.repeat(32768)); }, async (llm) => {
      await assert.rejects(collect(llm), LlmUpstreamError);
    });
  });
  it('cancels and unlocks the response when a consumer stops after the first content', async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame(content('partial')))); },
      cancel() { cancelled = true; },
    });
    globalThis.fetch = async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    try {
      for await (const event of streamChat([], { llm: { baseURL: 'http://mock.local', apiKey: 'mock', model: 'mock' } })) {
        assert.equal(event.type, 'content');
        break;
      }
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
    } finally { globalThis.fetch = originalFetch; }
  });
  it('cancels and unlocks the response when DONE arrives before network EOF', async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); },
      cancel() { cancelled = true; },
    });
    globalThis.fetch = async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    try {
      assert.deepEqual(await collect({ baseURL: 'http://mock.local', apiKey: 'mock', model: 'mock' }), [{ type: 'done', finishReason: 'stop' }]);
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
    } finally { globalThis.fetch = originalFetch; }
  });
});
