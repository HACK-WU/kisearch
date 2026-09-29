import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const tempRoot = path.join(process.cwd(), 'temp');
fs.mkdirSync(tempRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tempRoot, 'fulltext-dimension-mismatch-'));
const scope = 'fulltext-dimension-test';
const configPath = path.join(root, 'config.json');
const config = {
  dataDir: path.join(root, 'kb'),
  backupDir: path.join(root, 'backup'),
  vectorDir: path.join(root, 'vectors'),
  scopeMode: 'default',
  scopes: { [scope]: {} },
  embedding: {
    provider: 'siliconflow',
    baseURL: 'https://example.invalid/v1',
    model: 'dimension-test-model',
    apiKey: 'test-key',
    dimension: 4,
  },
};
fs.writeFileSync(configPath, JSON.stringify(config));
process.env.KI_CONFIG_PATH = configPath;

const { ZvecEngine } = await import('../dist/zvec-engine/index.js');
const { loadConfig } = await import('../src/lib/config.js');
const { getScopeCollectionPath } = await import('../src/lib/scope-collection.js');
const { closeEngine, fullTextSearch, vectorSearch } = await import('../src/lib/vector-client.js');
const { closeFtsEngine, ftsBulkStore } = await import('../src/lib/fts-client.js');

const embedding = (dimension: number) => ({
  dimension,
  async embed(texts: string[]) {
    return texts.map(() => Array.from({ length: dimension }, (_, index) => (index + 1) / dimension));
  },
});

test('全文检索可读取维度不匹配的 hybrid Collection，dense 检索仍拒绝不匹配向量', async () => {
  const dbPath = getScopeCollectionPath(loadConfig(), scope);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const engine = await ZvecEngine.create({
    dbPath,
    collection: {
      name: 'kisearch',
      denseField: 'dense',
      dimension: 4,
      metric: 'COSINE',
      scalarFields: [
        { name: 'tag', dataType: 'STRING', indexed: true },
        { name: 'scope', dataType: 'STRING', indexed: true },
        { name: 'group', dataType: 'STRING', indexed: true },
        { name: 'content', dataType: 'STRING' },
      ],
      fts: { field: 'content', tokenizer: 'jieba' },
    },
    embedding: embedding(4),
  });
  try {
    const stored = await engine.upsert([{
      id: 'dense-doc',
      text: 'Kafka consumer rebalance offset handling',
      vector: [0.1, 0.2, 0.3, 0.4],
      fields: { tag: 'ki-search', scope, group: 'docs/kafka' },
    }]);
    assert.equal(stored.ok, 1);
  } finally {
    await engine.close();
  }
  await ftsBulkStore([{
    text: 'Kafka rebalance recovery from the independent full-text index',
    scope,
    group: 'docs/kafka',
    relation: 'fulltext recovery',
    tag: 'ki-search',
  }]);

  config.embedding.dimension = 8;
  fs.writeFileSync(configPath, JSON.stringify(config));
  try {
    const hits = await fullTextSearch({ scope, query: 'Kafka rebalance', limit: 5, tags: 'ki-search' });
    assert.ok(hits.some((hit) => hit.memoryId === 'dense-doc' && hit.indexType === 'dense'));
    assert.ok(
      hits.some((hit) => hit.indexType === 'fts' && hit.content.includes('independent full-text index')),
      '维度不匹配时仍应返回独立 FTS-only Collection 的结果',
    );

    await assert.rejects(
      () => vectorSearch({ scope, query: 'Kafka rebalance', limit: 5, embeddingProvider: embedding(8) }),
      /vector dimension mismatch|embedding\.dimension \(8\) !== persisted dimension \(4\)/,
    );

    await closeEngine(scope);
    let embedCalls = 0;
    const writeEngine = await ZvecEngine.open({
      dbPath: getScopeCollectionPath(loadConfig(), scope),
      collectionName: 'kisearch',
      embedding: {
        dimension: 8,
        async embed(texts: string[]) {
          embedCalls++;
          return texts.map(() => Array.from({ length: 8 }, () => 0.125));
        },
      },
    });
    try {
      await assert.rejects(
        () => writeEngine.upsert([{ id: 'mismatched-write', text: 'do not embed or persist' }]),
        /embedding\.dimension \(8\) !== persisted dimension \(4\)/,
      );
      assert.equal(embedCalls, 0, '维度不匹配时应在调用 embedding provider 前失败');
    } finally {
      await writeEngine.close();
    }
  } finally {
    await closeEngine(scope);
    await closeFtsEngine(scope);
  }
});
