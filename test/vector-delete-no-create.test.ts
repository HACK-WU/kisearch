/**
 * vector-delete-no-create.test.ts —— 删除不得为不存在的 collection 创建空库（REQ-20261117-001）
 *
 * 背景：`vectorDelete` 走 `withEngine` → `getEngine` 的 create 自愈，会为一个从未初始化的
 * scope **建出空库并登记常驻句柄**（实测：删除前 `collections/<scope>` 不存在 → 删除后 5 项）。
 * 写/检索需要这条自愈；删除不需要，且空库一旦建出，`scopeCollectionExists` 从此返回 true，
 * 「从未初始化」这一事实被永久掩盖。
 *
 * 本用例走真实文件系统（判据是模块内私有函数，无法从外部 mock），断言四件事：
 *   ① 返回语义仍正确（deleted 0 + notFoundIds 含入参 id）
 *   ② 空库**没有被创建**
 *   ③ 目录里只有非集合文件时**不算有库**（否则会进引擎、被 probe 误判 locked，白重试 6s 并报错误信息）
 *   ④ 同源的 `vectorDeleteScope` 口径一致
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/vector-delete-no-create.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { loadConfig } from '../src/lib/config.js';
import { getCollectionsRoot, getScopeCollectionPath } from '../src/lib/scope-collection.js';
import { vectorDelete, vectorDeleteScope, scopeCollectionExists } from '../src/lib/vector-client.js';

const scope = `vd-nocreate-${Date.now()}`;
const junkScope = `vd-junk-${Date.now()}`;
let dbPath = '';
let junkDbPath = '';

before(() => {
  for (const s of [scope, junkScope]) registerTestScope(s);
  const config = loadConfig();
  dbPath = getScopeCollectionPath(config, scope);
  junkDbPath = getScopeCollectionPath(config, junkScope);
  // 前置：确认这是一个从未初始化过的 scope（否则用例失去意义）
  assert.equal(fs.existsSync(dbPath), false, `前置失败：${dbPath} 已存在，请换 scope 名`);
  assert.equal(scopeCollectionExists(scope), false);
});

after(() => {
  // 用例失败时可能已经把空库建出来了：清理掉，避免污染本机向量目录
  const root = getCollectionsRoot(loadConfig());
  for (const p of [dbPath, junkDbPath, `${root}/${scope}`, `${root}/${junkScope}`]) {
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

describe('vectorDelete · 目录存在但不是集合', () => {
  it('只有无关文件的目录 → 不算有库，删除不触发引擎（不报「被占用」）', async () => {
    fs.mkdirSync(junkDbPath, { recursive: true });
    fs.writeFileSync(path.join(junkDbPath, 'stray.tmp'), 'x');
    // 判据：zvec 布局文件（manifest*/idmap*）不存在 ⇒ 视为无库。
    // 旧实现只看「目录非空」⇒ 判为存在 ⇒ 进引擎 ⇒ probe 3s 超时被判 locked ⇒ 重试 6s 后
    // 报「向量库被其他进程占用或存在崩溃残留」，与真实原因（目录里有个无关文件）完全不符。
    assert.equal(scopeCollectionExists(junkScope), false, '垃圾目录不得被判为「有库」');

    const startedAt = Date.now();
    const missingId = 'b'.repeat(32);
    const result = await vectorDelete({ scope: junkScope, ids: [missingId] });
    const elapsed = Date.now() - startedAt;

    assert.equal(result.deleted, 0);
    assert.deepEqual(result.notFoundIds, [missingId], '按「无库」语义回报，而不是抛锁占用');
    assert.deepEqual(result.errors, []);
    assert.ok(elapsed < 1_000, `不应走引擎重试（实测 ${elapsed}ms；旧实现约 6000ms）`);
    assert.deepEqual(fs.readdirSync(junkDbPath), ['stray.tmp'], '不得改动目录内容');
  });
});

describe('vectorDeleteScope · 判据与 vectorDelete 同源', () => {
  it('库不存在 → { deleted: 0 } 且不建库', async () => {
    const result = await vectorDeleteScope({ scope });
    assert.equal(result.deleted, 0);
    assert.equal(fs.existsSync(dbPath), false, '清理不得创建空库');
  });
});
