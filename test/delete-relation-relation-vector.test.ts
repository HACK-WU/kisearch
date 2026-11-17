/**
 * delete-relation-relation-vector.test.ts —— 删除 Relation 必须清掉路径向量（REQ-20261021-002）
 *
 * 背景：写入侧**刻意**不回写 ki-relation 路径向量的 docId（cache 只记内容向量），
 * 因此过去 `delete-relation` 删完后 `ki doc list` 仍剩一条 tag=ki-relation 的孤儿
 * （本机复现 3 次）。现在改为按**可重算 docId** 补删 + tag 精确检索兜底。
 *
 * 覆盖：
 *   1) 正常删除 → 路径向量 docId 进入删除清单，relationVectorRemoved=true；
 *   2) **跨组共享保护**：docId 只由 relation 名决定，同名 relation 还活在别的组时必须保留；
 *   3) 未命中（本就没有路径向量）→ 不报错、不阻断；
 *   4) 兜底检索失败 → 只降级（ok:true + reason），不得让删除整体失败；
 *   5) 历史文本形态（`relation | Group: g`）未被 docId 重算命中时，靠 tag 检索兜底删掉，
 *      且不得误删内容无关的同 tag 条目。
 *
 * Mock 策略：先 import vector-client 再 patch 导出函数（ESM live binding），离线可跑。
 * `existingIds` 模拟向量层真实存在集合 —— 只有存在的 id 才计入 deleted（真实引擎语义）。
 * 运行：npx jiti test/delete-relation-relation-vector.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

const vectorClient = await import('../src/lib/vector-client.js');

const deleteCalls: string[][] = [];
let existingIds = new Set<string>();
let searchHits: { memoryId: string; content: string; tag?: string }[] = [];
let searchThrows = false;

(vectorClient as any).ensureVectorAvailable = async () => ({ available: true });
(vectorClient as any).vectorDelete = async (params: { ids: string[] }) => {
  deleteCalls.push([...params.ids]);
  const present = params.ids.filter((id) => existingIds.has(id));
  for (const id of present) existingIds.delete(id);
  return {
    deleted: present.length,
    failedIds: params.ids.filter((id) => !present.includes(id)),
    errors: [],
  };
};
(vectorClient as any).vectorSearch = async () => {
  if (searchThrows) throw new Error('mock search 失败');
  return searchHits;
};
(vectorClient as any).closeEngine = async () => {};
// 本文件用 mock 模拟「库里存在这些 docId」的场景：真实实现会先查 collection 是否存在
// （不存在时短路，避免为它打开/创建空库），这里要让守卫放行到 mock 的删除逻辑。
(vectorClient as any).scopeCollectionExists = () => true;

const { executeDeleteRelation } = await import('../src/delete-relation.js');
const { ensureScopeDir } = await import('../src/lib/store.js');
const { getKbDir } = await import('../src/lib/scope.js');

/** 直接铺 KB（group-index + relations-cache + local-kb），不依赖写入链路 */
function seedScope(scope: string, groups: Record<string, { text: string; memoryIds?: string[] }[]>): void {
  ensureScopeDir(scope);
  const kbDir = getKbDir(scope);
  const tree: Record<string, unknown> = {};
  for (const group of Object.keys(groups)) tree[group.split('/')[0]] = {};
  fs.writeFileSync(
    path.join(kbDir, 'group-index.json'),
    JSON.stringify({ version: 1, scope, groups: tree, updatedAt: new Date().toISOString() }),
    'utf-8',
  );
  const cacheGroups: Record<string, unknown> = {};
  for (const [group, relations] of Object.entries(groups)) {
    cacheGroups[group] = {
      hot_relations: relations.map((r, i) => ({
        id: `rel_${i + 1}`,
        text: r.text,
        score: 1,
        useCount: 0,
        lastUsedTime: null,
        isImported: false,
        ...(r.memoryIds ? { memoryIds: r.memoryIds } : {}),
      })),
      keywords: [],
    };
    fs.mkdirSync(path.join(kbDir, group), { recursive: true });
    const localKb: Record<string, string> = {};
    for (const item of relations) localKb[item.text] = '# body';
    fs.writeFileSync(path.join(kbDir, group, 'index.json'), JSON.stringify(localKb), 'utf-8');
  }
  fs.writeFileSync(
    path.join(kbDir, 'relations-cache.json'),
    JSON.stringify({ version: 1, scope, partition_config: {}, groups: cacheGroups, updatedAt: new Date().toISOString() }),
    'utf-8',
  );
}

let seq = 0;
function freshScope(): string {
  const scope = `dr-relvec-${Date.now()}-${seq++}`;
  registerTestScope(scope);
  return scope;
}

function resetMocks(): void {
  deleteCalls.length = 0;
  existingIds = new Set();
  searchHits = [];
  searchThrows = false;
}

after(() => cleanupTestConfig());

describe('delete-relation 清理路径向量（ki-relation）', () => {
  it('删除 Relation 时把可重算的路径向量 docId 一并删除', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '告警收敛策略', memoryIds: ['content-1'] }] });
    const expectedId = vectorClient.generateDocId('告警收敛策略', scope, 'ki-relation');
    existingIds.add(expectedId);

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '告警收敛策略' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;

    assert.ok(deleteCalls.flat().includes(expectedId), `路径向量 docId 应进入删除清单，实际：${JSON.stringify(deleteCalls)}`);
    assert.equal(outcome.result.relationVectorRemoved, true);
    assert.equal(outcome.result.relationVectorDeleted, 1);
    assert.equal(outcome.result.relationVectorReason, undefined);
  });

  it('同名 relation 仍在其他组 → 路径向量保留（docId 跨组共享，删了会误伤）', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, {
      g1: [{ text: '共享关系名', memoryIds: ['content-a'] }],
      g2: [{ text: '共享关系名', memoryIds: ['content-b'] }],
    });
    const expectedId = vectorClient.generateDocId('共享关系名', scope, 'ki-relation');
    existingIds.add(expectedId);

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '共享关系名' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;

    assert.ok(!deleteCalls.flat().includes(expectedId), '其他组仍持有同名 relation，不得删共享路径向量');
    assert.equal(outcome.result.relationVectorRemoved, false);
    assert.match(String(outcome.result.relationVectorReason ?? ''), /共享/);
    assert.match(String(outcome.result.relationVectorReason ?? ''), /g2/);
  });

  it('有 memoryIds 却查不到路径向量 → 不阻断删除，但显式说明试过的形态', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '无路径向量文档', memoryIds: ['content-x'] }] });

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '无路径向量文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.equal(outcome.result.deleted, true, '主删除不受影响');
    assert.equal(outcome.result.relationVectorRemoved, false);
    // 2026-11-16 复核：cache 声称写过内容向量（memoryIds 非空）却没有路径向量，
    // 属于可疑不一致（历史形态 / 摘除失败）。过去这里静默返回 relationVectorDeleted:0，
    // 让人误以为「兜底都跑过了」——现在必须说明尝试过哪三种形态。
    assert.match(String(outcome.result.relationVectorReason ?? ''), /三种形态/);
  });

  it('纯 FTS-only（无 memoryIds）→ 未命中不写原因（本就没有路径向量）', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '全文文档' }] });

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '全文文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.equal(outcome.result.relationVectorRemoved, false);
    assert.equal(outcome.result.relationVectorReason, undefined, '无向量记录时未命中属正常，不制造噪声');
  });

  it('分块导入的路径向量（relation-01）按后缀形态重算删除', async () => {
    resetMocks();
    const scope = freshScope();
    // 两个 chunk ⇒ import 写出的路径向量文本是 `分块文档-01` / `分块文档-02`
    seedScope(scope, { g1: [{ text: '分块文档', memoryIds: ['chunk-1', 'chunk-2'] }] });
    const chunkPathId = vectorClient.generateDocId('分块文档-01', scope, 'ki-relation');
    existingIds.add(chunkPathId);
    existingIds.add('chunk-1');
    existingIds.add('chunk-2');

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '分块文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.ok(
      deleteCalls.flat().includes(chunkPathId),
      `分块路径向量 docId 应进入删除清单（过去只算纯名，必然漏删），实际：${JSON.stringify(deleteCalls)}`,
    );
    assert.equal(outcome.result.relationVectorDeleted, 1);
  });

  it('分块后缀未命中时，兜底检索能识别 relation-NN 并删除', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '后缀文档', memoryIds: ['chunk-a'] }] });
    existingIds.add('chunk-a');
    existingIds.add('suffix-hit');
    searchHits = [
      { memoryId: 'suffix-hit', content: '后缀文档-02', tag: 'ki-relation' },
      { memoryId: 'unrelated', content: '后缀文档的补充说明', tag: 'ki-relation' },
    ];

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '后缀文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    const flat = deleteCalls.flat();
    assert.ok(flat.includes('suffix-hit'), `relation-NN 形态应被兜底识别：${JSON.stringify(deleteCalls)}`);
    assert.ok(!flat.includes('unrelated'), '非「名称-两位数字」的条目不得误删');
  });

  it('兜底检索失败只降级：ok 仍为 true 并给出原因', async () => {
    resetMocks();
    searchThrows = true;
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '兜底失败文档', memoryIds: ['content-y'] }] });

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '兜底失败文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.equal(outcome.result.deleted, true);
    assert.equal(outcome.result.relationVectorRemoved, false);
    assert.match(String(outcome.result.relationVectorReason ?? ''), /兜底失败/);
  });

  it('兜底检索命中以 relation 名开头的路径向量时删除之，且不误删无关条目', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '历史形态文档', memoryIds: ['content-z'] }] });
    // 历史文本形态（`relation | Group: g`）的 docId 与重算值不同 ⇒ 直接删除必未命中，只能靠检索兜底
    existingIds.add('content-z');        // 内容向量存在 ⇒ 不会走 deleteBySearch 兜底（模拟常规场景）
    existingIds.add('old-path-vector');
    searchHits = [
      { memoryId: 'old-path-vector', content: '历史形态文档 | Group: g1', tag: 'ki-relation' },
      { memoryId: 'unrelated', content: '别的文档', tag: 'ki-relation' },
    ];

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '历史形态文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    const flat = deleteCalls.flat();
    assert.ok(flat.includes('old-path-vector'), '历史形态路径向量应被兜底删除');
    assert.ok(!flat.includes('unrelated'), '不得误删仅标签相同但内容无关的向量');
    assert.equal(outcome.result.relationVectorRemoved, true);
    assert.equal(outcome.result.relationVectorDeleted, 1);
  });
});
