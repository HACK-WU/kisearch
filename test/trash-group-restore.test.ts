/**
 * trash-group-restore.test.ts —— 组条目恢复（REQ-20261123-005 · S04）
 *
 * 覆盖四件事：
 *   ① 完整恢复：树节点（含子组）+ 各篇正文/元数据 + 附件 + 索引重建登记全部回来，条目出站；
 *   ② 目标组已存在且非空 → **整组拒绝**，不动任何数据、条目仍在；
 *   ③ 部分失败：子组里已有同名文档 → 该篇 failed，其余照常恢复，条目收缩后保留；
 *   ④ 分派入口 `restoreAnyFromTrash` 能按 kind 走到组分支。
 *
 * 未覆盖：event 已删除后降级为 wiki（需造事件库），见设计 S04 决策点。
 * 运行：npx jiti test/trash-group-restore.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

const vectorClient = await import('../src/lib/vector-client.js');
(vectorClient as any).vectorDelete = async (params: { scope: string; ids: string[] }) =>
  vectorClient.normalizeVectorDeleteResult(params.ids, { ok: params.ids.length, errors: [] });
(vectorClient as any).vectorListAuxDocsByGroups = async () => ({ docs: [], truncated: false });

const { executeGroupDelete } = await import('../src/lib/group-delete.js');
const { ensureScopeDir, writeJson, readJson, readGroupIndex } = await import('../src/lib/store.js');
const { getKbDir, getLocalKbDir, getAssetsDir, getGroupIndexPath } = await import('../src/lib/scope.js');
const { loadGroupCache, writeGroupCache } = await import('../src/lib/group-cache.js');
const { listTrash } = await import('../src/lib/trash-store.js');
const { restoreGroupFromTrash, restoreAnyFromTrash } = await import('../src/lib/trash-service.js');

after(() => cleanupTestConfig());

const ROOT = '项目';
const SUB = '项目/网络';

function setupGroup(scope: string, tree: Record<string, unknown>, relations: Record<string, unknown>): void {
  ensureScopeDir(scope);
  const kbDir = getKbDir(scope);
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-gr-restore-src-'));
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

function writeKb(scope: string, group: string, docs: Record<string, string>): void {
  const kbPath = getLocalKbDir(scope, group);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  writeJson(kbPath, docs);
}

function writeAssets(scope: string, group: string, file: string): void {
  const dir = getAssetsDir(scope, group);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), 'png-bytes');
}

function mkRel(id: string, text: string) {
  return { id, text, score: 2, useCount: 3, lastUsedTime: null, isImported: true };
}

/** 造一个「两个组、三篇文档（其中一个只在 KB 里）+ 两份附件」的 scope */
function seedFull(scope: string): void {
  setupGroup(scope, { 项目: { 网络: {} } }, {
    项目: { hot_relations: [mkRel('r1', 'doc-a')], keywords: [] },
    [SUB]: { hot_relations: [mkRel('r2', 'doc-b')], keywords: [] },
  });
  writeKb(scope, ROOT, { 'doc-a': '正文 A' });
  writeKb(scope, SUB, { 'doc-b': '正文 B', 'doc-c': '只在 KB 里的 C' });
  writeAssets(scope, ROOT, 'a.png');
  writeAssets(scope, SUB, 'b.png');
}

describe('组条目恢复（S04）', () => {
  it('完整恢复：树 + 正文 + 元数据 + 附件 + 索引登记，条目出站', async () => {
    const scope = 'gr-restore-a';
    registerTestScope(scope);
    seedFull(scope);

    const deleted = await executeGroupDelete({ scope, path: ROOT });
    assert.equal(deleted.ok, true, deleted.error);
    assert.ok(deleted.trash);
    assert.equal(listTrash(scope).total, 1, '删完应有一条组条目');

    const restored = restoreGroupFromTrash({ scope, group: ROOT, dirName: deleted.trash!.dirName });
    assert.equal(restored.ok, true, restored.ok ? '' : restored.error);
    if (!restored.ok) return;
    assert.equal(restored.kind, 'group');
    assert.equal(restored.failed.length, 0, JSON.stringify(restored.failed));
    assert.equal(restored.restored.docs, 3, 'doc-c 只在 KB 里，也必须被恢复');
    assert.equal(restored.rebuild, 'pending');

    // 树节点（含子组）
    const index = readGroupIndex(scope);
    assert.ok(index?.groups?.['项目'], '被删组必须回到树里');
    assert.ok((index!.groups['项目'] as Record<string, unknown>)['网络'], '子组也必须回树');

    // 正文
    const kbRoot = readJson<Record<string, string>>(getLocalKbDir(scope, ROOT)) ?? {};
    assert.equal(kbRoot['doc-a'], '正文 A');
    const kbSub = readJson<Record<string, string>>(getLocalKbDir(scope, SUB)) ?? {};
    assert.equal(kbSub['doc-b'], '正文 B');
    assert.equal(kbSub['doc-c'], '只在 KB 里的 C');

    // 元数据（快照里的 id 与统计要带回来）
    const cacheRoot = loadGroupCache(scope, ROOT);
    const relA = cacheRoot?.hot_relations.find((rel) => rel.text === 'doc-a');
    assert.equal(relA?.id, 'r1');
    assert.equal(relA?.useCount, 3);

    // 附件（按 group 一份）
    assert.equal(fs.readFileSync(path.join(getAssetsDir(scope, ROOT), 'a.png'), 'utf8'), 'png-bytes');
    assert.equal(fs.readFileSync(path.join(getAssetsDir(scope, SUB), 'b.png'), 'utf8'), 'png-bytes');

    // 索引重建登记（整组一次写）
    const pending = readJson<{ items: Array<{ group: string; relation: string }> }>(
      path.join(getKbDir(scope), '.visibility-pending.json'),
    );
    assert.equal(pending?.items.length, 3);

    // 条目已出站
    assert.equal(listTrash(scope).total, 0, '全部恢复后条目必须移出回收站');
  });

  it('目标组已存在且非空 → 整组拒绝，不动数据、条目仍在', async () => {
    const scope = 'gr-restore-b';
    registerTestScope(scope);
    seedFull(scope);

    const deleted = await executeGroupDelete({ scope, path: ROOT });
    assert.equal(deleted.ok, true, deleted.error);

    // 用户又建了个同名组并写了一篇 —— 恢复必须拒绝，而不是合并出一团乱麻
    // 注意：树节点也要真的建出来，否则「目标组已存在」这个前提不成立
    const rebuiltIndex = readGroupIndex(scope)!;
    rebuiltIndex.groups['项目'] = {};
    writeJson(getGroupIndexPath(scope), rebuiltIndex as unknown as Record<string, unknown>);

    const kbPath = getLocalKbDir(scope, ROOT);
    fs.mkdirSync(path.dirname(kbPath), { recursive: true });
    writeJson(kbPath, { 'new-doc': '新建的正文' });
    writeGroupCache(scope, ROOT, {
      version: 1,
      scope,
      hot_relations: [mkRel('r9', 'new-doc')] as never,
      keywords: [],
      updatedAt: null,
    } as never);

    const outcome = restoreGroupFromTrash({ scope, group: ROOT, dirName: deleted.trash!.dirName });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, 'RESTORE_NAME_CONFLICT');

    const kb = readJson<Record<string, string>>(getLocalKbDir(scope, ROOT)) ?? {};
    assert.deepEqual(Object.keys(kb).filter((k) => k !== 'version' && k !== 'updatedAt'), ['new-doc']);
    assert.equal(listTrash(scope).total, 1, '拒绝时条目不能消失');
  });

  it('部分失败：子组已有同名文档 → 该篇 failed，其余恢复，条目收缩后保留', async () => {
    const scope = 'gr-restore-c';
    registerTestScope(scope);
    seedFull(scope);

    const deleted = await executeGroupDelete({ scope, path: ROOT });
    assert.equal(deleted.ok, true, deleted.error);

    // 只在**子组**里造同名（被删组自身仍不在树里，所以冲突判定放行）
    writeGroupCache(scope, SUB, {
      version: 1,
      scope,
      hot_relations: [mkRel('r8', 'doc-b')] as never,
      keywords: [],
      updatedAt: null,
    } as never);

    const outcome = restoreGroupFromTrash({ scope, group: ROOT, dirName: deleted.trash!.dirName });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
    if (!outcome.ok) return;
    assert.equal(outcome.restored.docs, 2, 'doc-a 与 doc-c 应恢复');
    assert.equal(outcome.failed.length, 1);
    assert.equal(outcome.failed[0].name, 'doc-b');
    assert.equal(outcome.failed[0].code, 'RESTORE_NAME_CONFLICT');

    // 条目还在（还剩 1 篇没恢复），但已收缩
    const items = listTrash(scope).items;
    assert.equal(items.length, 1);
    assert.equal(items[0].groupSnapshot?.docCount, 1);
  });

  it('restoreAnyFromTrash 按 kind 分派到组分支', async () => {
    const scope = 'gr-restore-d';
    registerTestScope(scope);
    seedFull(scope);

    const deleted = await executeGroupDelete({ scope, path: ROOT });
    assert.equal(deleted.ok, true, deleted.error);

    const outcome = restoreAnyFromTrash({ scope, group: ROOT, dirName: deleted.trash!.dirName });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
    if (!outcome.ok) return;
    assert.equal((outcome as { kind?: string }).kind, 'group');
  });
});
