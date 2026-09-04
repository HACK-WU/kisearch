/**
 * delete-group.test.ts —— 目录级删除 executeDeleteGroup 逻辑验证
 *
 * 契约（REQ-20260814-001）：
 *   - 删除整个 group：清空该 group 下所有 relations（cache + KB + 向量）
 *   - 级联删除：删除父 group 连带全部子 group（前缀 = group + '/'）
 *   - wiki 目录移入回收站（.ki/trash/<group>/ 保留完整结构）
 *   - group-index 树节点删除（叶子节点连带清理空父节点）
 *   - 向量删除失败 → vectorRemoved:false（可观测，避免孤儿向量静默残留）
 *   - NOT_FOUND（doc 已不存在）视为「已清理」，幂等重删不误报
 *   - 空路径卫兵：resolvedGroup 为空拒绝执行（防 rmSync 删整个 scope）
 *
 * 策略：patch vector-client 的 vectorDelete，验证 executeDeleteGroup 在各场景的行为。
 *       文件系统侧走真实临时目录（KB 写入真实发生，与 import-scheme-d 一致）。
 *       精确 group 名直接匹配，resolveGroupPath 不触发向量兜底（searchPath）。
 *
 * 运行：npx jiti test/delete-group.test.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

// ─── 被测模块（先 import 以便 patch 导出）───
const vectorClient = await import('../src/lib/vector-client.js');
const pathSearch = await import('../src/lib/path-search.js');

// ─── mock 状态 ───
let deleteCalls: { scope: string; ids: string[] }[] = [];
let mockDeleteResult: { deleted: number; errors: { id: string; code: string; reason: string }[] } = {
  deleted: 0,
  errors: [],
};
let mockDeleteThrows: Error | null = null;

// patch（CJS interop 下消费方按命名空间动态取属性，patch 生效）
(vectorClient as any).vectorDelete = async (params: { scope: string; ids: string[] }) => {
  deleteCalls.push({ scope: params.scope, ids: params.ids });
  if (mockDeleteThrows) throw mockDeleteThrows;
  return mockDeleteResult;
};

// patch searchPath：向量语义兜底返回 null（降级），避免「未匹配」用例触发真实引擎初始化
(pathSearch as any).searchPath = async () => null;

// ─── 动态 import 被测函数（patch 之后再 import，消费方取 patch 后的引用）───
const { executeDeleteGroup } = await import('../src/delete-relation.js');
const { ensureScopeDir } = await import('../src/lib/store.js');
const { getKbDir, setSource, getSource } = await import('../src/lib/scope.js');

const scope = `delete-group-${Date.now()}`;

// ─── 测试数据构造 ───
let wikiSourceDir: string;

/**
 * 构造一个含 group 树 + relations + KB 目录 + wiki 目录的 scope
 */
function setupGroup(scopeName: string, tree: Record<string, unknown>, relations: Record<string, any>) {
  ensureScopeDir(scopeName);
  const kbDir = getKbDir(scopeName);

  // source 块：sourceDir 指向临时 wiki 目录
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-del-src-'));
  setSource(scopeName, { dir: sourceDir });

  // 写 group-index.json（groups 树）
  const groupIndex = {
    version: 1,
    scope: scopeName,
    groups: tree,
    source: { dir: sourceDir },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(kbDir, 'group-index.json'), JSON.stringify(groupIndex), 'utf-8');

  // 写 relations-cache.json（groups 平铺键）
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

/** 造一个 relation 条目 */
function mkRelation(id: string, text: string, memoryIds?: string[]) {
  const r: any = { id, text, score: 1, useCount: 0, lastUsedTime: null, isImported: true };
  if (memoryIds) r.memoryIds = memoryIds;
  return r;
}

before(() => {
  registerTestScope(scope);
  wikiSourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-del-wiki-'));
});

after(() => {
  cleanupTestConfig();
});

beforeEach(() => {
  deleteCalls = [];
  mockDeleteResult = { deleted: 0, errors: [] };
  mockDeleteThrows = null;
});

describe('executeDeleteGroup：目录级删除', () => {
  it('基础删除：cache/KB/向量/wiki/树节点全清 + vectorRemoved:true', async () => {
    const s = `basic-${Date.now()}`;
    registerTestScope(s);
    const { sourceDir } = setupGroup(
      s,
      { wiki: { docs: {} } },
      {
        'wiki': { hot_relations: [mkRelation('r1', '父 relation', ['mem-1'])], keywords: [] },
        'wiki/docs': { hot_relations: [], keywords: [] },
      }
    );

    // 建 KB 目录 + wiki 目录
    fs.mkdirSync(path.join(getKbDir(s), 'wiki', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(getKbDir(s), 'wiki', 'docs', 'index.json'), '{}', 'utf-8');
    fs.mkdirSync(path.join(sourceDir, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'wiki', 'a.md'), '# 内容', 'utf-8');

    mockDeleteResult = { deleted: 1, errors: [] };

    const r = await executeDeleteGroup({ scope: s, group: 'wiki' });

    assert.equal(r.ok, true);
    const res = (r as any).result;
    assert.equal(res.deleted, true);
    assert.equal(res.vectorRemoved, true);
    assert.equal(res.relationCount, 1);
    assert.equal(res.wikiMoved, true);
    assert.equal(res.nodeRemoved, true);

    // cache 键已删
    const cache = JSON.parse(fs.readFileSync(path.join(getKbDir(s), 'relations-cache.json'), 'utf-8'));
    assert.equal(cache.groups['wiki'], undefined);
    assert.equal(cache.groups['wiki/docs'], undefined);

    // KB 目录已删
    assert.equal(fs.existsSync(path.join(getKbDir(s), 'wiki')), false);

    // wiki 移入回收站
    assert.equal(fs.existsSync(path.join(sourceDir, 'wiki')), false);
    assert.equal(fs.existsSync(path.join(sourceDir, '.ki', 'trash', 'wiki', 'a.md')), true);

    // 向量被调用一次，携带聚合 ids
    assert.equal(deleteCalls.length, 1);
    assert.deepEqual(deleteCalls[0].ids, ['mem-1']);
  });

  it('级联删除：父 group 连带子 group（cache + KB 前缀匹配）', async () => {
    const s = `cascade-${Date.now()}`;
    registerTestScope(s);
    const { sourceDir } = setupGroup(
      s,
      { wiki: { docs: { sub: {} } } },
      {
        'wiki': { hot_relations: [mkRelation('r1', '父', ['mem-1'])], keywords: [] },
        'wiki/docs': { hot_relations: [mkRelation('r2', '子', ['mem-2'])], keywords: [] },
        'wiki/docs/sub': { hot_relations: [mkRelation('r3', '孙', ['mem-3'])], keywords: [] },
        // 无关 group 不应被删除
        'other': { hot_relations: [mkRelation('r4', '无关', ['mem-4'])], keywords: [] },
      }
    );

    fs.mkdirSync(path.join(getKbDir(s), 'wiki', 'docs', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'wiki', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'wiki', 'docs', 'b.md'), '# b', 'utf-8');

    mockDeleteResult = { deleted: 3, errors: [] };

    const r = await executeDeleteGroup({ scope: s, group: 'wiki' });

    assert.equal(r.ok, true);
    const res = (r as any).result;
    assert.equal(res.deleted, true);
    assert.equal(res.relationCount, 3);

    const cache = JSON.parse(fs.readFileSync(path.join(getKbDir(s), 'relations-cache.json'), 'utf-8'));
    assert.equal(cache.groups['wiki'], undefined);
    assert.equal(cache.groups['wiki/docs'], undefined);
    assert.equal(cache.groups['wiki/docs/sub'], undefined);
    // 无关 group 保留
    assert.notEqual(cache.groups['other'], undefined);

    // 聚合删除 3 个 memoryIds
    assert.equal(deleteCalls.length, 1);
    assert.deepEqual(new Set(deleteCalls[0].ids), new Set(['mem-1', 'mem-2', 'mem-3']));
  });

  it('向量删除抛错 → vectorRemoved:false + reason 记录', async () => {
    const s = `verr-${Date.now()}`;
    registerTestScope(s);
    const { sourceDir } = setupGroup(
      s,
      { wiki: {} },
      { 'wiki': { hot_relations: [mkRelation('r1', 'x', ['mem-1'])], keywords: [] } }
    );
    fs.mkdirSync(path.join(getKbDir(s), 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'wiki'), { recursive: true });

    mockDeleteThrows = new Error('engine locked');

    const r = await executeDeleteGroup({ scope: s, group: 'wiki' });

    assert.equal(r.ok, true);
    const res = (r as any).result;
    // 索引删除仍成功（deleted:true），但向量残留需可观测
    assert.equal(res.deleted, true);
    assert.equal(res.vectorRemoved, false);
    assert.match(res.reason, /向量删除失败/);
  });

  it('NOT_FOUND（doc 已不存在）→ 视为已清理，vectorRemoved:true 不误报', async () => {
    const s = `notfound-${Date.now()}`;
    registerTestScope(s);
    const { sourceDir } = setupGroup(
      s,
      { wiki: {} },
      { 'wiki': { hot_relations: [mkRelation('r1', 'x', ['mem-gone'])], keywords: [] } }
    );
    fs.mkdirSync(path.join(getKbDir(s), 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'wiki'), { recursive: true });

    // NOT_FOUND：deleted 计数不含该 doc，但 errors 只含 NOT_FOUND
    mockDeleteResult = {
      deleted: 0,
      errors: [{ id: 'mem-gone', code: 'NOT_FOUND', reason: 'not found' }],
    };

    const r = await executeDeleteGroup({ scope: s, group: 'wiki' });

    assert.equal(r.ok, true);
    const res = (r as any).result;
    assert.equal(res.vectorRemoved, true); // 不误报
    assert.equal(res.reason, undefined); // 无失败提示
  });

  it('真实写错误（非 NOT_FOUND）→ vectorRemoved:false', async () => {
    const s = `realerr-${Date.now()}`;
    registerTestScope(s);
    const { sourceDir } = setupGroup(
      s,
      { wiki: {} },
      { 'wiki': { hot_relations: [mkRelation('r1', 'x', ['mem-bad'])], keywords: [] } }
    );
    fs.mkdirSync(path.join(getKbDir(s), 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'wiki'), { recursive: true });

    mockDeleteResult = {
      deleted: 0,
      errors: [{ id: 'mem-bad', code: 'ZVEC_WRITE_ERROR', reason: 'io error' }],
    };

    const r = await executeDeleteGroup({ scope: s, group: 'wiki' });

    assert.equal(r.ok, true);
    const res = (r as any).result;
    assert.equal(res.vectorRemoved, false);
    assert.match(res.reason, /向量删除失败/);
    assert.match(res.reason, /mem-bad/);
  });

  it('group 未匹配 → ok:false（不执行删除）', async () => {
    const s = `nomatch-${Date.now()}`;
    registerTestScope(s);
    setupGroup(s, { wiki: {} }, { 'wiki': { hot_relations: [], keywords: [] } });

    const r = await executeDeleteGroup({ scope: s, group: 'nonexistent' });

    assert.equal(r.ok, false);
    assert.match((r as any).error, /未匹配/);
    // 未触发向量删除
    assert.equal(deleteCalls.length, 0);
  });

  it('无 memoryIds 的 group（纯索引无向量）→ vectorRemoved:true 且不调 vectorDelete', async () => {
    const s = `novec-${Date.now()}`;
    registerTestScope(s);
    const { sourceDir } = setupGroup(
      s,
      { wiki: {} },
      { 'wiki': { hot_relations: [mkRelation('r1', 'x')], keywords: [] } }
    );
    fs.mkdirSync(path.join(getKbDir(s), 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'wiki'), { recursive: true });

    const r = await executeDeleteGroup({ scope: s, group: 'wiki' });

    assert.equal(r.ok, true);
    const res = (r as any).result;
    assert.equal(res.vectorRemoved, true);
    assert.equal(deleteCalls.length, 0); // 无 ids 可删，不调 vectorDelete
  });
});
