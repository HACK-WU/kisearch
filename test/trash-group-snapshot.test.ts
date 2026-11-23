/**
 * trash-group-snapshot.test.ts —— 回收站组条目（REQ-20261123-005 · S02）
 *
 * 锁住三件容易写错、写错了不报错的事：
 *   ① **附件按 group 存一份**，不按文档 —— 附件是 group 级共享目录（`getAssetsDir`），
 *      按篇复制会让占用放大到 N 倍，写满盘后 fail-closed 连删除都做不了；
 *   ② **篇目集合取 relations 分片键 ∪ KB 键的并集** —— 真正删数据的是 `rmSync(kbGroupDir)`，
 *      只看分片会把「KB 有正文、分片没 relation」的文档漏在快照之外，永久丢失；
 *   ③ **存量 doc 条目没有 kind 字段**，listTrash 必须补成 'doc'（不写回磁盘）。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const fixture = path.join(process.cwd(), 'temp', `trash-group-${Date.now()}`);
fs.mkdirSync(fixture, { recursive: true });
const dataDir = path.join(fixture, 'kb');
const vectorDir = path.join(fixture, 'vector');
const configPath = path.join(fixture, 'config.json');

const scopes = ['tg-a'] as const;
fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  vectorDir,
  scopeMode: 'default',
  scopes: Object.fromEntries(scopes.map((name) => [name, {}])),
}));
process.env.KI_CONFIG_PATH = configPath;

const { resetConfigCache } = await import('../src/lib/config.js');
const { initScope, writeJson } = await import('../src/lib/store.js');
const { getLocalKbDir, getAssetsDir } = await import('../src/lib/scope.js');
const { moveGroupToTrash } = await import('../src/lib/trash-service.js');
const {
  listTrash,
  writeTrashItem,
  readGroupSnapshotDocs,
  readGroupSnapshotAssets,
  getTrashRoot,
} = await import('../src/lib/trash-store.js');

after(() => {
  // 不清理 fixture（项目约定：验证产物留在 temp 下）
});

const group = '预警分析';
const subGroup = '预警分析/网络';

/** 造三种来源各一篇：alpha=both、beta=kb-only、gamma=shard-only；两个 group 各带附件 */
function seed(scope: string): void {
  resetConfigCache();
  initScope(scope);

  const kbPath = getLocalKbDir(scope, group);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  writeJson(kbPath, { alpha: '# alpha 正文', beta: '# beta 正文' });

  const subKb = getLocalKbDir(scope, subGroup);
  fs.mkdirSync(path.dirname(subKb), { recursive: true });
  writeJson(subKb, {});

  for (const [g, file] of [[group, 'a.png'], [subGroup, 'b.png']] as const) {
    const assetsDir = getAssetsDir(scope, g);
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, file), 'x'.repeat(32));
  }
}

describe('回收站组条目（S02）', () => {
  it('篇目取并集 + 附件按 group 存一份 + listTrash 能读出组条目', () => {
    const scope = scopes[0];
    seed(scope);

    const outcome = moveGroupToTrash({
      scope,
      group,
      groups: [group, subGroup],
      relations: [
        // 分片有、KB 也有 → both
        { group, name: 'alpha', snapshot: { id: 'rel_a', text: 'alpha', score: 0, useCount: 0, lastUsedTime: null } as never },
        // 分片有、KB 没有 → shard-only
        { group: subGroup, name: 'gamma' },
      ],
    });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
    if (!outcome.ok) return;
    assert.equal(outcome.docs, 3, 'beta 只在 KB 里，取并集后必须被收进快照');

    const docs = readGroupSnapshotDocs(scope, group, outcome.item.dirName);
    assert.equal(docs.length, 3);
    const byName = new Map(docs.map((entry) => [entry.doc?.name, entry]));
    assert.equal(byName.get('alpha')?.doc?.source, 'both');
    assert.equal(byName.get('beta')?.doc?.source, 'kb-only');
    assert.equal(byName.get('gamma')?.doc?.source, 'shard-only');
    assert.equal(byName.get('alpha')?.content, '# alpha 正文');
    assert.equal(byName.get('gamma')?.content, '', 'shard-only 没有正文');

    // 附件：2 个 group 各一份，而不是 3 篇各一份
    const assets = readGroupSnapshotAssets(scope, group, outcome.item.dirName);
    assert.equal(assets.length, 2);
    assert.deepEqual(assets.map((a) => a.group).sort(), [group, subGroup].sort());
    assert.equal(fs.readdirSync(path.join(getTrashRoot(scope), group, outcome.item.dirName, 'assets')).length, 2);

    // listTrash 能识别（walk 遇 meta.json 即停，不会把 docs/ 当成文档）
    const listed = listTrash(scope);
    const entry = listed.items.find((i) => i.dirName === outcome.item.dirName);
    assert.ok(entry, '组条目必须出现在回收站列表里');
    assert.equal(entry!.kind, 'group');
    assert.equal(entry!.groupSnapshot?.docCount, 3);
    assert.ok(entry!.sizeBytes > 0);
    assert.equal(entry!.hasAssets, true);
  });

  it('存量 doc 条目无 kind 字段：读侧补成 doc，且不写回磁盘', () => {
    const scope = scopes[0];
    const item = writeTrashItem({
      scope,
      group,
      relation: 'legacy-doc',
      reason: 'manual',
      now: Date.now(),
      content: '旧条目正文',
      keepDays: 7,
    });
    const raw = JSON.parse(fs.readFileSync(
      path.join(getTrashRoot(scope), group, item.dirName, 'meta.json'),
      'utf-8',
    )) as Record<string, unknown>;
    assert.equal('kind' in raw, false, '写入端不写 kind（存量兼容）');

    const listed = listTrash(scope);
    const entry = listed.items.find((i) => i.dirName === item.dirName);
    assert.equal(entry?.kind, 'doc', '读侧必须补成 doc，否则前端按 group 分支渲染就错了');
  });

  it('assets.json 缺失时 readGroupSnapshotAssets 降级为空数组（不抛错）', () => {
    const scope = scopes[0];
    const outcome = moveGroupToTrash({
      scope,
      group: '无附件组',
      groups: ['无附件组'],
      relations: [],
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(readGroupSnapshotAssets(scope, '无附件组', outcome.item.dirName), []);
    assert.deepEqual(readGroupSnapshotDocs(scope, '无附件组', outcome.item.dirName), []);
  });
});
