/**
 * search-view.test.ts —— 检索链路接入视图（REQ-20261104-003 / S-02）
 *
 * 覆盖：
 *   1) `--scope <视图>` 展开为成员库检索，响应带 `matchedViews` 与 `scopes`
 *   2) 单库请求**不出现** `matchedViews` / `scopes`（零回归）
 *   3) 非法字符仍被拒（安全不变量：展开不绕过 `validateScope`）
 *   4) 空视图 → ok:false + VIEW_EMPTY 语义
 *   5) strict 下未注册成员被跳过并上报，不静默通过
 *
 * 隔离：KI_CONFIG_PATH + 临时 dataDir/vectorDir
 * 运行：npx jiti test/search-view.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-search-view-'));
const configPath = path.join(tmpDir, 'config.json');
const viewsPath = path.join(tmpDir, 'views.json');

function writeConfig(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir: path.join(tmpDir, 'kb'),
    vectorDir: path.join(tmpDir, 'vector'),
    backupDir: path.join(tmpDir, 'backup'),
    scopes: {},
    ...extra,
  }), 'utf-8');
}

function writeViews(views: Record<string, string[]>): void {
  fs.writeFileSync(viewsPath, JSON.stringify({
    version: 1,
    views: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { members: v }])),
    updatedAt: new Date().toISOString(),
  }), 'utf-8');
}

writeConfig();
process.env.KI_CONFIG_PATH = configPath;

let search: typeof import('../src/search.js');
let configLib: typeof import('../src/lib/config.js');

before(async () => {
  configLib = await import('../src/lib/config.js');
  search = await import('../src/search.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function reset(views?: Record<string, string[]>, extra: Record<string, unknown> = {}): void {
  fs.rmSync(viewsPath, { force: true });
  fs.rmSync(`${viewsPath}.lock`, { force: true });
  if (views) writeViews(views);
  writeConfig(extra);
  configLib.resetConfigCache();
}

const q = (scope?: string) => search.executeSearch({ scope, query: '任意查询词', mode: 'fulltext' });

describe('视图展开进入检索链路', () => {
  it('单库请求零回归：不出现 matchedViews / scopes', async () => {
    reset({ team: ['a', 'b'] });
    const r = await q('kisearch');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.scope, 'kisearch');
    assert.equal('matchedViews' in r, false, '纯 scope 请求不得新增字段');
    assert.equal('scopes' in r, false);
  });

  it('视图请求：matchedViews + scopes 同时出现', async () => {
    reset({ team: ['a', 'b'] });
    const r = await q('team');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.matchedViews, ['team']);
    assert.deepEqual(r.scopes, ['a', 'b']);
  });

  it('单成员视图也走多库语义', async () => {
    reset({ solo: ['a'] });
    const r = await q('solo');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.matchedViews, ['solo']);
    assert.deepEqual(r.scopes, ['a']);
  });

  it('视图与真实 scope 混写', async () => {
    reset({ team: ['a', 'b'] });
    const r = await q('team,kisearch');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.matchedViews, ['team']);
    assert.deepEqual(r.scopes, ['a', 'b', 'kisearch']);
  });
});

describe('安全不变量', () => {
  it('★ 非法字符仍被拒（视图展开不绕过 validateScope）', async () => {
    reset({ team: ['a', 'b'] });
    const r1 = await q('../etc');
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.match(r1.error, /不合法|非法/);

    const r2 = await q('team,../x');
    assert.equal(r2.ok, false);
  });
});

describe('异常路径', () => {
  it('空视图 → ok:false 且提示没有成员', async () => {
    reset();
    fs.writeFileSync(viewsPath, JSON.stringify({ version: 1, views: { empty: { members: [] } } }), 'utf-8');
    configLib.resetConfigCache();
    const r = await q('empty');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /没有成员/);
  });

  it('strict 下未注册成员被跳过并上报', async () => {
    reset({ team: ['a', 'b'] }, { scopeMode: 'strict', scopes: { a: {} } });
    const r = await q('team');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.scopes, ['a']);
    assert.ok(Array.isArray(r.skipped) && r.skipped.some((s) => s.scope === 'b'), '未注册成员必须出现在 skipped');
  });

  it('strict 下全部成员未注册 → ok:false', async () => {
    reset({ team: ['a', 'b'] }, { scopeMode: 'strict', scopes: {} });
    const r = await q('team');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /无可检索的 scope/);
  });
});
