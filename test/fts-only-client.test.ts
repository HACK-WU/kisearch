import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(process.cwd(), 'temp', 'fts-only-client-'));
const configPath = path.join(root, 'config.json');
const vectorDir = path.join(root, 'vectors');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir: path.join(root, 'kb'),
  backupDir: path.join(root, 'backup'),
  vectorDir,
  scopeMode: 'default',
  scopes: { 'fts-client-test': {} },
  embedding: {
    provider: 'siliconflow',
    baseURL: 'https://example.invalid/v1',
    model: 'unused-in-fts-only-test',
    dimension: 4,
    queryTimeoutMs: 100,
  },
}));
process.env.KI_CONFIG_PATH = configPath;

const { ftsBulkStore, ftsDeleteByIds, ftsDeleteByFilter, ftsSearch, closeFtsEngine } = await import('../src/lib/fts-client.js');
const { fullTextSearch } = await import('../src/lib/vector-client.js');
const { rebuildFtsOnlyScope } = await import('../src/lib/fts-rebuild.js');

test('FTS-only client writes/searches/reopens/deletes without embedding', async () => {
  const scope = 'fts-client-test';
  const entries = [
    { scope, group: 'docs/kafka', relation: 'consumer', text: 'Kafka consumer offset commit and rebalance', tag: 'ki-search' },
    { scope, group: 'docs/http', relation: 'gateway', text: 'HTTP gateway timeout and retry policy', tag: 'ki-search' },
  ];

  const stored = await ftsBulkStore(entries);
  assert.equal(stored.failed, 0);
  assert.equal(stored.ids.length, 2);

  const direct = await ftsSearch({ scope, query: 'Kafka rebalance', limit: 5 });
  assert.equal(direct[0]?.relation, 'consumer');
  assert.match(direct[0]?.content ?? '', /Kafka/);

  const publicSearch = await fullTextSearch({ scope, query: 'Kafka rebalance', limit: 5 });
  assert.equal(publicSearch[0]?.memoryId, stored.ids[0]);
  assert.equal(publicSearch[0]?.indexType, 'fts');
  assert.equal(publicSearch[0]?.ftsId, stored.ids[0]);
  assert.equal(publicSearch[0]?.group, 'docs/kafka');

  await closeFtsEngine(scope);
  const reopened = await ftsSearch({ scope, query: 'HTTP retry', limit: 5 });
  assert.equal(reopened[0]?.relation, 'gateway');

  // 模拟快照恢复：只有 KB + relations-cache，没有 vectorDir 中的 FTS 数据时，
  // 仍可从 local KB 重建全文索引，且不需要 embedding 配置。
  const scopeDir = path.join(root, 'kb', scope);
  const groupDir = path.join(scopeDir, 'docs', 'recovered');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'index.json'), JSON.stringify({ recovered: '恢复后的 Kafka offset 文档' }));
  fs.writeFileSync(path.join(scopeDir, 'relations-cache.json'), JSON.stringify({
    groups: { 'docs/recovered': { hot_relations: [{ text: 'recovered', memoryIds: [], memoryId: 'stale-dense-id' }] } },
  }));
  const rebuilt = await rebuildFtsOnlyScope(scope);
  assert.equal(rebuilt.errors.length, 0);
  assert.ok(rebuilt.indexed > 0);
  assert.equal((await ftsSearch({ scope, query: '恢复 Kafka', limit: 5 }))[0]?.relation, 'recovered');

  const deleted = await ftsDeleteByIds({ scope, ids: stored.ids });
  assert.equal(deleted.failed, 0);
  assert.equal((await ftsSearch({ scope, query: 'rebalance', limit: 5 })).length, 0);
  await ftsDeleteByFilter({ scope });
  await closeFtsEngine(scope);
});
