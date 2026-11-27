/**
 * rules/lifecycle 单测（S-01）
 *
 * 覆盖：并集去重、过期过滤（human 过滤 / ai 不过滤）、2000 字截断、AI 去重、
 *       40 条宽限期与淘汰、100 条硬上限、人工 2000 字配额、AI 规则不可编辑/不可被 Agent 删。
 * 运行：node scripts/run-tests.mjs test/rules
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { KiConfig } from '../../src/lib/config.js';
import {
  addAiRule,
  createHumanRule,
  deleteAiRule,
  deleteRule,
  loadRulesForScopes,
  promoteAiRule,
  updateHumanRule,
} from '../../src/lib/rules/lifecycle.js';
import { readRules, withRulesLock, writeRules } from '../../src/lib/rules/store.js';
import { RulesError, type RuleRecord } from '../../src/lib/rules/types.js';

const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];

function makeConfig(): KiConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-rules-life-'));
  dirs.push(dir);
  return { dataDir: dir, chatDir: path.join(dir, 'chat') } as KiConfig;
}

function makeRule(over: Partial<RuleRecord>): RuleRecord {
  return {
    id: 'r_00000001',
    scope: 's',
    text: '规则',
    source: 'human',
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: 'user:test',
    ...over,
  };
}

/** 直接落盘 N 条 AI 规则（跳过 addAiRule，便于构造年龄/容量场景） */
function seedAi(config: KiConfig, scope: string, count: number, createdAt: string, chars = 20): void {
  const rules: RuleRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const text = `规则${String(i).padStart(2, '0')}${'x'.repeat(Math.max(0, chars - 4))}`.slice(0, chars);
    rules.push(makeRule({
      id: `r_${String(i).padStart(8, '0')}`,
      scope,
      text,
      source: 'ai',
      expiresAt: null,
      createdAt,
      updatedAt: createdAt,
      createdBy: 'token:test',
    }));
  }
  withRulesLock(config, () => {
    writeRules(config, { version: 1, rules: [...readRules(config).rules, ...rules] });
  });
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('rules/lifecycle', () => {
  it('跨 scope 并集按文本去重', () => {
    const config = makeConfig();
    createHumanRule(config, { scope: 'a', text: '共同规则', expiresAt: null, createdBy: 'user:1' });
    createHumanRule(config, { scope: 'b', text: '共同规则', expiresAt: null, createdBy: 'user:1' });

    const loaded = loadRulesForScopes(config, ['a', 'b']);
    assert.equal(loaded.total, 1);
    assert.equal(loaded.byScope.a?.length, 1);
    assert.equal(loaded.byScope.b, undefined);
  });

  it('过期人工规则不注入，AI 规则不受时间过滤', () => {
    const config = makeConfig();
    const now = new Date();
    createHumanRule(config, {
      scope: 's',
      text: '会过期的人工规则',
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      createdBy: 'user:1',
    });
    addAiRule(config, { scope: 's', text: 'AI 规则', createdBy: 'token:1' }, new Date(now.getTime() - 2 * DAY));

    const loaded = loadRulesForScopes(config, ['s'], { now: new Date(now.getTime() + 2 * 60 * 60 * 1000) });
    assert.equal(loaded.total, 1);
    assert.equal(loaded.byScope.s?.[0]?.source, 'ai');
  });

  it('2000 字截断按 human 优先、剩余条数正确', () => {
    const config = makeConfig();
    const now = new Date();
    for (let i = 0; i < 11; i += 1) {
      addAiRule(
        config,
        { scope: 's', text: `${'规'.repeat(196)}${String(i).padStart(4, '0')}`, createdBy: 'token:1' },
        now,
      );
    }

    const loaded = loadRulesForScopes(config, ['s'], { now, maxChars: 2000 });
    assert.equal(loaded.chars, 2000);
    assert.equal(loaded.truncated, 1);
    assert.equal(loaded.byScope.s?.length, 10);
  });

  it('AI 规则同文本去重', () => {
    const config = makeConfig();
    const first = addAiRule(config, { scope: 's', text: '重复规则', createdBy: 'token:1' });
    const second = addAiRule(config, { scope: 's', text: ' 重复规则 ', createdBy: 'token:1' });

    assert.equal(second.deduped, true);
    assert.equal(second.rule.id, first.rule.id);
    assert.equal(readRules(config).rules.length, 1);
  });

  it('40 条满 1 天后加第 41 条：淘汰到 20', () => {
    const config = makeConfig();
    const now = new Date();
    seedAi(config, 's', 40, new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString());

    const res = addAiRule(config, { scope: 's', text: '新规则', createdBy: 'token:1' }, now);
    assert.equal(res.evicted.length, 21);
    assert.equal(readRules(config).rules.filter((r) => r.source === 'ai').length, 20);
  });

  it('40 条都不满 1 天：允许暂时超过 20，不淘汰', () => {
    const config = makeConfig();
    const now = new Date();
    seedAi(config, 's', 40, now.toISOString());

    const res = addAiRule(config, { scope: 's', text: '新规则', createdBy: 'token:1' }, now);
    assert.equal(res.evicted.length, 0);
    assert.equal(readRules(config).rules.filter((r) => r.source === 'ai').length, 41);
  });

  it('100 条且无可淘汰项：拒绝新增', () => {
    const config = makeConfig();
    const now = new Date();
    seedAi(config, 's', 100, now.toISOString());

    assert.throws(
      () => addAiRule(config, { scope: 's', text: '第 101 条', createdBy: 'token:1' }, now),
      (err: unknown) => err instanceof RulesError && err.code === 'RULES_AI_HARD_CAP',
    );
  });

  it('人工规则每 scope 2000 字配额', () => {
    const config = makeConfig();
    for (let i = 0; i < 10; i += 1) {
      createHumanRule(
        config,
        { scope: 's', text: `${'规'.repeat(196)}${String(i).padStart(4, '0')}`, expiresAt: null, createdBy: 'user:1' },
      );
    }
    assert.throws(
      () => createHumanRule(config, { scope: 's', text: '再多一条', expiresAt: null, createdBy: 'user:1' }),
      (err: unknown) => err instanceof RulesError && err.code === 'RULE_SCOPE_QUOTA',
    );
  });

  it('AI 规则不可编辑；Agent 不可删人工规则', () => {
    const config = makeConfig();
    const ai = addAiRule(config, { scope: 's', text: 'AI 规则', createdBy: 'token:1' });
    const human = createHumanRule(config, { scope: 's', text: '人工规则', expiresAt: null, createdBy: 'user:1' });

    assert.throws(
      () => updateHumanRule(config, ai.rule.id, { text: '改一下' }, 'user:1'),
      (err: unknown) => err instanceof RulesError && err.code === 'RULE_NOT_HUMAN',
    );
    assert.throws(
      () => deleteAiRule(config, { scope: 's', text: human.text }, 'token:1'),
      (err: unknown) => err instanceof RulesError && err.code === 'RULE_NOT_AI',
    );
  });

  it('转永久时校验人工配额', () => {
    const config = makeConfig();
    for (let i = 0; i < 10; i += 1) {
      createHumanRule(
        config,
        { scope: 's', text: `${'规'.repeat(196)}${String(i).padStart(4, '0')}`, expiresAt: null, createdBy: 'user:1' },
      );
    }
    const ai = addAiRule(config, { scope: 's', text: '十个字的AI规则', createdBy: 'token:1' });

    assert.throws(
      () => promoteAiRule(config, ai.rule.id, 'user:1'),
      (err: unknown) => err instanceof RulesError && err.code === 'RULE_SCOPE_QUOTA',
    );
  });

  it('更新人工规则：改文本并保留永久', () => {
    const config = makeConfig();
    const rule = createHumanRule(config, { scope: 's', text: '旧文本', expiresAt: null, createdBy: 'user:1' });
    const updated = updateHumanRule(config, rule.id, { text: '新文本' }, 'user:1');

    assert.equal(updated.text, '新文本');
    assert.equal(updated.expiresAt, null);
    assert.equal(readRules(config).rules[0]!.text, '新文本');
  });

  it('AI 规则转永久后进入人工池', () => {
    const config = makeConfig();
    const ai = addAiRule(config, { scope: 's', text: 'AI 规则', createdBy: 'token:1' });
    const promoted = promoteAiRule(config, ai.rule.id, 'user:1');

    assert.equal(promoted.source, 'human');
    assert.equal(promoted.expiresAt, null);
    assert.equal(readRules(config).rules[0]!.source, 'human');
  });

  it('按 id 删除人工 / AI 规则', () => {
    const config = makeConfig();
    const human = createHumanRule(config, { scope: 's', text: '人工规则', expiresAt: null, createdBy: 'user:1' });
    const ai = addAiRule(config, { scope: 's', text: 'AI 规则', createdBy: 'token:1' });

    assert.equal(deleteRule(config, human.id, 'user:1').id, human.id);
    assert.equal(deleteAiRule(config, { id: ai.rule.id, scope: 's' }, 'token:1').id, ai.rule.id);
    assert.equal(readRules(config).rules.length, 0);
  });

  it('排序：人工规则在 AI 规则之前（即使 AI 更早）', () => {
    const config = makeConfig();
    addAiRule(config, { scope: 's', text: 'AI 先加', createdBy: 'token:1' }, new Date(Date.now() - 60_000));
    createHumanRule(config, { scope: 's', text: '人工后加', expiresAt: null, createdBy: 'user:1' });

    const loaded = loadRulesForScopes(config, ['s']);
    assert.equal(loaded.byScope.s?.[0]?.source, 'human');
    assert.equal(loaded.byScope.s?.[1]?.source, 'ai');
  });

  it('空 patch 与无删除目标被拒绝', () => {
    const config = makeConfig();
    const human = createHumanRule(config, { scope: 's', text: '人工规则', expiresAt: null, createdBy: 'user:1' });

    assert.throws(
      () => updateHumanRule(config, human.id, {}, 'user:1'),
      (err: unknown) => err instanceof RulesError && err.code === 'RULE_PATCH_EMPTY',
    );
    assert.throws(
      () => deleteAiRule(config, { scope: 's' }, 'token:1'),
      (err: unknown) => err instanceof RulesError && err.code === 'RULE_TARGET_INVALID',
    );
  });

  it('规则正文换行归一为空格', () => {
    const config = makeConfig();
    const rule = createHumanRule(config, {
      scope: 's',
      text: '第一行\n第二行',
      expiresAt: null,
      createdBy: 'user:1',
    });
    assert.equal(rule.text, '第一行 第二行');
  });
});
