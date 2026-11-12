/**
 * doc-move.test.ts —— 文档移动（REQ-20261112-002）
 *
 * 覆盖「预检 → 搬源文件 → 落新位置 → 清旧位置」这条链上真正会分叉的几处：
 * 四个落点（分片 / KB / Group 树 / wiki 文件）是否一起动、以及每种拒绝是否 fail-loud。
 *
 * ★ 每个用例用**独立 scope + 独立 wiki 目录**：首次写入会触发 relations-cache 惰性迁移
 *   （旧单文件 → 分片），共用 scope 时后面的用例再写旧文件就不生效了（读到"文档不存在"）。
 * ★ 记录刻意做成 **FTS-only**（`ftsIds` 非空、`ftsIndexComplete: true`）：
 *   `relationIndexMode` 据此判定 'fts'，移动走全文索引而不是 dense embedding，
 *   测试因此不依赖外部 embedding 服务（与 document-editor.test.ts 同一手法）。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 按项目约定，验证产物仅创建在 workspace/temp，不主动清理。
const fixture = path.join(process.cwd(), 'temp', `doc-move-${Date.now()}`);
fs.mkdirSync(fixture, { recursive: true });
const dataDir = path.join(fixture, 'kb');
const vectorDir = path.join(fixture, 'vector');
const configPath = path.join(fixture, 'config.json');

const CASES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const scopes = CASES.map((name) => `move-${name}`);
const sourceDirs: Record<string, string> = {};
for (const name of scopes) sourceDirs[name] = path.join(fixture, `source-${name}`);

fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  vectorDir,
  scopeMode: 'default',
  scopes: Object.fromEntries(scopes.map((name) => [name, { wikiSync: { enabled: true, sourceDir: sourceDirs[name] } }])),
}));
process.env.KI_CONFIG_PATH = configPath;

const { resetConfigCache } = await import('../src/lib/config.js');
const { initScope, readJson, writeJson } = await import('../src/lib/store.js');
const { getRelationsCachePath, getLocalKbDir, getGroupIndexPath } = await import('../src/lib/scope.js');
// 首次写入会触发「旧单文件 → 分片」惰性迁移，落盘后旧文件被改名：读分片必须走 layout 感知入口
const { loadCacheShape } = await import('../src/lib/group-cache.js');
const { moveDocument } = await import('../src/lib/doc-move.js');
const { executeDeleteRelation } = await import('../src/delete-relation.js');
const { closeFtsEngine } = await import('../src/lib/fts-client.js');
const { closeEngine } = await import('../src/lib/vector-client.js');

after(async () => {
  for (const scope of scopes) await closeFtsEngine(scope);
  for (const scope of scopes) await closeEngine(scope);
});

const fromGroup = '预警分析';
const relation = 'alert-search-v2';
const body = '# 告警检索 v2\n\n正文内容';

/** 造一份「一个组一篇文档 + 一份 wiki 源文件」的初始状态 */
function seed(scope: string): void {
  resetConfigCache();
  initScope(scope);
  const cachePath = getRelationsCachePath(scope);
  const cache = readJson<any>(cachePath)!;
  cache.groups = {
    [fromGroup]: {
      hot_relations: [{
        id: 'rel_move',
        text: relation,
        score: 0,
        useCount: 3,
        lastUsedTime: null,
        sourcePath: `${fromGroup}/${relation}.md`,
        ftsIds: ['fts-move-1'],
        ftsIndexComplete: true,
      }],
      keywords: [],
    },
  };
  writeJson(cachePath, cache);
  const kbPath = getLocalKbDir(scope, fromGroup);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  writeJson(kbPath, { [relation]: body });
  const srcFile = path.join(sourceDirs[scope], fromGroup, `${relation}.md`);
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, body);
}

describe('doc move', () => {
  it('移动文档到另一个 Group：KB / 分片 / 组树 / 源文件四层一起动', async () => {
    const scope = scopes[0];
    seed(scope);
    const result = await moveDocument({
      scope, group: fromGroup, relation, targetGroup: 'stages/3-网络与服务暴露',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.to.group, 'stages/3-网络与服务暴露');

    // ① KB 正文：旧组消失、新组就位
    const oldKb = readJson<Record<string, string>>(getLocalKbDir(scope, fromGroup))!;
    const newKb = readJson<Record<string, string>>(getLocalKbDir(scope, 'stages/3-网络与服务暴露'))!;
    assert.equal(relation in oldKb, false);
    assert.equal(newKb[relation], body);

    // ② 分片：旧组不再持有该文档，新组持有且 sourcePath 已改写
    const cache = loadCacheShape(scope) as any;
    const oldRels = cache.groups[fromGroup]?.hot_relations ?? [];
    assert.equal(oldRels.some((item: any) => item.text === relation), false);
    const moved = cache.groups['stages/3-网络与服务暴露'].hot_relations.find((item: any) => item.text === relation);
    assert.ok(moved);
    assert.equal(moved.sourcePath, `stages/3-网络与服务暴露/${relation}.md`);

    // ③ Group 树：目标组节点被补建
    const tree = JSON.stringify(readJson(getGroupIndexPath(scope)) ?? {});
    assert.match(tree, /3-网络与服务暴露/);

    // ④ wiki 源文件：物理搬家，内容零改写
    assert.equal(fs.existsSync(path.join(sourceDirs[scope], fromGroup, `${relation}.md`)), false);
    const dest = path.join(sourceDirs[scope], 'stages/3-网络与服务暴露', `${relation}.md`);
    assert.equal(fs.existsSync(dest), true);
    assert.equal(fs.readFileSync(dest, 'utf8'), body);
    assert.equal(result.source.moved, true);
  });

  it('移动时改名：新名称落到目标组，旧名称查不到', async () => {
    const scope = scopes[1];
    seed(scope);
    const result = await moveDocument({
      scope, group: fromGroup, relation, targetGroup: 'stages', targetRelation: 'alert-search-v2-performance',
    });
    assert.equal(result.to.relation, 'alert-search-v2-performance');
    const kb = readJson<Record<string, string>>(getLocalKbDir(scope, 'stages'))!;
    assert.equal(kb['alert-search-v2-performance'], body);
    assert.equal(relation in kb, false);
    assert.equal(fs.existsSync(path.join(sourceDirs[scope], 'stages', 'alert-search-v2-performance.md')), true);
    assert.equal(fs.existsSync(path.join(sourceDirs[scope], fromGroup, `${relation}.md`)), false);
  });

  it('目标与当前完全一致 → 400 SAME_TARGET', async () => {
    const scope = scopes[2];
    seed(scope);
    await assert.rejects(
      () => moveDocument({ scope, group: fromGroup, relation, targetGroup: fromGroup }),
      (error: any) => error.status === 400 && error.code === 'SAME_TARGET',
    );
  });

  it('目标组已有同名文档 → 409 TARGET_EXISTS（不覆盖、不加后缀）', async () => {
    const scope = scopes[3];
    seed(scope);
    const cachePath = getRelationsCachePath(scope);
    const cache = readJson<any>(cachePath)!;
    cache.groups.stages = {
      hot_relations: [{ id: 'rel_dup', text: relation, score: 0, useCount: 0, lastUsedTime: null }],
      keywords: [],
    };
    writeJson(cachePath, cache);
    await assert.rejects(
      () => moveDocument({ scope, group: fromGroup, relation, targetGroup: 'stages' }),
      (error: any) => error.status === 409 && error.code === 'TARGET_EXISTS',
    );
    // 拒绝时源文档必须原地不动
    assert.equal(readJson<Record<string, string>>(getLocalKbDir(scope, fromGroup))?.[relation], body);
  });

  it('移动到根目录（通用根选项，2026-11-12）：落在 __root__ 且不打「兜底」标记', async () => {
    const scope = scopes[4];
    seed(scope);
    const result = await moveDocument({ scope, group: fromGroup, relation, targetGroup: '__root__' });
    assert.equal(result.ok, true);
    assert.equal(result.to.group, '__root__');

    // KB 落在根键下（`<kb>/__root__/index.json`），旧组已清空
    const rootKb = readJson<Record<string, string>>(getLocalKbDir(scope, '__root__'))!;
    assert.equal(rootKb[relation], body);
    assert.equal(relation in (readJson<Record<string, string>>(getLocalKbDir(scope, fromGroup)) ?? {}), false);

    // 分片里记在根键下，且**不能**带 groupSource='scope-fallback'——
    // 这是用户显式选「根目录」，不是 Group 留空的兜底
    const cache = loadCacheShape(scope) as any;
    const rootRel = cache.groups.__root__.hot_relations.find((item: any) => item.text === relation);
    assert.ok(rootRel);
    assert.equal(rootRel.groupSource, undefined);

    // wiki 源文件搬到 wiki 根目录（不额外套一层 __root__/）
    assert.equal(fs.existsSync(path.join(sourceDirs[scope], `${relation}.md`)), true);
    assert.equal(fs.existsSync(path.join(sourceDirs[scope], fromGroup, `${relation}.md`)), false);
  });

  it('数据源管辖的文档 → 409 DATASOURCE_BLOCKED（下次同步会再导入一份）', async () => {
    const scope = scopes[5];
    seed(scope);
    // 造一份数据源登记，并让 sourcePath 在源目录下真实存在
    const repo = path.join(fixture, 'repo');
    const file = path.join(repo, 'docs', `${relation}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    fs.writeFileSync(path.join(dataDir, scope, 'datasource.json'), JSON.stringify({
      type: 'directory', dir: repo, group: '', vector: true,
      conflictMode: 'incremental', createdAt: Date.now(), updatedAt: Date.now(),
      mappings: [{ subdir: 'docs', group: '' }],
    }));
    const cachePath = getRelationsCachePath(scope);
    const cache = readJson<any>(cachePath)!;
    cache.groups[fromGroup].hot_relations[0].sourcePath = `${relation}.md`;
    writeJson(cachePath, cache);
    await assert.rejects(
      () => moveDocument({ scope, group: fromGroup, relation, targetGroup: 'stages' }),
      (error: any) => error.status === 409 && error.code === 'DATASOURCE_BLOCKED',
    );
    assert.equal(fs.existsSync(file), true, '被拒绝时不许动源目录里的文件');
  });

  it('删旧位置时跳过内容向量（docId 不含 group，同一篇不能删两次）', async () => {
    const scope = scopes[7];
    seed(scope);
    const cachePath = getRelationsCachePath(scope);
    const cache = readJson<any>(cachePath)!;
    cache.groups[fromGroup].hot_relations[0].memoryIds = ['dense-shared-id'];
    writeJson(cachePath, cache);
    // 不开开关时这条路会按 memoryIds 删、删不到再走 search 兜底；
    // 移动场景必须**整段跳过**（新位置写的就是同一批 docId）
    const removed = await executeDeleteRelation({ scope, group: fromGroup, relation, wikiDelete: false, skipDenseDelete: true });
    assert.equal(removed.ok, true);
    const result = (removed as { result: { memMethod: string; memRemoved: boolean } }).result;
    assert.equal(result.memMethod, 'skip');
    assert.equal(result.memRemoved, false);
  });

  it('目标位置已存在同名文件 → 409 SOURCE_EXISTS（绝不覆盖用户文件）', async () => {
    const scope = scopes[6];
    seed(scope);
    const occupied = path.join(sourceDirs[scope], 'stages', `${relation}.md`);
    fs.mkdirSync(path.dirname(occupied), { recursive: true });
    fs.writeFileSync(occupied, '别人的文件');
    await assert.rejects(
      () => moveDocument({ scope, group: fromGroup, relation, targetGroup: 'stages' }),
      (error: any) => error.status === 409 && error.code === 'SOURCE_EXISTS',
    );
    assert.equal(fs.readFileSync(occupied, 'utf8'), '别人的文件');
    assert.equal(fs.existsSync(path.join(sourceDirs[scope], fromGroup, `${relation}.md`)), true);
  });
});
