/**
 * asset-trash-dir.test.ts —— `/api/asset` 的附件根目录解析（回收站寻址，2026-11-23）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/asset-trash-dir.test.ts
 *
 * 为什么要单独钉这条：`trash` 是**新增的可枚举参数**，一旦没有单段校验，
 * `path.join` 会把 `../` 归一化掉 —— 附件通道立刻变成「任意文件读取」
 * （与事件 #80 里 purge 删到 KB 外是同一个成因，只是读/删之分）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { getAssetsDir, getKbDir } from '../src/lib/scope.js';
import { getTrashRoot } from '../src/lib/trash-store.js';
import { resolveAssetDir } from '../src/lib/mcp-http-api.js';

const scope = `asset-trash-${Date.now()}`;

before(() => registerTestScope(scope));
after(() => cleanupTestConfig());

const okDir = (res: ReturnType<typeof resolveAssetDir>): string => {
  assert.equal(res.ok, true, res.ok ? '' : `${res.status} ${res.error}`);
  return res.ok ? res.dir : '';
};
const fail = (res: ReturnType<typeof resolveAssetDir>): number => {
  assert.equal(res.ok, false, `本应被拒，却解析出 ${res.ok ? res.dir : ''}`);
  return res.ok ? 0 : res.status;
};

describe('① 常规寻址不受影响（既有调用方零变化）', () => {
  it('不带 trash → {kb}/{scope}/{group}/assets', () => {
    assert.equal(okDir(resolveAssetDir(scope, '错误库/Web前端界面')), path.resolve(getAssetsDir(scope, '错误库/Web前端界面')));
  });

  it('trash 传空串视同未传（前端拼 query 时的常见形态）', () => {
    assert.equal(okDir(resolveAssetDir(scope, '决策记录/事件页', '')), path.resolve(getAssetsDir(scope, '决策记录/事件页')));
  });
});

describe('② 回收站寻址', () => {
  it('带 trash → .trash/{group}/{dirName}/assets', () => {
    const dir = okDir(resolveAssetDir(scope, '错误库/Web前端界面', '被删的文档__20261123'));
    assert.equal(
      dir,
      path.resolve(path.join(getTrashRoot(scope), '错误库/Web前端界面', '被删的文档__20261123', 'assets')),
    );
  });

  it('结果仍落在该 scope 的 KB 根内（备份 / 权限边界不变）', () => {
    const dir = okDir(resolveAssetDir(scope, '项目/网络', 'doc'));
    assert.ok(dir.startsWith(path.resolve(getKbDir(scope)) + path.sep), `必须落在 ${getKbDir(scope)} 内`);
  });
});

describe('③ 穿越与非法输入一律拒（事件 #80 同口径）', () => {
  it('trash 含 .. / 分隔符 / 空段 → 400', () => {
    for (const bad of ['../etc', '..', 'a/b', 'a\\b', 'x\0y']) {
      assert.equal(fail(resolveAssetDir(scope, '决策记录/事件页', bad)), 400, `trash=${JSON.stringify(bad)} 应 400`);
    }
  });

  it('`.` 是合法目录名（不逃逸）：解析结果仍落在 KB 根内', () => {
    const dir = okDir(resolveAssetDir(scope, '决策记录/事件页', '.'));
    assert.ok(dir.startsWith(path.resolve(getKbDir(scope)) + path.sep));
  });

  it('group 含 .. / . / 空段或绝对路径 → 400', () => {
    for (const bad of ['../..', 'a/../b', 'a//b', './a', '/etc', '']) {
      assert.equal(fail(resolveAssetDir(scope, bad)), 400, `group=${JSON.stringify(bad)} 应 400`);
    }
  });

  it('group 本身指向 .trash 也不会越出 KB 根（仍只是组内路径）', () => {
    // 允许解析但落在 .trash 内：对外读取的仍是 assets 目录下、且后缀白名单另有限制；
    // 这里只钉"不会跑到 KB 根之外"这条底线。
    const res = resolveAssetDir(scope, '.trash', '项目');
    if (res.ok) {
      assert.ok(res.dir.startsWith(path.resolve(getKbDir(scope)) + path.sep), '必须在 KB 根内');
    } else {
      assert.equal(res.status, 403);
    }
  });
});
