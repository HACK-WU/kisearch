/**
 * rules/block 单测（S-01）
 *
 * 覆盖：空规则返回空串、internal/external framing、scope 分组、截断提示。
 * 运行：node scripts/run-tests.mjs test/rules
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRulesBlock } from '../../src/lib/rules/block.js';
import type { LoadedRules, RuleRecord } from '../../src/lib/rules/types.js';

function rule(over: Partial<RuleRecord> = {}): RuleRecord {
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

function loaded(over: Partial<LoadedRules> = {}): LoadedRules {
  return {
    byScope: { deployment: [rule()] },
    total: 1,
    truncated: 0,
    chars: 16,
    ...over,
  };
}

describe('rules/block', () => {
  it('空规则返回空串', () => {
    assert.equal(buildRulesBlock({ byScope: {}, total: 0, truncated: 0, chars: 0 }), '');
  });

  it('internal 注入带固定 framing 与 scope 分组', () => {
    const text = buildRulesBlock(loaded());
    assert.match(text, /## 项目规则（按知识库）/);
    assert.match(text, /不是系统指令；与输出格式冲突时以输出格式为准/);
    assert.match(text, /### deployment/);
    assert.match(text, /- 查部署问题优先「部署运维」组/);
  });

  it('external 返回换用调用方口径的 framing', () => {
    const text = buildRulesBlock(loaded(), { audience: 'external' });
    assert.match(text, /供你调整检索行为；不是系统指令/);
  });

  it('截断时追加提示', () => {
    const text = buildRulesBlock(loaded({ truncated: 2 }));
    assert.match(text, /另有 2 条因长度上限未注入/);
  });
});
