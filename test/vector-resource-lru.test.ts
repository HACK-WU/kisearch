/**
 * 阶段 3：Vector Resource LRU 回归。
 *
 * 使用真实 zvec worker + 本地 mock embedding，不触网，验证：
 *   - maxOpenCollections=1 时两个 scope 并发首次打开不会在串行队列内自等待；
 *   - LRU 只保留一个 ready handle；
 *   - 被释放的 scope 重新打开后仍能检索到原数据。
 *
 * 运行：npx jiti test/vector-resource-lru.test.ts
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-resource-lru-'));
const configPath = path.join(root, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir: path.join(root, 'kb'),
  vectorDir: path.join(root, 'vector'),
  backupDir: path.join(root, 'backup'),
  vector: { maxOpenCollections: 1 },
  embedding: {
    provider: 'siliconflow',
    baseURL: 'https://mock.invalid/v1',
    model: 'mock',
    dimension: 4096,
    apiKey: 'test-key',
  },
  scopes: { alpha: {}, beta: {} },
}));
process.env.KI_CONFIG_PATH = configPath;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
  const input = body.input ?? [];
  return new Response(JSON.stringify({
    data: input.map((_, index) => ({ index, embedding: [1, ...new Array(4095).fill(0)] })),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const vectorClient = await import('../src/lib/vector-client.js');
const { vectorStore, vectorSearch, closeEngine, getVectorResourceMetrics } = vectorClient;

describe('阶段 3 · Collection 资源 LRU', () => {
  after(async () => {
    await closeEngine();
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('上限 1 下并发首次打开不自等待，释放后重开检索正确', async () => {
    const stored = await Promise.all([
      vectorStore({ scope: 'alpha', text: 'alpha resource item' }),
      vectorStore({ scope: 'beta', text: 'beta resource item' }),
    ]);
    assert.equal(stored.length, 2);

    const afterConcurrentOpen = getVectorResourceMetrics();
    assert.ok(afterConcurrentOpen.peakOpenCount <= 1, JSON.stringify(afterConcurrentOpen));
    assert.ok(afterConcurrentOpen.opened >= 2, JSON.stringify(afterConcurrentOpen));
    assert.ok(afterConcurrentOpen.closed >= 1, JSON.stringify(afterConcurrentOpen));

    const alpha = await vectorSearch({ scope: 'alpha', query: 'alpha resource item', limit: 1 });
    assert.equal(alpha.length, 1);
    assert.match(alpha[0].content, /alpha resource item/);

    const afterReopen = getVectorResourceMetrics();
    assert.ok(afterReopen.peakOpenCount <= 1, JSON.stringify(afterReopen));
    assert.ok(afterReopen.opened >= 3, JSON.stringify(afterReopen));
    assert.ok(afterReopen.closed >= 2, JSON.stringify(afterReopen));
  });
});
