/**
 * `ki_scope_list` 的 wikiSync 状态（资源页「Scope 与 Wiki 同步」数据源）
 *
 * 为什么单独测：页面要显示的是「**能不能真的写回**」，而不是配置里那个开关。
 * 只看 `wikiSync.enabled` 会把三种不同处境混成一种：
 *   ① 配置开了 + 目录可用          → 能写回
 *   ② 配置开了 + source 块指向文件 → `enabled:true` 但写回仍会 ENOTDIR（2026-10-27 修过的 bug）
 *   ③ 没配 wikiSync 但 source 块是目录 → 能写回（走 source 块），此时 enabled 本就该是 false
 *
 * 覆盖：
 *   - 无配置无 source            → enabled:false / writableDir:null
 *   - wikiSync.sourceDir 可用     → enabled:true  / writableFrom:'wiki-sync'
 *   - wikiSync.enabled:false     → enabled:false / writableDir:null（显式关闭）
 *   - source 块指向**文件**       → writableDir:null + rejectReason 非空（关键回归）
 *   - source 块指向**目录**       → writableFrom:'source'，enabled 仍为 false
 *   - 既有字段未回归（registered / kb / vector / topGroups 等在）
 *
 * 运行：npx jiti test/scope-wikisync-status.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { resetConfigCache } from '../src/lib/config.js';
import { executeScopeList } from '../src/scope.js';
import { getGroupIndexPath } from '../src/lib/scope.js';

let tmpRoot: string;
let savedEnv: Record<string, string | undefined>;

/** 写一份最小配置：dataDir 指向临时目录，5 个 scope 分别覆盖各种 wikiSync 情形 */
function writeConfig(wikiDir: string): string {
  const configFile = path.join(tmpRoot, 'config.yaml');
  const yaml = [
    `dataDir: ${path.join(tmpRoot, 'kb')}`,
    `vectorDir: ${path.join(tmpRoot, 'vector')}`,
    `backupDir: ${path.join(tmpRoot, 'backup')}`,
    'scopeMode: default',
    'scopes:',
    '  ws-none: {}',
    '  ws-dir:',
    '    wikiSync:',
    `      sourceDir: ${wikiDir}`,
    '  ws-off:',
    '    wikiSync:',
    '      enabled: false',
    `      sourceDir: ${wikiDir}`,
    '  ws-file: {}',
    '  ws-source-dir: {}',
    '',
  ].join('\n');
  fs.writeFileSync(configFile, yaml, 'utf-8');
  return configFile;
}

/** 直接写 group-index.json 的 source 块（等价于导入时落盘的样子） */
function writeGroupIndexSource(scope: string, dir: string): void {
  const file = getGroupIndexPath(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 2, scope, groups: {}, updatedAt: null, source: { dir } }, null, 2),
    'utf-8',
  );
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-wikisync-status-'));
  savedEnv = {
    KI_CONFIG_PATH: process.env.KI_CONFIG_PATH,
    HOME: process.env.HOME,
    // Windows 上 os.homedir() 读 USERPROFILE：不同时改，隔离会失效（见 isolate-home.ts）
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;

  const wikiDir = path.join(tmpRoot, 'wiki-ok');
  fs.mkdirSync(wikiDir, { recursive: true });
  // source 块指向「单个文件」——单文件导入的真实落盘形态
  const singleFile = path.join(tmpRoot, 'sample.md');
  fs.writeFileSync(singleFile, '# sample\n', 'utf-8');

  process.env.KI_CONFIG_PATH = writeConfig(wikiDir);
  resetConfigCache();
  writeGroupIndexSource('ws-file', singleFile);
  writeGroupIndexSource('ws-source-dir', wikiDir);
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ki_scope_list · wikiSync 状态', () => {
  it('无 wikiSync 配置且无 source 块 → 未开启且不可写回', async () => {
    const res = await executeScopeList();
    assert.equal(res.ok, true);
    const entry = res.scopes.find((s) => s.scope === 'ws-none');
    assert.ok(entry, 'ws-none 应出现在列表里');
    assert.equal(entry.wikiSync.enabled, false);
    assert.equal(entry.wikiSync.writableDir, null);
    assert.equal(entry.wikiSync.writableFrom, null);
  });

  it('wikiSync.sourceDir 可用 → 开启且来源为 wiki-sync', async () => {
    const res = await executeScopeList();
    const entry = res.scopes.find((s) => s.scope === 'ws-dir');
    assert.ok(entry);
    assert.equal(entry.wikiSync.enabled, true);
    assert.equal(entry.wikiSync.writableFrom, 'wiki-sync');
    assert.equal(entry.wikiSync.writableDir, path.join(tmpRoot, 'wiki-ok'));
  });

  it('wikiSync.enabled:false → 显式关闭，即使 sourceDir 存在也不可写回', async () => {
    const res = await executeScopeList();
    const entry = res.scopes.find((s) => s.scope === 'ws-off');
    assert.ok(entry);
    assert.equal(entry.wikiSync.enabled, false);
    assert.equal(entry.wikiSync.writableDir, null);
  });

  it('★ source 块指向文件 → 不可写回且带 rejectReason（不能被 enabled 骗过）', async () => {
    const res = await executeScopeList();
    const entry = res.scopes.find((s) => s.scope === 'ws-file');
    assert.ok(entry);
    assert.equal(entry.wikiSync.writableDir, null, 'source 是文件时不得当成目录');
    assert.equal(entry.wikiSync.writableFrom, null);
    assert.equal(typeof entry.wikiSync.rejectReason, 'string');
    assert.ok((entry.wikiSync.rejectReason ?? '').length > 0, 'rejectReason 应给出人话原因');
    // 没配 wikiSync 段 ⇒ 开关本身是关的（与写回可用性是两个维度）
    assert.equal(entry.wikiSync.enabled, false);
  });

  it('source 块指向目录 → 可写回，来源为 source（wikiSync 开关仍为关）', async () => {
    const res = await executeScopeList();
    const entry = res.scopes.find((s) => s.scope === 'ws-source-dir');
    assert.ok(entry);
    assert.equal(entry.wikiSync.writableFrom, 'source');
    assert.equal(entry.wikiSync.writableDir, path.join(tmpRoot, 'wiki-ok'));
    assert.equal(entry.wikiSync.enabled, false);
  });

  it('既有字段未回归（每个 entry 仍有 registered / kb / vector / topGroups）', async () => {
    const res = await executeScopeList();
    for (const entry of res.scopes) {
      assert.equal(typeof entry.scope, 'string');
      assert.equal(typeof entry.registered, 'boolean');
      assert.equal(typeof entry.kb, 'boolean');
      assert.equal(typeof entry.vector, 'boolean');
      assert.ok(Array.isArray(entry.topGroups));
      assert.ok(entry.wikiSync && typeof entry.wikiSync === 'object');
    }
    const wsDir = res.scopes.find((s) => s.scope === 'ws-dir');
    assert.equal(wsDir?.registered, true);
  });
});
