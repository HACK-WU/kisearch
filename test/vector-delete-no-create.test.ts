/**
 * vector-delete-no-create.test.ts —— 删除不得为不存在的 collection 创建空库（REQ-20261117-001）
 *
 * 背景：`vectorDelete` 走 `withEngine` → `getEngine` 的 create 自愈，会为一个从未初始化的
 * scope **建出空库并登记常驻句柄**（实测：删除前 `collections/<scope>` 不存在 → 删除后 5 项）。
 * 写/检索需要这条自愈；删除不需要，且空库一旦建出，`scopeCollectionExists` 从此返回 true，
 * 「从未初始化」这一事实被永久掩盖。
 *
 * 本用例走真实文件系统（判据是模块内私有函数，无法从外部 mock），断言两件事：
 *   ① 返回语义仍正确（deleted 0 + notFoundIds 含入参 id）
 *   ② 空库**没有被创建**
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/vector-delete-no-create.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { loadConfig } from '../src/lib/config.js';
import { getCollectionsRoot, getScopeCollectionPath } from '../src/lib/scope-collection.js';
import { vectorDelete, scopeCollectionExists } from '../src/lib/vector-client.js';

const scope = `vd-nocreate-${Date.now()}`;
let dbPath = '';

before(() => {
  registerTestScope(scope);
  const config = loadConfig();
  dbPath = getScopeCollectionPath(config, scope);
  // 前置：确认这是一个从未初始化过的 scope（否则用例失去意义）
  assert.equal(fs.existsSync(dbPath), false, `前置失败：${dbPath} 已存在，请换 scope 名`);
  assert.equal(scopeCollectionExists(scope), false);
});

after(() => {
  // 用例失败时可能已经把空库建出来了：清理掉，避免污染本机向量目录
  const root = getCollectionsRoot(loadConfig());
  for (const p of [dbPath, `${root}/${scope}`]) {
    if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  cleanupTestConfig();
});

describe('vectorDelete · 空 collection', () => {
  it('库不存在 → 返回 notFoundIds 且不创建空库', async () => {
    const missingId = 'a'.repeat(32);
    const result = await vectorDelete({ scope, ids: [missingId] });

    assert.equal(result.deleted, 0, '没有可删的向量');
    assert.equal(result.failed, 0, '「不存在」不是失败');
    assert.deepEqual(result.notFoundIds, [missingId], '按 NOT_FOUND 语义回报，与真实引擎一致');
    assert.deepEqual(result.errors, [], 'NOT_FOUND 被归一，不产生 errors');

    assert.equal(fs.existsSync(dbPath), false, `删除不得创建空库：${dbPath} 被建出来了`);
    assert.equal(scopeCollectionExists(scope), false, '「从未初始化」的事实不得被掩盖');
  });

  it('空 ids 仍走短路（不触碰引擎）', async () => {
    const result = await vectorDelete({ scope, ids: [] });
    assert.equal(result.deleted, 0);
    assert.equal(fs.existsSync(dbPath), false);
  });
});
