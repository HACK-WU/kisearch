/**
 * scope-view-auth.test.ts —— 视图鉴权与列表暴露（REQ-20261104-003 / S-04）
 *
 * 覆盖：
 *   1) TokenRecord.viewGrants 与 scopes 分字段存储；加载时合并进鉴权集合
 *   2) 授权视图后：视图名可通过鉴权，成员名**不因此**获得授权（授权视图 ≠ 授权成员名）
 *   3) `all` 吞掉 viewGrants（已是全集）
 *   4) executeScopeList 返回 views[] + memberMeta（含只读态，前端据此渲染）
 *   5) `scope readonly` 拒绝视图名
 *   6) listTokensGrantingView 能列出授权该视图的 Token（供删前核对）
 *
 * 隔离：KI_CONFIG_PATH / KI_TOKENS_PATH；不触真实 ~/.ki
 * 运行：npx jiti test/scope-view-auth.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-view-auth-'));
const configPath = path.join(tmpDir, 'config.json');
const tokensPath = path.join(tmpDir, 'mcp-tokens.json');
const viewsPath = path.join(tmpDir, 'views.json');
const dataDir = path.join(tmpDir, 'kb');

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  vectorDir: path.join(tmpDir, 'vector'),
  backupDir: path.join(tmpDir, 'backup'),
  scopes: {},
}), 'utf-8');
fs.writeFileSync(viewsPath, JSON.stringify({
  version: 1,
  views: { work: { members: ['kisearch', 'kisearch-memory'] } },
  updatedAt: new Date().toISOString(),
}, null, 2), 'utf-8');
process.env.KI_CONFIG_PATH = configPath;

let tokens: typeof import('../src/lib/mcp-token.js');
let configLib: typeof import('../src/lib/config.js');
let scopeLib: typeof import('../src/scope.js');

before(async () => {
  configLib = await import('../src/lib/config.js');
  tokens = await import('../src/lib/mcp-token.js');
  scopeLib = await import('../src/scope.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('viewGrants 存储与合并', () => {
  it('授权视图：视图名进鉴权集合，成员名不进', () => {
    fs.rmSync(tokensPath, { force: true });
    const rec = tokens.createToken([], tokensPath, false, { viewGrants: ['work'] });
    assert.deepEqual(rec.viewGrants, ['work']);
    assert.deepEqual(rec.scopes, []);

    const auth = tokens.findTokenAuth(rec.token, tokensPath, path.join(tmpDir, 'users.json'));
    assert.ok(auth);
    assert.deepEqual(auth.viewGrants, ['work']);
    assert.equal(tokens.isScopeAuthorized(auth.scopes, 'work'), true, '视图名应通过鉴权');
    assert.equal(tokens.isScopeAuthorized(auth.scopes, 'kisearch'), false, '成员名不应因视图授权而可寻址');
  });

  it('scope + 视图可并存', () => {
    fs.rmSync(tokensPath, { force: true });
    const rec = tokens.createToken(['kisearch'], tokensPath, false, { viewGrants: ['work'] });
    const auth = tokens.findTokenAuth(rec.token, tokensPath, path.join(tmpDir, 'users.json'));
    assert.ok(auth);
    assert.deepEqual(auth.viewGrants, ['work']);
    assert.equal(tokens.isScopeAuthorized(auth.scopes, 'kisearch'), true);
    assert.equal(tokens.isScopeAuthorized(auth.scopes, 'work'), true);
    assert.equal(tokens.isScopeAuthorized(auth.scopes, 'other'), false);
  });

  it('all 收敛为全集（viewGrants 不再单独生效）', () => {
    fs.rmSync(tokensPath, { force: true });
    const rec = tokens.createToken(['all'], tokensPath, false, { viewGrants: ['work'] });
    const auth = tokens.findTokenAuth(rec.token, tokensPath, path.join(tmpDir, 'users.json'));
    assert.ok(auth);
    assert.deepEqual(auth.scopes, ['all']);
    assert.equal(tokens.isScopeAuthorized(auth.scopes, '任意名字'), true);
  });

  it('update 可单独改 viewGrants 且不动 scopes', () => {
    fs.rmSync(tokensPath, { force: true });
    const rec = tokens.createToken(['kisearch'], tokensPath, false, {});
    const updated = tokens.updateToken(rec.id, { viewGrants: ['work'] }, tokensPath);
    assert.deepEqual(updated.scopes, ['kisearch']);
    assert.deepEqual(updated.viewGrants, ['work']);

    const cleared = tokens.updateToken(rec.id, { viewGrants: [] }, tokensPath);
    assert.equal(cleared.viewGrants, undefined, '空数组应删除字段（与旧格式一致）');
  });

  it('listTokensGrantingView 能列出授权该视图的 Token', () => {
    fs.rmSync(tokensPath, { force: true });
    const a = tokens.createToken([], tokensPath, false, { label: 'A', viewGrants: ['work'] });
    tokens.createToken(['kisearch'], tokensPath, false, { label: 'B' });
    const hit = tokens.listTokensGrantingView('work', tokensPath);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, a.id);
  });

  it('历史记录：视图名混写在 scopes 里也能被 granting 查询命中', () => {
    fs.rmSync(tokensPath, { force: true });
    const rec = tokens.createToken(['work'], tokensPath, false, { label: 'Legacy' });
    const hit = tokens.listTokensGrantingView('work', tokensPath);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, rec.id);
  });
});

describe('executeScopeList 暴露视图与成员元信息', () => {
  it('返回 views[] + memberMeta（含只读态）', async () => {
    // 造一个只读成员
    fs.writeFileSync(configPath, JSON.stringify({
      dataDir,
      vectorDir: path.join(tmpDir, 'vector'),
      backupDir: path.join(tmpDir, 'backup'),
      scopes: {},
      scopeReadonly: ['kisearch-memory'],
    }), 'utf-8');
    configLib.resetConfigCache();

    // kb 目录：kisearch 存在，kisearch-memory 缺（用于验证 missing / availableCount）
    fs.mkdirSync(path.join(dataDir, 'kisearch'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'kisearch', 'relations-cache.json'),
      JSON.stringify({ version: 1, scope: 'kisearch', relations: [] }),
      'utf-8',
    );

    const result = await scopeLib.executeScopeListLocal();
    assert.equal(result.ok, true);
    const views = result.views ?? [];
    const work = views.find((v) => v.view === 'work');
    assert.ok(work, 'views 应包含 work');
    assert.deepEqual(work.members, ['kisearch', 'kisearch-memory']);
    assert.equal(work.memberMeta.length, 2);

    const meta = work.memberMeta.find((m) => m.scope === 'kisearch-memory');
    assert.ok(meta);
    assert.equal(meta.readonly, true, '★ 成员只读态必须可传递（否则前端会把只读库显示成可写）');

    const first = work.memberMeta.find((m) => m.scope === 'kisearch');
    assert.ok(first);
    assert.equal(first.kb, true);
    assert.equal(first.readonly, false);
  });
});

describe('scope readonly 拒绝视图名', () => {
  it('返回 BAD_SCOPE 且给出成员清单', () => {
    configLib.resetConfigCache();
    const r = scopeLib.executeScopeSetReadonlyLocal({ scope: 'work', readonly: true });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'BAD_SCOPE');
    assert.match(r.error, /视图/);
    assert.match(r.error, /kisearch/);
  });

  it('普通 scope 不受影响', () => {
    configLib.resetConfigCache();
    const r = scopeLib.executeScopeSetReadonlyLocal({ scope: 'kisearch', readonly: true });
    assert.equal(r.ok, true);
  });
});
