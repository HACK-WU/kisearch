/**
 * 多映射同步合并单测（src/lib/datasource-sync-merge.ts，REQ-20261104-002）
 *
 * 锁住的两条护栏（算错就会静默丢数据）：
 *  - #3 commit 水位：**只有全部映射成功且无候选冻结**才允许推进；
 *    否则失败文件下次 diff 不再出现 = 永久漏同步。
 *  - #2 基线分桶：合并后的 `seenRels` 必须带子目录前缀；失败映射回退**它自己**的上次桶，
 *    既不能丢（下次会重复判候选）也不能串到别的映射（会误删）。
 *
 * 运行：npx jiti test/datasource-sync-merge.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { failedMappingPart, mappingParams, mergeMappingSync } from '../src/lib/datasource-sync-merge.ts';
import { computePruneToken } from '../src/lib/import-prune.ts';
import type {
  DataSourceLastSync,
  DataSourceMappingItem,
  DataSourcePendingDelete,
  DataSourceSyncState,
} from '../src/lib/datasource-types.ts';

const PARAMS = {
  group: null,
  conflictMode: 'incremental' as const,
  vector: true,
  chunkSize: null,
  chunkOverlap: null,
  mode: 'incremental' as const,
};

function pending(overrides: Partial<DataSourcePendingDelete> = {}): DataSourcePendingDelete {
  return {
    computedAt: 1,
    total: 0,
    overLimit: false,
    truncated: false,
    items: [],
    candidateSourcePaths: [],
    untouchedGroups: [],
    unableCount: 0,
    eligibleCount: 0,
    stale: false,
    staleReason: null,
    blocked: null,
    ...overrides,
  };
}

function part(args: {
  state?: DataSourceSyncState;
  seen?: string[];
  files?: Partial<DataSourceLastSync['result']['files']>;
  pending?: Partial<DataSourcePendingDelete>;
  created?: { group: string; relation: string }[];
} = {}): DataSourceLastSync {
  return {
    at: 1,
    durationMs: 1,
    state: args.state ?? 'ok',
    params: PARAMS,
    result: {
      files: {
        scanned: 0,
        fullScanned: 0,
        changed: 0,
        completed: 0,
        unchanged: 0,
        skipped: 0,
        incomplete: 0,
        duplicatesSkipped: 0,
        ...args.files,
      },
      vectorized: 0,
      fullTextIndexed: 0,
      groups: [],
      conflicts: [],
      failures: [],
      ...(args.created ? { created: args.created, createdTotal: args.created.length } : {}),
    },
    seenRels: args.seen ?? [],
    pendingDelete: pending(args.pending),
  };
}

const MAPPINGS: DataSourceMappingItem[] = [
  { subdir: 'docs/guide', group: '指南' },
  { subdir: 'docs/api', group: 'API 文档' },
];

test('全成功：状态 ok、可推进水位、计数求和、基线带前缀且稳定排序', () => {
  const merged = mergeMappingSync({
    mappings: MAPPINGS,
    parts: [
      part({ seen: ['b.md', 'a.md'], files: { scanned: 2, completed: 2, fullScanned: 2 } }),
      part({ seen: ['c.md'], files: { scanned: 1, completed: 1, fullScanned: 1 } }),
    ],
    prevBuckets: [[], []],
    params: PARAMS,
    at: 10,
    computedAt: 10,
  });
  assert.equal(merged.state, 'ok');
  assert.equal(merged.canAdvanceCommit, true);
  assert.equal(merged.files.scanned, 3);
  assert.equal(merged.files.completed, 3);
  assert.deepEqual(merged.seenRels, ['docs/api/c.md', 'docs/guide/a.md', 'docs/guide/b.md']);
});

test('任一映射 failed：状态取最差，且【禁止】推进 commit（护栏 #3）', () => {
  const merged = mergeMappingSync({
    mappings: MAPPINGS,
    // 失败映射的 seenRels 由单映射链路回退成**它自己的旧桶**（importAndPersist 的 prevSeen），
    // 合并层原样接收即可 —— 关键是它不会串到另一个映射的桶里
    parts: [part({ seen: ['a.md'] }), part({ state: 'failed', seen: ['old-c.md'] })],
    prevBuckets: [['old-a.md'], ['old-c.md']],
    params: PARAMS,
    at: 10,
    computedAt: 10,
  });
  assert.equal(merged.state, 'failed');
  assert.equal(merged.canAdvanceCommit, false);
  assert.deepEqual(merged.seenRels, ['docs/api/old-c.md', 'docs/guide/a.md']);
});

test('partial 允许推进（与单映射口径一致），cancelled 不允许', () => {
  const partial = mergeMappingSync({
    mappings: MAPPINGS,
    parts: [part({ state: 'partial' }), part({})],
    prevBuckets: [[], []],
    params: PARAMS,
    at: 1,
    computedAt: 1,
  });
  assert.equal(partial.state, 'partial');
  assert.equal(partial.canAdvanceCommit, true);

  const cancelled = mergeMappingSync({
    mappings: MAPPINGS,
    parts: [part({ state: 'cancelled' }), part({})],
    prevBuckets: [[], []],
    params: PARAMS,
    at: 1,
    computedAt: 1,
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.canAdvanceCommit, false);
});

test('候选冻结（GATE_COORD）：不推进水位，且该映射基线回退上次桶', () => {
  const merged = mergeMappingSync({
    mappings: MAPPINGS,
    parts: [part({ seen: ['new.md'], pending: { blocked: 'GATE_COORD' } }), part({ seen: ['c.md'] })],
    prevBuckets: [['keep-a.md'], []],
    params: PARAMS,
    at: 1,
    computedAt: 1,
  });
  assert.equal(merged.canAdvanceCommit, false);
  assert.deepEqual(merged.seenRels, ['docs/api/c.md', 'docs/guide/keep-a.md']);
});

test('null part（增量无变更）：不贡献计数、不影响状态、基线回退上次桶', () => {
  const merged = mergeMappingSync({
    mappings: MAPPINGS,
    parts: [null, part({ seen: ['c.md'], files: { scanned: 1 } })],
    prevBuckets: [['a.md'], ['stale.md']],
    params: PARAMS,
    at: 1,
    computedAt: 1,
  });
  assert.equal(merged.state, 'ok');
  assert.equal(merged.canAdvanceCommit, true);
  assert.equal(merged.files.scanned, 1);
  assert.deepEqual(merged.seenRels, ['docs/api/c.md', 'docs/guide/a.md']);
});

test('待删候选：items 拼接、total 求和、token 按合并结果重算（护栏 #2 的可删性前提）', () => {
  const merged = mergeMappingSync({
    mappings: MAPPINGS,
    parts: [
      part({
        pending: {
          total: 1,
          token: 'tk-a',
          items: [{ group: '指南', relation: 'gone', sourcePath: 'gone.md' }],
          candidateSourcePaths: ['gone.md'],
          untouchedGroups: ['指南'],
          eligibleCount: 3,
        },
      }),
      part({
        pending: {
          total: 2,
          token: 'tk-b',
          items: [{ group: 'API 文档', relation: 'x', sourcePath: 'x.md' }],
          candidateSourcePaths: ['x.md', 'y.md'],
          eligibleCount: 4,
        },
      }),
    ],
    prevBuckets: [[], []],
    params: PARAMS,
    at: 1,
    computedAt: 99,
  });
  assert.equal(merged.pendingDelete.total, 3);
  assert.equal(merged.pendingDelete.items.length, 2);
  assert.deepEqual(merged.pendingDelete.untouchedGroups, ['指南']);
  assert.equal(merged.pendingDelete.eligibleCount, 7);
  assert.equal(merged.pendingDelete.computedAt, 99);
  // token 必须等于「对这组合并后的 items」重算的结果，而不是任何一份旧 token
  assert.notEqual(merged.pendingDelete.token, 'tk-a');
  assert.equal(
    merged.pendingDelete.token,
    computePruneToken(merged.pendingDelete.items.map((item) => ({
      group: item.group,
      relation: item.relation,
      sourcePath: item.sourcePath ?? item.relation,
    }))),
  );
});

test('候选：部分被闸门拦 → stale 可见但 blocked 为空；全部被拦才报 blocked', () => {
  const some = mergeMappingSync({
    mappings: MAPPINGS,
    parts: [part({ pending: { blocked: 'EMPTY_SOURCE' } }), part({ pending: { total: 1, items: [{ group: 'g', relation: 'r', sourcePath: 'r.md' }] } })],
    prevBuckets: [[], []],
    params: PARAMS,
    at: 1,
    computedAt: 1,
  });
  assert.equal(some.pendingDelete.blocked, null);
  assert.equal(some.pendingDelete.stale, true);
  assert.equal(some.pendingDelete.total, 1);

  const all = mergeMappingSync({
    mappings: MAPPINGS,
    parts: [part({ pending: { blocked: 'EMPTY_SOURCE' } }), part({ pending: { blocked: 'GATE_SCALE' } })],
    prevBuckets: [[], []],
    params: PARAMS,
    at: 1,
    computedAt: 1,
  });
  assert.equal(all.pendingDelete.blocked, 'EMPTY_SOURCE');
  assert.equal(all.canAdvanceCommit, false);
});

test('明细合并：created / groups 取并集拼接', () => {
  const merged = mergeMappingSync({
    mappings: MAPPINGS,
    parts: [
      part({ created: [{ group: '指南', relation: 'a' }] }),
      part({ created: [{ group: 'API 文档', relation: 'b' }] }),
    ],
    prevBuckets: [[], []],
    params: PARAMS,
    at: 1,
    computedAt: 1,
  });
  assert.deepEqual(merged.created?.map((item) => item.relation), ['a', 'b']);
  assert.equal(merged.createdTotal, 2);
});

test('失败映射：候选必须标 stale（半份候选不能当完整）', () => {
  const merged = mergeMappingSync({
    mappings: MAPPINGS,
    parts: [part({ pending: { total: 1, items: [{ group: 'g', relation: 'r', sourcePath: 'r.md' }] } }), failedMappingPart(['gone.md'], 5)],
    prevBuckets: [[], ['gone.md']],
    params: PARAMS,
    at: 1,
    computedAt: 1,
  });
  assert.equal(merged.state, 'failed');
  assert.equal(merged.canAdvanceCommit, false);
  // blocked 仍是 null（不是被闸门拦），但必须 stale —— 否则 UI 会把半份候选说成完整
  assert.equal(merged.pendingDelete.blocked, null);
  assert.equal(merged.pendingDelete.stale, true);
  assert.equal(merged.pendingDelete.staleReason, 'not-recomputed');
});

test('mappingParams：group 是首条兼容位，mappings 是完整真相', () => {
  assert.deepEqual(mappingParams(PARAMS, MAPPINGS), { ...PARAMS, mappings: MAPPINGS });
});
