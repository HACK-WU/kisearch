/**
 * group-delete-trash.test.ts —— 组删除入站（REQ-20261123-005 · S03）
 *
 * 锁住四件事：
 *   ① 删非空组时**先入站**：回收站里出现一条 `kind='group'` 的整组快照，回执带 `trash`；
 *   ② 篇目取「分片键 ∪ KB 键」并集 —— 只在 KB 里的文档也必须进快照，否则会被 `rmSync` 永久删掉；
 *   ③ KB 顶层的 `version` / `updatedAt` 是 `writeJson` 注入的元字段，**不是文档**，不能进快照；
 *   ④ `KI_TRASH_DISABLED=1` 走旧行为：不进站、回执无 `trash`；
 *   ⑤ 组路径含保留段 `.trash` 在 plan 阶段就拒绝（否则 `rmSync(kbDir/.trash)` 会删掉整个回收站）。
 *
 * 未覆盖（需故障注入，当前用例不含）：窗口 1 之后的失败保留快照、窗口 1 本身的失败回滚快照。
 * 运行：npx jiti test/group-delete-trash.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

const vectorClient = await import('../src/lib/vector-client.js');
// 不启动向量引擎：删组会清扫 dense 向量与辅助向量，这里直接给空结果
(vectorClient as any).vectorDelete = async (params: { scope: string; ids: string[] }) =>
  vectorClient.normalizeVectorDeleteResult(params.ids, { ok: params.ids.length, errors: [] });
(vectorClient as any).vectorListAuxDocsByGroups = async () => ({ docs: [], truncated: false });

const { planGroupDelete, executeGroupDelete } = await import('../src/lib/group-delete.js');
const { ensureScopeDir, writeJson } = await import('../src/lib/store.js');
const { getKbDir, getLocalKbDir } = await import('../src/lib/scope.js');
const { listTrash, readGroupSnapshotDocs } = await import('../src/lib/trash-store.js');

after(() => cleanupTestConfig());

function setupGroup(scope: string, tree: Record<string, unknown>, relations: Record<string, unknown>): void {
  ensureScopeDir(scope);
  const kbDir = getKbDir(scope);
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-gd-trash-src-'));
  fs.writeFileSync(path.join(kbDir, 'group-index.json'), JSON.stringify({
    version: 1,
    scope,
    groups: tree,
    source: { dir: sourceDir },
    updatedAt: new Date().toISOString(),
  }), 'utf-8');
  fs.writeFileSync(path.join(kbDir, 'relations-cache.json'), JSON.stringify({
    version: 1,
    scope,
    partition_config: {},
    groups: relations,
    updatedAt: new Date().toISOString(),
  }), 'utf-8');
}

/** 真实 KB 由 writeJson 落盘，会自动带 version / updatedAt —— 正好用来验证元字段不被当成文档 */
function writeKb(scope: string, group: string, docs: Record<string, string>): void {
  const kbPath = getLocalKbDir(scope, group);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  writeJson(kbPath, docs);
}

function mkRel(id: string, text: string) {
  return { id, text, score: 1, useCount: 0, lastUsedTime: null, isImported: true };
}

describe('组删除入站（S03）', () => {
  it('删非空组：先入站，回执带 trash，回收站能读出整组（含只在 KB 里的文档）', async () => {
    const scope = 'gd-trash-a';
    registerTestScope(scope);
    setupGroup(scope, { 项目: { 网络: {} } }, {
      项目: { hot_relations: [mkRel('r1', 'doc-a')], keywords: [] },
      '项目/网络': { hot_relations: [mkRel('r2', 'doc-b')], keywords: [] },
    });
    writeKb(scope, '项目', { 'doc-a': '正文 A' });
    writeKb(scope, '项目/网络', { 'doc-b': '正文 B', 'doc-c': '只在 KB 里的 C' });

    const result = await executeGroupDelete({ scope, path: '项目' });
    assert.equal(result.ok, true, result.error);
    assert.ok(result.trash, '删组必须给入站回执，否则前端无从告知可恢复');
    assert.equal(result.trash!.docs, 3, 'doc-c 只在 KB 里，取并集后必须进快照');
    assert.equal(result.trash!.reason, 'manual');
    assert.ok(result.trash!.expiresAt > Date.now());

    const groupItems = listTrash(scope).items.filter((entry) => entry.kind === 'group');
    assert.equal(groupItems.length, 1, '回收站里应恰好一条组条目');
    const docs = readGroupSnapshotDocs(scope, '项目', result.trash!.dirName);
    const names = docs.map((entry) => entry.doc?.name).sort();
    assert.deepEqual(names, ['doc-a', 'doc-b', 'doc-c']);
    assert.equal(names.includes('version'), false, 'version 是 writeJson 注入的元字段');
    assert.equal(names.includes('updatedAt'), false, 'updatedAt 是 writeJson 注入的元字段');
    assert.equal(docs.find((d) => d.doc?.name === 'doc-c')?.doc?.source, 'kb-only');
  });

  it('KI_TRASH_DISABLED=1：不进站，回执无 trash', async () => {
    const scope = 'gd-trash-b';
    registerTestScope(scope);
    setupGroup(scope, { 临时: {} }, {
      临时: { hot_relations: [mkRel('r3', 'x')], keywords: [] },
    });
    writeKb(scope, '临时', { x: '正文 X' });

    process.env.KI_TRASH_DISABLED = '1';
    try {
      const result = await executeGroupDelete({ scope, path: '临时' });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.trash, undefined, '未进站时不能谎报可恢复');
      assert.equal(listTrash(scope).total, 0);
    } finally {
      delete process.env.KI_TRASH_DISABLED;
    }
  });

  it('组路径含保留段 .trash：plan 阶段拒绝（否则会删掉整个回收站）', async () => {
    const scope = 'gd-trash-c';
    registerTestScope(scope);
    setupGroup(scope, { '.trash': {} }, {});
    const plan = await planGroupDelete({ scope, path: '.trash' });
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.equal(plan.code, 'INVALID_PATH');
  });
});
