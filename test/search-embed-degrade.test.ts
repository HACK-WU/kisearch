/**
 * vectorSearch · 查询 embedding 降级与预计算复用（O1 + O3）
 *
 * 契约：
 *   - 可降级错误（超时/网络/429/5xx，nonRetryable !== true）→ FTS-only 检索 + onDegrade 回调，
 *     且降级时跳过 threshold（FTS 分数尺度与混合 RRF 不可比）
 *   - 不可降级错误（4xx / 配置类）→ 原样抛出，不静默降级
 *   - ALS 预计算向量命中 → 不调用 provider.embed（embedding 已移出占用窗口）
 *   - ALS 预计算失败标记 → 直接降级，不再重复等待
 *
 * 运行：npx jiti test/search-embed-degrade.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ZvecEngine } from '../dist/zvec-engine/index.js';
import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import { ensureVectorLayout, getScopeCollectionPath } from '../src/lib/scope-collection.js';
import { vectorSearch, closeEngine } from '../src/lib/vector-client.js';
import { queryVectorCacheKey, runWithPrecomputedQueryVectors } from '../src/lib/query-vector-precompute.js';

const DIM = 4;
const SCOPE = 'team-a';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-embed-degrade-'));
const configPath = path.join(tmpRoot, 'config.yaml');
fs.writeFileSync(
  configPath,
  [
    `dataDir: ${path.join(tmpRoot, 'kb')}`,
    `vectorDir: ${path.join(tmpRoot, 'vector')}`,
    'scopeMode: default',
    'scopes:',
    `  ${SCOPE}: {}`,
    // engine 打开路径会构造 provider 实例（构造要求 apiKey 非空），但测试全程不触发真实请求：
    // 降级用例注入必失败 provider，预计算用例走 ALS 注入向量
    'embedding:',
    '  apiKey: test-key-not-used',
    `  dimension: ${DIM}`,
    '',
  ].join('\n'),
  'utf-8',
);
process.env.KI_CONFIG_PATH = configPath;
resetConfigCache();

/** 模拟可降级错误（provider 抛出的 EmbeddingError，nonRetryable=false） */
class DegradableEmbedError extends Error {
  readonly data = { nonRetryable: false };
  constructor() {
    super('SiliconFlow /embeddings timeout after 2000ms（模拟）');
    this.name = 'EmbeddingError';
  }
}

/** 模拟不可降级错误（4xx，nonRetryable=true） */
class FatalEmbedError extends Error {
  readonly data = { nonRetryable: true };
  constructor() {
    super('HTTP_401 Unauthorized（模拟）');
    this.name = 'EmbeddingError';
  }
}

function providerThrowing(err: Error, counter?: { calls: number }) {
  return {
    dimension: DIM,
    embed: async (): Promise<number[][]> => {
      if (counter) counter.calls += 1;
      throw err;
    },
  };
}

describe('vectorSearch · 查询 embedding 降级与预计算复用', () => {
  before(async () => {
    const config = loadConfig();
    ensureVectorLayout(config);
    const engine = await ZvecEngine.create({
      dbPath: getScopeCollectionPath(config, SCOPE),
      collection: {
        name: 'kisearch',
        denseField: 'dense',
        dimension: DIM,
        metric: 'COSINE',
        scalarFields: [
          { name: 'tag', dataType: 'STRING', indexed: true },
          { name: 'scope', dataType: 'STRING', indexed: true },
          { name: 'group', dataType: 'STRING', indexed: true },
          { name: 'content', dataType: 'STRING' },
        ],
        fts: { field: 'content', tokenizer: 'jieba' },
      },
      embedding: { dimension: DIM, embed: async () => [[0, 0, 0, 0]] },
    });
    await engine.upsert([{
      id: 'doc-1',
      vector: [1, 0, 0, 0],
      fields: { tag: 'ki-search', scope: SCOPE, group: 'G', content: '混合检索的降级路径测试内容' },
    }]);
    await engine.close();
  });

  after(async () => {
    await closeEngine();
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('可降级错误 → FTS-only 检索 + onDegrade 回调 + threshold 跳过', async () => {
    const reasons: string[] = [];
    const counter = { calls: 0 };
    const results = await vectorSearch({
      scopes: [SCOPE],
      query: '降级路径',
      limit: 5,
      // 混合 RRF 分数尺度（~0.01–0.03）下 0.99 会过滤掉一切；降级为 FTS 时必须跳过，
      // 否则"降级可用"会表现为"降级后零结果"。
      threshold: 0.99,
      embeddingProvider: providerThrowing(new DegradableEmbedError(), counter),
      onDegrade: (r) => reasons.push(r),
    });
    assert.equal(counter.calls, 1, '应尝试 embed 一次');
    assert.equal(reasons.length, 1, 'onDegrade 应被调用一次');
    assert.match(reasons[0], /降级/);
    assert.ok(results.length > 0, 'FTS-only 应仍有命中（threshold 被跳过）');
    assert.equal(results[0].memoryId, 'doc-1');
  });

  it('不可降级错误（4xx）→ 原样抛出，不静默降级', async () => {
    await assert.rejects(
      () => vectorSearch({
        scopes: [SCOPE],
        query: '降级路径',
        embeddingProvider: providerThrowing(new FatalEmbedError()),
      }),
      /HTTP_401/,
    );
  });

  it('显式 timeoutMs → 传给 query embedding provider', async () => {
    const observed: number[] = [];
    const provider = {
      dimension: DIM,
      embed: async (_texts: string[], opts?: { timeoutMs?: number }): Promise<number[][]> => {
        observed.push(opts?.timeoutMs ?? -1);
        return [[1, 0, 0, 0]];
      },
    };
    await vectorSearch({
      scopes: [SCOPE],
      query: '显式 timeout',
      limit: 5,
      timeoutMs: 10000,
      embeddingProvider: provider,
    });
    assert.deepEqual(observed, [10000]);
  });

  it('预计算向量命中 → 不调用 provider.embed', async () => {
    const counter = { calls: 0 };
    const results = await runWithPrecomputedQueryVectors(
      new Map([[queryVectorCacheKey('预计算查询', 3000), { kind: 'vector', vector: [1, 0, 0, 0] as number[] }]]),
      () => vectorSearch({
        scopes: [SCOPE],
        query: '预计算查询',
        embeddingProvider: providerThrowing(new Error('不应被调用'), counter),
      }),
    );
    assert.equal(counter.calls, 0, '命中预计算时不得调用 provider');
    assert.ok(results.length > 0);
  });

  it('预计算失败标记 → 直接降级，不再重复等待', async () => {
    const counter = { calls: 0 };
    const reasons: string[] = [];
    const results = await runWithPrecomputedQueryVectors(
      new Map([[queryVectorCacheKey('降级路径', 3000), { kind: 'failed', reason: '预计算失败（模拟）' }]]),
      () => vectorSearch({
        scopes: [SCOPE],
        query: '降级路径',
        embeddingProvider: providerThrowing(new Error('不应被调用'), counter),
        onDegrade: (r) => reasons.push(r),
      }),
    );
    assert.equal(counter.calls, 0, '失败标记命中时不得重复 embed');
    assert.deepEqual(reasons, ['预计算失败（模拟）']);
    assert.ok(results.length > 0, '应走 FTS-only 并返回命中');
  });
});
