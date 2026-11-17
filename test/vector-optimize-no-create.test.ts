/**
 * vector-optimize-no-create.test.ts —— 索引整理不得为不存在的 collection 创建空库
 *
 * 与 `vector-delete-no-create.test.ts` 同源（REQ-20261117-001 复核时发现）：`optimizeVectorIndex`
 * 同样经 `withEngine` → `getEngine`，对从未初始化的 scope 会**建出一个空库**（实测 5 项：
 * 0/LOCK/del.0/idmap.0/manifest.0）并返回 `ok:true`，把「该 scope 从未初始化」的事实掩盖掉。
 * 整理是辅助动作，没有库 ⇒ 没有可整理的索引 ⇒ 无操作成功即可，不需要自愈建库。
 *
 * 断言四件事：
 *   ① 库不存在 → `skipped:'collection-missing'` 且空库**没有被创建**
 *   ② 守卫不吞真实错误：迁移未完成 / scope 非法仍归一为 degraded，且「不抛错」契约不变
 *   ③ 真实集合仍能正常整理（守卫不误伤），顺带守住 `scopeCollectionExists` 对 zvec
 *      磁盘布局（manifest/idmap）的依赖——布局改名会让它退化成 always-false 的静默 no-op
 *   ④ 本进程已有活句柄时不走 skip（否则 daemon 的向量路径漂移会被当成「从来没建过库」）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/vector-optimize-no-create.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerTestScope, cleanupTestConfig, hasTestEmbeddingKey } from './test-config.js';
import { loadConfig, runWithConfigSnapshot, type KiConfig } from '../src/lib/config.js';
import { getCollectionsRoot, getScopeCollectionPath, getVectorMigrationMarkerPath } from '../src/lib/scope-collection.js';
import { optimizeVectorIndex, scopeCollectionExists, getEngine, closeEngine } from '../src/lib/vector-client.js';

const scope = `vo-nocreate-${Date.now()}`;
const migratingScope = `vo-nocreate-mig-${Date.now()}`;
const liveScope = `vo-existing-${Date.now()}`;
let dbPath = '';
let migratingDbPath = '';
let liveDbPath = '';

before(() => {
  for (const s of [scope, migratingScope, liveScope]) registerTestScope(s);
  const config = loadConfig();
  dbPath = getScopeCollectionPath(config, scope);
  migratingDbPath = getScopeCollectionPath(config, migratingScope);
  liveDbPath = getScopeCollectionPath(config, liveScope);
  // 前置：确认这是一个从未初始化过的 scope（否则用例失去意义）
  assert.equal(fs.existsSync(dbPath), false, `前置失败：${dbPath} 已存在，请换 scope 名`);
  assert.equal(scopeCollectionExists(scope), false);
});

after(async () => {
  await closeEngine().catch(() => {});
  // 用例失败时可能已经把空库建出来了：清理掉，避免污染测试向量目录
  const config = loadConfig();
  const root = getCollectionsRoot(config);
  for (const p of [dbPath, migratingDbPath, liveDbPath, `${root}/${scope}`, `${root}/${migratingScope}`, `${root}/${liveScope}`]) {
    if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  try { fs.rmSync(getVectorMigrationMarkerPath(config, migratingScope), { force: true }); } catch { /* ignore */ }
  cleanupTestConfig();
});

describe('optimizeVectorIndex · 空 collection', () => {
  it('库不存在 → 无操作成功且不创建空库', async () => {
    const outcome = await optimizeVectorIndex(scope, { timeoutMs: 10_000 });

    assert.equal(outcome.ok, true, `整理应视为成功：${JSON.stringify(outcome)}`);
    assert.equal(outcome.ok && outcome.skipped, 'collection-missing', '必须显式标记「没有可整理的索引」');
    // 未触碰引擎 ⇒ 耗时应在毫秒级（不写死 0：定时器/时钟精度会偶尔给 1ms）
    assert.ok((outcome.ok ? outcome.wallMs : Number.NaN) <= 5, `未触碰引擎却有耗时：${JSON.stringify(outcome)}`);

    assert.equal(fs.existsSync(dbPath), false, `整理不得创建空库：${dbPath} 被建出来了`);
    assert.equal(scopeCollectionExists(scope), false, '「从未初始化」的事实不得被掩盖');
  });

  it('迁移未完成 → 归一为 degraded，不建库', async () => {
    const config = loadConfig();
    const marker = getVectorMigrationMarkerPath(config, migratingScope);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ scope: migratingScope }), 'utf-8');

    const outcome = await optimizeVectorIndex(migratingScope, { timeoutMs: 10_000 });

    assert.equal(outcome.ok, false, '迁移中断必须报出来，不能被守卫吞成成功');
    assert.equal(outcome.ok === false && outcome.degraded, 'error');
    assert.match(outcome.ok === false ? outcome.reason : '', /迁移/);
    assert.equal(fs.existsSync(migratingDbPath), false, '迁移中不得建库');

    fs.rmSync(marker, { force: true });
  });

  it('scope 非法 → 不抛错（契约：整理属可失败辅助动作）', async () => {
    const outcome = await optimizeVectorIndex('非法 scope!', { timeoutMs: 5_000 });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.degraded, 'error');
  });
});

describe('optimizeVectorIndex · 已有 collection', () => {
  it('真实集合 → 照常整理，不被守卫误判为「不存在」', { skip: !hasTestEmbeddingKey && '未注入 embedding 密钥' }, async () => {
    await getEngine(liveScope);
    assert.equal(scopeCollectionExists(liveScope), true,
      '真集合必须判为存在（若此断言失败：zvec 磁盘布局改名了，需同步 scopeCollectionExists 的判据）');

    const outcome = await optimizeVectorIndex(liveScope, { timeoutMs: 60_000 });

    assert.equal(outcome.ok, true, `已有库应能正常整理：${JSON.stringify(outcome)}`);
    assert.equal(outcome.ok && outcome.skipped, undefined, '库存在时不得标记 collection-missing');
    assert.equal(fs.existsSync(liveDbPath), true, '整理不应削弱已有库');
    await closeEngine(liveScope);
  });

  it('本进程有活句柄 + 磁盘路径对不上 → 不按「缺库」短路（漂移保护）', { skip: !hasTestEmbeddingKey && '未注入 embedding 密钥' }, async () => {
    await getEngine(liveScope);
    // 用配置快照把 vectorDir 指到一个空目录：模拟「句柄在、配置路径已漂移」。
    // 旧写法只看磁盘 ⇒ 会返回 skipped:'collection-missing'，把漂移静默成「从来没建过库」。
    const emptyVectorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-drift-'));
    const drifted: KiConfig = { ...loadConfig(), vectorDir: emptyVectorDir };
    try {
      const outcome = await runWithConfigSnapshot(drifted, () => optimizeVectorIndex(liveScope, { timeoutMs: 60_000 }));
      assert.equal(outcome.ok && outcome.skipped, undefined,
        `有活句柄时不得短路（否则吞掉 DAEMON_IDENTITY_DRIFT）：${JSON.stringify(outcome)}`);
    } finally {
      fs.rmSync(emptyVectorDir, { recursive: true, force: true });
      await closeEngine(liveScope);
    }
  });
});
