/**
 * ensureScopeDir scopeMode 语义测试
 *
 * 背景：ensureScopeDir 的注册校验曾无条件执行，与 scopeMode 语义矛盾——
 * scopeMode=default 应任意 scope 放行（resolveScope 语义），strict 才强制
 * 注册白名单。本测试锁定两种模式下的正确行为，防止回归。
 *
 * 运行：npx jiti test/scope-mode.test.ts
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureScopeDir } from '../src/lib/store.js';
import { getKbDir } from '../src/lib/scope.js';
import { resetConfigCache } from '../src/lib/config.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-mode-'));

function setupConfig(scopeMode: string): { configPath: string; dataDir: string } {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `cfg-${scopeMode}-`));
  const dataDir = path.join(dir, 'kb');
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(
    configPath,
    [
      `dataDir: ${dataDir}`,
      `vectorDir: ${path.join(dir, 'vector')}`,
      `scopeMode: ${scopeMode}`,
      'scopes:',
      '  default: {}',
      '',
    ].join('\n'),
    'utf-8'
  );
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();
  return { configPath, dataDir };
}

describe('ensureScopeDir scopeMode 语义', () => {
  afterEach(() => {
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
  });

  it('default 模式：未注册 scope 放行并自动创建目录', () => {
    setupConfig('default');
    assert.doesNotThrow(() => ensureScopeDir('fresh-scope'));
    assert.ok(fs.existsSync(getKbDir('fresh-scope')), '应自动创建 kb/fresh-scope 目录');
  });

  it('default 模式：已注册 scope 正常', () => {
    setupConfig('default');
    assert.doesNotThrow(() => ensureScopeDir('default'));
  });

  it('strict 模式：未注册 scope 拒绝且不创建目录', () => {
    setupConfig('strict');
    assert.throws(() => ensureScopeDir('fresh-scope'), /未在 ki 配置中注册/);
    assert.ok(!fs.existsSync(getKbDir('fresh-scope')), 'strict 拒绝时不应创建目录');
  });

  it('strict 模式：已注册 scope 正常', () => {
    setupConfig('strict');
    assert.doesNotThrow(() => ensureScopeDir('default'));
  });

  it('default 模式：未注册 scope 但有数据目录 → 放行（不误拒已还原的 scope）', () => {
    const { dataDir } = setupConfig('default');
    // 模拟"已还原的 KB"：数据目录存在且有内容
    const scopeDir = path.join(dataDir, 'restored-scope');
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.writeFileSync(
      path.join(scopeDir, 'relations-cache.json'),
      JSON.stringify({ groups: {} }),
      'utf-8'
    );

    assert.doesNotThrow(() => ensureScopeDir('restored-scope'));
    // 已有数据保持原样（不被 _template 覆盖）
    assert.ok(fs.existsSync(path.join(scopeDir, 'relations-cache.json')));
  });

  it('strict 模式：未注册 scope 即使有数据目录也拒绝', () => {
    const { dataDir } = setupConfig('strict');
    const scopeDir = path.join(dataDir, 'restored-scope');
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.writeFileSync(path.join(scopeDir, 'relations-cache.json'), '{}', 'utf-8');

    assert.throws(() => ensureScopeDir('restored-scope'), /未在 ki 配置中注册/);
    // 数据目录不被触碰
    assert.ok(fs.existsSync(path.join(scopeDir, 'relations-cache.json')));
  });
});
