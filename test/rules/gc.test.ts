/**
 * rules/gc 单测（S-01）
 *
 * 覆盖：超容淘汰、宽限期不淘汰、5 分钟/scope 节流。
 * 运行：node scripts/run-tests.mjs test/rules
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { KiConfig } from '../../src/lib/config.js';
import { gcRules, maybeGcRules } from '../../src/lib/rules/lifecycle.js';
import { readRules, withRulesLock, writeRules } from '../../src/lib/rules/store.js';
import type { RuleRecord } from '../../src/lib/rules/types.js';

const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];

function makeConfig(): KiConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-rules-gc-'));
  dirs.push(dir);
  return { dataDir: dir, chatDir: path.join(dir, 'chat') } as KiConfig;
}

function seedAi(config: KiConfig, scope: string, count: number, createdAt: string): void {
  const rules: RuleRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    rules.push({
      id: `r_${crypto.randomBytes(4).toString('hex')}`,
      scope,
      text: `规则${i}`,
      source: 'ai',
      expiresAt: null,
      createdAt,
      updatedAt: createdAt,
      createdBy: 'token:test',
    });
  }
  withRulesLock(config, () => {
    writeRules(config, { version: 1, rules: [...readRules(config).rules, ...rules] });
  });
}

function aiCount(config: KiConfig, scope: string): number {
  return readRules(config).rules.filter((r) => r.scope === scope && r.source === 'ai').length;
}

function wait(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('rules/gc', () => {
  it('40 条满 1 天：淘汰到 20', () => {
    const config = makeConfig();
    const now = new Date();
    seedAi(config, 's', 40, new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString());

    assert.deepEqual(gcRules(config, ['s'], now), { removed: 20 });
    assert.equal(aiCount(config, 's'), 20);
  });

  it('40 条都不满 1 天：不淘汰', () => {
    const config = makeConfig();
    const now = new Date();
    seedAi(config, 's', 40, now.toISOString());

    assert.deepEqual(gcRules(config, ['s'], now), { removed: 0 });
    assert.equal(aiCount(config, 's'), 40);
  });

  it('5 分钟内不重复 GC', async () => {
    const config = makeConfig();
    const t0 = new Date();
    seedAi(config, 'throttle', 40, new Date(t0.getTime() - 25 * 60 * 60 * 1000).toISOString());

    maybeGcRules(config, ['throttle'], t0);
    await wait();
    assert.equal(aiCount(config, 'throttle'), 20);

    seedAi(config, 'throttle', 5, new Date(t0.getTime() - 25 * 60 * 60 * 1000).toISOString());
    assert.equal(aiCount(config, 'throttle'), 25);

    maybeGcRules(config, ['throttle'], new Date(t0.getTime() + 60 * 1000));
    await wait();
    assert.equal(aiCount(config, 'throttle'), 25);

    maybeGcRules(config, ['throttle'], new Date(t0.getTime() + 6 * 60 * 1000));
    await wait();
    assert.equal(aiCount(config, 'throttle'), 20);
  });
});
