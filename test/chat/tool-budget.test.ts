/**
 * 工具预算（REQ-20261015-001）单测
 *
 * 覆盖三个 SSOT 点：
 *   · `applyBudgetDefault` —— 仅 ki_search 且未传 limit 时补默认值（执行必经点注入）
 *   · `serializeToolResponse` —— limit 参数与返回值（默认 = 内置 10000）
 *   · `normalizePromptConfig` —— 两个新字段的边界校验与「缺省 = 未覆盖」语义
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/tool-budget.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_BUDGET } from '../../src/lib/chat/chat-contract.js';
import { applyBudgetDefault } from '../../src/lib/chat/mcp-tool-registry.js';
import { serializeToolResponse } from '../../src/lib/chat/retrieval/tool-response.js';
import { normalizePromptConfig, type PromptConfigIssue } from '../../src/lib/chat/prompt-config.js';

/** 最小合法配置骨架（含内置 skill，避免触发「内置不可删除」校验） */
const baseConfig = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  prompt: { content: '基础提示词' },
  skills: [{ id: 'builtin-retrieval', name: '知识库检索', content: '正文', description: '描述' }],
  ...extra,
});

describe('工具预算 · applyBudgetDefault（执行必经点注入）', () => {
  it('未传 limit 时补配置默认值', () => {
    assert.deepEqual(applyBudgetDefault('ki_search', { query: 'x' }, 8), { query: 'x', limit: 8 });
  });

  it('显式传值时原样保留（AI 自主控制条数的前提）', () => {
    assert.deepEqual(applyBudgetDefault('ki_search', { query: 'x', limit: 3 }, 8), { query: 'x', limit: 3 });
  });

  it('其他工具原样透传（同一引用，零开销）', () => {
    const other = { group: 'g', relation: 'r' };
    assert.equal(applyBudgetDefault('ki_get_module_info', other, 8), other);
  });

  it('默认值 0 / 负数也照常补（合法性由 spec 钳制，不在本函数把关）', () => {
    // 防御性说明：applyBudgetDefault 只负责「缺省补值」，范围校验在 parseToolArgs 的 spec.max/min
    assert.deepEqual(applyBudgetDefault('ki_search', { query: 'x' }, 1), { query: 'x', limit: 1 });
  });
});

describe('工具预算 · serializeToolResponse 的 limit', () => {
  it('缺省 = 内置上限，返回值带 limit', () => {
    const r = serializeToolResponse({ a: 1 });
    assert.equal(r.limit, CHAT_BUDGET.maxToolResponseChars);
    assert.equal(r.truncated, false);
  });

  it('显式 limit 生效：超限截断且文本不超该值', () => {
    const r = serializeToolResponse('中'.repeat(200), 100);
    assert.equal(r.limit, 100);
    assert.equal(r.truncated, true);
    assert.ok(Array.from(r.text).length <= 100);
    assert.match(r.text, /100 字符，已截断/);
  });

  it('未超限时不截断且 limit 如实回填', () => {
    const r = serializeToolResponse({ ok: true }, 2000);
    assert.equal(r.limit, 2000);
    assert.equal(r.truncated, false);
    assert.deepEqual(JSON.parse(r.text), { ok: true });
  });
});

describe('工具预算 · normalizePromptConfig 两字段', () => {
  it('缺省 = 未覆盖（字段不写入）', () => {
    const issues: PromptConfigIssue[] = [];
    const out = normalizePromptConfig(baseConfig(), issues);
    assert.equal(out.toolResponseChars, undefined);
    assert.equal(out.searchHitsPerCall, undefined);
    assert.equal(issues.length, 0);
  });

  it('合法值写入', () => {
    const out = normalizePromptConfig(baseConfig({ toolResponseChars: 20000, searchHitsPerCall: 8 }), []);
    assert.equal(out.toolResponseChars, 20000);
    assert.equal(out.searchHitsPerCall, 8);
  });

  it('越界值记 issue 且不写入（由调用方整体回退默认）', () => {
    const issues: PromptConfigIssue[] = [];
    normalizePromptConfig(baseConfig({ toolResponseChars: 500, searchHitsPerCall: 51 }), issues);
    assert.deepEqual(issues.map((i) => i.path).sort(), ['searchHitsPerCall', 'toolResponseChars']);
  });

  it('非整数 / 非数字被拒', () => {
    for (const bad of [1000.5, '20000', null, {}, true]) {
      const issues: PromptConfigIssue[] = [];
      normalizePromptConfig(baseConfig({ toolResponseChars: bad }), issues);
      assert.ok(issues.some((i) => i.path === 'toolResponseChars'), `应拒绝：${JSON.stringify(bad)}`);
    }
  });

  it('边界值恰好合法（1000 / 100000 / 1 / 50）', () => {
    const out = normalizePromptConfig(
      baseConfig({
        toolResponseChars: CHAT_BUDGET.toolResponseCharsMin,
        searchHitsPerCall: CHAT_BUDGET.maxHitsPerCallHardMax,
      }),
      [],
    );
    assert.equal(out.toolResponseChars, CHAT_BUDGET.toolResponseCharsMin);
    assert.equal(out.searchHitsPerCall, CHAT_BUDGET.maxHitsPerCallHardMax);
  });
});
