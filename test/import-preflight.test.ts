/**
 * import-preflight.test.ts —— 重复导入预检（REQ-20261010-001 R6 / A10）。
 *
 * 契约：
 *   1. 命中判据 = 文件**原文**与库中某文档原文一致，且 `sourcePath !== rel`；
 *   2. `sourcePath` 相同（正常幂等更新）**不算**重复；
 *   3. 预检**零写入**（local KB / 关系数 / 向量均不变）；
 *   4. `onlyRelPaths` 与 run 同口径（子集预检）；明细截断时 `files.matched` 仍是完整计数。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/import-preflight.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { getLocalKbDir } from '../src/lib/scope.js';
import { readAllGroupCaches } from '../src/lib/group-cache.js';
import { preflightImportDuplicates } from '../src/lib/import-preflight.js';

const { handleDirectImport } = await import('../src/lib/import.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-preflight-'));
const SCOPE = `preflight-${Date.now().toString(36)}`;
registerTestScope(SCOPE);

function writeFiles(base: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const dst = path.join(base, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, body);
  }
}

const BODY_A = '# alpha\n内容 A 正文。\n';
const BODY_B = '# beta\n内容 B 正文。\n';

/** 库内先有一份扁平导入的文档：rel = "alpha.md"、group = scope 名 */
const library = path.join(tmpRoot, 'library');
writeFiles(library, { 'alpha.md': BODY_A });

/** 本次待导入：同一份内容换了路径（rel = "docs/alpha.md"）+ 一份全新内容 */
const staged = path.join(tmpRoot, 'staged');
writeFiles(staged, {
  'docs/alpha.md': BODY_A, // 与库中 alpha.md 原文一致、sourcePath 不同 → 疑似重复
  'alpha.md': BODY_A, // 与库中同 rel → 正常幂等更新，不算重复
  'docs/new.md': BODY_B, // 新内容 → 不算重复
});

describe('R6：重复导入预检（只读）', () => {
  it('命中"内容一致但 sourcePath 不同"，同 rel 与全新内容都不算重复', async () => {
    await handleDirectImport({ scope: SCOPE, sourceDir: library, vector: false });
    const before = readAllGroupCaches(SCOPE).get(SCOPE)?.hot_relations.length ?? 0;
    const kbPath = getLocalKbDir(SCOPE, SCOPE);
    const kbBefore = fs.readFileSync(kbPath, 'utf-8');

    const result = preflightImportDuplicates({ scope: SCOPE, sourceDir: staged });

    assert.equal(result.ok, true);
    assert.equal(result.files.scanned, 3, '扫描到 3 个 Markdown');
    assert.equal(result.files.matched, 1, '只有 docs/alpha.md 命中');
    assert.equal(result.truncated, false);
    assert.deepEqual(result.duplicates, [{
      rel: 'docs/alpha.md',
      existingGroup: SCOPE,
      existingRelation: 'alpha',
      existingSourcePath: 'alpha.md',
    }]);

    // 零写入：KB 原文与关系数均不变
    assert.equal(fs.readFileSync(kbPath, 'utf-8'), kbBefore, '预检不得改动 local KB');
    assert.equal(readAllGroupCaches(SCOPE).get(SCOPE)?.hot_relations.length ?? 0, before, '预检不得改动关系数');
  });

  it('onlyRelPaths 与 run 同口径（子集预检）', async () => {
    const subset = preflightImportDuplicates({
      scope: SCOPE,
      sourceDir: staged,
      onlyRelPaths: ['alpha.md'],
    });
    assert.equal(subset.files.scanned, 1);
    assert.equal(subset.files.matched, 0, '同 rel 的幂等更新不算重复');

    const subsetHit = preflightImportDuplicates({
      scope: SCOPE,
      sourceDir: staged,
      onlyRelPaths: ['docs/alpha.md'],
    });
    assert.equal(subsetHit.files.matched, 1);
  });

  it('明细截断时 files.matched 仍是完整计数', () => {
    const many = path.join(tmpRoot, 'many');
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) files[`docs/dup-${i}.md`] = BODY_A;
    writeFiles(many, files);
    const result = preflightImportDuplicates({ scope: SCOPE, sourceDir: many, maxDetail: 2 });
    assert.equal(result.files.matched, 5);
    assert.equal(result.duplicates.length, 2);
    assert.equal(result.truncated, true);
  });
});

/**
 * debug 2026-10-19：group 吸收路径前缀时的疑似重复误判。
 *
 * 场景（用户实测）：上次 sourceDir 选父目录、缺省 group（rel=`wiki/docs/a.md`），
 * 本次 sourceDir 选 `wiki` 子目录 + 显式 group=`wiki`（rel=`docs/a.md`）。
 * 两次**落点相同**（`wiki/docs` + `a`），只比裸 rel 会把幂等更新报成"会新建副本"。
 */
describe('group 吸收路径前缀时不算重复', () => {
  const GROUP_SCOPE = `${SCOPE}-grp`;
  const parent = path.join(tmpRoot, 'grp-parent');
  const child = path.join(tmpRoot, 'grp-child');

  it('落点相同 ⇒ 幂等更新；不传 group 时仍按旧口径误报（证明修复必要性）', async () => {
    registerTestScope(GROUP_SCOPE);
    writeFiles(parent, { 'wiki/docs/a.md': BODY_A });
    await handleDirectImport({ scope: GROUP_SCOPE, sourceDir: parent, vector: false });
    writeFiles(child, { 'docs/a.md': BODY_A });

    const withoutGroup = preflightImportDuplicates({ scope: GROUP_SCOPE, sourceDir: child });
    assert.equal(withoutGroup.files.matched, 1, '不传 group ⇒ 只比裸 rel，误判为重复（旧行为）');

    const withGroup = preflightImportDuplicates({ scope: GROUP_SCOPE, sourceDir: child, group: 'wiki' });
    assert.equal(withGroup.files.matched, 0, '落点相同（wiki/docs + a）不得判为疑似重复');
    assert.deepEqual(withGroup.duplicates, []);
  });

  it('落点不同时仍要判重复（修复不能放宽到"永不重复"）', async () => {
    const other = path.join(tmpRoot, 'grp-other');
    writeFiles(other, { 'docs/a.md': BODY_A });
    const result = preflightImportDuplicates({ scope: GROUP_SCOPE, sourceDir: other, group: 'other' });
    assert.equal(result.files.matched, 1, 'group=other 落点不同，应仍然提示重复');
  });

  it('导入侧同口径：同落点重导不进入跳过集，落点不同才跳过', async () => {
    // 同落点（sourceDir=<group> 子目录 + group=wiki）再导一次 ⇒ 应视为更新，duplicatesSkipped = 0
    const again = path.join(tmpRoot, 'grp-child-2');
    writeFiles(again, { 'docs/a.md': BODY_A });
    const updated = await handleDirectImport({
      scope: GROUP_SCOPE,
      sourceDir: again,
      group: 'wiki',
      vector: false,
      skipDuplicates: true,
    });
    assert.equal(updated.stats.files.duplicatesSkipped, 0, '落点相同（wiki/docs + a）不得被跳过');

    // 换 group 落到别的 groupPath ⇒ 与库中不是同一篇，整批被判重复
    // ⇒ 按既有语义 fail-loud 抛 ALL_FILES_DUPLICATES（不静默成功 0 篇）
    // 注意用不同文件名：`sourcePath` 只存相对路径（不含 sourceDir 身份），
    // 同名 rel 会被既有语义当成"同一来源"，测不出落点差异
    const elsewhere = path.join(tmpRoot, 'grp-child-3');
    writeFiles(elsewhere, { 'docs/b.md': BODY_A });
    await assert.rejects(
      () => handleDirectImport({
        scope: GROUP_SCOPE,
        sourceDir: elsewhere,
        group: 'other',
        vector: false,
        skipDuplicates: true,
      }),
      (error: unknown) => (error as { code?: string }).code === 'ALL_FILES_DUPLICATES',
      '落点不同应被判为重复（整批重复则拒绝导入）',
    );
  });
});

describe('库中同内容多副本', () => {
  const MULTI_SCOPE = `${SCOPE}-multi`;

  it('副本都进索引（不再只留第一条），任一条匹配即视为同一篇', async () => {
    const { buildLibraryIndex } = await import('../src/lib/duplicate-index.ts');
    registerTestScope(MULTI_SCOPE);
    // 副本 1：父目录导入（rel 带 wiki 前缀）⇒ 落点 wiki/docs
    const first = path.join(tmpRoot, 'multi-first');
    writeFiles(first, { 'wiki/docs/a.md': BODY_A });
    await handleDirectImport({ scope: MULTI_SCOPE, sourceDir: first, vector: false });
    // 副本 2：另一 group、同内容 ⇒ 同 hash 的第二条
    const second = path.join(tmpRoot, 'multi-second');
    writeFiles(second, { 'docs/a.md': BODY_A });
    await handleDirectImport({ scope: MULTI_SCOPE, sourceDir: second, group: 'other', vector: false });

    const index = buildLibraryIndex(MULTI_SCOPE);
    const multi = [...index.values()].filter((list) => list.length > 1);
    assert.ok(multi.length > 0, '同内容的两份文档必须留在同一个 hash 的数组里');
    assert.ok(multi[0].length >= 2);

    // 本次与副本 1 落点相同（wiki/docs + a）⇒ 不判重复
    const third = path.join(tmpRoot, 'multi-third');
    writeFiles(third, { 'docs/a.md': BODY_A });
    const result = preflightImportDuplicates({ scope: MULTI_SCOPE, sourceDir: third, group: 'wiki' });
    assert.equal(result.files.matched, 0);
  });
});

after(() => {
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
