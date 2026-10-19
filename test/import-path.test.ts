/**
 * 导入落点推导单测（src/lib/import-path.ts）
 *
 * 锁住的不变量：
 *   1) `resolveGroupForSource` 与历史实现逐字等价（显式 group 拼前缀；缺省取相对目录；根下文件归 scope）；
 *   2) `isSafeGroupPath` 与 `/api/import/run` / `/api/import/preflight` 共用同一判据（R1 收敛）；
 *   3) `relationOfPath` 直接复用 `deriveRelationText`（判据里的 relation 必须与真实写入一致）。
 *
 * 运行：npx jiti test/import-path.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeGroupPath, relationOfPath, resolveGroupForSource } from '../src/lib/import-path.ts';
import { deriveRelationText } from '../src/lib/chunk-entries.ts';

test('resolveGroupForSource：显式 group 作为根前缀，保留文件相对子目录', () => {
  assert.equal(resolveGroupForSource('raw', 'a.md', 'demo'), 'raw');
  assert.equal(resolveGroupForSource('raw', 'docs/a.md', 'demo'), 'raw/docs');
  assert.equal(resolveGroupForSource('raw', 'x/y/a.md', 'demo'), 'raw/x/y');
});

test('resolveGroupForSource：缺省 group 取相对目录，根下文件归 scope', () => {
  assert.equal(resolveGroupForSource('', 'docs/a.md', 'demo'), 'docs');
  assert.equal(resolveGroupForSource('', 'a.md', 'demo'), 'demo');
  assert.equal(resolveGroupForSource('', 'langchain/stages/a.md', 'demo'), 'langchain/stages');
});

test('isSafeGroupPath：拒绝绝对路径 / 反斜杠 / .. 段，空串合法', () => {
  assert.equal(isSafeGroupPath(''), true, '空串 = 未指定');
  assert.equal(isSafeGroupPath('raw'), true);
  assert.equal(isSafeGroupPath('wiki/部署运维'), true);

  assert.equal(isSafeGroupPath('/etc'), false);
  assert.equal(isSafeGroupPath('a\\b'), false);
  assert.equal(isSafeGroupPath('..'), false);
  assert.equal(isSafeGroupPath('a/../b'), false);
  assert.equal(isSafeGroupPath('a/..'), false);
});

test('relationOfPath 与 deriveRelationText 完全一致（判据与写入同源）', () => {
  for (const rel of ['docs/a.md', 'docs/01-LangChain是什么.md', 'a*b~c`.md', 'no-ext']) {
    assert.equal(relationOfPath(rel), deriveRelationText(rel), rel);
  }
  assert.equal(relationOfPath('docs/01-LangChain是什么.md'), '01-LangChain是什么');
});
