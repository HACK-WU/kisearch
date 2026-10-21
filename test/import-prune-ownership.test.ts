/**
 * import-prune-ownership.test.ts —— 数据源路径的三个新增入参（S-01 共享底座）
 *
 * 覆盖：
 *  1. `writeSourceBlock:false` 不写 `group-index.json.source`（Q-C）；缺省仍写
 *  2. `onScannedFiles` 拿到与导入一致的**全量扫描**列表（供 lastSync.seenRels）
 *  3. `pruneEligibleRels` 只让本数据源见过的文档进候选 —— 其他通道导入的文档不受影响
 *     （不传基线时会被列入，这正是 Q14 要消除的误删面）
 *
 * 隔离：独立 KI_CONFIG_PATH + 临时数据目录（test-config），不触真实数据 / daemon。
 * 运行：npx jiti test/import-prune-ownership.test.ts
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

process.env.KI_DAEMON_OWNER = '1';

const { handleDirectImport } = await import('../src/lib/import.js');
const { getSource } = await import('../src/lib/scope.js');
const { closeFtsEngine } = await import('../src/lib/fts-client.js');

const SCOPES = ['ds-own-nosource', 'ds-own-writesource', 'ds-own-scan', 'ds-own-eligible'];
for (const scope of SCOPES) registerTestScope(scope);

function mkSource(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-own-'));
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

describe('数据源路径入参：writeSourceBlock / onScannedFiles / pruneEligibleRels', () => {
  it('writeSourceBlock:false 不写 source 块；缺省仍写（既有行为不变）', async () => {
    const srcOff = mkSource({ 'a.md': '# A\n\nbody' });
    const off = await handleDirectImport({ scope: 'ds-own-nosource', sourceDir: srcOff, vector: false, writeSourceBlock: false });
    assert.equal(off.ok, true);
    assert.equal(getSource('ds-own-nosource'), null, 'Q-C：数据源同步不得写 source 块');

    const srcOn = mkSource({ 'b.md': '# B\n\nbody' });
    const on = await handleDirectImport({ scope: 'ds-own-writesource', sourceDir: srcOn, vector: false });
    assert.equal(on.ok, true);
    assert.equal(getSource('ds-own-writesource')?.dir, srcOn, '缺省必须保持一次性导入的既有行为');
  });

  it('onScannedFiles 拿到与导入一致的全量扫描列表', async () => {
    const src = mkSource({ 'a.md': '# A\n\nbody', 'sub/b.md': '# B\n\nbody' });
    let seen: string[] = [];
    const result = await handleDirectImport({
      scope: 'ds-own-scan',
      sourceDir: src,
      vector: false,
      onScannedFiles: (files) => { seen = files; },
    });
    assert.equal(result.ok, true);
    assert.deepEqual([...seen].sort(), ['a.md', 'sub/b.md']);
    assert.equal((result as { stats: { files: { scanned: number } } }).stats.files.scanned, 2);
  });

  it('pruneEligibleRels 只让本数据源的文档进候选（其他通道文档不受影响）', async () => {
    const scope = 'ds-own-eligible';
    const srcA = mkSource({ 'wiki/a1.md': '# A1\n\nbody', 'wiki/a2.md': '# A2\n\nbody' });
    await handleDirectImport({ scope, sourceDir: srcA, group: '', vector: false });
    const srcB = mkSource({ 'other/b1.md': '# B1\n\nbody' });
    await handleDirectImport({ scope, sourceDir: srcB, group: '', vector: false });

    // 模拟源目录删掉 a2.md；其余不动
    fs.unlinkSync(path.join(srcA, 'wiki/a2.md'));
    // group 留空 ⇒ 候选范围是整个 scope 库（正是 Q14 的风险面）
    const common = {
      scope,
      sourceDir: srcA,
      group: '',
      vector: false as const,
      pruneStale: true as const,
      pickMode: 'dir' as const,
    };

    const legacy = await handleDirectImport(common);
    const legacyPrune = (legacy as { prune?: { total: number; items: { sourcePath: string }[] } }).prune;
    assert.ok(legacyPrune, '应产出候选计划');
    assert.equal(legacyPrune.total, 2, '不传基线时其他通道的 other/b1.md 也会被列为候选（Q14 要消除的风险）');
    assert.ok(legacyPrune.items.some((item) => item.sourcePath === 'other/b1.md'));

    const owned = await handleDirectImport({
      ...common,
      pruneEligibleRels: ['wiki/a1.md', 'wiki/a2.md'],
      pruneEmitTokenWhenOverLimit: true,
    });
    const ownedPrune = (owned as { prune?: { total: number; items: { sourcePath: string }[]; token?: string } }).prune;
    assert.ok(ownedPrune);
    assert.equal(ownedPrune.total, 1);
    assert.equal(ownedPrune.items[0].sourcePath, 'wiki/a2.md');
    assert.ok(ownedPrune.token, '数据源路径应生成 token');
  });
});

after(async () => {
  await closeFtsEngine();
  cleanupTestConfig();
});
