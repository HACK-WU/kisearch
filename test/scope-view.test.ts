/**
 * scope-view.test.ts —— 知识视图定义层（REQ-20261104-003 / S-01）
 *
 * 覆盖：
 *   1) views.json 落点跟随 config 目录；缺失时读成空表
 *   2) 视图名校验：字符集 / 保留名 / 与已有 scope 撞名
 *   3) 成员校验：空 / 禁嵌套 / 禁自引用 / strict 下必须已注册
 *   4) resolveScopeTargets 行为表（含安全不变量：非法字符被拒）
 *   5) views.json 损坏 → fail-loud 且**拒绝写入**（不覆盖用户原文件）
 *   6) 并发 `ki view add` 不丢更新（真进程并发）
 *   7) 删除视图不动任何知识库数据
 *
 * 隔离：KI_CONFIG_PATH + 临时 dataDir/vectorDir（不触真实 ~/.ki）
 * 运行：npx jiti test/scope-view.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-scope-view-'));
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

/** 每个用例前清空视图文件与配置缓存，避免相互污染 */
function reset(extra: Record<string, unknown> = {}): void {
  fs.rmSync(viewsPath, { force: true });
  fs.rmSync(`${viewsPath}.lock`, { force: true });
  writeConfig(extra);
  configLib.resetConfigCache();
}

const cfg = () => configLib.loadConfig();

describe('views.json 落点与读取', () => {
  it('跟随 config 所在目录', () => {
    reset();
    assert.equal(sv.getViewsPath(cfg()), viewsPath);
  });

  it('文件不存在时读成空表（不是错误）', () => {
    reset();
    assert.deepEqual(sv.readViews(cfg()), {});
  });

  it('写入后读回一致，且文件权限为 0600', () => {
    reset();
    const config = cfg();
    sv.validateViewName(config, 'team');
    sv.validateViewMembers(config, ['a', 'b'], 'team');
    sv.createView(config, 'team', ['a', 'b']);

    // Ｒ-12：落盘形状多了 id / createdAt / revision，不再与「只有 members」全等
    const views = sv.readViews(config);
    assert.deepEqual(views.team.members, ['a', 'b']);
    assert.match(views.team.id, /^v_[0-9a-f]{8}$/, '应生成稳定 ID');
    assert.equal(views.team.revision, 0);
    assert.ok(typeof views.team.createdAt === 'string', '应记录创建时间');

    const mode = fs.statSync(viewsPath).mode & 0o777;
    assert.equal(mode, 0o600, `期望 0600，实际 ${mode.toString(8)}`);

    const raw = JSON.parse(fs.readFileSync(viewsPath, 'utf-8'));
    assert.equal(raw.version, 2, '落盘应写 v2');
    assert.ok(typeof raw.updatedAt === 'string');
  });

  it('v1 旧文件：读时补 id（由名字派生）、不伪造 createdAt，写入后固化为 v2', () => {
    reset();
    // 手工造一份 003 时代的文件（只有 members）
    fs.writeFileSync(viewsPath, JSON.stringify({
      version: 1,
      views: { team: { members: ['a', 'b'] } },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2));
    configLib.resetConfigCache();

    const config = cfg();
    const first = sv.readViews(config);
    assert.deepEqual(first.team.members, ['a', 'b']);
    assert.match(first.team.id, /^v_[0-9a-f]{8}$/, '应由名字派生 ID');
    assert.equal(first.team.createdAt, undefined, '旧视图不得伪造创建时间（§1.5 迁移第 4 条）');

    // 任意一次写都会带出 needsMigration → 强制写回固化
    sv.updateView(config, 'team', (cur) => [...cur, 'c']);
    const raw = JSON.parse(fs.readFileSync(viewsPath, 'utf-8'));
    assert.equal(raw.version, 2, '迁移后应写成 v2');
    assert.equal(raw.views.team.id, first.team.id, 'ID 必须固化，二次读取不得重算');
    assert.equal(raw.views.team.createdAt, undefined, '迁移不得补 createdAt');

    // 幂等：再读一次 ID 仍然是同一个
    configLib.resetConfigCache();
    assert.equal(sv.readViews(cfg()).team.id, first.team.id, '重复读取必须幂等');
  });

  it('del 后不再出现在定义里', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a']);
    sv.deleteView(config, 'team');
    assert.deepEqual(sv.readViews(config), {});
  });
});

describe('视图名校验', () => {
  it('非法字符被拒（并指出具体字符）', () => {
    reset();
    assert.throws(
      () => sv.validateViewName(cfg(), 'bad name!'),
      (err: unknown) => sv.isViewError(err) && err.code === 'INVALID_VIEW_NAME' && /非法字符/.test(err.message),
    );
  });

  it('保留名被拒', () => {
    reset();
    for (const name of ['all', 'default', '__global__', '__root__']) {
      assert.throws(
        () => sv.validateViewName(cfg(), name),
        (err: unknown) => sv.isViewError(err) && err.code === 'RESERVED_VIEW_NAME',
        `${name} 应被拒`,
      );
    }
  });

  it('与已注册 scope 撞名被拒', () => {
    reset({ scopes: { kisearch: {} } });
    assert.throws(
      () => sv.validateViewName(cfg(), 'kisearch'),
      (err: unknown) => sv.isViewError(err) && err.code === 'VIEW_NAME_CONFLICT',
    );
  });

  it('与磁盘上未注册的 scope 撞名也被拒', () => {
    reset();
    // 旧布局：<dataDir>/<scope>/relations-cache.json
    const dir = path.join(dataDir, 'legacy-scope');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'relations-cache.json'), '{}', 'utf-8');
    assert.throws(
      () => sv.validateViewName(cfg(), 'legacy-scope'),
      (err: unknown) => sv.isViewError(err) && err.code === 'VIEW_NAME_CONFLICT',
    );
    fs.rmSync(path.join(dataDir, 'legacy-scope'), { recursive: true, force: true });
  });
});

describe('成员校验', () => {
  it('空成员被拒', () => {
    reset();
    assert.throws(
      () => sv.validateViewMembers(cfg(), []),
      (err: unknown) => sv.isViewError(err) && err.code === 'VIEW_EMPTY',
    );
  });

  it('成员是已存在视图 → 禁嵌套', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'v1', ['a']);
    assert.throws(
      () => sv.validateViewMembers(config, ['v1'], 'v2'),
      (err: unknown) => sv.isViewError(err) && err.code === 'VIEW_MEMBER_IS_VIEW',
    );
  });

  it('★ 自引用被拒（目标视图尚未落盘时也必须拦住）', () => {
    reset();
    const config = cfg();
    assert.equal(sv.isViewName(config, 'loop'), false, '前置：loop 尚不存在');
    assert.throws(
      () => sv.validateViewMembers(config, ['loop'], 'loop'),
      (err: unknown) => sv.isViewError(err) && err.code === 'VIEW_MEMBER_IS_VIEW',
    );
  });

  it('strict 下未注册成员被拒', () => {
    reset({ scopeMode: 'strict', scopes: { a: {} } });
    assert.throws(
      () => sv.validateViewMembers(cfg(), ['a', 'b'], 'team'),
      (err: unknown) => sv.isViewError(err) && err.code === 'VIEW_MEMBER_NOT_REGISTERED' && /b/.test(err.message),
    );
  });

  it('strict 下已注册成员通过', () => {
    reset({ scopeMode: 'strict', scopes: { a: {}, b: {} } });
    assert.doesNotThrow(() => sv.validateViewMembers(cfg(), ['a', 'b'], 'team'));
  });
});

describe('resolveScopeTargets 行为表', () => {
  function seed(): void {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a', 'b']);
    sv.createView(config, 'solo', ['a']);
    configLib.resetConfigCache();
  }

  it('未传 scope → 回退 default', () => {
    seed();
    const t = sv.resolveScopeTargets(cfg(), undefined);
    assert.deepEqual(t, { views: [], scopes: ['default'], skipped: [], multiRequested: false });
  });

  it('单段真实 scope → 原样返回，views 为空', () => {
    seed();
    const t = sv.resolveScopeTargets(cfg(), 'kisearch');
    assert.deepEqual(t, { views: [], scopes: ['kisearch'], skipped: [], multiRequested: false });
  });

  it('单段视图 → 展开成员', () => {
    seed();
    const t = sv.resolveScopeTargets(cfg(), 'team');
    assert.deepEqual(t, { views: ['team'], scopes: ['a', 'b'], skipped: [], multiRequested: false });
  });

  it('视图 + 真实 scope 混写 → 合并去重', () => {
    seed();
    const t = sv.resolveScopeTargets(cfg(), 'team,kisearch');
    assert.deepEqual(t, { views: ['team'], scopes: ['a', 'b', 'kisearch'], skipped: [], multiRequested: true });
  });

  it('重复视图去重', () => {
    seed();
    const t = sv.resolveScopeTargets(cfg(), 'team,team');
    assert.deepEqual(t, { views: ['team'], scopes: ['a', 'b'], skipped: [], multiRequested: false });
  });

  it('单成员视图也走视图语义（views 非空）', () => {
    seed();
    const t = sv.resolveScopeTargets(cfg(), 'solo');
    assert.deepEqual(t, { views: ['solo'], scopes: ['a'], skipped: [], multiRequested: false });
  });

  it('空视图抛 VIEW_EMPTY', () => {
    reset();
    const config = cfg();
    // 绕过 validateViewMembers 直接写空成员，模拟手改文件
    fs.writeFileSync(viewsPath, JSON.stringify({ version: 1, views: { empty: { members: [] } }, updatedAt: '' }), 'utf-8');
    configLib.resetConfigCache();
    assert.throws(
      () => sv.resolveScopeTargets(configLib.loadConfig(), 'empty'),
      (err: unknown) => sv.isViewError(err) && err.code === 'VIEW_EMPTY',
    );
    void config;
  });

  it('★ 安全不变量：非法字符被拒（视图展开不会绕过字符校验）', () => {
    seed();
    assert.throws(() => sv.resolveScopeTargets(cfg(), '../etc'));
    assert.throws(() => sv.resolveScopeTargets(cfg(), 'team,../x'));
  });

  it('strict 下未注册成员进 skipped（视图不享受免注册特权）', () => {
    reset({ scopeMode: 'strict', scopes: { a: {} } });
    const config = cfg();
    // strict 下创建会被 validateViewMembers 拦，故直接写文件模拟"先建视图后收紧策略"
    fs.writeFileSync(viewsPath, JSON.stringify({ version: 1, views: { team: { members: ['a', 'b'] } }, updatedAt: '' }), 'utf-8');
    configLib.resetConfigCache();
    const t = sv.resolveScopeTargets(configLib.loadConfig(), 'team');
    assert.deepEqual(t.scopes, ['a']);
    assert.equal(t.skipped.length, 1);
    assert.equal(t.skipped[0].scope, 'b');
    void config;
  });
});

describe('损坏文件 fail-loud 且拒绝写入', () => {
  it('非 JSON → VIEWS_CORRUPT，且原文件不被覆盖', () => {
    reset();
    const broken = '{ this is not json';
    fs.writeFileSync(viewsPath, broken, 'utf-8');
    configLib.resetConfigCache();
    const config = cfg();

    assert.throws(
      () => sv.readViews(config),
      (err: unknown) => sv.isViewError(err) && err.code === 'VIEWS_CORRUPT',
    );
    assert.throws(() => sv.createView(config, 'team', ['a']));
    assert.equal(fs.readFileSync(viewsPath, 'utf-8'), broken, '损坏文件必须原样保留，供用户修');
  });

  it('members 非字符串数组 → VIEWS_CORRUPT', () => {
    reset();
    fs.writeFileSync(viewsPath, JSON.stringify({ version: 1, views: { bad: { members: [1, 2] } } }), 'utf-8');
    configLib.resetConfigCache();
    assert.throws(
      () => sv.readViews(cfg()),
      (err: unknown) => sv.isViewError(err) && err.code === 'VIEWS_CORRUPT',
    );
  });
});

describe('并发写入不丢更新', () => {
  it('5 个并发 ki view add 全部生效', async () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['seed']);

    const kiBin = path.join(process.cwd(), 'bin', 'ki.mjs');
    const jobs = ['m1', 'm2', 'm3', 'm4', 'm5'].map((m) =>
      execFileAsync(process.execPath, [kiBin, 'view', 'add', 'team', m], {
        env: { ...process.env, KI_CONFIG_PATH: configPath },
        timeout: 60_000,
      }),
    );
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(failed.length, 0, `有 ${failed.length} 个并发进程失败`);

    configLib.resetConfigCache();
    const members = sv.getViewMembers(cfg(), 'team');
    for (const m of ['seed', 'm1', 'm2', 'm3', 'm4', 'm5']) {
      assert.ok(members.includes(m), `丢失成员 ${m}（实际：${members.join(',')}）`);
    }
    assert.equal(members.length, 6);
  });
});

describe('删除视图不动数据', () => {
  it('views.json 删除后，成员库目录仍在', () => {
    reset();
    const config = cfg();
    const memberDir = path.join(dataDir, 'a');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'group-index.json'), JSON.stringify({ version: 1, scope: 'a', groups: {} }), 'utf-8');

    sv.createView(config, 'team', ['a']);
    sv.deleteView(config, 'team');

    assert.deepEqual(sv.readViews(config), {});
    assert.ok(fs.existsSync(memberDir), '删除视图不得删除成员库目录');
    assert.ok(fs.existsSync(path.join(memberDir, 'group-index.json')), '删除视图不得删除成员库文件');
  });
});
