/**
 * import-modified.test.ts —— 「变更的文档」采集口径（2026-11-04）
 *
 * 契约（用户 2026-11-04 定）：后端**不采集被修改的内容**，只记录「哪个文档被覆盖重写」。
 * 判定仅 `action === 'overwrite'`，**不做原文比对、不存差异正文**。
 *
 * 覆盖用例：
 *   1. 首次导入 → 只进 created，modified 为空
 *   2. 同目录重导（覆盖）→ 只进 modified，created 为空
 *   3. 新增 + 重导混合 → 两清单互不污染
 *   4. `--conflict-mode skip` → 被跳过的文件不算变更
 *
 * 运行：npx jiti test/import-modified.test.ts
 *
 * ★ 全部用 --no-vector（免 embedding），因此 incremental 的「内容未变则跳过重算」不生效
 *   （该判定要求 vector 模式）——正好验证「非增量策略下覆盖即变更」的既定取舍。
 *   「向量模式下内容未变的文件不计入 modified」由既有 `isContentUnchanged` 分支保证
 *   （它在记账点之前 continue），本文件不重复验证。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, getTestEnv, cleanupTestConfig, JITI_CLI } from './test-config.js';

const SCRIPT = path.resolve('src/import.ts');

function runImport(args: string[]): any {
  const { execFileSync } = require('node:child_process');
  let out: string;
  try {
    out = execFileSync(process.execPath, [JITI_CLI, SCRIPT, ...args], {
      encoding: 'utf-8',
      env: getTestEnv(),
      cwd: path.resolve('.'),
    });
  } catch (err: any) {
    out = err.stdout ?? '';
  }
  return JSON.parse(out);
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const scope = `modified-${Date.now()}`;
let sourceDir = '';

describe('变更的文档采集口径：只记标识，不采集内容', () => {
  before(() => {
    registerTestScope(scope);
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-modified-'));
    writeFile(sourceDir, 'docs/a.md', '# A\n第一版');
    writeFile(sourceDir, 'docs/b.md', '# B\n第一版');
  });

  after(() => {
    cleanupTestConfig();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  it('首次导入：全部计入 created，modified 为空', () => {
    const r = runImport(['--scope', scope, '--source', sourceDir, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.createdTotal, 2, `createdTotal 应为 2：${JSON.stringify(r.created)}`);
    assert.strictEqual(r.modifiedTotal, 0, '首次导入没有覆盖重写，modifiedTotal 必须为 0');
    assert.deepStrictEqual(r.modified, []);
    assert.strictEqual(r.modifiedTruncated, false);
  });

  it('同目录重导（覆盖重写）：进 modified，不再计入 created', () => {
    writeFile(sourceDir, 'docs/a.md', '# A\n第二版（内容改过）');
    const r = runImport(['--scope', scope, '--source', sourceDir, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    // --no-vector 不启用 incremental 的「内容未变」判定 ⇒ 两篇都走了 overwrite
    assert.strictEqual(r.modifiedTotal, 2, `modified=${JSON.stringify(r.modified)}`);
    assert.strictEqual(r.createdTotal, 0, '覆盖重写不得计入新增');
    const names = r.modified.map((item: { relation: string }) => item.relation).sort();
    assert.deepStrictEqual(names, ['a', 'b']);
    // 只记标识：绝不带内容/差异字段
    for (const item of r.modified) {
      assert.deepStrictEqual(Object.keys(item).sort(), ['group', 'relation']);
      // 源目录子结构会派生 group（docs/ 子目录 ⇒ wiki/docs）
      assert.ok(item.group.startsWith('wiki'), `group 应落在 wiki 下：${item.group}`);
    }
  });

  it('新增 + 重导混合：两清单互不污染', () => {
    writeFile(sourceDir, 'docs/c.md', '# C\n新文件');
    const r = runImport(['--scope', scope, '--source', sourceDir, '--group', 'wiki', '--no-vector']);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.createdTotal, 1, `created=${JSON.stringify(r.created)}`);
    assert.deepStrictEqual(r.created.map((item: { relation: string }) => item.relation), ['c']);
    assert.strictEqual(r.modifiedTotal, 2, `modified=${JSON.stringify(r.modified)}`);
    assert.deepStrictEqual(
      r.modified.map((item: { relation: string }) => item.relation).sort(),
      ['a', 'b'],
    );
  });

  it('--conflict-mode skip：被跳过的文件不算变更', () => {
    const r = runImport([
      '--scope', scope, '--source', sourceDir, '--group', 'wiki', '--no-vector',
      '--conflict-mode', 'skip',
    ]);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.modifiedTotal, 0, 'skip 的文件没有落库，不能报成已变更');
    assert.deepStrictEqual(r.modified, []);
  });
});
