/**
 * 写入落点推导单测（2026-10-21）
 *
 * 锁住四条不变量：
 *   1) Group 有值 → 原样使用（含多级路径），且**不受 scope 影响**；
 *   2) Group 为空白（空格 / 制表 / 全空白）→ 回退为 scope 名，并置 fellBack；
 *   3) 两侧空白一律 trim（与提交给后端的值一致，避免 `" a/b "` 写出奇怪组名）；
 *   4) group 与 scope 都空 → 返回空串且 fellBack=false（调用方须先行拦截，不得提交）。
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

  it('Group 留空 → 落到与 scope 同名的组，并标记 fellBack', () => {
    assert.deepEqual(resolveWriteGroup('', 'bulk-test'), { group: 'bulk-test', fellBack: true });
  });

  it('Group 全空白（空格 / 制表 / 换行）同样回退', () => {
    for (const raw of ['   ', '\t', '\n', ' \t\n ']) {
      assert.deepEqual(resolveWriteGroup(raw, 'kisearch'), { group: 'kisearch', fellBack: true }, JSON.stringify(raw));
    }
  });

  it('两侧空白一律 trim（与提交给后端的值一致）', () => {
    assert.deepEqual(resolveWriteGroup('  项目根/测试模块  ', 'bulk-test'), {
      group: '项目根/测试模块',
      fellBack: false,
    });
    assert.deepEqual(resolveWriteGroup('', '  kafka  '), { group: 'kafka', fellBack: true });
  });

  it('scope 带空白时回退结果也是 trim 后的值', () => {
    assert.equal(resolveWriteGroup(' ', ' xpert-memory ').group, 'xpert-memory');
  });

  it('group 与 scope 都空 → 空串且不标记回退（调用方须先行拦截 scope）', () => {
    assert.deepEqual(resolveWriteGroup('', ''), { group: '', fellBack: false });
    assert.deepEqual(resolveWriteGroup('   ', '   '), { group: '', fellBack: false });
  });

  it('null / undefined 容错（不抛，视同留空）', () => {
    assert.deepEqual(resolveWriteGroup(null, 'kafka'), { group: 'kafka', fellBack: true });
    assert.deepEqual(resolveWriteGroup(undefined, undefined), { group: '', fellBack: false });
  });

  it('回退结果通过 Group 路径校验（scope 名只允许 [A-Za-z0-9_-]）', async () => {
    const { groupError } = await vite.ssrLoadModule('/src/lib/validators.ts');
    for (const scope of ['default', 'bulk-test', 'xpert_memory', 'kisearch2']) {
      const { group } = resolveWriteGroup('', scope);
      assert.equal(groupError(group), null, `scope=${scope} → group=${group}`);
    }
  });
});
