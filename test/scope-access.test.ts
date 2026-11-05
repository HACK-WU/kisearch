/**
 * scope-access.test.ts —— 视图授权判定（MCP 与 REST 必须同判）
 *
 * 覆盖：
 *   1) 名字 ∧ 全部成员（全有或全无）
 *   2) `all` 通配 / 真实 scope 不受影响
 *   3) views.json 损坏 → fail-closed（拒绝，不降级为"不是视图"）
 *   4) ★ 同一条授权在 MCP `findScopeViolation` 与 REST `isScopeAccessAllowed` 上结论一致
 *      （曾经 REST 只比对名字，导致 `--view team` 的 Token 在 MCP 全 403、在 REST 能读全部成员）
 *   5) 视图名字符集：shell 元字符必须被拒（名字会被复制进命令提示）
 *
 * 隔离：KI_CONFIG_PATH + 临时目录
 * 运行：npx jiti test/scope-access.test.ts
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-scope-access-'));
const configPath = path.join(tmpDir, 'config.json');
const viewsPath = path.join(tmpDir, 'views.json');

const dataDir = path.join(tmpDir, 'kb');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({
  dataDir,
  vectorDir: path.join(tmpDir, 'vector'),
  backupDir: path.join(tmpDir, 'backup'),
  scopes: {},
}), 'utf-8');
process.env.KI_CONFIG_PATH = configPath;

let access: typeof import('../src/lib/scope-access.js');
let scopeView: typeof import('../src/lib/scope-view.js');
let configLib: typeof import('../src/lib/config.js');
let mcpHttp: typeof import('../src/lib/mcp-http.js');

before(async () => {
  configLib = await import('../src/lib/config.js');
  access = await import('../src/lib/scope-access.js');
  scopeView = await import('../src/lib/scope-view.js');
  mcpHttp = await import('../src/lib/mcp-http.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写 views.json（v2 形状）；不传则删除文件 = 没有任何视图 */
function writeViews(views?: Record<string, string[]>): void {
  fs.rmSync(viewsPath, { force: true });
  if (views) {
    fs.writeFileSync(viewsPath, JSON.stringify({
      version: 2,
      views: Object.fromEntries(Object.entries(views).map(([name, members], i) => [
        name,
        { id: `v_test${i}`, members, revision: 0 },
      ])),
      updatedAt: new Date().toISOString(),
    }), 'utf-8');
  }
  // mtime/size 缓存：同毫秒同长度时可能不失效，显式丢弃快照
  access.resetScopeAccessCache();
  configLib.resetConfigCache();
}

beforeEach(() => writeViews({ team: ['a', 'b'] }));

describe('视图授权：视图名 ∧ 全部成员（全有或全无）', () => {
  it('授权视图 + 全部成员 → 允许', () => {
    assert.equal(access.isScopeAccessAllowed(['team', 'a', 'b'], 'team'), true);
  });

  it('★ 授权视图但缺一个成员 → 拒绝（否则视图就是越权通道）', () => {
    assert.equal(access.isScopeAccessAllowed(['team', 'a'], 'team'), false);
    assert.deepEqual(access.missingViewMembers(['team', 'a'], 'team'), ['b']);
  });

  it('只授权成员、未授权视图名 → 拒绝（名字本身也必须被授权）', () => {
    assert.equal(access.isScopeAccessAllowed(['a', 'b'], 'team'), false);
  });

  it('all 通配 → 全放行', () => {
    assert.equal(access.isScopeAccessAllowed(['all'], 'team'), true);
  });

  it('真实 scope 不受视图表影响', () => {
    assert.equal(access.isScopeAccessAllowed(['a'], 'a'), true);
    assert.equal(access.isScopeAccessAllowed(['b'], 'a'), false);
  });

  it('单成员视图：授权视图 + 该成员 → 允许', () => {
    writeViews({ solo: ['a'] });
    assert.equal(access.isScopeAccessAllowed(['solo', 'a'], 'solo'), true);
    assert.equal(access.isScopeAccessAllowed(['solo'], 'solo'), false);
  });
});

describe('★ 两条通道同判（防再次分叉）', () => {
  const call = (scope: string): unknown => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'ki_search', arguments: { scope } },
  });

  const viewMembers = (name: string): string[] | null =>
    scopeView.readViews(configLib.loadConfig())[name]?.members ?? null;

  const cases: { auth: string[]; label: string }[] = [
    { auth: ['team', 'a', 'b'], label: '视图 + 全部成员' },
    { auth: ['team', 'a'], label: '缺一个成员' },
    { auth: ['team'], label: '只授权视图名' },
    { auth: ['a', 'b'], label: '只授权成员' },
    { auth: ['all'], label: 'all 通配' },
  ];

  for (const c of cases) {
    it(`${c.label}：REST 与 MCP 结论一致`, () => {
      const restAllowed = access.isScopeAccessAllowed(c.auth, 'team');
      const mcpViolation = mcpHttp.findScopeViolation(call('team'), c.auth, viewMembers);
      assert.equal(
        restAllowed,
        mcpViolation === null,
        `REST=${restAllowed} 与 MCP 拒绝项=${String(mcpViolation)} 必须一致`,
      );
    });
  }
});

describe('views.json 损坏 → fail-closed', () => {
  it('不是放行、也不是「当它不是视图」', () => {
    fs.writeFileSync(viewsPath, '{ 这不是 JSON', 'utf-8');
    access.resetScopeAccessCache();
    configLib.resetConfigCache();
    // 名字在授权内，但成员表不可读 → 拒绝
    assert.equal(access.isScopeAccessAllowed(['team'], 'team'), false);
    writeViews({ team: ['a', 'b'] });
  });

  /**
   * ★ 但**真实 scope 不能被误拒**：视图名与 scope 名共用命名空间且唯一、且视图不落盘，
   * 所以"磁盘上存在的库"必然不是视图 —— 这条事实判定必须保住，否则 views.json 里
   * 一个语法错误就会让整个应用所有数据都 403（且 403 文案看不出根因）。
   */
  it('磁盘上存在的真实 scope 仍可访问（不被视图表损坏连坐）', () => {
    fs.mkdirSync(path.join(dataDir, 'kisearch'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'kisearch', 'relations-cache.json'), '{"groups":{}}', 'utf-8');
    fs.writeFileSync(viewsPath, '{ 坏 JSON', 'utf-8');
    access.resetScopeAccessCache();
    configLib.resetConfigCache();

    assert.equal(access.isScopeAccessAllowed(['kisearch'], 'kisearch'), true, '真实库必须仍可用');
    assert.equal(access.isScopeAccessAllowed(['team'], 'team'), false, '读不出视图表的未知名字仍拒绝');
    writeViews({ team: ['a', 'b'] });
  });
});

describe('视图名字符集：shell 元字符', () => {
  it('命令替换 / 管道 / 分隔符被拒', () => {
    for (const name of ['$(id)', '`id`', 'a;b', 'a|b', 'a&b', 'a>b', 'a*', 'a#b']) {
      assert.notEqual(
        scopeView.viewNameCharsetError(name),
        null,
        `"${name}" 必须被拒（会被复制进命令提示后执行）`,
      );
    }
  });

  it('正常名字（含中文）仍然允许', () => {
    for (const name of ['team', 'team-a', 'team_a', '团队视图', 'v1.2']) {
      assert.equal(scopeView.viewNameCharsetError(name), null, `"${name}" 应允许`);
    }
  });
});
