/**
 * rules/store 单测（S-01）
 *
 * 覆盖：路径派生、缺失文件降级、写读 round-trip、损坏降级、缓存失效、锁重入。
 * 运行：node scripts/run-tests.mjs test/rules
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { KiConfig } from '../../src/lib/config.js';
import { readRules, rulesFilePath, withRulesLock, writeRules } from '../../src/lib/rules/store.js';
import { RulesError, type RuleRecord, type RulesFile } from '../../src/lib/rules/types.js';

const dirs: string[] = [];

function makeConfig(): KiConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-rules-store-'));
  dirs.push(dir);
  return { dataDir: dir, chatDir: path.join(dir, 'chat') } as KiConfig;
}

function makeRule(over: Partial<RuleRecord> = {}): RuleRecord {
  return {
    id: 'r_00000001',
    scope: 'deployment',
    text: '查部署问题优先「部署运维」组',
    source: 'human',
    expiresAt: null,
    createdAt: '2026-11-20T08:00:00.000Z',
    updatedAt: '2026-11-20T08:00:00.000Z',
    createdBy: 'user:test',
    ...over,
  };
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('rules/store', () => {
  it('路径落在 chatDir 下', () => {
    const config = makeConfig();
    assert.equal(rulesFilePath(config), path.join(config.chatDir!, 'scope-rules.json'));
  });

  it('文件不存在时返回空规则', () => {
    const config = makeConfig();
    assert.deepEqual(readRules(config), { version: 1, rules: [] });
  });

  it('写读 round-trip', () => {
    const config = makeConfig();
    const file: RulesFile = { version: 1, rules: [makeRule()] };
    withRulesLock(config, () => writeRules(config, file));

    const got = readRules(config);
    assert.equal(got.version, 1);
    assert.equal(got.rules.length, 1);
    assert.equal(got.rules[0]!.text, '查部署问题优先「部署运维」组');
  });

  it('损坏文件降级为空，且写路径拒绝覆盖', () => {
    const config = makeConfig();
    const filePath = rulesFilePath(config);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ not json', 'utf8');

    assert.deepEqual(readRules(config), { version: 1, rules: [] });
    assert.throws(
      () => withRulesLock(config, () => writeRules(config, { version: 1, rules: [] })),
      (err: unknown) => err instanceof RulesError && err.code === 'RULES_CORRUPT',
    );
  });

  it('外部写后缓存失效', () => {
    const config = makeConfig();
    withRulesLock(config, () => writeRules(config, { version: 1, rules: [makeRule()] }));
    assert.equal(readRules(config).rules.length, 1);

    const filePath = rulesFilePath(config);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, rules: [makeRule(), makeRule({ id: 'r_00000002', text: '第二条规则，长度不同' })] }),
      'utf8',
    );

    assert.equal(readRules(config).rules.length, 2);
  });

  it('同进程锁重入被拒绝', () => {
    const config = makeConfig();
    assert.throws(
      () => withRulesLock(config, () => withRulesLock(config, () => 1)),
      (err: unknown) => err instanceof RulesError && err.code === 'RULES_BUSY',
    );
  });

  it('writeRules 在锁外被拒绝', () => {
    const config = makeConfig();
    assert.throws(
      () => writeRules(config, { version: 1, rules: [] }),
      (err: unknown) => err instanceof RulesError && err.code === 'RULES_BUSY',
    );
  });

  it('单条坏记录被跳过', () => {
    const config = makeConfig();
    const filePath = rulesFilePath(config);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        rules: [makeRule(), makeRule({ id: 'r_00000002', text: 'x'.repeat(201) })],
      }),
      'utf8',
    );

    const got = readRules(config);
    assert.equal(got.rules.length, 1);
    assert.equal(got.rules[0]!.id, 'r_00000001');
  });
});
