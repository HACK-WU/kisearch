/**
 * doc-delete.test.ts —— 浏览页删除文档（2026-11-13）
 *
 * 覆盖这条链上真正会分叉的几处：
 *   ├─ 删除范围：KB 正文 / 元数据分片 / wiki 源文件（默认一起删，可只删库）
 *   ├─ 预检：不产生副作用，且如实回答「源文件会不会一起没 / 有没有草稿 / 是不是数据源管辖」
 *   └─ 拒绝路径：文档不存在 404、草稿未收口 409、数据源管辖**放行**（与移动刻意不同）
 *
 * ★ 每个用例用**独立 scope + 独立 wiki 目录**：首次写入会触发 relations-cache 惰性迁移
 *   （旧单文件 → 分片），共用 scope 时后面的用例再写旧文件就不生效了（读到"文档不存在"）。
 * ★ 记录做成 **FTS-only**（`ftsIds` 非空、`ftsIndexComplete: true`）：删除时按全文索引收尾，
 *   不依赖外部 embedding 服务（与 doc-move.test.ts 同一手法）。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 按项目约定，验证产物仅创建在 workspace/temp，不主动清理。
const fixture = path.join(process.cwd(), 'temp', `doc-delete-${Date.now()}`);
fs.mkdirSync(fixture, { recursive: true });
const dataDir = path.join(fixture, 'kb');
const vectorDir = path.join(fixture, 'vector');
const configPath = path.join(fixture, 'config.json');

const CASES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;
const scopes = CASES.map((name) => `del-${name}`);
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
const { getRelationsCachePath, getLocalKbDir } = await import('../src/lib/scope.js');
// 首次写入会触发「旧单文件 → 分片」惰性迁移：读分片必须走 layout 感知入口
const { loadCacheShape } = await import('../src/lib/group-cache.js');
const { deleteDocument, precheckDocDelete } = await import('../src/lib/doc-delete.js');
const { createDraft } = await import('../src/lib/relation-edit-draft.js');
const { closeFtsEngine } = await import('../src/lib/fts-client.js');
const { closeEngine } = await import('../src/lib/vector-client.js');

after(async () => {
  for (const scope of scopes) await closeFtsEngine(scope);
  for (const scope of scopes) await closeEngine(scope);
});

const group = '预警分析';
const relation = 'alert-search-v2';
const body = '# 告警检索 v2\n\n正文内容';

/** 造一份「一个组一篇文档 + 一份 wiki 源文件」的初始状态 */
function seed(scope: string, docGroup = group): void {
  resetConfigCache();
  initScope(scope);
  const cachePath = getRelationsCachePath(scope);
  const cache = readJson<any>(cachePath)!;
  cache.groups = {
    [docGroup]: {
      hot_relations: [{
        id: 'rel_del',
        text: relation,
        score: 0,
        useCount: 3,
        lastUsedTime: null,
        sourcePath: `${docGroup}/${relation}.md`,
        ftsIds: ['fts-del-1'],
        ftsIndexComplete: true,
      }],
      keywords: [],
    },
  };
  writeJson(cachePath, cache);
  const kbPath = getLocalKbDir(scope, docGroup);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  writeJson(kbPath, { [relation]: body });
  const srcFile = path.join(sourceDirs[scope], docGroup, `${relation}.md`);
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, body);
}

describe('doc delete', () => {
  it('默认删除：KB 正文 / 元数据分片 / wiki 源文件三层一起清掉', async () => {
    const scope = scopes[0];
    seed(scope);
    const result = await deleteDocument({ scope, group, relation });
    assert.equal(result.ok, true);
    assert.equal(result.deleted, true);
    assert.equal(result.wikiRemoved, true);

    // ① KB 正文：这篇从组里消失
    const kb = readJson<Record<string, string>>(getLocalKbDir(scope, group)) ?? {};
    assert.equal(relation in kb, false);

    // ② 元数据分片：组树里不再有它
    const cache = loadCacheShape(scope) as any;
    const rels = cache.groups[group]?.hot_relations ?? [];
    assert.equal(rels.some((item: any) => item.text === relation), false);

    // ③ wiki 源文件：不进回收站，直接没了
    assert.equal(fs.existsSync(path.join(sourceDirs[scope], group, `${relation}.md`)), false);
  });

  it('wikiDelete:false：只从知识库移除，仓库里的 .md 原地不动', async () => {
    const scope = scopes[1];
    seed(scope);
    const result = await deleteDocument({ scope, group, relation, wikiDelete: false });
    assert.equal(result.deleted, true);
    assert.equal(result.wikiRemoved, false);
    assert.equal(result.wikiSkipReason, 'wiki-delete-disabled');

    const srcFile = path.join(sourceDirs[scope], group, `${relation}.md`);
    assert.equal(fs.existsSync(srcFile), true, '选了保留就必须真的保留');
    assert.equal(fs.readFileSync(srcFile, 'utf8'), body);
    const kb = readJson<Record<string, string>>(getLocalKbDir(scope, group)) ?? {};
    assert.equal(relation in kb, false);
  });

  it('预检不产生任何副作用，并报告源文件落点', async () => {
    const scope = scopes[2];
    seed(scope);
    const before = fs.readFileSync(path.join(sourceDirs[scope], group, `${relation}.md`), 'utf8');
    const pre = precheckDocDelete({ scope, group, relation });
    assert.equal(pre.ok, true);
    assert.equal(pre.exists, true);
    assert.equal(pre.pendingDrafts, 0);
    assert.equal(pre.wikiWillDelete, true);
    assert.equal(pre.wikiPath, path.join(sourceDirs[scope], group, `${relation}.md`));
    assert.equal(pre.datasourceSource, undefined);

    // 预检完，文档与源文件都还在
    assert.equal(readJson<Record<string, string>>(getLocalKbDir(scope, group))?.[relation], body);
    assert.equal(fs.readFileSync(path.join(sourceDirs[scope], group, `${relation}.md`), 'utf8'), before);
  });

  it('没有 wiki 源文件时预检不返回路径（前端据此不显示「同时删除源文件」勾选）', async () => {
    const scope = scopes[3];
    seed(scope);
    fs.unlinkSync(path.join(sourceDirs[scope], group, `${relation}.md`));
    const pre = precheckDocDelete({ scope, group, relation });
    assert.equal(pre.wikiWillDelete, false);
    assert.equal(pre.wikiSkipReason, 'file-not-found');
    assert.equal(pre.wikiPath, undefined);
  });

  it('数据源管辖的文档：预检预告、删除放行（与移动的阻断刻意不同）', async () => {
    const scope = scopes[4];
    seed(scope);
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
    cache.groups[group].hot_relations[0].sourcePath = `${relation}.md`;
    writeJson(cachePath, cache);

    const pre = precheckDocDelete({ scope, group, relation });
    assert.equal(pre.datasourceSource, file, '预检必须认出这是数据源同步下来的');

    const result = await deleteDocument({ scope, group, relation });
    assert.equal(result.deleted, true, '删除不产生副本，所以放行（阻断等于这篇永远删不掉）');
    assert.ok(result.warnings.some((line) => line.includes('数据源')), '必须预告「下次同步会重新导入」');
    // 数据源源目录里的文件不归 ki 删（它不是 wiki 回写目标）
    assert.equal(fs.existsSync(file), true);
  });

  it('有未结束的编辑草稿 → 409 DOC_EDIT_IN_PROGRESS，且什么都不删', async () => {
    const scope = scopes[5];
    seed(scope);
    createDraft({
      scope,
      group,
      relation,
      baseRevision: 'r1',
      baseMetadataRevision: 'm1',
      baseContent: body,
      content: `${body}\n\n改到一半`,
    });
    const pre = precheckDocDelete({ scope, group, relation });
    assert.equal(pre.pendingDrafts, 1);

    await assert.rejects(
      () => deleteDocument({ scope, group, relation }),
      (error: any) => error.status === 409 && error.code === 'DOC_EDIT_IN_PROGRESS',
    );
    assert.equal(readJson<Record<string, string>>(getLocalKbDir(scope, group))?.[relation], body);
  });

  it('文档不存在 → 404 DOC_NOT_FOUND；根目录文档允许删除', async () => {
    const scope = scopes[6];
    seed(scope, '__root__');
    // 根散文件：group 是保留键，删除入口必须放行（否则留一个删不掉的孤儿）
    const pre = precheckDocDelete({ scope, group: '__root__', relation });
    assert.equal(pre.exists, true);
    const result = await deleteDocument({ scope, group: '__root__', relation });
    assert.equal(result.deleted, true);
    assert.equal(readJson<Record<string, string>>(getLocalKbDir(scope, '__root__'))?.[relation], undefined);

    await assert.rejects(
      () => deleteDocument({ scope, group: '__root__', relation }),
      (error: any) => error.status === 404 && error.code === 'DOC_NOT_FOUND',
    );
  });
});
