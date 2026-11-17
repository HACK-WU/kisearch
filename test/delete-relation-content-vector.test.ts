/**
 * delete-relation-content-vector.test.ts —— 删除 Relation 必须清掉**内容向量**（事件 #36 回归）
 *
 * 背景（`.debug/delete-vector-residual-20261116`）：
 * 内容向量 docId = `sha256(正文 + scope + tag)`，写入侧只在成功时回写 cache。一旦回落失败
 * 或写入形态切换，`memoryIds` 就指向不存在的 id；而旧的兜底判据要求「relation 名作为标题
 * 前缀出现」—— 正文标题与文件名不一致的文档因此**必然漏删**，删完 `ki search` 仍能召回。
 *
 * 覆盖三层（按可靠性排序）：
 *   ① memoryIds 命中；
 *   ② memoryIds 失效 → 用删除前读到的正文**重算 docId**（精确、不调用 embedding）；
 *   ③ 重算也没覆盖（chunk / 清洗差异）→ 语义检索后按「正文包含候选内容」判定归属。
 * 另覆盖组内清空后的 `ki-path`（组级路径向量）孤儿清理。
 *
 * Mock 策略：先 import vector-client 再 patch 导出函数（ESM live binding），离线可跑。
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/delete-relation-content-vector.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

const vectorClient = await import('../src/lib/vector-client.js');

const deleteCalls: string[][] = [];
let existingIds = new Set<string>();
/** 内容检索（无限定 tag 或 tags 不含 ki-path）返回的命中 */
let searchHits: { memoryId: string; content: string; tag?: string }[] = [];
/** ki-path 专用检索返回的命中（deletePathVector 走 tags:'ki-path'） */
let pathHits: { memoryId: string; content: string; tag?: string }[] = [];
/** ki-relation 路径向量检索返回的命中（deleteRelationVector 兜底走 tags:['ki-relation']） */
let relationHits: { memoryId: string; content: string; tag?: string }[] = [];
let pathSearched = 0;
/** 指定 id 模拟底层删除失败（真实 vectorDelete 的 errors 已过滤 NOT_FOUND ⇒ 非空即真失败） */
let errorOnIds = new Set<string>();
/** 内容检索次数（非 ki-path）：用于断言「正常路径不付 embedding 成本」 */
let contentSearched = 0;

(vectorClient as any).ensureVectorAvailable = async () => ({ available: true });
(vectorClient as any).vectorDelete = async (params: { ids: string[] }) => {
  deleteCalls.push([...params.ids]);
  const failedHere = params.ids.filter((id) => errorOnIds.has(id));
  if (failedHere.length > 0) {
    return {
      deleted: params.ids.filter((id) => existingIds.has(id) && !errorOnIds.has(id)).length,
      failed: failedHere.length,
      failedIds: failedHere,
      notFoundIds: [],
      errors: failedHere.map((id) => ({ id, code: 'WRITE_FAILED', reason: 'mock 底层失败' })),
    };
  }
  const present = params.ids.filter((id) => existingIds.has(id));
  for (const id of present) existingIds.delete(id);
  return {
    deleted: present.length,
    failedIds: params.ids.filter((id) => !present.includes(id)),
    errors: [],
  };
};
(vectorClient as any).vectorSearch = async (params: { tags?: string | string[] }) => {
  const tags = params?.tags;
  const tagList = Array.isArray(tags) ? tags : tags ? [String(tags)] : [];
  if (tagList.includes('ki-path')) {
    pathSearched += 1;
    return pathHits;
  }
  if (tagList.includes('ki-relation')) return relationHits;
  contentSearched += 1;
  return searchHits;
};
(vectorClient as any).closeEngine = async () => {};

const { executeDeleteRelation } = await import('../src/delete-relation.js');
const { ensureScopeDir } = await import('../src/lib/store.js');
const { getKbDir } = await import('../src/lib/scope.js');

const BODY = '# 完全不同的标题\n\n这是正文，首行标题与关系名不一致。关键词：ORNITHOPTER 残留标记。\n\n## 小节\n\n补充。';

/** 铺 KB / cache（group-index + relations-cache + local-kb），正文可指定 */
function seedScope(
  scope: string,
  groups: Record<string, { text: string; memoryIds?: string[]; tags?: string[]; body?: string }[]>,
): void {
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
        isImported: true,
        ...(r.memoryIds ? { memoryIds: r.memoryIds } : {}),
        ...(r.tags ? { tags: r.tags } : {}),
      })),
      keywords: [],
    };
    fs.mkdirSync(path.join(kbDir, group), { recursive: true });
    const localKb: Record<string, string> = {};
    for (const item of relations) localKb[item.text] = item.body ?? BODY;
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
  const scope = `dr-content-${Date.now()}-${seq++}`;
  registerTestScope(scope);
  return scope;
}

function resetMocks(): void {
  deleteCalls.length = 0;
  existingIds = new Set();
  searchHits = [];
  pathHits = [];
  relationHits = [];
  pathSearched = 0;
  contentSearched = 0;
  errorOnIds = new Set();
}

after(() => cleanupTestConfig());

describe('delete-relation 清理内容向量（三层兜底）', () => {
  it('memoryIds 命中 → 直接删除，不走重算与检索', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '正常文档', memoryIds: ['live-id'] }] });
    existingIds.add('live-id');

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '正常文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.equal(outcome.result.memRemoved, true);
    assert.equal(outcome.result.memMethod, 'memoryId');
    assert.ok(deleteCalls.flat().includes('live-id'));
    // 未触发内容检索（零 embedding 成本）
    assert.equal(contentSearched, 0);
  });

  it('memoryIds 全部失效 → 用删除前读到的正文重算 docId 精确补删', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '漂移文档', memoryIds: ['stale-id'] }] });
    const realId = vectorClient.generateDocId(BODY, scope, 'ki-search');
    existingIds.add(realId);

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '漂移文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.ok(
      deleteCalls.flat().includes(realId),
      `正文重算的 docId 应进入删除清单，实际：${JSON.stringify(deleteCalls)}`,
    );
    assert.equal(outcome.result.memRemoved, true);
    assert.equal(outcome.result.memMethod, 'memoryId', '重算命中仍属按 id 删除');
  });

  it('自定义 tag 的内容向量也要一并重算删除（多 tag 各有独立 docId）', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '多标签文档', memoryIds: ['stale-a', 'stale-b'], tags: ['api'] }] });
    const mainId = vectorClient.generateDocId(BODY, scope, 'ki-search');
    const tagId = vectorClient.generateDocId(BODY, scope, 'api');
    existingIds.add(mainId);
    existingIds.add(tagId);

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '多标签文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    const flat = deleteCalls.flat();
    assert.ok(flat.includes(mainId) && flat.includes(tagId), `两个 tag 的 docId 都要删：${JSON.stringify(deleteCalls)}`);
  });

  it('正文标题与 relation 名不一致 + memoryIds 失效 → 检索按正文比对兜底删除（旧判据必漏）', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '标题不一致文档', memoryIds: ['stale-id'] }] });
    // 重算未覆盖（模拟导入切 chunk 后的形态）
    searchHits = [
      // 真实 chunk 远长于判据阈值（MIN_CONTENT_MATCH_LEN=40），这里用整篇正文模拟「单 chunk 文档」
      { memoryId: 'chunk-vec-1', content: BODY, tag: 'ki-search' },
      { memoryId: 'unrelated-vec', content: '另一篇文档的正文，与本次删除无关，用于验证不会误删他人向量。', tag: 'ki-search' },
    ];
    existingIds.add('chunk-vec-1');
    existingIds.add('unrelated-vec');

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '标题不一致文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    const flat = deleteCalls.flat();
    assert.ok(flat.includes('chunk-vec-1'), `正文比对应命中 chunk 向量：${JSON.stringify(deleteCalls)}`);
    assert.ok(!flat.includes('unrelated-vec'), '不得误删无关文档的内容向量');
    assert.equal(outcome.result.memRemoved, true);
    assert.equal(outcome.result.memMethod, 'search');
  });

  it('检索命中内容与正文无关且标题不匹配 → 不误删，并说明是哪种判据失败', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '无匹配文档', memoryIds: ['stale-id'] }] });
    searchHits = [{ memoryId: 'other-vec', content: '完全不相干的一段内容文本，用于验证不会误删他人向量。', tag: 'ki-search' }];
    existingIds.add('other-vec');

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '无匹配文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.ok(!deleteCalls.flat().includes('other-vec'));
    assert.equal(outcome.result.memRemoved, false);
    assert.match(String(outcome.result.reason ?? ''), /正文与候选内容不一致/);
  });

  it('组内最后一篇被删 → 清掉组级路径向量（ki-path 孤儿）', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '末篇文档', memoryIds: ['live-id'], body: 'g1' }] });
    existingIds.add('live-id');
    existingIds.add('path-vec');
    pathHits = [{ memoryId: 'path-vec', content: 'g1', tag: 'ki-path' }];

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '末篇文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.equal(pathSearched >= 1, true, '应当查询组路径向量');
    assert.ok(deleteCalls.flat().includes('path-vec'), `ki-path 孤儿应被清理：${JSON.stringify(deleteCalls)}`);
    assert.equal(outcome.result.groupPathVectorRemoved, true);
  });

  it('组内还有其他文档 → 绝不碰组级路径向量（path 属于整组）', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, {
      g1: [
        { text: '待删文档', memoryIds: ['live-1'], body: 'g1' },
        { text: '保留文档', memoryIds: ['live-2'], body: 'g1' },
      ],
    });
    existingIds.add('live-1');
    existingIds.add('live-2');
    pathHits = [{ memoryId: 'path-vec', content: 'g1', tag: 'ki-path' }];
    existingIds.add('path-vec');

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '待删文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.equal(pathSearched, 0, '组里还有文档时不得查询/删除组路径向量');
    assert.ok(!deleteCalls.flat().includes('path-vec'));
    assert.equal(outcome.result.groupPathVectorRemoved, undefined);
  });

  it('memoryIds 部分命中 → 不静默成功：删除成功但 reason 显式带缺口', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '部分命中文档', memoryIds: ['live-1', 'stale-2'] }] });
    existingIds.add('live-1');

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '部分命中文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.equal(outcome.result.memRemoved, true, '删到一部分仍算已删除');
    assert.match(String(outcome.result.reason ?? ''), /仍有缺口/, '缺口必须显式报出，不能静默');
  });

  it('底层删除报错（errors 非空）→ 不当成功，reason 带失败原因', async () => {
    resetMocks();
    const scope = freshScope();
    seedScope(scope, { g1: [{ text: '报错文档', memoryIds: ['boom-id'] }] });
    existingIds.add('boom-id');
    errorOnIds.add('boom-id');

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '报错文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.equal(outcome.result.memRemoved, false, 'errors 非空不得报成功');
    assert.match(String(outcome.result.reason ?? ''), /删除失败/);
  });

  it('命中内容同时被同组其他文档正文包含 → 判为歧义放弃删除（不误删他人向量）', async () => {
    resetMocks();
    const scope = freshScope();
    // 两篇文档正文完全相同（共享模板场景）
    seedScope(scope, {
      g1: [
        { text: '歧义文档', memoryIds: ['stale-id'] },
        { text: '模板同源文档' },
      ],
    });
    searchHits = [{ memoryId: 'shared-vec', content: BODY, tag: 'ki-search' }];
    existingIds.add('shared-vec');

    const outcome = await executeDeleteRelation({ scope, group: 'g1', relation: '歧义文档' });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.ok(!deleteCalls.flat().includes('shared-vec'), '无法唯一归属的命中不得删除');
    assert.match(String(outcome.result.reason ?? ''), /无法唯一归属/);
  });

});
