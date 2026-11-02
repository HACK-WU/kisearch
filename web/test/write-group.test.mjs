/**
 * 写入落点推导单测（2026-11-02 修订：留空→根保留键）
 *
 * 锁住五条不变量：
 *   1) Group 有值 → 原样使用（含多级路径），且**不受 scope 影响**；
 *   2) Group 为空白（空格 / 制表 / 全空白）→ 落到根保留键 `__root__`，并置 fellBack；
 *   3) 两侧空白一律 trim（与提交给后端的值一致，避免 `" a/b "` 写出奇怪组名）；
 *   4) group 与 scope 都空 → 返回空串且 fellBack=false（调用方须先行拦截，不得提交）；
 *   5) 用户手写保留名 `__root__` → 视同留空（根只能靠「留空」到达，与后端拒收口径对齐）。
 *
 * 为什么不再用 scope 名：会与「源目录里真实存在的同名子目录」共用 group 键，
 * 同名文档被判幂等重导后内容丢失（`.debug/import-root-files-scope-group-20261102/`）。
 *
 * 运行：cd web && npm run test
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
const { resolveWriteGroup } = await vite.ssrLoadModule('/src/lib/writeGroup.ts');
const { ROOT_GROUP_KEY } = await vite.ssrLoadModule('/src/lib/groupTree.ts');
after(async () => vite.close());

describe('resolveWriteGroup', () => {
  it('Group 有值时原样使用，不回退', () => {
    assert.deepEqual(resolveWriteGroup('告警系统/告警收敛', 'kafka'), {
      group: '告警系统/告警收敛',
      fellBack: false,
    });
    assert.deepEqual(resolveWriteGroup('单级组', 'kafka'), { group: '单级组', fellBack: false });
  });

  it('Group 有值时不使用 scope（即使 scope 存在）', () => {
    const target = resolveWriteGroup('自定义组', 'some-scope');
    assert.equal(target.group, '自定义组');
    assert.equal(target.fellBack, false);
  });

  it('Group 留空 → 落到根保留键，并标记 fellBack', () => {
    assert.deepEqual(resolveWriteGroup('', 'bulk-test'), { group: ROOT_GROUP_KEY, fellBack: true });
    // 落点与 scope 无关：换 scope 不影响根键
    assert.equal(resolveWriteGroup('', 'kisearch').group, ROOT_GROUP_KEY);
  });

  it('Group 全空白（空格 / 制表 / 换行）同样落到根', () => {
    for (const raw of ['   ', '\t', '\n', ' \t\n ']) {
      assert.deepEqual(resolveWriteGroup(raw, 'kisearch'), { group: ROOT_GROUP_KEY, fellBack: true }, JSON.stringify(raw));
    }
  });

  it('两侧空白一律 trim（与提交给后端的值一致）', () => {
    assert.deepEqual(resolveWriteGroup('  项目根/测试模块  ', 'bulk-test'), {
      group: '项目根/测试模块',
      fellBack: false,
    });
    assert.deepEqual(resolveWriteGroup('', '  kafka  '), { group: ROOT_GROUP_KEY, fellBack: true });
  });

  it('用户手写保留名视同留空（根只能靠留空到达）', () => {
    assert.deepEqual(resolveWriteGroup('__root__', 'kafka'), { group: ROOT_GROUP_KEY, fellBack: true });
    assert.deepEqual(resolveWriteGroup('  __root__  ', 'kafka'), { group: ROOT_GROUP_KEY, fellBack: true });
  });

  it('group 与 scope 都空 → 空串且不标记回退（调用方须先行拦截 scope）', () => {
    assert.deepEqual(resolveWriteGroup('', ''), { group: '', fellBack: false });
    assert.deepEqual(resolveWriteGroup('   ', '   '), { group: '', fellBack: false });
  });

  it('null / undefined 容错（不抛，视同留空）', () => {
    assert.deepEqual(resolveWriteGroup(null, 'kafka'), { group: ROOT_GROUP_KEY, fellBack: true });
    assert.deepEqual(resolveWriteGroup(undefined, undefined), { group: '', fellBack: false });
  });

  it('回退结果通过 Group 路径校验', async () => {
    const { groupError } = await vite.ssrLoadModule('/src/lib/validators.ts');
    for (const scope of ['default', 'bulk-test', 'xpert_memory', 'kisearch2']) {
      const { group } = resolveWriteGroup('', scope);
      assert.equal(groupError(group), null, `scope=${scope} → group=${group}`);
    }
  });
});
