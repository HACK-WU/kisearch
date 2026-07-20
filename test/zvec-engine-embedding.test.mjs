/**
 * zvec-engine-embedding.test.mjs —— SiliconFlowProvider（TG-03，TC-REQ-03-01~15）
 *
 * 注入 mock fetch，不触网。重试用 `retry-after: '0'` 使退避即时。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SiliconFlowProvider } from '../dist/zvec-engine/index.js';
import { EmbeddingError, EmbeddingConfigError } from '../dist/zvec-engine/errors.js';

const DIM = 4096;
const V = (n = DIM, fill = 0) => new Array(n).fill(fill);

// ─── mock fetch 工具 ───

function makeResp({ status = 200, data, headers = {}, text = '' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => data ?? {},
    text: async () => text,
  };
}

/** 按序返回响应；item 为 Error 时抛出，为函数时调用 */
function seq(items) {
  let i = 0;
  const calls = { count: 0, inputs: [] };
  const fn = async (url, init) => {
    calls.count++;
    if (init?.body) {
      try { calls.inputs.push(JSON.parse(init.body).input); } catch { calls.inputs.push(null); }
    }
    const item = items[Math.min(i, items.length - 1)];
    i++;
    if (item instanceof Error) throw item;
    if (typeof item === 'function') return item();
    return makeResp(item);
  };
  fn.calls = calls;
  return fn;
}

function okData(texts, fill = 0) {
  return { status: 200, data: { data: texts.map((_, idx) => ({ index: idx, embedding: V(DIM, fill) })) } };
}

// ─── env 管理 ───

const SAVED_KEY = process.env.SILICONFLOW_API_KEY;

test('TC-REQ-03-01: 缺 apiKey（config 与 env 均无）→ EmbeddingConfigError', () => {
  delete process.env.SILICONFLOW_API_KEY;
  assert.throws(
    () => new SiliconFlowProvider({}),
    (e) => e instanceof EmbeddingConfigError && /apiKey missing/.test(e.message),
  );
});

test('TC-REQ-03-02: apiKey 经 env 读取 + 默认 dimension 4096', () => {
  process.env.SILICONFLOW_API_KEY = 'sk-env';
  const p = new SiliconFlowProvider({});
  assert.equal(p.dimension, 4096);
  delete process.env.SILICONFLOW_API_KEY;
});

test('TC-REQ-03-03: baseURL 非 https → EmbeddingConfigError', () => {
  assert.throws(
    () => new SiliconFlowProvider({ apiKey: 'sk', baseURL: 'http://insecure' }),
    (e) => e instanceof EmbeddingConfigError && /https/.test(e.message),
  );
});

test('TC-REQ-03-04: dimension 非正整数 → EmbeddingConfigError', () => {
  for (const d of [0, -1, 1.5]) {
    assert.throws(
      () => new SiliconFlowProvider({ apiKey: 'sk', dimension: d }),
      EmbeddingConfigError,
    );
  }
});

test('TC-REQ-03-05: embed 正常分批 + onProgress 回调', async () => {
  const texts = ['a', 'b', 'c', 'd', 'e'];
  const fetchImpl = async (_url, init) => {
    const input = JSON.parse(init.body).input;
    return makeResp(okData(input));
  };
  const p = new SiliconFlowProvider({ apiKey: 'sk', fetchImpl });
  const progress = [];
  const result = await p.embed(texts, { batchSize: 2, onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(result.length, 5);
  assert.ok(result.every((v) => v.length === DIM));
  assert.deepEqual(progress, [[2, 5], [4, 5], [5, 5]]);
});

test('TC-REQ-03-06: embed 空数组 → 空数组（不调 fetch）', async () => {
  let called = false;
  const p = new SiliconFlowProvider({ apiKey: 'sk', fetchImpl: async () => { called = true; return makeResp(okData(['x'])); } });
  const result = await p.embed([]);
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test('TC-REQ-03-07: 5xx 指数退避重试成功', async () => {
  const f = seq([
    { status: 503, headers: { 'retry-after': '0' }, text: 'err' },
    { status: 503, headers: { 'retry-after': '0' }, text: 'err' },
    okData(['x']),
  ]);
  const p = new SiliconFlowProvider({ apiKey: 'sk', fetchImpl: f });
  const result = await p.embed(['x'], { retries: 3 });
  assert.equal(result.length, 1);
  assert.equal(f.calls.count, 3);
});

test('TC-REQ-03-08: 429 带 Retry-After 优先退避', async () => {
  const f = seq([
    { status: 429, headers: { 'retry-after': '0' }, text: 'rate' },
    okData(['x']),
  ]);
  const p = new SiliconFlowProvider({ apiKey: 'sk', fetchImpl: f });
  const start = Date.now();
  const result = await p.embed(['x'], { retries: 1 });
  const elapsed = Date.now() - start;
  assert.equal(result.length, 1);
  assert.equal(f.calls.count, 2);
  // retry-after:0 → 即时（指数退避会是 1000ms）
  assert.ok(elapsed < 500, `Retry-After:0 应即时重试，elapsed=${elapsed}ms`);
});

test('TC-REQ-03-09: 4xx（非 429）不重试直接抛', async () => {
  const f = seq([{ status: 401, text: 'unauthorized' }]);
  const p = new SiliconFlowProvider({ apiKey: 'sk', fetchImpl: f });
  await assert.rejects(
    () => p.embed(['x'], { retries: 3 }),
    (e) => e instanceof EmbeddingError && e.code === 'HTTP_401' && e.data?.nonRetryable === true,
  );
  assert.equal(f.calls.count, 1, '4xx 不应重试');
});

test('TC-REQ-03-10: 超时 → EmbeddingError(code=TIMEOUT) 可重试', async () => {
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const f = seq([abortErr]);
  const p = new SiliconFlowProvider({ apiKey: 'sk', fetchImpl: f });
  await assert.rejects(
    () => p.embed(['x'], { retries: 0, timeoutMs: 10 }),
    (e) => e instanceof EmbeddingError && e.code === 'TIMEOUT' && e.data?.nonRetryable === false,
  );
  assert.equal(f.calls.count, 1);
});

test('TC-REQ-03-11: 响应维度不符 → EmbeddingError(nonRetryable)', async () => {
  const f = seq([{ status: 200, data: { data: [{ index: 0, embedding: V(2048) }] } }]);
  const p = new SiliconFlowProvider({ apiKey: 'sk', fetchImpl: f });
  await assert.rejects(
    () => p.embed(['x'], { retries: 0 }),
    (e) => e instanceof EmbeddingError && /dimension mismatch/.test(e.message) && e.data?.nonRetryable === true,
  );
});

test('TC-REQ-03-12: 响应 data 数量不符 → EmbeddingError', async () => {
  const f = seq([{ status: 200, data: { data: [{ index: 0, embedding: V() }] } }]);
  const p = new SiliconFlowProvider({ apiKey: 'sk', fetchImpl: f });
  await assert.rejects(
    () => p.embed(['a', 'b', 'c'], { retries: 0 }),
    (e) => e instanceof EmbeddingError && /length mismatch/.test(e.message),
  );
});

test('TC-REQ-03-13: 响应乱序按 index 对齐', async () => {
  // input ['a','b']，响应故意反序：index1→0.2 向量，index0→0.1 向量
  const f = seq([{
    status: 200,
    data: { data: [
      { index: 1, embedding: V(DIM, 0.2) },
      { index: 0, embedding: V(DIM, 0.1) },
    ] },
  }]);
  const p = new SiliconFlowProvider({ apiKey: 'sk', fetchImpl: f });
  const result = await p.embed(['a', 'b']);
  assert.equal(result.length, 2);
  assert.equal(result[0][0], 0.1, 'result[0] 应对齐 a（index0）');
  assert.equal(result[1][0], 0.2, 'result[1] 应对齐 b（index1）');
});

test('TC-REQ-03-14: 网络错误（fetch reject）→ EmbeddingError(NETWORK) 可重试', async () => {
  const f = seq([new TypeError('fetch failed')]);
  const p = new SiliconFlowProvider({ apiKey: 'sk', fetchImpl: f });
  await assert.rejects(
    () => p.embed(['x'], { retries: 0 }),
    (e) => e instanceof EmbeddingError && e.code === 'NETWORK' && e.data?.nonRetryable === false,
  );
  assert.equal(f.calls.count, 1);
});

test('TC-REQ-03-15: Retry-After HTTP 日期格式', async () => {
  // HTTP 日期为秒级粒度（toUTCString 截断毫秒），故用 +2500ms 使截断后的秒仍约 2s 在未来。
  // 日期分支 backoff ≈ 2000ms，指数退避 = 1000ms；以 elapsed > 1500ms 区分二者。
  const f = seq([
    () => makeResp({
      status: 429,
      headers: { 'retry-after': new Date(Date.now() + 2500).toUTCString() },
      text: 'rate',
    }),
    okData(['x']),
  ]);
  const p = new SiliconFlowProvider({ apiKey: 'sk', fetchImpl: f });
  const start = Date.now();
  const result = await p.embed(['x'], { retries: 1 });
  const elapsed = Date.now() - start;
  assert.equal(result.length, 1);
  assert.equal(f.calls.count, 2);
  assert.ok(elapsed > 1500, `HTTP 日期分支 backoff 应 > 1500ms（区别于指数 1000ms），elapsed=${elapsed}ms`);
  assert.ok(elapsed < 4000, `backoff 不应过大，elapsed=${elapsed}ms`);
});

// 恢复 env
after(() => {
  if (SAVED_KEY !== undefined) process.env.SILICONFLOW_API_KEY = SAVED_KEY;
  else delete process.env.SILICONFLOW_API_KEY;
});
