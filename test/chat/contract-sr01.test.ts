/**
 * SR-01 契约测试（**骨架期应为【红】**）
 *
 * 验的是：**本砖头是否兑现契约**（形状层面）—— 由 `chat-contract.ts` 的契约派生。
 * 骨架期这些用例必然失败（桩抛 `STUB:SR-01:*`），**红是健康**：
 *   若骨架期出现 passed，说明桩返回了"看似合法的默认值"（假绿）→ 必须归零。
 *
 * 运行：`npx jiti test/chat/contract-sr01.test.ts`
 * 分组口径：**被测接口的实现方**（本文件只测 SR-01 提供的接口）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_BUDGET } from '../../src/lib/chat/chat-contract.js';
import { toToolProjection, toSourceRefs } from '../../src/lib/chat/retrieval/projection.js';
import { buildSystemMessages, RETRIEVAL_SKILL_PROMPT } from '../../src/lib/chat/retrieval/retrieval-skill.js';
import { CHAT_MCP_TOOLS, getChatTool } from '../../src/lib/chat/mcp-tool-registry.js';
import { mockSearchResult, mockSearchResultWithoutLines } from './fixtures/mock-search.js';

describe('SR-01 契约 · 检索工具参数解析（批次 2：ki_search 注册表）', () => {
  const parseKiSearch = (raw: string): Record<string, unknown> => getChatTool('ki_search')!.parse(raw) as Record<string, unknown>;

  it('limit 超上限 → 钳制到 maxHitsPerCall（不报错）', () => {
    const a = parseKiSearch(JSON.stringify({ query: 'x', limit: 99 }));
    assert.equal(a.limit, CHAT_BUDGET.maxHitsPerCall);
  });

  it('mode 非法 → 回落 hybrid（模型无需懂枚举）', () => {
    const a = parseKiSearch(JSON.stringify({ query: 'x', mode: 'semantic' }));
    assert.equal(a.mode, 'hybrid');
  });

  it('非法 JSON → 抛错（不静默空查询）', () => {
    // ⚠️ 断言必须排除「未实现桩错误」——否则骨架期桩抛错也会让本用例通过（**假绿**）
    assert.throws(
      () => parseKiSearch('{not json'),
      (e: unknown) => e instanceof Error && !e.message.startsWith('STUB:'),
      '应抛解析错误，而非 STUB 未实现错误（后者即假绿）',
    );
  });

  it('缺 query → 抛错', () => {
    assert.throws(
      () => parseKiSearch('{}'),
      (e: unknown) => e instanceof Error && !e.message.startsWith('STUB:'),
      '应抛参数校验错误，而非 STUB 未实现错误（后者即假绿）',
    );
  });
});

describe('SR-01 契约 · 投影（两种，不可混用）', () => {
  it('无命中 → 空投影，不抛错（由 skill 反幻觉规则处理）', () => {
    const p = toToolProjection(mockSearchResult('empty'));
    assert.equal(p.hits.length, 0);
    assert.equal(p.total, 0);
  });

  it('条数不超过 maxHitsPerCall', () => {
    const p = toToolProjection(mockSearchResult('ok'));
    assert.ok(p.hits.length <= CHAT_BUDGET.maxHitsPerCall);
  });

  it('单片段截断至 snippetChars', () => {
    const p = toToolProjection(mockSearchResult('ok'));
    for (const h of p.hits) assert.ok(h.snippet.length <= CHAT_BUDGET.snippetChars);
  });

  it('语义侧降级 → note 透传（不让用户误以为用了语义检索）', () => {
    const p = toToolProjection(mockSearchResult('degraded'));
    assert.match(p.note ?? '', /降级|全文/);
  });

  it('行号缺失 → SourceRef.lineStart = 0（文档级定位，UI 不得显示 0-0）', () => {
    const refs = toSourceRefs(mockSearchResultWithoutLines());
    assert.equal(refs[0]?.lineStart, 0);
  });

  it('sources 摘要截断至 sourceSnippetChars', () => {
    const refs = toSourceRefs(mockSearchResult('ok'));
    for (const r of refs) assert.ok(r.snippet.length <= CHAT_BUDGET.sourceSnippetChars);
  });
});

describe('SR-01 契约 · 检索 skill（与工具 schema 同源）', () => {
  it('system 消息顺序：skill 在前、会话 prompt 在后（反幻觉规则不得被用户 prompt 覆盖）', () => {
    const msgs = buildSystemMessages('你是一个助手');
    assert.ok(msgs.length >= 1);
    assert.match(msgs[0]!.content, /知识库|检索/);
  });

  it('会话 systemPrompt 为空 → 不产生空 system 消息', () => {
    const msgs = buildSystemMessages('');
    assert.ok(msgs.every((m) => m.content.trim().length > 0));
  });

  it('skill 正文包含四条反幻觉规则（N17 依赖）', () => {
    assert.match(RETRIEVAL_SKILL_PROMPT, /知识库中未找到/);
    assert.match(RETRIEVAL_SKILL_PROMPT, /本次未检索/);
  });

  it('工具 schema：不暴露 scope（N23 禁止跨 scope）—— 14 个工具全量校验（批次 2）', () => {
    for (const entry of CHAT_MCP_TOOLS) {
      const props = Object.keys((entry.def.function.parameters as { properties: Record<string, unknown> }).properties ?? {});
      assert.ok(!props.includes('scope'), `${entry.name} 不得暴露 scope 参数`);
    }
    const ki = getChatTool('ki_search')!;
    const props = Object.keys((ki.def.function.parameters as { properties: Record<string, unknown> }).properties);
    assert.deepEqual(props.sort(), ['limit', 'mode', 'query']);
  });
});

describe('SR-01 契约 · 预算常量', () => {
  it('2026-09-30 用户决策取消固定工具轮次上限', () => assert.equal(CHAT_BUDGET.maxToolRounds, Number.POSITIVE_INFINITY));
  it('单次上游请求默认超时 = 300s', () => assert.equal(CHAT_BUDGET.requestTimeoutMs, 300_000));
});
