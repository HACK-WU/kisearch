/**
 * 导入落点推导单测（src/lib/import-path.ts）
 *
 * 锁住的不变量：
 *   1) `resolveGroupForSource`（显式 group 拼前缀；缺省取相对目录；根下散文件归 `__root__` 保留键）；
 *   2) `isSafeGroupPath` 与 `/api/import/run` / `/api/import/preflight` 共用同一判据（R1 收敛）；
 *   3) `isUserAssignableGroup` = 前者 + 拒收保留键（根只能靠「留空」到达）；
 *   4) `relationOfPath` 直接复用 `deriveRelationText`（判据里的 relation 必须与真实写入一致）。
 *
 * 运行：npx jiti test/import-path.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOT_GROUP_KEY, groupDisplayName, groupToRelDir, isRootGroup, isSafeGroupPath, isUserAssignableGroup, relationOfPath, resolveGroupForSource } from '../src/lib/import-path.ts';
import { deriveRelationText } from '../src/lib/chunk-entries.ts';

test('resolveGroupForSource：显式 group 作为根前缀，保留文件相对子目录', () => {
  assert.equal(resolveGroupForSource('raw', 'a.md', 'demo'), 'raw');
  assert.equal(resolveGroupForSource('raw', 'docs/a.md', 'demo'), 'raw/docs');
  assert.equal(resolveGroupForSource('raw', 'x/y/a.md', 'demo'), 'raw/x/y');
});

test('resolveGroupForSource：缺省 group 取相对目录，根下散文件归根保留键', () => {
  assert.equal(resolveGroupForSource('', 'docs/a.md', 'demo'), 'docs');
  // ★ 不再用 scope 名：否则与「源目录里真实存在同名子目录」共用键，同名文档被判幂等重导而丢内容
  assert.equal(resolveGroupForSource('', 'a.md', 'demo'), ROOT_GROUP_KEY);
  assert.equal(resolveGroupForSource('', 'langchain/stages/a.md', 'demo'), 'langchain/stages');
  // 显式 group 的语义不受影响：它仍是统一根前缀
  assert.equal(resolveGroupForSource('demo', 'a.md', 'demo'), 'demo');
});

test('根键工具：展示为「根」、Wiki 回写落 wiki 根目录', () => {
  assert.equal(isRootGroup(ROOT_GROUP_KEY), true);
  assert.equal(isRootGroup('demo'), false);
  assert.equal(groupDisplayName(ROOT_GROUP_KEY), '根');
  assert.equal(groupDisplayName('docs/api'), 'docs/api');
  assert.equal(groupToRelDir(ROOT_GROUP_KEY), '');
  assert.equal(groupToRelDir('docs/api'), 'docs/api');
});

test('isUserAssignableGroup：保留键对内部合法、对用户非法', () => {
  // 内部存储/路径拼接允许（导入会写它、wiki 回写要拼它）
  assert.equal(isSafeGroupPath(ROOT_GROUP_KEY), true);
  // 用户不能手写：根只能通过「Group 留空」到达
  assert.equal(isUserAssignableGroup(ROOT_GROUP_KEY), false);
  assert.equal(isUserAssignableGroup(''), true, '空串 = 未指定，合法');
  assert.equal(isUserAssignableGroup('raw'), true);
  assert.equal(isUserAssignableGroup('/etc'), false);
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
