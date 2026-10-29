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

// 辅助向量（ki-relation / ki-path）按 group 枚举：测试里直接给结果，不启动向量引擎。
let auxDocs: { id: string; tag?: string; group?: string; text: string }[] = [];
let auxTruncated = false;
(vectorClient as any).vectorListAuxDocsByGroups = async () => ({ docs: auxDocs, truncated: auxTruncated });

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
  auxDocs = [];
  auxTruncated = false;
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
    // 内容向量 1 条 + 组路径向量 2 条（wiki / wiki/docs）——预览与执行同口径（N-01）
    assert.equal(plan.willDelete.vectors, 3);
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

  it('辅助向量按 group 清扫：ki-relation / ki-path 幽灵被删除（K-01/K-02）', async () => {
    const s = `aux-${Date.now()}`;
    registerTestScope(s);
    setupGroup(
      s,
      { wiki: {} },
      { wiki: { hot_relations: [mkRelation('r1', 'a-01', ['m1'])], keywords: [] } },
    );
    // 辅助向量的 docId 不含 group，只能靠向量文档上的 group 字段枚举出来
    auxDocs = [
      { id: 'rel-docid', tag: 'ki-relation', group: 'wiki', text: 'a-01' },
      { id: 'path-docid', tag: 'ki-path', group: 'wiki', text: 'wiki' },
    ];
    mockDeleteResult = { ok: 3, errors: [] };

    const r = await executeGroupDelete({ scope: s, path: 'wiki' });
    assert.equal(r.ok, true);
    assert.equal(r.vectors.auxFound, 2);
    assert.equal(r.vectors.sharedKept, 0);
    const ids = deleteCalls[0].ids;
    assert.ok(ids.includes('m1'), '内容向量仍按 memoryIds 删除');
    assert.ok(ids.includes('rel-docid'), '应删除 ki-relation 辅助向量（K-01）');
    assert.ok(ids.includes('path-docid'), '应删除 ki-path 辅助向量');
  });

  it('同名 relation 仍被存活组引用时，保留该 ki-relation 向量', async () => {
    const s = `aux-shared-${Date.now()}`;
    registerTestScope(s);
    setupGroup(
      s,
      { A: {}, B: {} },
      {
        A: { hot_relations: [mkRelation('ra', '共享名', ['ma'])], keywords: [] },
        B: { hot_relations: [mkRelation('rb', '共享名', ['mb'])], keywords: [] },
      },
    );
    auxDocs = [{ id: 'shared-rel', tag: 'ki-relation', group: 'A', text: '共享名' }];

    const r = await executeGroupDelete({ scope: s, path: 'A' });
    assert.equal(r.ok, true);
    assert.equal(r.vectors.sharedKept, 1);
    assert.ok(!deleteCalls[0].ids.includes('shared-rel'), '存活组仍在用的共享向量不得删除');
    assert.ok(deleteCalls[0].ids.includes('ma'));
    assert.ok((readTree(s) as Record<string, unknown>).B !== undefined, 'B 组保留');
  });

  it('辅助向量枚举被截断时给出 warning，不静默当成"没有残留"', async () => {
    const s = `aux-trunc-${Date.now()}`;
    registerTestScope(s);
    setupGroup(s, { wiki: {} }, { wiki: { hot_relations: [], keywords: [] } });
    auxTruncated = true;
    auxDocs = [{ id: 'path-x', tag: 'ki-path', group: 'wiki', text: 'wiki' }];

    const r = await executeGroupDelete({ scope: s, path: 'wiki' });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.includes('单批上限')), '截断必须显式告警');
  });

  it('import 的 -NN chunk 后缀也识别为同一 relation，不误删共享向量', async () => {
    const s = `aux-chunk-${Date.now()}`;
    registerTestScope(s);
    setupGroup(
      s,
      { A: {}, B: {} },
      {
        A: { hot_relations: [mkRelation('ra', 'a', ['ma'])], keywords: [] },
        B: { hot_relations: [mkRelation('rb', 'a', ['mb'])], keywords: [] },
      },
    );
    // import 写的是 `${relation}-${NN}`（见 import.ts），与 cache 里的 'a' 不同名
    auxDocs = [{ id: 'chunk-01', tag: 'ki-relation', group: 'A', text: 'a-01' }];

    const r = await executeGroupDelete({ scope: s, path: 'A' });
    assert.equal(r.ok, true);
    assert.equal(r.vectors.sharedKept, 1);
    assert.ok(!deleteCalls[0].ids.includes('chunk-01'), 'chunk 后缀的共享向量不得删除');
  });

  it('内容向量仍被存活组引用时不删（同内容跨组共享 docId）', async () => {
    const s = `aux-content-${Date.now()}`;
    registerTestScope(s);
    setupGroup(
      s,
      { A: {}, B: {} },
      {
        A: { hot_relations: [mkRelation('ra', '同文', ['shared-id'])], keywords: [] },
        B: { hot_relations: [mkRelation('rb', '同文', ['shared-id'])], keywords: [] },
      },
    );

    const r = await executeGroupDelete({ scope: s, path: 'A' });
    assert.equal(r.ok, true);
    assert.equal(r.vectors.sharedContentKept, 1);
    assert.ok(!deleteCalls[0].ids.includes('shared-id'), '存活组仍在引用的内容向量不得删除');
  });

  it('legacy roots：预览与执行看到同一棵树，且预览零写入（K-03）', async () => {
    const s = `legacy-${Date.now()}`;
    registerTestScope(s);
    ensureScopeDir(s);
    const kbDir = getKbDir(s);
    fs.writeFileSync(
      path.join(kbDir, 'group-index.json'),
      JSON.stringify({ version: 1, scope: s, roots: { 项目根: { A: { B: {} } } }, updatedAt: null }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(kbDir, 'relations-cache.json'),
      JSON.stringify({
        version: 1,
        scope: s,
        partition_config: {},
        groups: { A: { hot_relations: [], keywords: [] } },
        updatedAt: null,
      }),
      'utf-8',
    );
    const before = fs.readFileSync(path.join(kbDir, 'group-index.json'), 'utf-8');

    const plan = await planGroupDelete({ scope: s, path: 'A' });
    assert.equal(plan.ok, true, plan.ok ? '' : plan.error);
    if (plan.ok) assert.deepEqual(plan.willDelete.groups, ['A', 'A/B']);
    assert.equal(
      fs.readFileSync(path.join(kbDir, 'group-index.json'), 'utf-8'),
      before,
      '预览不得触发 legacy 迁移写盘',
    );

    const r = await executeGroupDelete({ scope: s, path: 'A' });
    assert.equal(r.ok, true);
    assert.deepEqual(readTree(s), {});
  });
});
