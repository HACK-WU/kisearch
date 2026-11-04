/**
 * 多映射表单模型（REQ-20261104-002）：归一 / 校验 / 与旧记录兼容 / 列表列文案。
 *
 * 判据与后端 `src/lib/datasource-mappings.ts` 逐条对齐 —— 消息文案也要一致，
 * 否则「前端拦住」和「后端拒绝」会给出两套说法。
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const {
  MAX_MAPPINGS,
  emptyRow,
  normalizeSubdir,
  isSafeSubdir,
  isAssignableGroup,
  rowsFromMappings,
  toMappingPayload,
  validateMappingRows,
  mappingRowsEqual,
  mappingUiMode,
  sourceTypeLabel,
  subdirLabel,
  groupLabel,
  summarizeGroupColumn,
} = await vite.ssrLoadModule('/src/lib/datasourceMappings.ts');
after(async () => vite.close());

describe('多映射表单模型', () => {
  it('归一：去空白 / 去首尾斜杠 / "." 视为仓库根', () => {
    assert.equal(normalizeSubdir('  docs/guide  '), 'docs/guide');
    assert.equal(normalizeSubdir('/docs/guide/'), 'docs/guide');
    assert.equal(normalizeSubdir('.'), '');
    assert.equal(normalizeSubdir(''), '');
  });

  it('子目录与 Group 判据与后端一致', () => {
    assert.equal(isSafeSubdir('docs/guide'), true);
    assert.equal(isSafeSubdir(''), true);
    assert.equal(isSafeSubdir('/abs'), false);
    assert.equal(isSafeSubdir('a/../b'), false);
    assert.equal(isSafeSubdir('a\\b'), false);
    assert.equal(isAssignableGroup('指南'), true);
    assert.equal(isAssignableGroup(''), true);
    assert.equal(isAssignableGroup('__root__'), false);
    assert.equal(isAssignableGroup('/abs'), false);
  });

  it('旧记录（无 mappings）：按 relativeRoot + group 合成 1 行', () => {
    assert.deepEqual(rowsFromMappings(undefined, { relativeRoot: 'docs', group: '文档' }), [
      { subdir: 'docs', group: '文档' },
    ]);
    assert.deepEqual(rowsFromMappings([], { relativeRoot: '', group: null }), [{ subdir: '', group: '' }]);
  });

  it('提交负载：空 group → null（= 自动）', () => {
    assert.deepEqual(
      toMappingPayload([{ subdir: ' docs/guide ', group: ' 指南 ' }, { subdir: 'docs/api', group: '' }]),
      [{ subdir: 'docs/guide', group: '指南' }, { subdir: 'docs/api', group: null }],
    );
  });

  it('校验：0 条 / 超上限', () => {
    assert.equal(validateMappingRows([]).code, 'MAPPING_EMPTY');
    const many = Array.from({ length: MAX_MAPPINGS + 1 }, (_, i) => ({ subdir: `d${i}`, group: '' }));
    assert.equal(validateMappingRows(many).code, 'MAPPING_LIMIT');
    const max = Array.from({ length: MAX_MAPPINGS }, (_, i) => ({ subdir: `d${i}`, group: '' }));
    assert.equal(validateMappingRows(max), null);
  });

  it('校验：重复子目录 / 互相包含 / 根行共存都被拒，且带行号', () => {
    const dup = validateMappingRows([{ subdir: 'docs', group: 'a' }, { subdir: ' docs ', group: 'b' }]);
    assert.equal(dup.code, 'MAPPING_DUPLICATE');
    assert.equal(dup.index, 0);
    assert.equal(dup.conflictIndex, 1);

    const nested = validateMappingRows([{ subdir: 'docs', group: 'a' }, { subdir: 'docs/guide', group: 'b' }]);
    assert.equal(nested.code, 'MAPPING_OVERLAP');
    assert.equal(nested.conflictIndex, 1);

    const rootPlus = validateMappingRows([{ subdir: '', group: 'all' }, { subdir: 'docs', group: 'docs' }]);
    assert.equal(rootPlus.code, 'MAPPING_OVERLAP');
  });

  it('校验：同一 Group 被两条映射共用是允许的（Q3）', () => {
    assert.equal(validateMappingRows([
      { subdir: 'docs/guide', group: '文档' },
      { subdir: 'docs/faq', group: '文档' },
    ]), null);
  });

  it('等价判定：忽略空白差异，但对顺序敏感', () => {
    const saved = [{ subdir: 'docs/guide', group: '指南' }, { subdir: 'docs/api', group: null }];
    assert.equal(mappingRowsEqual([{ subdir: ' docs/guide ', group: ' 指南 ' }, { subdir: 'docs/api', group: '' }], saved), true);
    assert.equal(mappingRowsEqual([{ subdir: 'docs/api', group: '' }, { subdir: 'docs/guide', group: '指南' }], saved), false);
  });

  it('展示文案：根 / 自动', () => {
    assert.equal(subdirLabel(''), '（仓库根）');
    assert.equal(subdirLabel('docs/guide'), 'docs/guide');
    assert.equal(groupLabel(null), '自动：按顶层子目录');
    assert.equal(groupLabel('指南'), '指南');
  });

  it('列表列：1 条显示原值，≥2 条显示「N 个映射」且 title 带全部映射', () => {
    assert.deepEqual(summarizeGroupColumn(undefined, '文档'), { text: '文档', title: '文档' });
    assert.deepEqual(summarizeGroupColumn(undefined, null), { text: '(自动)', title: '(自动)' });
    const many = summarizeGroupColumn([
      { subdir: 'docs/guide', group: '指南' },
      { subdir: 'docs/api', group: null },
    ]);
    assert.equal(many.text, '2 个映射');
    assert.equal(many.title, 'docs/guide → 指南\ndocs/api → 自动');
  });

  it('落点区形态：Git 源可编辑、目录源单只读落点、旧 daemon 只读降级', () => {
    // Git 源（含旧 daemon 不返回 type、但有 git 元信息的情况）
    assert.equal(mappingUiMode({ type: 'git', git: { repoRoot: '/r' }, mappings: [] }), 'editor');
    assert.equal(mappingUiMode({ git: { repoRoot: '/r' }, mappings: [{}] }), 'editor');
    // 普通目录源：归一化同样会给它一条根映射，但**绝不能**因此出映射表
    assert.equal(mappingUiMode({ type: 'directory', mappings: [{ subdir: '', group: null }] }), 'single');
    assert.equal(mappingUiMode({ type: 'directory' }), 'single');
    // 旧 daemon：不下发 mappings
    assert.equal(mappingUiMode({ type: 'git', git: { repoRoot: '/r' } }), 'readonly');
  });

  it('源类型文案与落点形态解耦：旧 daemon 的 Git 源仍显示「Git 仓库」', () => {
    // 若用「能否编辑映射」反推类型，这一条会错成「普通目录」
    assert.equal(sourceTypeLabel({ type: 'git', git: { repoRoot: '/r' } }), 'Git 仓库');
    assert.equal(sourceTypeLabel({ git: { repoRoot: '/r' } }), 'Git 仓库');
    assert.equal(sourceTypeLabel({ type: 'git', git: { repoRoot: '/r' }, mappings: [] }), 'Git 仓库');
    assert.equal(sourceTypeLabel({ type: 'directory', mappings: [{ subdir: '', group: null }] }), '普通目录');
    assert.equal(sourceTypeLabel({ type: 'directory' }), '普通目录');
  });

  it('emptyRow：默认一条根映射', () => {
    assert.deepEqual(emptyRow(), { subdir: '', group: '' });
  });
});
