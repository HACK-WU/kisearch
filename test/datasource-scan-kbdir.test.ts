/**
 * 回归（2026-11-16）：配置了 `scopes.<scope>.kbDir` 的 scope，其 `datasource.json`
 * 落在 `<kbDir>/kb/<scope>/`，不在 `dataDir` 下。枚举口径必须同时覆盖
 * 「config.scopes 声明的 scope」与「dataDir 下的目录」，否则：
 * CLI `datasource add` 成功，列表页 / 调度器 / 共享 clone 引用计数却全都看不到它。
 *
 * 运行：npx jiti test/datasource-scan-kbdir.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import { addDataSource, listRegisteredDataSourceRecords, readDataSource, scanDataSources } from '../src/lib/datasource.js';

let root: string;
let dataDir: string;
let externalKbDir: string;
let configPath: string;
let savedConfigPath: string | undefined;

const extScope = `ds-scan-ext-${process.pid}`;
const plainScope = `ds-scan-plain-${process.pid}`;
const neverScope = 'ds-scan-never';

let extSource: string;
let plainSource: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ds-scan-'));
  dataDir = path.join(root, 'data');
  externalKbDir = path.join(root, 'external-kb');
  configPath = path.join(root, 'config.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    dataDir,
    vectorDir: path.join(root, 'vector'),
    backupDir: path.join(root, 'backup'),
    scopeMode: 'default',
    scopes: {
      [extScope]: { kbDir: externalKbDir },
      [plainScope]: {},
      // 声明了但从未登记：应静默跳过（NOT_FOUND），不进 registered/missing/corrupt
      [neverScope]: {},
      // 调度器保留字：readDataSource 会抛，枚举时应先过滤掉，不能变成「损坏」
      __global__: {},
    },
  }), 'utf8');

  savedConfigPath = process.env.KI_CONFIG_PATH;
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();

  extSource = path.join(root, 'src-ext');
  plainSource = path.join(root, 'src-plain');
  for (const dir of [extSource, plainSource]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.md'), '# a\n');
  }
});

after(() => {
  if (savedConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = savedConfigPath;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('扫描口径：kbDir 外挂的 scope 不能被漏掉', () => {
  it('前置：两个 scope 各登记一个目录数据源，外挂 scope 的记录确实不在 dataDir 下', async () => {
    const config = loadConfig();
    const a = await addDataSource({ scope: extScope, dir: extSource, config });
    assert.equal(a.ok, true);
    const b = await addDataSource({ scope: plainScope, dir: plainSource, config });
    assert.equal(b.ok, true);

    const extFile = path.join(externalKbDir, 'kb', extScope, 'datasource.json');
    assert.equal(fs.existsSync(extFile), true, '外挂 scope 的记录应写进 <kbDir>/kb/<scope>/');
    assert.equal(fs.existsSync(path.join(dataDir, extScope)), false, 'dataDir 下不该有该 scope 的目录');
    assert.equal(readDataSource(extScope).ok, true);
  });

  it('scanDataSources 同时覆盖 kbDir scope 与 dataDir scope，且无假损坏', () => {
    const scan = scanDataSources(loadConfig());
    const names = scan.registered.map((r) => r.scope);
    assert.equal(names.includes(extScope), true, 'kbDir scope 必须出现在列表');
    assert.equal(names.includes(plainScope), true, 'dataDir scope 仍要在列表');
    assert.equal(names.includes(neverScope), false, '未登记的 scope 不进列表');
    assert.equal(names.includes('__global__'), false, '保留字不该被当成 scope');
    assert.deepEqual(scan.corrupt, [], '保留字/未登记 scope 不得产生「损坏」记录');
    assert.deepEqual(scan.missing, []);
  });

  it('listRegisteredDataSourceRecords 同样含 kbDir scope（调度器 / 共享 clone 引用计数口径）', () => {
    const all = listRegisteredDataSourceRecords(loadConfig()).map((r) => r.scope);
    assert.equal(all.includes(extScope), true);
    assert.equal(all.includes(plainScope), true);
    assert.equal(all.includes(neverScope), false);
    assert.equal(all.includes('__global__'), false);
  });

  it('dataDir 不可读时不抛错，仍按配置声明的 scope 枚举', () => {
    // ⚠ 必须浅拷贝：`loadConfig()` 命中缓存时返回的是**进程级同一个对象**，
    // 直接改它的字段等于污染后续所有 loadConfig() 调用（本文件 after 虽会
    // resetConfigCache，但后来者在此文件追加用例就会拿到被改坏的 dataDir）。
    const broken = { ...loadConfig(), dataDir: path.join(root, 'no-such-data-dir') };
    const scan = scanDataSources(broken);
    assert.equal(scan.registered.some((r) => r.scope === extScope), true);
    assert.deepEqual(scan.corrupt, []);
  });
});
