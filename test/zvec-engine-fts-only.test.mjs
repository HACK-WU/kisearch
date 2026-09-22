/**
 * FTS-only Engine 回归：无 dense schema、无 embedding、写入/检索/删除/重开。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZvecEngine } from '../dist/zvec-engine/index.js';

function makeConfig(dbPath) {
  return {
    dbPath,
    collection: {
      name: 'fts_only_test',
      scalarFields: [
        { name: 'content', dataType: 'STRING' },
        { name: 'scope', dataType: 'STRING', indexed: true },
        { name: 'group', dataType: 'STRING', indexed: true },
      ],
      fts: { field: 'content', tokenizer: 'jieba' },
    },
  };
}

test('FTS-only Engine：无 embedding 写入、FTS 查询、删除和重开', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zvec-fts-only-'));
  const dbPath = join(root, 'collection');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const engine = await ZvecEngine.create(makeConfig(dbPath));
  const write = await engine.upsert([
    { id: 'doc-1', text: 'Kafka consumer offset commit', fields: { scope: 'demo', group: 'messaging' } },
    { id: 'doc-2', text: 'Zvec FTS-only BM25 search', fields: { scope: 'demo', group: 'search' } },
  ]);
  assert.equal(write.ok, 2);
  assert.equal((await engine.info()).dimension, undefined);

  const hits = await engine.ftsSearch({
    match: 'Kafka',
    filter: { field: 'scope', op: '==', value: 'demo' },
    topk: 5,
  });
  assert.deepEqual(hits.map((hit) => hit.id), ['doc-1']);
  assert.equal(hits[0].queryType, 'fts');

  await engine.close();
  const reopened = await ZvecEngine.open({ dbPath, collectionName: 'fts_only_test' });
  assert.deepEqual(
    (await reopened.ftsSearch({ match: 'BM25', topk: 5 })).map((hit) => hit.id),
    ['doc-2'],
  );
  const deleted = await reopened.delete(['doc-2']);
  assert.equal(deleted.ok, 1);
  assert.equal((await reopened.ftsSearch({ match: 'BM25', topk: 5 })).length, 0);
  await reopened.close();
});
