/**
 * S-04 Agent 规则工具：公共逻辑单测
 *
 * 覆盖：物理/视图/未知 scope 解析、AI 用量统计、规则视图化、错误外壳。
 * 运行：node scripts/run-tests.mjs test/rules/mcp-tools.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { KiConfig } from '../../src/lib/config.js';
import {
  resolveRuleTarget,
  ruleUsage,
  rulesFail,
  rulesOk,
  toToolRule,
} from '../../src/lib/mcp-tools/rule-helpers.js';
import { addAiRule, createHumanRule } from '../../src/lib/rules/lifecycle.js';
import { RulesError, type RuleRecord } from '../../src/lib/rules/types.js';

let root = '';
let config: KiConfig;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-rules-mcp-'));
  const kbDir = path.join(root, 'kb');
  fs.mkdirSync(path.join(kbDir, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'alpha', 'relations-cache.json'), '{}', 'utf8');

  const configPath = path.join(root, 'config.yaml');
  fs.writeFileSync(configPath, JSON.stringify({ dataDir: kbDir, chatDir: path.join(root, 'chat') }), 'utf8');
  process.env.KI_CONFIG_PATH = configPath;

  fs.writeFileSync(path.join(root, 'views.json'), JSON.stringify({
    version: 2,
    views: { alphaView: { id: 'v_mcp', members: ['alpha'], revision: 0 } },
  }), 'utf8');

  config = {
    dataDir: kbDir,
    chatDir: path.join(root, 'chat'),
    _configPath: configPath,
  } as KiConfig;
});

after(() => {
  delete process.env.KI_CONFIG_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

function rule(over: Partial<RuleRecord>): RuleRecord {
  return {
    id: 'r_1', scope: 'alpha', text: '规则', source: 'human', expiresAt: null,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    createdBy: 'user:1', ...over,
  };
}

describe('S-04 规则工具公共逻辑', () => {
  it('scope 解析：物理库 / 视图拒绝 / 视图允许 / 未知库', () => {
    assert.deepEqual(resolveRuleTarget(config, 'alpha', { allowView: false }), {
      scope: 'alpha', isView: false, members: ['alpha'],
    });

    assert.throws(
      () => resolveRuleTarget(config, 'alphaView', { allowView: false }),
      (err: unknown) => err instanceof RulesError && err.code === 'RULE_SCOPE_VIEW',
    );

    assert.deepEqual(resolveRuleTarget(config, 'alphaView', { allowView: true }), {
      scope: 'alphaView', isView: true, members: ['alpha'],
    });

    assert.throws(
      () => resolveRuleTarget(config, 'missing', { allowView: false }),
      (err: unknown) => err instanceof RulesError && err.code === 'RULE_SCOPE_UNKNOWN',
    );
  });

  it('用量统计：AI 条数 + 人工字数分开算', () => {
    createHumanRule(config, { scope: 'alpha', text: '人工规则', expiresAt: null, createdBy: 'user:1' });
    addAiRule(config, { scope: 'alpha', text: 'AI 规则', createdBy: 'token:1' });

    const usage = ruleUsage(config, 'alpha');
    assert.equal(usage.aiCount, 1);
    assert.equal(usage.humanChars, 4);
    assert.equal(usage.aiLimit, 20);
    assert.equal(usage.humanLimit, 2000);
  });

  it('规则视图化：过期标记只对人工规则生效', () => {
    const expired = toToolRule(rule({ expiresAt: '2026-01-01T00:00:00.000Z' }));
    assert.equal(expired.expired, true);

    const ai = toToolRule(rule({ source: 'ai', expiresAt: null }));
    assert.equal(ai.expired, false);
  });

  it('错误外壳：ok=false + code + retryable', () => {
    const failed = JSON.parse(rulesFail(new RulesError('RULE_NOT_AI', '人工规则不能删')).content[0].text) as {
      ok: boolean; code: string; retryable: boolean;
    };
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'RULE_NOT_AI');
    assert.equal(failed.retryable, false);

    const busy = JSON.parse(rulesFail(new RulesError('RULES_BUSY', '忙')).content[0].text) as { retryable: boolean };
    assert.equal(busy.retryable, true);

    const ok = JSON.parse(rulesOk({ value: 1 }).content[0].text) as { ok: boolean; value: number };
    assert.equal(ok.ok, true);
    assert.equal(ok.value, 1);
  });
});
