/**
 * visibility-dense-delete.test.ts —— hidden 摘除必须核对「真的摘干净了」（事件 #37 回归）
 *
 * 背景（`.debug/delete-vector-residual-20261116` E-04）：
 * `applyVisibility` 的 dense 分支过去只看 `vectorDelete.errors`，`deleted === 0`（cache 的
 * memoryIds 全部失效）时照样 `removed.push('dense')` —— 实测后果是「接口返回
 * visibilityFailed:[] 且 mode=hidden，但该文档的 ki-search 向量仍在库里，ki search 直接召回」。
 * hidden 是隔离语义，少摘一条就是一次静默数据泄漏，且读侧没有任何兜底能发现。
 *
 * 覆盖：
 *   ① ids 命中 → 直接摘除，不付 embedding 成本；
 *   ② ids 全部失效 → 用正文重算 docId 补删（精确、不调用 embedding）；
 *   ③ 重算未覆盖（chunk / 清洗差异）→ 检索后按正文比对补删；
 *   ④ 检索命中却删不掉 → 记 failed 并写失败诊断，绝不谎报成功；
 *   ⑤ 无 ids → skipped（本就没有向量）。
 *
 * Mock 策略：先 import vector-client 再 patch 导出函数（ESM live binding），离线可跑。
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/visibility-dense-delete.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';

const vectorClient = await import('../src/lib/vector-client.js');

const deleteCalls: string[][] = [];
let existingIds = new Set<string>();
let contentHits: { memoryId: string; content: string; tag?: string }[] = [];
let failDeletes = false;
let contentSearched = 0;

(vectorClient as any).ensureVectorAvailable = async () => ({ available: true });
(vectorClient as any).vectorDelete = async (params: { ids: string[] }) => {
  deleteCalls.push([...params.ids]);
  if (failDeletes) return { deleted: 0, failedIds: [...params.ids], errors: [] };
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
  if (tagList.includes('ki-relation') || tagList.includes('ki-path')) return [];
  contentSearched += 1;
  return contentHits;
};
(vectorClient as any).closeEngine = async () => {};

const { applyVisibility, failureFilePath: _failureFilePath } = await import('../src/lib/visibility-index.js');
const { failureFilePath } = await import('../src/lib/visibility-index.js');
const { initScope, readJson, writeJson } = await import('../src/lib/store.js');
const { getKbDir, getLocalKbDir } = await import('../src/lib/scope.js');
const { loadGroupCache, writeGroupCache } = await import('../src/lib/group-cache.js');
import type { Relation } from '../src/lib/scoring.js';

const GROUP = '错误库/向量核对';
const BODY = '# 完全不同的标题\n\n正文关键词：ORNITHOPTER hidden 摘除核对。\n\n## 小节\n\n补充内容。';

function seed(scope: string, name: string, extra: Partial<Relation> = {}): void {
  const rel: Relation = {
    id: `rel_${name.length}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: true,
    ...extra,
  };
  const doc = loadGroupCache(scope, GROUP) ?? { version: 1, scope, hot_relations: [], keywords: [], updatedAt: null };
  doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
  doc.hot_relations.push(rel);
  writeGroupCache(scope, GROUP, doc);

  // ⚠️ getLocalKbDir 返回的就是 index.json 文件路径（不是目录）
  const kbPath = getLocalKbDir(scope, GROUP);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  const kb = readJson<Record<string, string>>(kbPath) ?? {};
  kb[name] = BODY;
  writeJson(kbPath, kb);
}

let seq = 0;
function freshScope(): string {
  const scope = `vis-dense-${Date.now()}-${seq++}`;
  registerTestScope(scope);
  initScope(scope);
  return scope;
}

function resetMocks(): void {
  deleteCalls.length = 0;
  existingIds = new Set();
  contentHits = [];
  failDeletes = false;
  contentSearched = 0;
}

after(() => cleanupTestConfig());

describe('applyVisibility · dense 摘除核对', () => {
  it('ids 命中 → 直接摘除，不触发检索', async () => {
    resetMocks();
    const scope = freshScope();
    seed(scope, '正常文档', { memoryIds: ['live-id'] });
    existingIds.add('live-id');

    const result = await applyVisibility({ scope, group: GROUP, relation: '正常文档', to: 'hidden', from: 'full' });
    assert.deepEqual(result.failed, []);
    assert.ok(result.removed.includes('dense'), 'dense 应记为已摘除');
    assert.equal(contentSearched, 0, '正常路径不付 embedding 成本');
  });

  it('ids 全部失效（删 0 条）→ 用正文重算 docId 补删，不得谎报成功', async () => {
    resetMocks();
    const scope = freshScope();
    seed(scope, '漂移文档', { memoryIds: ['stale-id'] });
    const realId = vectorClient.generateDocId(BODY, scope, 'ki-search');
    existingIds.add(realId);

    const result = await applyVisibility({ scope, group: GROUP, relation: '漂移文档', to: 'hidden', from: 'full' });
    assert.deepEqual(result.failed, []);
    assert.ok(result.removed.includes('dense'));
    assert.ok(deleteCalls.flat().includes(realId), `正文重算的 docId 必须被删：${JSON.stringify(deleteCalls)}`);
    assert.equal(existingIds.has(realId), false, '库里不得再剩该文档的内容向量');
  });

  it('重算未覆盖时按正文比对检索补删（正文标题与 relation 名不同也能摘干净）', async () => {
    resetMocks();
    const scope = freshScope();
    seed(scope, '标题不一致文档', { memoryIds: ['stale-id'] });
    contentHits = [
      // 真实 chunk 远长于判据阈值（MIN_CONTENT_MATCH_LEN=40），用整篇正文模拟「单 chunk 文档」
      { memoryId: 'chunk-vec', content: BODY, tag: 'ki-search' },
      { memoryId: 'other-vec', content: '与本文无关的内容片段，用于验证不会误删他人向量。', tag: 'ki-search' },
    ];
    existingIds.add('chunk-vec');
    existingIds.add('other-vec');

    const result = await applyVisibility({ scope, group: GROUP, relation: '标题不一致文档', to: 'hidden', from: 'full' });
    assert.deepEqual(result.failed, []);
    const flat = deleteCalls.flat();
    assert.ok(flat.includes('chunk-vec'), `正文比对应命中 chunk 向量：${JSON.stringify(deleteCalls)}`);
    assert.ok(!flat.includes('other-vec'), '不得误删无关向量');
  });

  it('检索命中但删除未生效 → 记 failed 并写失败诊断（绝不谎报已隐藏）', async () => {
    resetMocks();
    const scope = freshScope();
    seed(scope, '删不掉的文档', { memoryIds: ['stale-id'] });
    contentHits = [{ memoryId: 'stuck-vec', content: BODY, tag: 'ki-search' }];
    existingIds.add('stuck-vec');
    failDeletes = true;

    const result = await applyVisibility({ scope, group: GROUP, relation: '删不掉的文档', to: 'hidden', from: 'full' });
    assert.ok(result.failed.includes('dense'), '删不掉必须落 failed，不能假装成功');
    assert.equal(result.removed.includes('dense'), false);
    const failures = readJson<{ items: Array<{ kind: string; code: string }> }>(failureFilePath(scope));
    assert.ok(failures?.items?.some((i) => i.kind === 'dense' && i.code === 'DENSE_DELETE_FAILED'), '失败要落诊断文件');
  });

  it('无 ids → skipped（本就没有向量，不算失败也不额外检索）', async () => {
    resetMocks();
    const scope = freshScope();
    seed(scope, '无索引文档');

    const result = await applyVisibility({ scope, group: GROUP, relation: '无索引文档', to: 'hidden', from: 'full' });
    assert.deepEqual(result.failed, []);
    assert.ok(result.skipped.some((s) => s.kind === 'dense' && s.reason === 'no-dense-ids'));
    assert.equal(contentSearched, 0);
  });

  it('自定义 tag 的内容向量一并重算摘除（多 tag 各一条 docId）', async () => {
    resetMocks();
    const scope = freshScope();
    seed(scope, '多标签摘除文档', { memoryIds: ['stale-a', 'stale-b'], tags: ['api'] });
    const mainId = vectorClient.generateDocId(BODY, scope, 'ki-search');
    const tagId = vectorClient.generateDocId(BODY, scope, 'api');
    existingIds.add(mainId);
    existingIds.add(tagId);

    const result = await applyVisibility({ scope, group: GROUP, relation: '多标签摘除文档', to: 'hidden', from: 'full' });
    assert.deepEqual(result.failed, []);
    const flat = deleteCalls.flat();
    assert.ok(flat.includes(mainId) && flat.includes(tagId), `两个 tag 都要摘：${JSON.stringify(deleteCalls)}`);
    assert.equal(existingIds.size, 0, '库里不得再剩该文档的任何内容向量');
  });

});
