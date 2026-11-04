/**
 * 「仓库子目录 → 落点 Group」映射单测（src/lib/datasource-mappings.ts，REQ-20261104-002）
 *
 * 锁住的不变量：
 *   1) 旧记录（version:2，单子目录 + 单 group）必须等价迁移成 1 条映射（R1，护栏 #5）；
 *   2) 子目录**互相包含**（含仓库根）一律拒绝 —— 否则同一文件被导入两次（N1/N2）；
 *   3) 同一 Group 被多条映射共用是**允许**的（Q3）；
 *   4) 基线分桶用**最长子目录前缀**，仓库根是长度 0 的兜底（护栏 #2）：
 *      `seenRels` 若不分桶，`docs/guide/a.md` 与 `docs/api/a.md` 会撞成同一个 `a.md`，
 *      待删候选可能把在用文档列成待删。
 *
 * 运行：npx jiti test/datasource-mappings.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_DATASOURCE_MAPPINGS,
  describeMapping,
  isSafeRelativeSubdir,
  joinSeenRelsByMapping,
  mappingTargetDir,
  normalizeMappingGroup,
  normalizeSubdir,
  resolveMappings,
  seenRelKey,
  splitSeenRelsByMapping,
  validateMappings,
  type MappingIssue,
} from '../src/lib/datasource-mappings.ts';

const codes = (issue: MappingIssue | null): string | null => issue?.code ?? null;

test('normalizeSubdir：去空白与首尾斜杠，"." 视为仓库根', () => {
  assert.equal(normalizeSubdir('  docs/guide  '), 'docs/guide');
  assert.equal(normalizeSubdir('/docs/guide/'), 'docs/guide');
  assert.equal(normalizeSubdir('.'), '');
  assert.equal(normalizeSubdir(''), '');
  assert.equal(normalizeSubdir(undefined), '');
  assert.equal(normalizeSubdir(123), '');
});

test('normalizeMappingGroup：空串 → null（= 按顶层子目录自动）', () => {
  assert.equal(normalizeMappingGroup('  '), null);
  assert.equal(normalizeMappingGroup(''), null);
  assert.equal(normalizeMappingGroup(' 指南 '), '指南');
  assert.equal(normalizeMappingGroup(null), null);
});

test('isSafeRelativeSubdir：与 datasource-clone 同口径', () => {
  assert.equal(isSafeRelativeSubdir(''), true);
  assert.equal(isSafeRelativeSubdir('docs/guide'), true);
  assert.equal(isSafeRelativeSubdir('/abs'), false);
  assert.equal(isSafeRelativeSubdir('a/../b'), false);
  assert.equal(isSafeRelativeSubdir('a\\b'), false);
  assert.equal(isSafeRelativeSubdir('a//b'), false);
  assert.equal(isSafeRelativeSubdir('a/.git/b'), false);
  assert.equal(isSafeRelativeSubdir('x'.repeat(1025)), false);
});

test('mappingTargetDir：空子目录 = 仓库根', () => {
  assert.equal(mappingTargetDir('/repo', ''), '/repo');
  assert.equal(mappingTargetDir('/repo', 'docs/guide'), '/repo/docs/guide');
});

test('resolveMappings：旧记录（单子目录 + 单 group）等价迁移为 1 条', () => {
  assert.deepEqual(
    resolveMappings({ relativeRoot: 'docs/guide', group: '指南' }),
    [{ subdir: 'docs/guide', group: '指南' }],
  );
  assert.deepEqual(
    resolveMappings({ relativeRoot: '', group: null }),
    [{ subdir: '', group: null }],
  );
  // 非 git 记录（relativeRoot 缺省）同样得到 1 条根映射
  assert.deepEqual(resolveMappings({ relativeRoot: null, group: null }), [{ subdir: '', group: null }]);
});

test('resolveMappings：mappings 是权威，逐项归一', () => {
  assert.deepEqual(
    resolveMappings({
      mappings: [
        { subdir: ' docs/guide ', group: ' 指南 ' },
        { subdir: '/docs/api/', group: '' },
      ],
      relativeRoot: 'ignored',
      group: 'ignored',
    }),
    [
      { subdir: 'docs/guide', group: '指南' },
      { subdir: 'docs/api', group: null },
    ],
  );
});

test('resolveMappings：脏项丢弃；全部脏则退回旧字段，不静默降级成根', () => {
  assert.deepEqual(
    resolveMappings({ mappings: ['x', null, { subdir: 'ok' }], relativeRoot: 'r', group: null }),
    [{ subdir: 'ok', group: null }],
  );
  assert.deepEqual(
    resolveMappings({ mappings: [1, 2], relativeRoot: 'r', group: 'g' }),
    [{ subdir: 'r', group: 'g' }],
  );
});

test('validateMappings：0 条 / 超上限', () => {
  assert.equal(codes(validateMappings([])), 'MAPPING_EMPTY');
  const tooMany = Array.from({ length: MAX_DATASOURCE_MAPPINGS + 1 }, (_, i) => ({ subdir: `d${i}`, group: null }));
  assert.equal(codes(validateMappings(tooMany)), 'MAPPING_LIMIT');
  const max = Array.from({ length: MAX_DATASOURCE_MAPPINGS }, (_, i) => ({ subdir: `d${i}`, group: null }));
  assert.equal(validateMappings(max), null);
});

test('validateMappings：非法子目录 / 非法 Group 带下标定位', () => {
  const badSubdir = validateMappings([
    { subdir: 'docs', group: null },
    { subdir: 'a/../b', group: null },
  ]);
  assert.equal(codes(badSubdir), 'INVALID_SUBDIR');
  assert.equal(badSubdir?.index, 1);

  const badGroup = validateMappings([
    { subdir: 'docs', group: '/abs' },
  ]);
  assert.equal(codes(badGroup), 'INVALID_GROUP');
  assert.equal(badGroup?.index, 0);

  // 保留名不能由用户手写（根只能靠「Group 留空」表达）
  assert.equal(codes(validateMappings([{ subdir: 'docs', group: '__root__' }])), 'INVALID_GROUP');
});

test('validateMappings：重复子目录被拒（N3）', () => {
  const issue = validateMappings([
    { subdir: 'docs', group: 'a' },
    { subdir: ' docs ', group: 'b' },
  ]);
  assert.equal(codes(issue), 'MAPPING_DUPLICATE');
  assert.equal(issue?.index, 0);
  assert.equal(issue?.conflictIndex, 1);
});

test('validateMappings：子目录互相包含被拒（N1），仓库根与子目录共存被拒（N2）', () => {
  const nested = validateMappings([
    { subdir: 'docs', group: 'a' },
    { subdir: 'docs/guide', group: 'b' },
  ]);
  assert.equal(codes(nested), 'MAPPING_OVERLAP');
  assert.equal(nested?.conflictIndex, 1);

  const rootPlusDir = validateMappings([
    { subdir: '', group: 'all' },
    { subdir: 'docs', group: 'docs' },
  ]);
  assert.equal(codes(rootPlusDir), 'MAPPING_OVERLAP');
  // 反向顺序同样被拒（与顺序无关）
  assert.equal(
    codes(validateMappings([
      { subdir: 'docs', group: 'docs' },
      { subdir: '', group: 'all' },
    ])),
    'MAPPING_OVERLAP',
  );
});

test('validateMappings：同一 Group 被多条映射共用是允许的（Q3）', () => {
  assert.equal(validateMappings([
    { subdir: 'docs/guide', group: '文档' },
    { subdir: 'docs/faq', group: '文档' },
  ]), null);
  // 兄弟目录、Group 互为前缀也允许
  assert.equal(validateMappings([
    { subdir: 'docs/guide', group: 'guide' },
    { subdir: 'docs/api', group: 'guide/api' },
  ]), null);
});

test('seenRelKey：子目录前缀进键，仓库根不贡献前缀', () => {
  assert.equal(seenRelKey('docs/guide', 'a.md'), 'docs/guide/a.md');
  assert.equal(seenRelKey('docs/guide', '/a.md'), 'docs/guide/a.md');
  assert.equal(seenRelKey('', 'docs/a.md'), 'docs/a.md');
});

test('splitSeenRelsByMapping：最长前缀胜 + 根兜底 + 孤立键丢弃', () => {
  const mappings = [
    { subdir: 'docs/guide', group: 'g1' },
    { subdir: 'docs/api', group: 'g2' },
  ];
  const seen = ['docs/guide/a.md', 'docs/guide/sub/b.md', 'docs/api/c.md', 'docs/other/d.md'];
  assert.deepEqual(splitSeenRelsByMapping(seen, mappings), [
    ['a.md', 'sub/b.md'],
    ['c.md'],
  ]);

  // 根映射兜底：所有键都归它
  assert.deepEqual(splitSeenRelsByMapping(seen, [{ subdir: '', group: null }]), [seen]);

  // 根与子目录共存（历史脏数据）：子目录优先，根只收剩余
  assert.deepEqual(
    splitSeenRelsByMapping(['docs/guide/a.md', 'docs/other/d.md'], [
      { subdir: '', group: null },
      { subdir: 'docs/guide', group: 'g' },
    ]),
    [['docs/other/d.md'], ['a.md']],
  );
});

test('joinSeenRelsByMapping：切桶可逆，输出稳定排序', () => {
  const mappings = [
    { subdir: 'docs/guide', group: 'g1' },
    { subdir: 'docs/api', group: 'g2' },
  ];
  const buckets = [['b.md', 'a.md'], ['c.md']];
  const merged = joinSeenRelsByMapping(mappings, buckets);
  assert.deepEqual(merged, ['docs/api/c.md', 'docs/guide/a.md', 'docs/guide/b.md']);
  assert.deepEqual(splitSeenRelsByMapping(merged, mappings), [['a.md', 'b.md'], ['c.md']]);
});

test('describeMapping：面向人的文案（根 / 自动）', () => {
  assert.equal(describeMapping({ subdir: '', group: null }), '（仓库根） → 自动');
  assert.equal(describeMapping({ subdir: 'docs/guide', group: '指南' }), 'docs/guide → 指南');
});
