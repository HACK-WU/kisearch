/**
 * delete-group.test.ts —— 唯一删组 core（src/lib/group-delete.ts）验证
 *
 * 契约（REQ-20261019-005）：
 *   - planGroupDelete 只读、零写入；
 *   - executeGroupDelete 删 relations 分片 + KB 目录（含 assets）+ 树节点 + 向量/FTS；
 *   - 组级删除不触碰 source.dir / wiki 目录（D3/D4）；
 *   - 只精确匹配，近似路径报 GROUP_NOT_FOUND；
 *   - requireEmpty 拒绝非空组；
 *   - 向量失败 → degraded + orphanIds。
 *
 * 运行：npx jiti test/delete-group.test.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

const vectorClient = await import('../src/lib/vector-client.js');

let deleteCalls: { scope: string; ids: string[] }[] = [];
let mockDeleteResult: { ok: number; errors: { id: string; code: string; reason: string }[] } = {
  ok: 0,
  errors: [],
};
let mockDeleteThrows: Error | null = null;

(vectorClient as any).vectorDelete = async (params: { scope: string; ids: string[] }) => {
  deleteCalls.push({ scope: params.scope, ids: params.ids });
  if (mockDeleteThrows) throw mockDeleteThrows;
  return vectorClient.normalizeVectorDeleteResult(params.ids, mockDeleteResult);
};

const { planGroupDelete, executeGroupDelete } = await import('../src/lib/group-delete.js');
const { ensureScopeDir } = await import('../src/lib/store.js');
const { getKbDir, setSource } = await import('../src/lib/scope.js');

function setupGroup(scopeName: string, tree: Record<string, unknown>, relations: Record<string, any>) {
  ensureScopeDir(scopeName);
  const kbDir = getKbDir(scopeName);
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-del-src-'));
  setSource(scopeName, { dir: sourceDir });

  const groupIndex = {
    version: 1,
    scope: scopeName,
    groups: tree,
    source: { dir: sourceDir },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(kbDir, 'group-index.json'), JSON.stringify(groupIndex), 'utf-8');

  const cache = {
    version: 1,
    scope: scopeName,
    partition_config: {},
    groups: relations,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(kbDir, 'relations-cache.json'), JSON.stringify(cache), 'utf-8');
  return { sourceDir, kbDir };
}

function mkRelation(id: string, text: string, memoryIds?: string[]) {
  const r: any = { id, text, score: 1, useCount: 0, lastUsedTime: null, isImported: true };
  if (memoryIds) r.memoryIds = memoryIds;
  return r;
}

function readTree(scope: string): Record<string, unknown> {
  const p = path.join(getKbDir(scope), 'group-index.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')).groups;
}

before(() => {
  registerTestScope('delete-group-test');
});

after(() => {
  cleanupTestConfig();
});

beforeEach(() => {
  deleteCalls = [];
  mockDeleteResult = { ok: 0, errors: [] };
  mockDeleteThrows = null;
});

describe('group-delete：plan / execute', () => {
  it('预览零写入：KB、树、wiki 全部保持原样', async () => {
    const s = `plan-${Date.now()}`;
    registerTestScope(s);
    const { sourceDir } = setupGroup(
      s,
      { wiki: { docs: {} } },
      { wiki: { hot_relations: [mkRelation('r1', 'a', ['m1'])], keywords: [] } },
    );
    fs.mkdirSync(path.join(getKbDir(s), 'wiki', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(getKbDir(s), 'wiki', 'docs', 'index.json'), '{}', 'utf-8');
    fs.mkdirSync(path.join(sourceDir, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'wiki', 'a.md'), '# keep', 'utf-8');

    const plan = await planGroupDelete({ scope: s, path: 'wiki' });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.willDelete.relations, 1);
    assert.equal(plan.willDelete.vectors, 1);
    assert.ok(plan.willDelete.groups.includes('wiki/docs'));
    assert.equal(plan.willKeep.wikiDir, path.join(sourceDir, 'wiki'));

    assert.equal(fs.existsSync(path.join(getKbDir(s), 'wiki')), true);
    assert.equal(fs.existsSync(path.join(getKbDir(s), 'relations-cache.json')), true);
    assert.deepEqual(readTree(s), { wiki: { docs: {} } });
    assert.equal(fs.existsSync(path.join(sourceDir, 'wiki', 'a.md')), true);
    assert.equal(fs.existsSync(path.join(sourceDir, '.ki', 'trash')), false);
  });

  it('执行删除：分片/KB/树/向量清理，source.dir 原样保留', async () => {
    const s = `exec-${Date.now()}`;
    registerTestScope(s);
    const { sourceDir } = setupGroup(
      s,
      { wiki: { docs: {} } },
      {
        wiki: { hot_relations: [mkRelation('r1', 'a', ['m1', 'm2'])], keywords: [] },
        'wiki/docs': { hot_relations: [], keywords: [] },
      },
    );
    fs.mkdirSync(path.join(getKbDir(s), 'wiki', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(getKbDir(s), 'wiki', 'docs', 'index.json'), '{}', 'utf-8');
    fs.mkdirSync(path.join(getKbDir(s), 'wiki', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(getKbDir(s), 'wiki', 'assets', 'a.png'), 'img', 'utf-8');
    fs.mkdirSync(path.join(sourceDir, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'wiki', 'a.md'), '# keep', 'utf-8');

    mockDeleteResult = { ok: 2, errors: [] };
    const r = await executeGroupDelete({ scope: s, path: 'wiki' });

    assert.equal(r.ok, true);
    assert.equal(r.degraded, false);
    assert.equal(r.deleted.kbDir, true);
    assert.equal(r.deleted.tree, true);
    assert.equal(r.vectors.deleted, deleteCalls[0].ids.length);
    assert.ok(deleteCalls[0].ids.includes('m1') && deleteCalls[0].ids.includes('m2'));
    const { generateDocId } = await import('../src/lib/vector-client.js');
    const { buildGroupPathContent } = await import('../src/lib/path-vectorize.js');
    for (const g of ['wiki', 'wiki/docs']) {
      assert.ok(deleteCalls[0].ids.includes(generateDocId(buildGroupPathContent(g), s, 'ki-path')),
        `应删除 ${g} 的 ki-path 路径向量`);
    }

    assert.equal(fs.existsSync(path.join(getKbDir(s), 'wiki')), false);
    assert.deepEqual(readTree(s), {});
    // D3/D4：wiki / source.dir 零写操作
    assert.equal(fs.existsSync(path.join(sourceDir, 'wiki', 'a.md')), true);
    assert.equal(fs.existsSync(path.join(sourceDir, '.ki', 'trash')), false);
  });

  it('只精确匹配：近似路径返回 GROUP_NOT_FOUND + candidates', async () => {
    const s = `exact-${Date.now()}`;
    registerTestScope(s);
    setupGroup(s, { wiki: {} }, { wiki: { hot_relations: [], keywords: [] } });

    const plan = await planGroupDelete({ scope: s, path: 'wik' });
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.equal(plan.code, 'GROUP_NOT_FOUND');
    assert.ok(Array.isArray(plan.candidates));
  });

  it('拒绝 .. 与空路径', async () => {
    const s = `invalid-${Date.now()}`;
    registerTestScope(s);
    setupGroup(s, { wiki: {} }, { wiki: { hot_relations: [], keywords: [] } });

    for (const p of ['../x', '', 'a//b', '..']) {
      const r = await planGroupDelete({ scope: s, path: p });
      assert.equal(r.ok, false, `path=${JSON.stringify(p)} 应被拒绝`);
      if (!r.ok) assert.equal(r.code, 'INVALID_PATH');
    }
  });

  it('requireEmpty：非空组拒绝，空组可删', async () => {
    const s = `empty-${Date.now()}`;
    registerTestScope(s);
    setupGroup(
      s,
      { A: { B: {} }, Empty: {} },
      { A: { hot_relations: [mkRelation('r1', 'a')], keywords: [] } },
    );

    const nonEmpty = await executeGroupDelete({ scope: s, path: 'A', requireEmpty: true });
    assert.equal(nonEmpty.ok, false);
    assert.equal(nonEmpty.code, 'GROUP_NOT_EMPTY');
    assert.ok(readTree(s).A);

    const empty = await executeGroupDelete({ scope: s, path: 'Empty', requireEmpty: true });
    assert.equal(empty.ok, true);
    assert.equal(readTree(s).Empty, undefined);
  });

  it('向量删除失败：degraded + orphanIds，元数据仍删除', async () => {
    const s = `degraded-${Date.now()}`;
    registerTestScope(s);
    setupGroup(
      s,
      { wiki: {} },
      { wiki: { hot_relations: [mkRelation('r1', 'a', ['m1'])], keywords: [] } },
    );
    mockDeleteThrows = new Error('vector down');

    const r = await executeGroupDelete({ scope: s, path: 'wiki' });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true);
    assert.ok(r.vectors.orphanIds.includes('m1'));
    assert.equal(fs.existsSync(path.join(getKbDir(s), 'wiki')), false);
  });

  it('删除叶子后清理确认为空的父节点', async () => {
    const s = `prune-${Date.now()}`;
    registerTestScope(s);
    setupGroup(
      s,
      { A: { B: {} } },
      { A: { hot_relations: [], keywords: [] }, 'A/B': { hot_relations: [], keywords: [] } },
    );

    const plan = await planGroupDelete({ scope: s, path: 'A/B' });
    assert.equal(plan.ok, true);
    if (plan.ok) assert.deepEqual(plan.willDelete.emptyParents, ['A']);

    const r = await executeGroupDelete({ scope: s, path: 'A/B' });
    assert.equal(r.ok, true);
    assert.deepEqual(readTree(s), {});
  });
});
