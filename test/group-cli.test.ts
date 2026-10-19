/**
 * group-cli.test.ts —— `ki group` CLI 表面与 RENAMED 迁移提示
 *
 * 契约（REQ-20261019-005）：
 *   - `ki manage-index` / `ki query-group` 物理不可执行，只打印新命令；
 *   - `ki group --help` 暴露 create/delete/list；
 *   - 退出码：旧命令 1。
 *
 * 运行：npx jiti test/group-cli.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'ki.mjs');

function run(args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KI_CONFIG_PATH: process.env.KI_CONFIG_PATH ?? '' },
  });
}

describe('ki group CLI', () => {
  it('ki group --help 暴露 create/delete/list', () => {
    const r = run(['group', '--help']);
    assert.equal(r.status, 0);
    for (const word of ['create', 'delete', 'list']) {
      assert.match(r.stdout, new RegExp(word));
    }
    assert.doesNotMatch(r.stdout, /^\s+--parent\b/m);
    assert.doesNotMatch(r.stdout, /^\s+--name\b/m);
  });

  it('ki manage-index create → RENAMED 提示 ki group create', () => {
    const r = run(['manage-index', '--action', 'create', '--parent', 'A', '--name', 'B']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /已移除/);
    assert.match(r.stderr, /ki group create "A\/B"/);
  });

  it('ki manage-index delete → RENAMED 提示 --yes', () => {
    const r = run(['manage-index', '--action', 'delete', '--name', 'B']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ki group delete "B" --yes/);
  });

  it('ki manage-index list-scopes → ki scope list', () => {
    const r = run(['manage-index', '--action', 'list-scopes']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ki scope list/);
  });

  it('ki query-group --subtree → 位置参数', () => {
    const r = run(['query-group', '--subtree', 'A/B']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ki group list "A\/B"/);
  });
});
