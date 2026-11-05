/**
 * scope-view-rename.test.ts —— 视图稳定 ID 与改名（REQ-20261104-004 / D7、R-10、R-12）
 *
 * 覆盖：
 *   1) createView 生成 id / createdAt / revision=0
 *   2) updateView 改成员**不能丢** id 与创建信息，revision 递增
 *   3) renameView：id 不变、revision+1、createdAt 保留、updatedAt 更新
 *   4) 改名撞已存在视图 / 撞 scope / 撞保留名 → 对应错误码
 *   5) 改名到同名 → 幂等无操作
 *   6) 旧名不存在 → VIEW_NOT_FOUND
 *   7) findViewNameById / getViewId 正反查
 *
 * 隔离：KI_CONFIG_PATH + 临时 dataDir/vectorDir（不触真实 ~/.ki）
 * 运行：npx jiti test/scope-view-rename.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-view-rename-'));
const configPath = path.join(tmpDir, 'config.json');
const dataDir = path.join(tmpDir, 'kb');
const viewsPath = path.join(tmpDir, 'views.json');

function writeConfig(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir,
    vectorDir: path.join(tmpDir, 'vector'),
    backupDir: path.join(tmpDir, 'backup'),
    scopes: {},
    ...extra,
  }), 'utf-8');
}

writeConfig();
process.env.KI_CONFIG_PATH = configPath;

let sv: typeof import('../src/lib/scope-view.js');
let configLib: typeof import('../src/lib/config.js');

before(async () => {
  configLib = await import('../src/lib/config.js');
  sv = await import('../src/lib/scope-view.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function reset(extra: Record<string, unknown> = {}): void {
  fs.rmSync(viewsPath, { force: true });
  fs.rmSync(`${viewsPath}.lock`, { force: true });
  writeConfig(extra);
  configLib.resetConfigCache();
}

const cfg = () => configLib.loadConfig();

/** 断言抛出的 ViewError 带指定 code */
function assertViewError(fn: () => void, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(sv.isViewError(err), `应抛 ViewError，实际：${String(err)}`);
    assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}：${err.message}`);
    return;
  }
  assert.fail(`期望抛出 ${code}，但没有抛错`);
}

describe('稳定 ID（D7 / R-12）', () => {
  it('createView 生成 v_ 前缀 8 位 ID、createdAt、revision=0', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a', 'b'], { createdBy: 'u_zhang' });

    const view = sv.readViews(config).team;
    assert.match(view.id, /^v_[0-9a-f]{8}$/);
    assert.equal(view.revision, 0);
    assert.equal(view.createdBy, 'u_zhang');
    assert.ok(typeof view.createdAt === 'string' && view.createdAt.length > 0);
  });

  it('两个视图的 ID 必须不同', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'one', ['a']);
    sv.createView(config, 'two', ['b']);
    const views = sv.readViews(config);
    assert.notEqual(views.one.id, views.two.id);
  });

  it('updateView 改成员不得丢 id / createdAt，revision 递增', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a'], { createdBy: 'u_zhang' });
    const before = sv.readViews(config).team;

    sv.updateView(config, 'team', (cur) => [...cur, 'b'], { updatedBy: 'u_li' });
    const after = sv.readViews(config).team;

    assert.equal(after.id, before.id, 'id 必须保持（否则 token 授权锚点失效）');
    assert.equal(after.createdAt, before.createdAt, 'createdAt 不得被覆盖');
    assert.equal(after.createdBy, before.createdBy);
    assert.equal(after.revision, 1);
    assert.deepEqual(after.members, ['a', 'b']);
    assert.equal(after.updatedBy, 'u_li');
    assert.ok(typeof after.updatedAt === 'string');
  });

  it('findViewNameById / getViewId 正反查一致', () => {
    reset();
    const config = cfg();
    sv.createView(config, '团队研发', ['a']);
    const id = sv.getViewId(config, '团队研发');
    assert.ok(id);
    assert.equal(sv.findViewNameById(config, id), '团队研发');
    assert.equal(sv.findViewNameById(config, 'v_notexist'), null);
    assert.equal(sv.getViewId(config, '不存在'), null);
  });
});

describe('改名（D7 / R-10）', () => {
  it('改名后 ID 不变、createdAt 保留、revision+1，旧名消失', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a', 'b'], { createdBy: 'u_zhang' });
    const before = sv.readViews(config).team;

    sv.renameView(config, 'team', 'team-dev', { updatedBy: 'u_zhang' });
    const views = sv.readViews(config);

    assert.equal(views.team, undefined, '旧名应消失');
    assert.equal(views['team-dev'].id, before.id, 'ID 不得变化（D7 的核心）');
    assert.equal(views['team-dev'].createdAt, before.createdAt, 'createdAt 保留');
    assert.equal(views['team-dev'].revision, before.revision + 1);
    assert.deepEqual(views['team-dev'].members, ['a', 'b'], '成员不受改名影响');
  });

  it('改名到同名 → 幂等，revision 不变', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a']);
    sv.renameView(config, 'team', 'team');
    assert.equal(sv.readViews(config).team.revision, 0);
  });

  it('改名撞已存在视图 → VIEW_NAME_CONFLICT', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a']);
    sv.createView(config, 'other', ['b']);
    assertViewError(() => sv.renameView(config, 'team', 'other'), 'VIEW_NAME_CONFLICT');
    // 失败不得留下半成品
    assert.deepEqual(sv.listViewNames(config), ['other', 'team']);
  });

  it('改名撞 scope 名 → VIEW_NAME_CONFLICT', () => {
    reset({ scopes: { 'already-a-scope': {} } });
    const config = cfg();
    sv.createView(config, 'team', ['a']);
    assertViewError(() => sv.renameView(config, 'team', 'already-a-scope'), 'VIEW_NAME_CONFLICT');
  });

  it('改名到保留名 → RESERVED_VIEW_NAME', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a']);
    assertViewError(() => sv.renameView(config, 'team', 'all'), 'RESERVED_VIEW_NAME');
  });

  it('改名旧名不存在 → VIEW_NOT_FOUND', () => {
    reset();
    const config = cfg();
    assertViewError(() => sv.renameView(config, 'nope', 'whatever'), 'VIEW_NOT_FOUND');
  });
});

describe('--scope 解析（D5：中文视图名）', () => {
  it('中文视图名可被 --scope 展开（不被 ASCII 校验拦下）', () => {
    reset();
    const config = cfg();
    sv.createView(config, '研发视图', ['a', 'b']);
    const targets = sv.resolveScopeTargets(config, '研发视图');
    assert.deepEqual(targets.views, ['研发视图']);
    assert.deepEqual(targets.scopes, ['a', 'b']);
    assert.equal(targets.multiRequested, false);
  });

  it('中文视图名与真实 scope 混写', () => {
    reset();
    const config = cfg();
    sv.createView(config, '研发视图', ['a']);
    const targets = sv.resolveScopeTargets(config, '研发视图,kisearch');
    assert.deepEqual(targets.views, ['研发视图']);
    assert.deepEqual(targets.scopes, ['a', 'kisearch']);
    assert.equal(targets.multiRequested, true);
  });

  it('**非视图段仍走 scope 校验**：不存在的中文名被拒（安全不变量不能被 D5 放宽）', () => {
    reset();
    const config = cfg();
    sv.createView(config, '研发视图', ['a']);
    assert.throws(
      () => sv.resolveScopeTargets(config, '不存在的视图'),
      (err: unknown) => {
        assert.equal(sv.isViewError(err), false, '这里应抛 ScopeError 而不是 ViewError');
        assert.match(String((err as Error).message), /不合法/);
        return true;
      },
    );
  });

  it('路径遍历仍被拒（即使带中文视图也别想绕过）', () => {
    reset();
    const config = cfg();
    sv.createView(config, '研发视图', ['a']);
    assert.throws(() => sv.resolveScopeTargets(config, '研发视图,../etc'));
    assert.throws(() => sv.resolveScopeTargets(config, '../etc'));
  });
});
