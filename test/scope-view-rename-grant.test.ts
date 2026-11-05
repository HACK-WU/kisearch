/**
 * scope-view-rename-grant.test.ts —— 改名不断授权（REQ-20261104-004 / D7、R-12、N11）
 *
 * 核心断言：`viewGrants` 从「按名字」迁到「按稳定 ID」后，
 * **改名不再需要重新签发 token** —— 这是 D7 存在的唯一理由。
 *
 * 隔离：KI_CONFIG_PATH + 临时 tokensPath（`renameView` 支持注入路径，
 * 否则这里会改写开发者真实的 ~/.ki/mcp-tokens.json）。
 *
 * 运行：npx jiti test/scope-view-rename-grant.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-view-grant-'));
const configPath = path.join(tmpDir, 'config.json');
const dataDir = path.join(tmpDir, 'kb');
const viewsPath = path.join(tmpDir, 'views.json');
const tokensPath = path.join(tmpDir, 'mcp-tokens.json');

function writeConfig(): void {
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir,
    vectorDir: path.join(tmpDir, 'vector'),
    backupDir: path.join(tmpDir, 'backup'),
    scopes: {},
  }), 'utf-8');
}

writeConfig();
process.env.KI_CONFIG_PATH = configPath;

let sv: typeof import('../src/lib/scope-view.js');
let tok: typeof import('../src/lib/mcp-token.js');
let configLib: typeof import('../src/lib/config.js');

before(async () => {
  configLib = await import('../src/lib/config.js');
  sv = await import('../src/lib/scope-view.js');
  tok = await import('../src/lib/mcp-token.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function reset(): void {
  for (const f of [viewsPath, `${viewsPath}.lock`, tokensPath, `${tokensPath}.lock`]) {
    fs.rmSync(f, { force: true });
  }
  writeConfig();
  configLib.resetConfigCache();
}

const cfg = () => configLib.loadConfig();
const rename = (a: string, b: string) =>
  sv.renameView(cfg(), a, b, { tokensPath });

describe('改名不断授权（D7）', () => {
  it('viewGrants 存旧名字 → 改名时自动换成稳定 ID', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a', 'b']);
    const id = sv.getViewId(config, 'team');
    assert.ok(id, '视图应有 ID');

    const rec = tok.createToken(['a', 'b'], tokensPath, false, { viewGrants: ['team'] });

    rename('team', 'team-dev');

    const after = tok.listTokens(tokensPath).find((t) => t.id === rec.id);
    assert.ok(after, 'token 记录应还在');
    assert.deepEqual(after.viewGrants, [id], '旧名字应被换成稳定 ID');
  });

  it('改名后该 token 的授权集合里是**新名字**（注入解析器后语义正确）', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a', 'b']);
    const rec = tok.createToken(['a', 'b'], tokensPath, false, { viewGrants: ['team'] });

    rename('team', 'team-dev');

    const auth = tok.findTokenAuth(rec.token, tokensPath, undefined, sv.makeViewNameResolver(cfg()));
    assert.ok(auth, 'token 应仍有效');
    assert.ok(auth.scopes.includes('team-dev'), `应含新名字，实际：${auth.scopes.join(',')}`);
    assert.ok(!auth.scopes.includes('team'), '不应再含旧名字');
    // 未注入解析器时 ID 原样保留（调用方漏加会看到 ID，属可诊断的失败模式）
    const raw = tok.findTokenAuth(rec.token, tokensPath);
    assert.deepEqual(raw?.scopes, ['a', 'b', sv.getViewId(cfg(), 'team-dev')]);
  });

  it('viewGrants 已存 ID → 改名完全不改动记录', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a']);
    const id = sv.getViewId(config, 'team');
    const rec = tok.createToken(['a'], tokensPath, false, { viewGrants: [id!] });

    rename('team', 'team-x');

    const after = tok.listTokens(tokensPath).find((t) => t.id === rec.id);
    assert.deepEqual(after?.viewGrants, [id], 'ID 不该被动过');
    const auth = tok.findTokenAuth(rec.token, tokensPath, undefined, sv.makeViewNameResolver(cfg()));
    assert.ok(auth?.scopes.includes('team-x'), '仍应指向改名后的视图');
  });

  it('历史兼容：旧名字混写在 scopes 里也一并换成新名字', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a']);
    const rec = tok.createToken(['a', 'team'], tokensPath);

    rename('team', 'team-2');

    const after = tok.listTokens(tokensPath).find((t) => t.id === rec.id);
    assert.deepEqual(after?.scopes, ['a', 'team-2']);
  });

  it('指向已删视图的 viewGrants 原样保留（不能顺手清掉）', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a']);
    const rec = tok.createToken(['a'], tokensPath, false, { viewGrants: ['v_deadbeef'] });

    rename('team', 'team-y');

    const after = tok.listTokens(tokensPath).find((t) => t.id === rec.id);
    assert.deepEqual(after?.viewGrants, ['v_deadbeef'], '无主 ID 应原样保留，交由人工处理');
  });

  it('没有 token 文件时改名不报错（正常路径）', () => {
    reset();
    const config = cfg();
    sv.createView(config, 'team', ['a']);
    assert.doesNotThrow(() => rename('team', 'team-ok'));
    assert.ok(sv.readViews(cfg())['team-ok']);
  });
});
