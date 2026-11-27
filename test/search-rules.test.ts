/**
 * S-02 读取面单测
 *
 * 覆盖：搜索规则 payload 开关、external framing、recall 系统提示词注入顺序。
 * 运行：node scripts/run-tests.mjs test/search-rules.test.ts
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { KiConfig } from '../src/lib/config.js';
import { buildSearchRulesPayload } from '../src/lib/mcp-tools/search.js';
import { buildRecallSystemPrompt, type RecallRuntimeCfg } from '../src/lib/recall/recall-prompt.js';
import { createHumanRule } from '../src/lib/rules/lifecycle.js';
import { buildRulesBlock } from '../src/lib/rules/index.js';

const dirs: string[] = [];

function makeConfig(): KiConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-rules-s02-'));
  dirs.push(dir);
  return { dataDir: dir, chatDir: path.join(dir, 'chat') } as KiConfig;
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('S-02 读取面', () => {
  it('ki_search rules：有规则时返回文本/计数；关闭或无 scope 时 undefined', () => {
    const config = makeConfig();
    createHumanRule(config, {
      scope: 'deployment',
      text: '查部署问题优先「部署运维」组',
      expiresAt: null,
      createdBy: 'user:1',
    });

    const on = buildSearchRulesPayload(config, ['deployment'], true);
    assert.ok(on);
    assert.equal(on!.count, 1);
    assert.equal(on!.truncated, 0);
    assert.match(on!.text, /查部署问题优先/);
    assert.match(on!.text, /供你调整检索行为/);

    assert.equal(buildSearchRulesPayload(config, ['deployment'], false), undefined);
    assert.equal(buildSearchRulesPayload(config, [], true), undefined);
  });

  it('external 与 internal 的 framing 不同', () => {
    const rule = {
      id: 'r_1', scope: 's', text: '规则正文', source: 'human' as const,
      expiresAt: null, createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z', createdBy: 'user:1',
    };
    const loaded = { byScope: { s: [rule] }, total: 1, truncated: 0, chars: 4 };

    const internal = buildRulesBlock(loaded, { audience: 'internal' });
    const external = buildRulesBlock(loaded, { audience: 'external' });
    assert.match(internal, /与输出格式冲突/);
    assert.match(external, /供你调整检索行为/);
    assert.doesNotMatch(external, /与输出格式冲突/);
  });

  it('旧规则带换行时渲染仍为单行', () => {
    const rule = {
      id: 'r_2', scope: 's', text: '第一行\n第二行', source: 'human' as const,
      expiresAt: null, createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z', createdBy: 'user:1',
    };
    const block = buildRulesBlock({ byScope: { s: [rule] }, total: 1, truncated: 0, chars: 7 });
    assert.match(block, /- 第一行 第二行/);
    assert.doesNotMatch(block, /\n第二行/);
  });

  it('recall 系统提示词顺序：prompt → skill → rules → scopeNote → 预算', () => {
    const cfg: RecallRuntimeCfg = {
      prompt: 'BASE_PROMPT',
      tools: {},
      maxRounds: 3,
      toolResponseChars: 1000,
      maxToolCalls: 5,
      skills: [{ id: 's1', name: 'SKILL_ONE', content: 'SKILL_BODY', enabled: true }],
      rulesBlock: 'RULES_BLOCK',
      scopeNote: 'SCOPE_NOTE',
    };
    const prompt = buildRecallSystemPrompt(cfg);

    const iPrompt = prompt.indexOf('BASE_PROMPT');
    const iSkill = prompt.indexOf('SKILL_ONE');
    const iRules = prompt.indexOf('RULES_BLOCK');
    const iScope = prompt.indexOf('SCOPE_NOTE');
    const iBudget = prompt.indexOf('工具调用预算');

    assert.ok(iPrompt >= 0 && iSkill > iPrompt && iRules > iSkill && iScope > iRules && iBudget > iScope);
  });

  it('rulesBlock 为空时不插入空段', () => {
    const cfg: RecallRuntimeCfg = {
      prompt: 'BASE_PROMPT',
      tools: {},
      maxRounds: 3,
      toolResponseChars: 1000,
      skills: [],
    };
    const prompt = buildRecallSystemPrompt(cfg);
    assert.doesNotMatch(prompt, /## 项目规则/);
  });
});
