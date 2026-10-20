/**
 * import-prune-e2e.test.ts —— 验收级真实链路（REQ-20261019-001）。
 *
 * 与 `import-prune.test.ts`（纯函数单测）的区别：这里走**真实导入**（写 relations-cache /
 * local KB / 向量），验证「导入 → 候选 → 重算 token → 删除」的端到端闭环。
 *
 * 重点验收项：
 *   1. 首次导入（库空）不产候选；
 *   2. 删掉源文件后重导 → 候选恰好 1 篇且指向被删文件；
 *   3. **同一份输入重算 → token 必须一致**（run 与 /api/import/prune 的同源契约）；
 *   4. **preserveRels 会改变 token** —— 证明 prune 侧漏传它就会恒 409（code review #1）；
 *   5. 删除后 cache 中该 relation 消失。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/import-prune-e2e.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { readAllGroupCaches } from '../src/lib/group-cache.js';

const { handleDirectImport } = await import('../src/lib/import.js');
const { planImportPrune } = await import('../src/lib/import-prune.js');
const { executeBatchDelete } = await import('../src/delete-relation.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-prune-e2e-'));
const SCOPE = `prune-${Date.now().toString(36)}`;
registerTestScope(SCOPE);

const sourceDir = path.join(tmpRoot, 'wiki');
fs.mkdirSync(sourceDir, { recursive: true });
for (const name of ['a', 'b', 'c']) {
  fs.writeFileSync(path.join(sourceDir, `${name}.md`), `# ${name}\n${name} 的正文内容。\n`);
}

/** 不传 group → 文件落在源目录根部 → groupPath = scope 名 */
const importedGroups = (rels: string[]) => [...new Set(rels.map(() => SCOPE))];

after(async () => {
  // 必须显式关引擎：FTS / zvec worker 常驻会让 node:test 进程不退出（外部还得靠 timeout 兜底）
  try {
    const { closeFtsEngine } = await import('../src/lib/fts-client.js');
    await closeFtsEngine(SCOPE);
  } catch { /* 未初始化则忽略 */ }
  try {
    const { closeEngine } = await import('../src/lib/vector-client.js');
    await closeEngine();
  } catch { /* 未初始化则忽略 */ }
  // 清理 scope 数据目录：本用例走真实导入，会在仓库 kb/ 下留 kb/<scope>/（此前每次跑都残留一份）
  try {
    const { getKbDir } = await import('../src/lib/scope.js');
    fs.rmSync(getKbDir(SCOPE), { recursive: true, force: true });
  } catch { /* 配置已销毁 / 目录不存在则忽略 */ }
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('端到端：导入 → 候选 → 重算 → 删除', () => {
  it('① 首次导入（库空）不产候选', { timeout: 60_000 }, async () => {
    const result = await handleDirectImport({
      scope: SCOPE,
      sourceDir,
      pruneStale: true,
      pickMode: 'dir',
      // 验收不依赖外部 embedding：FTS-only 走同一套 cache/local KB 写入与候选计算
      vector: false,
    });
    assert.ok(result.prune, '开启 pruneStale 时必须带 prune 字段');
    // 库内尚无可判定文档（judicable=0）→ EMPTY_LIBRARY，属正确关闭而非闸门拦截
    assert.equal(result.prune!.skipReason, 'EMPTY_LIBRARY', `实际：${result.prune!.skipReason}`);
    assert.equal(result.prune!.total, 0, '库内没有历史文档，不该有候选');
    assert.equal(result.prune!.judicable, 0);
    assert.equal(result.stats.files.completed, 3);
  });

  it('② 删掉源文件 b.md 后重导 → 候选恰好 1 篇且指向 b.md', { timeout: 60_000 }, async () => {
    fs.unlinkSync(path.join(sourceDir, 'b.md'));
    const result = await handleDirectImport({
      scope: SCOPE,
      sourceDir,
      pruneStale: true,
      pickMode: 'dir',
      // 验收不依赖外部 embedding：FTS-only 走同一套 cache/local KB 写入与候选计算
      vector: false,
    });
    const plan = result.prune!;
    assert.equal(plan.skipReason, undefined, `不应被闸门关闭：${plan.skipDetail ?? ''}`);
    assert.equal(plan.total, 1, `应恰好 1 篇候选，实际 ${plan.total}`);
    assert.equal(plan.items[0].sourcePath, 'b.md');
    assert.equal(plan.items[0].group, SCOPE);
    assert.equal(plan.coordRatio, 1, '本次 2 篇都能在库里找到');
    assert.ok(plan.token, '候选非空且未超限时必须给 token');
  });

  it('③ 同一输入重算 → token 必须一致（run 与 /api/import/prune 同源契约）', { timeout: 60_000 }, async () => {
    const first = await handleDirectImport({ scope: SCOPE, sourceDir, pruneStale: true, pickMode: 'dir', vector: false });
    const rels = ['a.md', 'c.md'];
    const recomputed = planImportPrune({
      scope: SCOPE,
      group: '',
      scannedRels: rels,
      importedGroups: importedGroups(rels),
      precheck: { pruneStale: true, pickMode: 'dir', subsetRetry: false, uploadIncomplete: false, scannedCount: rels.length },
    });
    assert.equal(recomputed.total, 1);
    assert.equal(recomputed.token, first.prune!.token, '两次计算必须得到同一 token，否则 prune 接口恒 409');
  });

  it('④ preserveRels 会改变 token（漏传即恒 409，对应 code review #1）', { timeout: 60_000 }, async () => {
    const rels = ['a.md', 'c.md'];
    const withoutPreserve = planImportPrune({
      scope: SCOPE,
      group: '',
      scannedRels: rels,
      importedGroups: importedGroups(rels),
      precheck: { pruneStale: true, pickMode: 'dir', subsetRetry: false, uploadIncomplete: false, scannedCount: rels.length },
    });
    // 模拟「b.md 上传失败但仍本地存在」：并入 preserveRels 后 b 不算已删 → 候选为空
    const withPreserve = planImportPrune({
      scope: SCOPE,
      group: '',
      scannedRels: rels,
      preserveRels: ['b.md'],
      importedGroups: importedGroups(rels),
      precheck: { pruneStale: true, pickMode: 'dir', subsetRetry: false, uploadIncomplete: false, scannedCount: rels.length },
    });
    assert.equal(withoutPreserve.total, 1);
    assert.equal(withPreserve.total, 0, 'preserveRels 中的文件应视为「本次有」');
    assert.notEqual(withPreserve.token, withoutPreserve.token);
  });

  it('⑤ 删除候选后 cache 中该 relation 消失', { timeout: 60_000 }, async () => {
    const groupsBefore = readAllGroupCaches(SCOPE);
    const relationsBefore = groupsBefore.get(SCOPE)?.hot_relations.map((item) => item.text) ?? [];
    assert.ok(relationsBefore.includes('b'), `删除前应存在 relation b，实际：${relationsBefore.join(',')}`);

    const outcome = await executeBatchDelete(SCOPE, [{ group: SCOPE, relation: 'b' }]);
    assert.equal(outcome.ok, true);
    // `BatchDeleteResult` 没有聚合的 `deleted` 字段（只有 results/total/failed）——按条统计
    assert.equal(outcome.results.filter((item) => item.deleted).length, 1);

    const groupsAfter = readAllGroupCaches(SCOPE);
    const relationsAfter = groupsAfter.get(SCOPE)?.hot_relations.map((item) => item.text) ?? [];
    assert.ok(!relationsAfter.includes('b'), `删除后不应再存在 relation b，实际：${relationsAfter.join(',')}`);
    assert.deepEqual(relationsAfter.sort(), ['a', 'c']);
  });
});
