/**
 * import-skip-duplicates.test.ts —— 重复导入「跳过疑似重复」（REQ-20261019-002）。
 *
 * 契约：
 *   1. `skipDuplicates: true` 时，内容与库中一致但 sourcePath 不同的文件**零写入**；
 *   2. 统计恒等式 `completed + incomplete + skipped = scanned` 成立，且
 *      `stats.files.duplicatesSkipped` 是 `skipped` 的子集（不得重复计数）；
 *   3. 剔除后为空 → `ALL_FILES_DUPLICATES` fail-loud（含与 onlyRelPaths 交集为空）；
 *   4. 不传 `skipDuplicates` 时行为与改前一致（全量导入，新字段取缺省值）；
 *   5. 跳过集为空（库中无同内容）→ 等同普通导入，不报错。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/import-skip-duplicates.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { readAllGroupCaches } from '../src/lib/group-cache.js';

const { handleDirectImport } = await import('../src/lib/import.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-skipdup-'));
const SCOPE = `skipdup-${Date.now().toString(36)}`;
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
const BODY_C = '# gamma\n内容 C 正文。\n';
const BODY_D = '# delta\n内容 D 正文。\n';
/** 白名单用例专用：必须是全库唯一内容，否则会被前序用例导入的文档判成重复（测试间数据污染） */
const BODY_E = '# epsilon\n内容 E 正文。\n';

/** 库内先有一份扁平导入的文档：rel = "alpha.md"、group = scope 名 */
const library = path.join(tmpRoot, 'library');
writeFiles(library, { 'alpha.md': BODY_A });

/** 部分重复：docs/alpha.md 内容与库中一致但来源不同；docs/new.md 是新内容 */
const stagedPartlyDup = path.join(tmpRoot, 'partly');
writeFiles(stagedPartlyDup, { 'docs/alpha.md': BODY_A, 'docs/new.md': BODY_B });

/** 不跳过时用：b/alpha.md 重复 + b/new.md 新内容 */
const stagedNoSkip = path.join(tmpRoot, 'noskip');
writeFiles(stagedNoSkip, { 'b/alpha.md': BODY_A, 'b/new.md': BODY_B });

/** 全部重复：唯一文件与库中内容一致且来源不同 */
const stagedAllDup = path.join(tmpRoot, 'allDup');
writeFiles(stagedAllDup, { 'docs/alpha.md': BODY_A });

/** 无重复：全新内容 */
const stagedFresh = path.join(tmpRoot, 'fresh');
writeFiles(stagedFresh, { 'c1.md': BODY_C, 'c2.md': BODY_D });

/** 白名单用例：docs/alpha.md（重复）+ docs/new2.md（新） */
const stagedWhitelist = path.join(tmpRoot, 'whitelist');
writeFiles(stagedWhitelist, { 'docs/alpha.md': BODY_A, 'docs/new2.md': BODY_E });

const relationsCount = (group: string): number =>
  readAllGroupCaches(SCOPE).get(group)?.hot_relations.length ?? 0;

describe('REQ-20261019-002：跳过疑似重复', () => {
  it('部分重复：只导入非重复项，统计口径自洽（不重复计数）', async () => {
    await handleDirectImport({ scope: SCOPE, sourceDir: library, vector: false });
    assert.equal(relationsCount(SCOPE), 1, '库内先有 1 篇');

    const result = await handleDirectImport({
      scope: SCOPE,
      sourceDir: stagedPartlyDup,
      vector: false,
      skipDuplicates: true,
    });

    // 明细：只有 docs/alpha.md 被判重复
    assert.deepEqual(result.duplicatesSkipped, [{
      path: 'docs/alpha.md',
      existingGroup: SCOPE,
      existingRelation: 'alpha',
    }]);
    assert.equal(result.duplicatesSkippedTruncated, false);

    // 统计：scanned = 白名单后、剔除前（2）；completed = 1；skipped = 1（跳过项）
    assert.equal(result.stats.files.duplicatesSkipped, 1);
    assert.equal(result.stats.files.scanned, 2);
    assert.equal(result.stats.files.completed, 1);
    assert.equal(result.stats.files.incomplete, 0);
    assert.equal(result.stats.files.skipped, 1);
    // 恒等式（★ 跳过数不得被计两次）
    assert.equal(
      result.stats.files.completed + result.stats.files.incomplete + result.stats.files.skipped,
      result.stats.files.scanned,
      '恒等式 completed + incomplete + skipped = scanned 必须成立',
    );

    // 零写入：docs/alpha 不进库，只有 docs/new
    assert.equal(relationsCount('docs'), 1, '重复项未写入，只新增 new');
    assert.equal(readAllGroupCaches(SCOPE).get('docs')?.hot_relations[0]?.text, 'new');
  });

  it('不传 skipDuplicates：行为与改前一致（全量导入）', async () => {
    const result = await handleDirectImport({
      scope: SCOPE,
      sourceDir: stagedNoSkip,
      vector: false,
    });
    assert.equal(result.stats.files.duplicatesSkipped, 0);
    assert.deepEqual(result.duplicatesSkipped, []);
    assert.equal(result.duplicatesSkippedTruncated, false);
    assert.equal(result.stats.files.scanned, 2);
    assert.equal(result.stats.files.completed, 2, '两篇都导入（含重复项的新副本）');
    assert.equal(relationsCount('b'), 2, 'b/alpha 与 b/new 均入库');
  });

  it('全部重复：ALL_FILES_DUPLICATES fail-loud 且零写入', async () => {
    const before = relationsCount(SCOPE);
    await assert.rejects(
      () => handleDirectImport({
        scope: SCOPE,
        sourceDir: stagedAllDup,
        vector: false,
        skipDuplicates: true,
      }),
      (err: NodeJS.ErrnoException & { code?: string }) => {
        assert.equal(err.code, 'ALL_FILES_DUPLICATES');
        return true;
      },
    );
    assert.equal(relationsCount(SCOPE), before, '抛错前不得写入');
  });

  it('跳过集为空：等同普通导入，不报错', async () => {
    const result = await handleDirectImport({
      scope: SCOPE,
      sourceDir: stagedFresh,
      vector: false,
      skipDuplicates: true,
    });
    assert.equal(result.stats.files.duplicatesSkipped, 0);
    assert.deepEqual(result.duplicatesSkipped, []);
    assert.equal(result.stats.files.completed, 2);
    assert.equal(
      result.stats.files.completed + result.stats.files.incomplete + result.stats.files.skipped,
      result.stats.files.scanned,
    );
  });

  it('与 onlyRelPaths 叠加：白名单内全为重复 → fail-loud', async () => {
    await assert.rejects(
      () => handleDirectImport({
        scope: SCOPE,
        sourceDir: stagedWhitelist,
        vector: false,
        onlyRelPaths: ['docs/alpha.md'],
        skipDuplicates: true,
      }),
      (err: NodeJS.ErrnoException & { code?: string }) => err.code === 'ALL_FILES_DUPLICATES',
    );
  });

  it('与 onlyRelPaths 叠加：白名单减重复集后仍有文件 → 只导非重复项', async () => {
    const result = await handleDirectImport({
      scope: SCOPE,
      sourceDir: stagedWhitelist,
      vector: false,
      onlyRelPaths: ['docs/alpha.md', 'docs/new2.md'],
      skipDuplicates: true,
    });
    assert.equal(result.stats.files.duplicatesSkipped, 1);
    // scanned = 白名单后、剔除前（2）；completed = 1
    assert.equal(result.stats.files.scanned, 2);
    assert.equal(result.stats.files.completed, 1);
    assert.deepEqual(result.duplicatesSkipped.map((item) => item.path), ['docs/alpha.md']);
  });
});

after(() => {
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
