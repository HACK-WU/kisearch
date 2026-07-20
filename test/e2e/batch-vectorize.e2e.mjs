// S-03 端到端：真实调用 bin/mem.mjs store
// 跑此测试前需确保 ~/.config/memory-mcp/config.yaml 有 mcp-test scope。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';

import { vectorizeOne, batchVectorize, deleteMemory } from '../../scripts/lib/batch-vectorize.ts';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// 直接使用全局 mem 命令，无需设置 MEM_PROJECT_ROOT

test('S-03 E2E: 单条 vectorizeOne 写入并能读到 memoryId', () => {
  const r = vectorizeOne(
    {
      path: 's03-e2e/single.md',
      groupPath: 'wiki/s03-e2e',
      summary: 'S-03 e2e single test ' + Date.now(),
      keywords: ['s03', 'e2e'],
      enriched: true,
      memoryId: null,
      action: 'add',
    },
    'mcp-test',
    { timeoutMs: 60_000 }
  );
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.match(r.memoryId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // 写完即清理，避免污染
  const del = deleteMemory(r.memoryId, { timeoutMs: 30_000 });
  assert.equal(del.ok, true, del.ok ? '' : del.error);
});

test('S-03 E2E: batchVectorize 写入 3 条并清理', () => {
  const ts = Date.now();
  const entries = [
    { path: `s03-e2e/${ts}-a.md`, groupPath: 'wiki/s03-e2e', summary: `e2e a ${ts}`, keywords: ['x'], enriched: true, memoryId: null, action: 'add' },
    { path: `s03-e2e/${ts}-b.md`, groupPath: 'wiki/s03-e2e', summary: `e2e b ${ts}`, keywords: ['y'], enriched: true, memoryId: null, action: 'add' },
    { path: `s03-e2e/${ts}-c.md`, groupPath: 'wiki/s03-e2e', summary: `e2e c ${ts}`, keywords: ['z'], enriched: true, memoryId: null, action: 'add' },
  ];
  const r = batchVectorize(entries, 'mcp-test', { timeoutMs: 60_000 });
  assert.equal(r.ok.size, 3, `errors: ${JSON.stringify(r.errors)}`);
  assert.equal(r.errors.length, 0);

  // 清理
  for (const id of r.ok.values()) {
    deleteMemory(id, { timeoutMs: 30_000 });
  }
});
