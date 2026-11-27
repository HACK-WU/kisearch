/**
 * S-05 导入导出单测
 *
 * 覆盖：导出过滤、合并去重、覆盖语义、AI 跳过、过期/孤儿计数、配额、整单事务。
 * 运行：node scripts/run-tests.mjs test/rules/import-export.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { KiConfig } from '../../src/lib/config.js';
import {
  applyImport,
  buildExportPackage,
  planImport,
} from '../../src/lib/rules/import-export.js';
import { addAiRule, createHumanRule } from '../../src/lib/rules/lifecycle.js';
import { readRules } from '../../src/lib/rules/store.js';
import { RulesError } from '../../src/lib/rules/types.js';

let root = '';
let config: KiConfig;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-rules-ie-'));
  const kbDir = path.join(root, 'kb');
  for (const s of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(kbDir, s), { recursive: true });
    fs.writeFileSync(path.join(kbDir, s, 'relations-cache.json'), '{}', 'utf8');
  }
  const configPath = path.join(root, 'config.yaml');
  fs.writeFileSync(configPath, JSON.stringify({ dataDir: kbDir, chatDir: path.join(root, 'chat') }), 'utf8');
  process.env.KI_CONFIG_PATH = configPath;
  fs.writeFileSync(path.join(root, 'views.json'), JSON.stringify({
    version: 2,
    views: { authView: { id: 'v_ie', members: ['alpha'], revision: 0 } },
  }), 'utf8');
  config = { dataDir: kbDir, chatDir: path.join(root, 'chat'), _configPath: configPath } as KiConfig;
});

after(() => {
  delete process.env.KI_CONFIG_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

function pkg(rules: unknown[]): unknown {
  return { version: 1, exportedAt: new Date().toISOString(), rules };
}

function item(scope: string, text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { scope, text, source: 'human', expiresAt: null, createdAt: new Date().toISOString(), ...over };
}

describe('S-05 导入导出', () => {
  it('导出按 scope 过滤，AI 可选', () => {
    createHumanRule(config, { scope: 'alpha', text: 'alpha 人工', expiresAt: null, createdBy: 'user:1' });
    createHumanRule(config, { scope: 'beta', text: 'beta 人工', expiresAt: null, createdBy: 'user:1' });
    addAiRule(config, { scope: 'alpha', text: 'alpha AI', createdBy: 'token:1' });

    const humanOnly = buildExportPackage(config, { scopes: ['alpha'], includeAi: false });
    assert.equal(humanOnly.rules.length, 1);
    assert.equal(humanOnly.rules[0]!.source, 'human');

    const withAi = buildExportPackage(config, { scopes: ['alpha'], includeAi: true });
    assert.equal(withAi.rules.length, 2);

    const all = buildExportPackage(config, { scopes: null, includeAi: false });
    assert.equal(all.rules.length, 2);
    assert.equal(all.version, 1);
    assert.equal(all.generator, 'kisearch/ai-rules');
    assert.equal(Object.prototype.hasOwnProperty.call(all.rules[0]!, 'id'), false);
  });

  it('合并导入：去重 / 跳过 AI / 过期与孤儿计数', () => {
    const beforeCount = readRules(config).rules.length;
    const plan = planImport(config, pkg([
      item('alpha', 'alpha 人工'), // 已存在 → 跳过
      item('alpha', '新的合并规则'),
      item('alpha', 'AI 规则', { source: 'ai' }),
      item('beta', '已过期规则', { expiresAt: '2026-01-01T00:00:00.000Z' }),
      item('legacy', '孤儿规则'),
    ]), 'merge', new Date('2026-11-27T12:00:00.000Z'));

    assert.equal(plan.result.imported, 3);
    assert.equal(plan.result.skippedDuplicate, 1);
    assert.equal(plan.result.skippedAi, 1);
    assert.equal(plan.result.expired, 1);
    assert.deepEqual(plan.result.orphanScopes, [{ scope: 'legacy', count: 1 }]);
    assert.equal(plan.nextFile.rules.length, beforeCount + 3);
    assert.equal(plan.nextFile.rules.some((r) => r.source === 'ai' && r.text === 'AI 规则'), false);
  });

  it('apply 幂等：第二次全部跳过', () => {
    const packageRules = [item('beta', '只导一次')];
    const first = applyImport(config, pkg(packageRules), 'merge');
    assert.equal(first.imported, 1);

    const second = applyImport(config, pkg(packageRules), 'merge');
    assert.equal(second.imported, 0);
    assert.equal(second.skippedDuplicate, 1);
  });

  it('覆盖模式：只清包内 scope 的人工规则，AI 保留', () => {
    const alphaAi = addAiRule(config, { scope: 'alpha', text: '覆盖测试 AI', createdBy: 'token:1' });
    applyImport(config, pkg([item('alpha', '覆盖后的规则')]), 'replace');

    const rules = readRules(config).rules.filter((r) => r.scope === 'alpha');
    const human = rules.filter((r) => r.source === 'human');
    assert.equal(human.length, 1);
    assert.equal(human[0]!.text, '覆盖后的规则');
    assert.ok(rules.some((r) => r.id === alphaAi.rule.id), 'AI 规则不应被覆盖清掉');
  });

  it('配额 / 版本 / 条数 / 空包 / 超长文本', () => {
    const many = Array.from({ length: 11 }, (_, i) => item('beta', `${'规'.repeat(196)}${String(i).padStart(4, '0')}`));
    assert.throws(
      () => planImport(config, pkg(many), 'merge'),
      (err: unknown) => err instanceof RulesError && err.code === 'RULES_IMPORT_QUOTA',
    );

    assert.throws(
      () => planImport(config, { version: 2, rules: [] }, 'merge'),
      (err: unknown) => err instanceof RulesError && err.code === 'RULES_IMPORT_INVALID',
    );
    assert.throws(
      () => planImport(config, pkg([]), 'merge'),
      (err: unknown) => err instanceof RulesError && err.code === 'RULES_IMPORT_EMPTY',
    );
    assert.throws(
      () => planImport(config, pkg(Array.from({ length: 501 }, () => item('beta', 'x'))), 'merge'),
      (err: unknown) => err instanceof RulesError && err.code === 'RULES_IMPORT_TOO_LARGE',
    );
    assert.throws(
      () => planImport(config, pkg([item('beta', 'x'.repeat(201))]), 'merge'),
      (err: unknown) => err instanceof RulesError && err.code === 'RULE_TEXT_INVALID',
    );
    assert.throws(
      () => planImport(config, pkg([item('authView', '视图规则')]), 'merge'),
      (err: unknown) => err instanceof RulesError && err.code === 'RULES_IMPORT_INVALID',
    );
  });
});
