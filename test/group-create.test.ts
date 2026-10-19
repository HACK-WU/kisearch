/**
 * group-create.test.ts —— `ki group create` core（src/lib/group-create.ts）
 *
 * 契约（REQ-20261019-005）：
 *   - 只接受单一路径 { scope?, path }；
 *   - 只建单个节点，父路径必须已存在；不做语义补全；
 *   - scope 不存在自动创建并返回 createdScope；
 *   - 非法路径（空 / .. / 反斜杠 / 空段）拒绝。
 *
 * 运行：npx jiti test/group-create.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { executeGroupCreate } from '../src/lib/group-create.js';
import { getKbDir } from '../src/lib/scope.js';
import { buildListJson } from '../src/group.js';

function readTree(scope: string): Record<string, unknown> {
  const p = path.join(getKbDir(scope), 'group-index.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')).groups;
}

let seq = 0;
function freshScope(): string {
  const s = `gcreate-${Date.now()}-${seq++}`;
  registerTestScope(s);
  return s;
}

after(() => cleanupTestConfig());

describe('group-create', () => {
  it('全新 scope：自动建库并返回 createdScope', async () => {
    const s = freshScope();
    const r = await executeGroupCreate({ scope: s, path: '项目概述' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.createdScope, true);
    assert.deepEqual(readTree(s), { 项目概述: {} });
  });

  it('嵌套创建：父存在时成功', async () => {
    const s = freshScope();
    assert.equal((await executeGroupCreate({ scope: s, path: '工具库' })).ok, true);
    const r = await executeGroupCreate({ scope: s, path: '工具库/Redis' });
    assert.equal(r.ok, true);
    assert.deepEqual(readTree(s), { 工具库: { Redis: {} } });
  });

  it('父路径不存在：报错 + 候选，且不建任何节点', async () => {
    const s = freshScope();
    await executeGroupCreate({ scope: s, path: '工具库' });
    await executeGroupCreate({ scope: s, path: '工具库/Redis' });
    await executeGroupCreate({ scope: s, path: '工具库/MySQL' });
    const before = readTree(s);
    const r = await executeGroupCreate({ scope: s, path: '工具库/Oracle/集群' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /父路径不存在/);
    assert.deepEqual([...r.candidates!].sort(), ['MySQL', 'Redis']);
    assert.deepEqual(readTree(s), before);
  });

  it('不做语义补全：近似父路径必须失败', async () => {
    const s = freshScope();
    await executeGroupCreate({ scope: s, path: '工具库' });
    const r = await executeGroupCreate({ scope: s, path: '工具/Redis' });
    assert.equal(r.ok, false);
    assert.deepEqual(readTree(s), { 工具库: {} });
  });

  it('重复创建：报错', async () => {
    const s = freshScope();
    await executeGroupCreate({ scope: s, path: 'A' });
    const r = await executeGroupCreate({ scope: s, path: 'A' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /已存在/);
  });

  it('list --json 包含只有树、没有 relations 的组', async () => {
    const s = freshScope();
    await executeGroupCreate({ scope: s, path: '工具库' });
    await executeGroupCreate({ scope: s, path: '工具库/Redis' });
    const json = buildListJson({ scope: s, withCounts: false });
    const paths = (json.groups as Array<{ path: string }>).map((g) => g.path);
    assert.deepEqual(paths.sort(), ['工具库', '工具库/Redis']);
    assert.equal(json.total, 2);
  });

  it('非法路径：.. / 空 / 反斜杠 / 空段 全部拒绝', async () => {
    const s = freshScope();
    for (const p of ['..', '', 'a//b', 'a\\b', '../x']) {
      const r = await executeGroupCreate({ scope: s, path: p });
      assert.equal(r.ok, false, `path=${JSON.stringify(p)} 应被拒绝`);
    }
    assert.equal(fs.existsSync(path.join(getKbDir(s), 'group-index.json')) === false, true, '非法路径不应建库');
  });
});
