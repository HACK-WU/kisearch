/**
 * 跨维度向量迁移回归（embedding.dimension 变更后重建 Collection schema）
 *
 * 背景：向量集合按创建时的 embedding 维度持久化。配置维度改了（如 4096 → 1024）后，
 * 旧集合无法直接写入新维度向量，必须在"保留旧数据 + 可回退"的前提下换 schema。
 *
 * 覆盖：
 *   A. 未确认（缺 --yes）时拒绝迁移，旧集合与 relations-cache 原样保留
 *   B. 向量化导入在写 KB 前被拒绝，并给出可执行的迁移命令
 *   C. --yes 全量重建：新维度集合切换成功，旧集合留在 migration-backups
 *   D. 迁移中途 embedding 失败：旧集合与缓存不变，暂存目录清理，不留事务标记
 *   E. 切换窗口崩溃（事务标记残留）：读写与导入一律拦截；重跑 --yes 自动回退后完成迁移
 *   F. 迁移来源 KB 非法（index.json 值非文本）：拒绝迁移，不动旧集合
 *   G. live 集合缺失但存在旧集合备份：禁止误建空库
 *
 * 运行：npx jiti test/vector-dimension-migration.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const tempRoot = path.join(process.cwd(), 'temp');
fs.mkdirSync(tempRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(tempRoot, 'vector-dimension-migration-'));

const OLD_DIMENSION = 4;
const NEW_DIMENSION = 8;
/** 手工构造中断现场时使用的固定 migrationId（getVectorMigrationPaths 要求 UUID 形态） */
const STUB_MIGRATION_ID = '11111111-1111-1111-8111-111111111111';
/** 迁移期间 embedding 服务故障开关（D 场景用） */
let failEmbedding = false;

const { ZvecEngine } = await import('../dist/zvec-engine/index.js');
const { loadConfig, resetConfigCache } = await import('../src/lib/config.js');
const { getScopeCollectionPath, getVectorMigrationPaths } = await import('../src/lib/scope-collection.js');
const { closeEngine, fullTextSearch, getVectorDimensionStatus, vectorSearch } = await import('../src/lib/vector-client.js');
const { rebuildScopeVectors } = await import('../src/lib/rebuild-vector.js');
const { handleDirectImport } = await import('../src/lib/import.js');

const collectionSchema = (dimension: number) => ({
  name: 'kisearch',
  denseField: 'dense',
  dimension,
  metric: 'COSINE' as const,
  scalarFields: [
    { name: 'tag', dataType: 'STRING' as const, indexed: true },
    { name: 'scope', dataType: 'STRING' as const, indexed: true },
    { name: 'group', dataType: 'STRING' as const, indexed: true },
    { name: 'content', dataType: 'STRING' as const },
  ],
  fts: { field: 'content', tokenizer: 'jieba' },
});

/** 建一个"按旧维度持久化"的 scope：KB + relations-cache + 旧维度集合（含 1 条 legacy 向量）。 */
async function makeOldScope(scope: string): Promise<string> {
  const config = loadConfig();
  const scopeDir = path.join(config.dataDir, scope);
  fs.mkdirSync(path.join(scopeDir, 'docs'), { recursive: true });
  const cachePath = path.join(scopeDir, 'relations-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    groups: { docs: { hot_relations: [{ text: 'topic', memoryId: 'legacy', memoryIds: ['legacy'] }] } },
  }));
  fs.writeFileSync(path.join(scopeDir, 'docs', 'index.json'), JSON.stringify({ topic: 'dimension migration sample' }));

  const dbPath = getScopeCollectionPath(config, scope);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const engine = await ZvecEngine.create({
    dbPath,
    collection: collectionSchema(OLD_DIMENSION),
    embedding: { dimension: OLD_DIMENSION, async embed(texts: string[]) { return texts.map(() => [1, 0, 0, 0]); } },
  });
  try {
    const result = await engine.upsert([{ id: 'legacy', text: 'legacy content', vector: [1, 0, 0, 0], fields: { tag: 'ki-search', scope } }]);
    assert.equal(result.ok, 1);
  } finally {
    await engine.close();
  }
  return cachePath;
}

/** 在暂存目录建一个新维度集合，用于手工构造"切换窗口崩溃"的现场。 */
async function makeStagedCollection(scope: string): Promise<void> {
  const paths = getVectorMigrationPaths(loadConfig(), scope, STUB_MIGRATION_ID);
  fs.mkdirSync(path.dirname(paths.stageCollectionPath), { recursive: true });
  const engine = await ZvecEngine.create({
    dbPath: paths.stageCollectionPath,
    collection: collectionSchema(NEW_DIMENSION),
    embedding: {
      dimension: NEW_DIMENSION,
      async embed(texts: string[]) { return texts.map(() => Array(NEW_DIMENSION).fill(0)); },
    },
  });
  await engine.close();
}

const configPath = path.join(root, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  dataDir: path.join(root, 'kb'),
  vectorDir: path.join(root, 'vector'),
  backupDir: path.join(root, 'backup'),
  scopeMode: 'default',
  scopes: {
    migration_refused: {}, migration_success: {}, migration_failure: {},
    migration_interrupted: {}, migration_bad_source: {},
  },
  embedding: {
    provider: 'siliconflow',
    baseURL: 'https://embedding.test/v1',
    model: 'test',
    apiKey: 'test-key',
    dimension: NEW_DIMENSION,
  },
}));
process.env.KI_CONFIG_PATH = configPath;
resetConfigCache();

const originalFetch = globalThis.fetch;
const originalDaemonOwner = process.env.KI_DAEMON_OWNER;
// daemon owner 标记让 getEngine 走 dbPath 漂移校验分支，贴近真实迁移运行环境
process.env.KI_DAEMON_OWNER = '1';
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), 'https://embedding.test/v1/embeddings');
  const body = JSON.parse(String(init?.body)) as { input: string[] };
  assert.ok(Array.isArray(body.input));
  if (failEmbedding) return new Response('embedding unavailable', { status: 400 });
  return Response.json({
    data: body.input.map((_, index) => ({
      index,
      embedding: Array.from({ length: NEW_DIMENSION }, (_, i) => (i === 0 ? 1 : 0)),
    })),
  });
};

test(
  '跨维度迁移：确认门、成功切换、失败保留、中断回退与来源校验',
  { timeout: 120_000 },
  async () => {
    try {
      // ── A/B：未确认时拒绝，且导入入口在写 KB 前就被拦下 ──
      const refusedCache = await makeOldScope('migration_refused');
      const refusedBefore = fs.readFileSync(refusedCache, 'utf8');
      const refused = await rebuildScopeVectors('migration_refused');
      assert.equal(refused.ok, false);
      assert.match(refused.errors[0]?.error ?? '', /--yes/);
      assert.equal(fs.readFileSync(refusedCache, 'utf8'), refusedBefore, '未确认时不得改 relations-cache');
      assert.equal((await getVectorDimensionStatus('migration_refused')).persisted, OLD_DIMENSION);

      const sourceDir = path.join(root, 'new-import');
      fs.mkdirSync(sourceDir);
      fs.writeFileSync(path.join(sourceDir, 'new.md'), 'new content');
      await assert.rejects(
        handleDirectImport({ scope: 'migration_refused', sourceDir, group: 'docs', vector: true }),
        /--rebuild-vector --yes/,
        '向量化导入应给出可执行的迁移命令',
      );
      assert.equal(fs.readFileSync(refusedCache, 'utf8'), refusedBefore, '导入被拒后缓存应原样');
      const refusedIndex = JSON.parse(fs.readFileSync(path.join(loadConfig().dataDir, 'migration_refused', 'docs', 'index.json'), 'utf8'));
      assert.deepEqual(refusedIndex, { topic: 'dimension migration sample' }, '导入被拒后 KB 不应有新增文档');

      // ── C：--yes 全量重建完成 schema 切换，旧集合保留 ──
      const successCache = await makeOldScope('migration_success');
      const successBefore = fs.readFileSync(successCache, 'utf8');
      const migrated = await rebuildScopeVectors('migration_success', {}, { yes: true });
      assert.equal(migrated.ok, true, migrated.errors.map((e) => e.error).join('; '));
      assert.equal((await getVectorDimensionStatus('migration_success')).persisted, NEW_DIMENSION);
      assert.ok(migrated.migrationBackup && fs.existsSync(migrated.migrationBackup), '旧集合应保留在 migration-backups');
      assert.ok(migrated.migrationCacheBackup && fs.existsSync(migrated.migrationCacheBackup), '旧缓存应有配套备份');
      assert.notEqual(fs.readFileSync(successCache, 'utf8'), successBefore, 'memoryId 应回写为新维度 docId');
      const hits = await vectorSearch({ scope: 'migration_success', query: 'dimension migration sample', limit: 5 });
      assert.ok(hits.length > 0, '迁移后 dense 检索应命中');

      // ── G：live 缺失但有旧备份时，禁止误建空库 ──
      await closeEngine('migration_success');
      const livePath = getScopeCollectionPath(loadConfig(), 'migration_success');
      const displacedPath = path.join(root, 'displaced-live-collection');
      fs.renameSync(livePath, displacedPath);
      try {
        await assert.rejects(getVectorDimensionStatus('migration_success'), /禁止自动创建空库/);
        assert.equal(fs.existsSync(livePath), false, '探测维度不得顺手创建集合');
      } finally {
        fs.renameSync(displacedPath, livePath);
      }

      // ── D：迁移中途 embedding 失败 → 旧集合与缓存不变，不留事务标记 ──
      const failureCache = await makeOldScope('migration_failure');
      const failureBefore = fs.readFileSync(failureCache, 'utf8');
      failEmbedding = true;
      const failed = await rebuildScopeVectors('migration_failure', {}, { yes: true });
      failEmbedding = false;
      assert.equal(failed.ok, false);
      assert.equal((await getVectorDimensionStatus('migration_failure')).persisted, OLD_DIMENSION, '失败后仍是旧维度');
      assert.equal(fs.readFileSync(failureCache, 'utf8'), failureBefore, '失败后缓存不得改');
      assert.equal(fs.existsSync(path.join(root, 'vector', 'migration-pending', 'migration_failure.json')), false, '失败不得留事务标记');
      assert.equal(fs.readdirSync(path.join(root, 'vector', 'migration-staging')).length, 0, '失败应清理暂存目录');

      // ── F：迁移来源非法（index.json 值为对象）→ 拒绝迁移 ──
      const badCache = await makeOldScope('migration_bad_source');
      const badBefore = fs.readFileSync(badCache, 'utf8');
      const badIndexPath = path.join(loadConfig().dataDir, 'migration_bad_source', 'docs', 'index.json');
      fs.writeFileSync(badIndexPath, JSON.stringify({ topic: { nested: 'not text' } }));
      const badSource = await rebuildScopeVectors('migration_bad_source', {}, { yes: true });
      assert.equal(badSource.ok, false);
      assert.equal(badSource.errors[0]?.type, 'migration-source');
      assert.equal((await getVectorDimensionStatus('migration_bad_source')).persisted, OLD_DIMENSION, '来源非法时旧集合不变');
      assert.equal(fs.readFileSync(badCache, 'utf8'), badBefore, '来源非法时缓存不变');

      // ── E：切换窗口崩溃（标记残留 + 新集合已就位）──
      const interruptedCache = await makeOldScope('migration_interrupted');
      const paths = getVectorMigrationPaths(loadConfig(), 'migration_interrupted', STUB_MIGRATION_ID);
      fs.mkdirSync(path.dirname(paths.backupPath), { recursive: true });
      fs.mkdirSync(path.dirname(paths.stageRoot), { recursive: true });
      fs.mkdirSync(path.dirname(paths.markerPath), { recursive: true });
      fs.copyFileSync(interruptedCache, paths.cacheBackupPath);
      await makeStagedCollection('migration_interrupted');
      // 模拟新集合已切到 live、新缓存已就位，但事务标记尚未清除
      fs.renameSync(paths.liveCollectionPath, paths.backupPath);
      fs.renameSync(paths.stageCollectionPath, paths.liveCollectionPath);
      fs.writeFileSync(interruptedCache, JSON.stringify({ groups: { docs: { hot_relations: [{ text: 'topic', memoryId: 'half-written' }] } } }));
      fs.writeFileSync(paths.markerPath, JSON.stringify({
        scope: 'migration_interrupted',
        migrationId: STUB_MIGRATION_ID,
        backupPath: paths.backupPath,
        cacheBackupPath: paths.cacheBackupPath,
        cachePath: interruptedCache,
        liveCollectionPath: paths.liveCollectionPath,
        stageCollectionPath: paths.stageCollectionPath,
      }));
      await closeEngine('migration_interrupted');

      await assert.rejects(vectorSearch({ scope: 'migration_interrupted', query: 'topic', limit: 5 }), /迁移未完成/);
      await assert.rejects(fullTextSearch({ scope: 'migration_interrupted', query: 'topic', limit: 5 }), /迁移未完成/);
      // 关键：FTS-only 导入（vector=false）同样不能绕过标记写 KB/缓存
      await assert.rejects(
        handleDirectImport({ scope: 'migration_interrupted', sourceDir, group: 'docs', vector: false }),
        /迁移未完成/,
        '迁移中断时 vector=false 的导入也必须被拦截',
      );

      // 重跑 --yes：先自动回退旧集合与配套缓存，再按当前配置完成迁移
      const recovered = await rebuildScopeVectors('migration_interrupted', {}, { yes: true });
      assert.equal(recovered.ok, true, recovered.errors.map((e) => e.error).join('; '));
      assert.equal(fs.existsSync(paths.markerPath), false, '完成后应清除事务标记');
      assert.equal((await getVectorDimensionStatus('migration_interrupted')).persisted, NEW_DIMENSION);
      const cacheAfter = JSON.parse(fs.readFileSync(interruptedCache, 'utf8')) as {
        groups: Record<string, { hot_relations: { memoryId?: string }[] }>;
      };
      assert.notEqual(cacheAfter.groups.docs.hot_relations[0]?.memoryId, 'half-written', '半写状态应被回退掉');
      assert.ok(!!cacheAfter.groups.docs.hot_relations[0]?.memoryId, '回退后仍应完成 memoryId 回写');
    } finally {
      await closeEngine();
      delete process.env.KI_CONFIG_PATH;
      resetConfigCache();
      if (originalDaemonOwner === undefined) delete process.env.KI_DAEMON_OWNER;
      else process.env.KI_DAEMON_OWNER = originalDaemonOwner;
      globalThis.fetch = originalFetch;
    }
  },
);
