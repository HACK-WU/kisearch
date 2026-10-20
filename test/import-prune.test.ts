/**
 * import-prune 单测（REQ-20261019-001 / 设计 S01 §4 场景表）。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/import-prune.test.ts
 *
 * 覆盖重点：
 *  - 双闸门的 7 个典型场景（放行 / 关闭 / 不误伤）
 *  - **全量扫描口径**：`skipDuplicates` 剔除、增量未变的文件必须算「本次有」（否则会误删）
 *  - 边界：sourcePath 为空、候选超限、token 稳定与校验
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  computePrunePlan,
  planImportPrune,
  resolvePrunePrecheck,
  verifyPruneToken,
  computePruneToken,
  PRUNE_MAX_ITEMS,
  PRUNE_COORD_THRESHOLD,
  PRUNE_SCALE_THRESHOLD,
} = await import('../src/lib/import-prune.js');

interface LibSpec {
  group: string;
  /** 该组文档数；sourcePath 用 `${prefix}${i}.md` 生成 */
  count: number;
  prefix?: string;
  /** 是否写入 sourcePath（false 模拟手工 sync-relation 写入的文档） */
  withSourcePath?: boolean;
}

function buildLib(specs: LibSpec[], extraGroups: string[] = []) {
  const items: { group: string; relation: string; sourcePath: string }[] = [];
  const groupDocs: Record<string, number> = {};
  const groups = new Set<string>(extraGroups);
  let docs = 0;
  let judicable = 0;

  for (const spec of specs) {
    const prefix = spec.prefix ?? `${spec.group}/`;
    const withSource = spec.withSourcePath !== false;
    groups.add(spec.group);
    groupDocs[spec.group] = (groupDocs[spec.group] ?? 0) + spec.count;
    docs += spec.count;
    for (let i = 0; i < spec.count; i += 1) {
      const rel = `${prefix}${i}.md`;
      if (withSource) {
        judicable += 1;
        items.push({ group: spec.group, relation: `doc-${i}`, sourcePath: rel });
      } else {
        items.push({ group: spec.group, relation: `manual-${i}`, sourcePath: '' });
      }
    }
  }

  // 无 sourcePath 的条目不属于 lib.items（纯函数只吃可判定项）
  return {
    groups: [...groups].sort(),
    docs,
    judicable,
    groupDocs,
    items: items.filter((item) => item.sourcePath !== ''),
  };
}

function relsOf(spec: LibSpec): string[] {
  const prefix = spec.prefix ?? `${spec.group}/`;
  return Array.from({ length: spec.count }, (_, i) => `${prefix}${i}.md`);
}

describe('computePrunePlan · 双闸门场景表', () => {
  it('场景1 正常：库 130 篇、本次 128 篇 → 放行且恰好 2 篇候选', () => {
    const spec: LibSpec = { group: 'wiki', count: 130 };
    const plan = computePrunePlan({
      scope: 's', group: 'wiki', scannedRels: relsOf(spec).slice(0, 128), importedGroups: ['wiki'], lib: buildLib([spec]),
    });
    assert.equal(plan.skipReason, undefined);
    assert.equal(plan.total, 2);
    assert.equal(plan.coordRatio, 1);
    assert.equal(plan.deleteRatio, 0.015);
    assert.equal(plan.warn, false);
    assert.ok(plan.token);
    assert.equal(plan.items.length, 2);
  });

  it('场景2 层级变化（本次 path 与库完全不重合）→ GATE_COORD', () => {
    const lib = buildLib([{ group: '部署', count: 20, prefix: '部署/' }]);
    const plan = computePrunePlan({
      scope: 's', group: '', scannedRels: ['a.md', 'b.md'], importedGroups: ['docs'], lib,
    });
    assert.equal(plan.skipReason, 'GATE_COORD');
    assert.equal(plan.coordRatio, 0);
    assert.equal(plan.token, undefined);
  });

  it('场景3 选错目录但 group 名相同 → GATE_COORD', () => {
    const lib = buildLib([{ group: '部署', count: 20, prefix: '部署/' }]);
    const plan = computePrunePlan({
      scope: 's', group: '部署', scannedRels: ['other/1.md', 'other/2.md'], importedGroups: ['部署'], lib,
    });
    assert.equal(plan.skipReason, 'GATE_COORD');
  });

  it('场景4 用户删掉整个子组（20/130）→ 放行，不误伤整组删除', () => {
    const lib = buildLib([
      { group: 'wiki', count: 110, prefix: '部署/' },
      { group: 'wiki/架构', count: 20, prefix: '架构/' },
    ]);
    const plan = computePrunePlan({
      scope: 's', group: 'wiki', scannedRels: relsOf({ group: 'wiki', count: 110, prefix: '部署/' }), importedGroups: ['wiki'], lib,
    });
    assert.equal(plan.skipReason, undefined);
    assert.equal(plan.total, 20);
    assert.equal(plan.deleteRatio, 0.154);
  });

  it('场景5 首次对已有 1000 篇的库开启 → GATE_COORD', () => {
    const lib = buildLib([{ group: 'wiki', count: 1000 }]);
    const plan = computePrunePlan({
      scope: 's', group: '', scannedRels: ['x/1.md', 'x/2.md'], importedGroups: ['x'], lib,
    });
    assert.equal(plan.skipReason, 'GATE_COORD');
  });

  it('场景6 只上传 3 个文件（都能在库里找到）→ GATE_SCALE', () => {
    const spec: LibSpec = { group: 'wiki', count: 130 };
    const plan = computePrunePlan({
      scope: 's', group: 'wiki', scannedRels: relsOf(spec).slice(0, 3), importedGroups: ['wiki'], lib: buildLib([spec]),
    });
    assert.equal(plan.skipReason, 'GATE_SCALE');
    assert.equal(plan.total, 127);
  });

  it('场景7 大批量整理（130 删 110）→ GATE_SCALE', () => {
    const spec: LibSpec = { group: 'wiki', count: 130 };
    const plan = computePrunePlan({
      scope: 's', group: 'wiki', scannedRels: relsOf(spec).slice(0, 20), importedGroups: ['wiki'], lib: buildLib([spec]),
    });
    assert.equal(plan.skipReason, 'GATE_SCALE');
  });

  it('场景8 sourcePath 为空的文档不参与，且分母用 judicable', () => {
    const lib = buildLib([
      { group: 'wiki', count: 70, prefix: 'a/' },
      { group: 'wiki', count: 30, prefix: 'manual/', withSourcePath: false },
    ]);
    const plan = computePrunePlan({
      scope: 's', group: 'wiki', scannedRels: relsOf({ group: 'wiki', count: 68, prefix: 'a/' }), importedGroups: ['wiki'], lib,
    });
    assert.equal(plan.skipReason, undefined);
    assert.equal(plan.unableCount, 30);
    assert.equal(plan.judicable, 70);
    assert.equal(plan.total, 2);
    assert.equal(plan.deleteRatio, 0.029);
    assert.ok(plan.items.every((item) => item.sourcePath.startsWith('a/')));
  });

  it('场景9 候选 501 篇 → overLimit 且不给 token', () => {
    const spec: LibSpec = { group: 'wiki', count: 700 };
    const plan = computePrunePlan({
      scope: 's', group: 'wiki', scannedRels: relsOf(spec).slice(0, 199), importedGroups: ['wiki'], lib: buildLib([spec]),
    });
    assert.equal(plan.skipReason, undefined);
    assert.equal(plan.total, 501);
    assert.equal(plan.overLimit, true);
    assert.equal(plan.token, undefined);
    assert.ok(plan.items.length <= PRUNE_MAX_ITEMS);
  });

  it('场景12 preserveRels（上传失败的文件）视为本次有，不进候选', () => {
    const spec: LibSpec = { group: 'wiki', count: 130 };
    const scanned = relsOf(spec).slice(0, 128); // 少 128/129 两篇
    const plan = computePrunePlan({
      scope: 's',
      group: 'wiki',
      scannedRels: scanned,
      preserveRels: ['wiki/128.md'], // 128 篇本地仍在但没传上来
      importedGroups: ['wiki'],
      lib: buildLib([spec]),
    });
    assert.equal(plan.total, 1);
    assert.equal(plan.items[0].sourcePath, 'wiki/129.md');
  });
});

describe('computePrunePlan · 全量扫描口径（护栏 #1）', () => {
  it('被 skipDuplicates 剔除的文件仍算「本次有」→ 不产生候选', () => {
    const spec: LibSpec = { group: 'wiki', count: 3 };
    const plan = computePrunePlan({
      scope: 's',
      group: 'wiki',
      // 关键：全量扫描包含被剔除的 wiki/0.md；若误用 filesForImport 就会漏掉它
      scannedRels: ['wiki/0.md', 'wiki/1.md', 'wiki/2.md'],
      importedGroups: ['wiki'],
      lib: buildLib([spec]),
    });
    assert.equal(plan.total, 0);
    assert.equal(plan.token, undefined);
  });

  it('路径归一：反斜杠与 NFC 差异不产生假候选', () => {
    const lib = {
      groups: ['wiki'],
      docs: 2,
      judicable: 2,
      groupDocs: { wiki: 2 },
      items: [
        { group: 'wiki', relation: 'a', sourcePath: 'dir/a.md' },
        { group: 'wiki', relation: 'b', sourcePath: 'dir/b.md' },
      ],
    };
    const plan = computePrunePlan({
      scope: 's', group: 'wiki', scannedRels: ['dir\\a.md', '/dir/b.md'], importedGroups: ['wiki'], lib,
    });
    assert.equal(plan.total, 0);
  });
});

describe('computePrunePlan · 未触及 group 与 token', () => {
  it('未触及 group 单列，候选标记 untouched', () => {
    const lib = buildLib([
      { group: 'wiki/a', count: 5, prefix: 'a/' },
      { group: 'wiki/b', count: 5, prefix: 'b/' },
    ]);
    const plan = computePrunePlan({
      scope: 's', group: 'wiki', scannedRels: relsOf({ group: 'wiki/a', count: 4, prefix: 'a/' }), importedGroups: ['wiki/a'], lib,
    });
    assert.deepEqual(plan.untouchedGroups, ['wiki/b']);
    const fromB = plan.items.filter((item) => item.group === 'wiki/b');
    assert.ok(fromB.length > 0);
    assert.ok(fromB.every((item) => item.untouched));
    assert.ok(plan.items.filter((item) => item.group === 'wiki/a').every((item) => !item.untouched));
  });

  it('token 与候选顺序无关，且 verifyPruneToken 可比对', () => {
    const a = [{ group: 'g', relation: 'r1', sourcePath: 'x.md', untouched: false },
      { group: 'g', relation: 'r2', sourcePath: 'y.md', untouched: false }];
    const b = [a[1], a[0]];
    assert.equal(computePruneToken(a), computePruneToken(b));

    const lib = buildLib([{ group: 'g', count: 3, prefix: '' }]);
    const plan = computePrunePlan({
      scope: 's', group: 'g', scannedRels: relsOf({ group: 'g', count: 2, prefix: '' }), importedGroups: ['g'], lib,
    });
    assert.ok(plan.token);
    assert.equal(verifyPruneToken(plan, plan.token as string), true);
    assert.equal(verifyPruneToken(plan, 'deadbeefdeadbeef'), false);
  });
});

describe('resolvePrunePrecheck · 前置护栏', () => {
  const base = { pruneStale: true, pickMode: 'dir' as const, subsetRetry: false, uploadIncomplete: false, scannedCount: 10 };

  it('开关未开 → DISABLED', () => {
    assert.equal(resolvePrunePrecheck({ ...base, pruneStale: false })?.reason, 'DISABLED');
  });

  it('选择文件模式 → NOT_DIR_MODE（场景10）', () => {
    assert.equal(resolvePrunePrecheck({ ...base, pickMode: 'files' })?.reason, 'NOT_DIR_MODE');
  });

  it('混合选择 → NOT_DIR_MODE 且文案说明路径口径', () => {
    const result = resolvePrunePrecheck({ ...base, pickMode: 'mixed' });
    assert.equal(result?.reason, 'NOT_DIR_MODE');
    assert.match(result?.detail ?? '', /混合/);
  });

  it('子集重试 → SUBSET_RETRY', () => {
    assert.equal(resolvePrunePrecheck({ ...base, subsetRetry: true })?.reason, 'SUBSET_RETRY');
  });

  it('上传不完整 → UPLOAD_INCOMPLETE（场景11，硬门槛）', () => {
    assert.equal(resolvePrunePrecheck({ ...base, uploadIncomplete: true })?.reason, 'UPLOAD_INCOMPLETE');
  });

  it('空源 → EMPTY_SOURCE', () => {
    assert.equal(resolvePrunePrecheck({ ...base, scannedCount: 0 })?.reason, 'EMPTY_SOURCE');
  });

  it('全部通过 → null', () => {
    assert.equal(resolvePrunePrecheck(base), null);
  });

  it('planImportPrune 在前置不通过时返回带原因的 plan（scopeGroups 为空）', () => {
    const plan = planImportPrune({
      scope: 's',
      group: 'wiki',
      scannedRels: ['a.md'],
      importedGroups: ['wiki'],
      precheck: { ...base, pickMode: 'files' },
    });
    assert.equal(plan.skipReason, 'NOT_DIR_MODE');
    assert.equal(plan.total, 0);
    assert.equal(plan.token, undefined);
  });
});

describe('阈值常量', () => {
  it('双闸门阈值与需求一致（80%）', () => {
    assert.equal(PRUNE_COORD_THRESHOLD, 0.8);
    assert.equal(PRUNE_SCALE_THRESHOLD, 0.8);
  });
});
