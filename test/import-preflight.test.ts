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

after(() => {
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
