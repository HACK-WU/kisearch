/**
 * 任务台账快照抽取单测（REQ-20261019-004 S-02）
 *
 * 锁住的不变量：
 *   1) `splitSkipped` 三项之和恒等于 `skipped`（`import.ts` 的 skipped 已是合并值，不能直接相加）；
 *   2) `sourceKind` 由源目录是否落在受控上传根目录下决定（决定「能否事后重试」）；
 *   3) 缺省口径与 `handleDirectImport` 一致（vector 缺省 true、conflictMode 缺省 incremental）；
 *   4) 明细超过上限时截断并标记 `truncated`（否则台账可能超 32KB 导致任务消失）；
 *   5) 非导入 operation 返回 undefined（restore/rebuild 无此语义）。
 *
 * 运行：npx jiti test/task-snapshot.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { splitSkipped, toParamSnapshot, toResultSnapshot, MAX_SNAPSHOT_DETAIL, MAX_SNAPSHOT_CREATED } from '../src/lib/task-snapshot.ts';

test('splitSkipped：三项之和恒等于 skipped', () => {
  const reasons = splitSkipped(10, 3, [{ action: 'skip' }, { action: 'skip' }, { action: 'overwrite' }]);
  assert.deepEqual(reasons, { conflict: 2, duplicate: 3, other: 5 });
  assert.equal(reasons.conflict + reasons.duplicate + reasons.other, 10);
});

test('splitSkipped：明细计数超过总数时收敛到 skipped（不产生负 other / 溢出）', () => {
  const reasons = splitSkipped(2, 5, [{ action: 'skip' }, { action: 'skip' }, { action: 'skip' }]);
  assert.equal(reasons.duplicate, 2);
  assert.equal(reasons.conflict, 0);
  assert.equal(reasons.other, 0);
  assert.equal(reasons.conflict + reasons.duplicate + reasons.other, 2);
});

test('splitSkipped：skipped 为 0 时不产生负数', () => {
  assert.deepEqual(splitSkipped(0, 3, [{ action: 'skip' }]), { conflict: 0, duplicate: 0, other: 0 });
});

test('toParamSnapshot：受控上传目录判为 upload，普通目录判为 external', () => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-snap-uploads-'));
  const uploadDir = path.join(uploadsRoot, '9f1c2d3e-0000-4000-8000-000000000000');
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-snap-ext-'));
  try {
    assert.equal(toParamSnapshot('import', { sourceDir: uploadDir }, uploadsRoot)?.sourceKind, 'upload');
    assert.equal(toParamSnapshot('import', { sourceDir: externalDir }, uploadsRoot)?.sourceKind, 'external');
    // 子目录不算上传态（uploadIdFromSourceDir 要求目录直接位于根下）
    assert.equal(
      toParamSnapshot('import', { sourceDir: path.join(uploadDir, 'sub') }, uploadsRoot)?.sourceKind,
      'external',
    );
  } finally {
    fs.rmSync(uploadsRoot, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});

test('toParamSnapshot：缺省口径与 handleDirectImport 一致', () => {
  const snapshot = toParamSnapshot('import', { tags: ' 产品 , v2 ,, ' });
  assert.equal(snapshot?.vector, true, 'vector 缺省必须为 true（与 --no-vector 相反）');
  assert.equal(snapshot?.conflictMode, 'incremental', '缺省策略是增量导入');
  assert.equal(snapshot?.skipDuplicates, false);
  assert.deepEqual(snapshot?.tags, ['产品', 'v2']);
});

test('toParamSnapshot：tags 与导入侧同源解析（小写 / 去重 / 过滤保留 tag）', () => {
  // 该输入在 `parseContentTags` 下实际生效为 ['产品','v2']（ki-search 是内部保留 tag）
  const snapshot = toParamSnapshot('import', { tags: ' 产品 , V2 , ki-search , 产品 ,, ' });
  assert.deepEqual(snapshot?.tags, ['产品', 'v2']);
});

test('toParamSnapshot：非 suffix 策略不保留后缀模板', () => {
  assert.equal(toParamSnapshot('import', { conflictMode: 'overwrite', conflictSuffix: '_{n}' })?.conflictSuffix, undefined);
  assert.equal(toParamSnapshot('import', { conflictMode: 'suffix', conflictSuffix: '_{n}' })?.conflictSuffix, '_{n}');
});

test('toParamSnapshot：非导入 operation 返回 undefined', () => {
  assert.equal(toParamSnapshot('rebuild-vector', { sourceDir: '/tmp/x' }), undefined);
  assert.equal(toParamSnapshot('restore-snapshot', { sourceDir: '/tmp/x' }), undefined);
});

test('toResultSnapshot：文件级统计 + 跳过原因拆分', () => {
  const snapshot = toResultSnapshot('import', {
    stats: {
      vectorized: 148,
      fullTextIndexed: 132,
      assets: 3,
      files: { scanned: 12, completed: 10, incomplete: 0, skipped: 2, unchanged: 9, duplicatesSkipped: 1 },
    },
    duplicatesSkipped: [{ path: 'docs/a.md', existingGroup: 'raw', existingRelation: 'a' }],
    conflicts: [{ path: 'docs/b.md', relation: 'b_1', action: 'suffix' }],
    groups: ['raw/browser'],
  });
  assert.equal(snapshot?.files?.scanned, 12);
  assert.equal(snapshot?.files?.unchanged, 9);
  assert.deepEqual(snapshot?.files?.skippedReasons, { conflict: 0, duplicate: 1, other: 1 });
  assert.equal(snapshot?.vectorized, 148);
  assert.equal(snapshot?.fullTextIndexed, 132);
  assert.equal(snapshot?.assets, 3);
  assert.deepEqual(snapshot?.groups, ['raw/browser']);
  assert.equal(snapshot?.duplicates?.length, 1);
  assert.equal(snapshot?.conflicts?.length, 1);
  assert.equal(snapshot?.truncated, undefined);
});

test('toResultSnapshot：明细超过上限时截断并标记 truncated', () => {
  const many = Array.from({ length: MAX_SNAPSHOT_DETAIL + 5 }, (_, index) => ({
    path: `docs/${index}.md`,
    existingGroup: 'raw',
    existingRelation: `doc-${index}`,
  }));
  const snapshot = toResultSnapshot('import', {
    stats: { files: { scanned: 30, completed: 30, incomplete: 0, skipped: 0, unchanged: 0, duplicatesSkipped: 0 } },
    duplicatesSkipped: many,
  });
  assert.equal(snapshot?.duplicates?.length, MAX_SNAPSHOT_DETAIL);
  assert.equal(snapshot?.truncated, true);
});

test('toResultSnapshot：失败错误对象（无 stats.files）返回 undefined，不虚构数字', () => {
  const cancelled = Object.assign(new Error('导入已取消（已完成 3/10 个文件）'), { code: 'IMPORT_CANCELLED' });
  assert.equal(toResultSnapshot('import', cancelled), undefined);
  assert.equal(toResultSnapshot('import', undefined), undefined);
  assert.equal(toResultSnapshot('rebuild-vector', { stats: {} }), undefined);
});

test('toResultSnapshot：冲突的 unchanged 标记必须透传（不能显示成"已覆盖"）', () => {
  const snapshot = toResultSnapshot('import', {
    stats: { files: { scanned: 2, completed: 2, incomplete: 0, skipped: 0, unchanged: 2, duplicatesSkipped: 0 } },
    conflicts: [
      { path: 'a.md', relation: 'a', action: 'overwrite', unchanged: true },
      { path: 'b.md', relation: 'b', action: 'overwrite' },
    ],
  });
  assert.equal(snapshot?.conflicts?.[0]?.unchanged, true);
  assert.equal(snapshot?.conflicts?.[1]?.unchanged, undefined);
});

test('toResultSnapshot：未知 action 的冲突条目被丢弃', () => {
  const snapshot = toResultSnapshot('import', {
    stats: { files: { scanned: 1, completed: 1, incomplete: 0, skipped: 0, unchanged: 0, duplicatesSkipped: 0 } },
    conflicts: [{ path: 'a.md', relation: 'a_1', action: 'renamed' }],
  });
  assert.equal(snapshot?.conflicts, undefined);
});

test('toResultSnapshot：新建明细压成 [group, relation] 二元组', () => {
  const snapshot = toResultSnapshot('import', {
    stats: { files: { scanned: 2, completed: 2, incomplete: 0, skipped: 0, unchanged: 0, duplicatesSkipped: 0 } },
    created: [
      { group: 'langchain/stages', relation: '01-入门' },
      { group: 'langchain/stages', relation: '02-进阶' },
    ],
    createdTotal: 2,
  });
  assert.deepEqual(snapshot?.created, [
    ['langchain/stages', '01-入门'],
    ['langchain/stages', '02-进阶'],
  ]);
  assert.equal(snapshot?.createdTotal, 2);
  assert.equal(snapshot?.createdTruncated, undefined);
});

test('toResultSnapshot：新建明细超过上限时截断并标记（防 32KB 撑爆导致任务消失）', () => {
  const created = Array.from({ length: MAX_SNAPSHOT_CREATED + 5 }, (_, i) => ({ group: `g/${i}`, relation: `r${i}` }));
  const snapshot = toResultSnapshot('import', {
    stats: { files: { scanned: 1, completed: 1, incomplete: 0, skipped: 0, unchanged: 0, duplicatesSkipped: 0 } },
    created,
    createdTotal: created.length,
  });
  assert.equal(snapshot?.created?.length, MAX_SNAPSHOT_CREATED);
  assert.equal(snapshot?.createdTruncated, true);
  assert.equal(snapshot?.createdTotal, created.length);
  assert.equal(snapshot?.truncated, true);
});

test('toResultSnapshot：明细被裁掉但总数仍在（前端展示「共 N 篇」而不是 0）', () => {
  const snapshot = toResultSnapshot('import', {
    stats: { files: { scanned: 3, completed: 3, incomplete: 0, skipped: 0, unchanged: 0, duplicatesSkipped: 0 } },
    createdTotal: 251,
    createdTruncated: true,
  });
  assert.equal(snapshot?.created, undefined);
  assert.equal(snapshot?.createdTotal, 251);
  assert.equal(snapshot?.createdTruncated, true);
});

test('toResultSnapshot：非法新建条目被丢弃', () => {
  const snapshot = toResultSnapshot('import', {
    stats: { files: { scanned: 1, completed: 1, incomplete: 0, skipped: 0, unchanged: 0, duplicatesSkipped: 0 } },
    created: [{ group: '', relation: 'a' }, { group: 'g', relation: '   ' }, { group: 'g', relation: 'ok' }],
    createdTotal: 3,
  });
  assert.deepEqual(snapshot?.created, [['g', 'ok']]);
});
