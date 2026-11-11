/**
 * 工具步骤落盘口径（2026-11-11）
 *
 * 锁住四条不变量：
 *   1) `tool_start` 的 `query` / `args` **必须随 progress 落盘** —— 否则刷新/切会话后
 *      入参只剩 `mode`，其余工具连入参区都不渲染（用户无从核对 AI 调了什么）；
 *   2) 长检索词按 `CHAT_PROGRESS_QUERY_MAX` 截断并补 `…`（防单条消息被撑大）；
 *   3) 缺字段时**不产出该键**（旧 daemon / 旧会话的渲染分支靠"键不存在"判断）；
 *   4) `args` 原样透传（已经过 describe 摘要，不再二次改写 —— 生成中与落盘必须同一份）。
 *
 * 运行：`npx jiti test/chat/tool-progress-persist.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_PROGRESS_QUERY_MAX, type ChatEvent } from '../../src/lib/chat/chat-contract.js';
import { toProgressStartStep } from '../../src/lib/chat/chat-routes.js';
import { getChatTool } from '../../src/lib/chat/mcp-tool-registry.js';

type ToolStart = Extract<ChatEvent, { type: 'tool_start' }>;

describe('tool_start → 落盘步骤', () => {
  it('检索类：query / mode / args 全部落盘', () => {
    const ev: ToolStart = { type: 'tool_start', name: 'ki_search', query: '多容器 Pod', mode: 'fulltext' };
    const step = toProgressStartStep(ev, 42);
    assert.equal(step.phase, 'start');
    assert.equal(step.name, 'ki_search');
    assert.equal(step.mode, 'fulltext');
    assert.equal(step.query, '多容器 Pod');
    assert.equal(step.afterChars, 42, 'interleave 锚点必须写入');
  });

  it('非检索类：args（结构化对象）原样落盘，且不带 mode 键', () => {
    const args = { module: 'k8s/x', group: '学习路径', max_chars: 7500 };
    const ev: ToolStart = { type: 'tool_start', name: 'ki_get_module_info', args };
    const step = toProgressStartStep(ev, 0);
    assert.deepEqual(step.args, args);
    // 前端以「mode 键是否存在」判检索类（不显示命中数）—— 不得写成 mode: undefined
    assert.equal(Object.prototype.hasOwnProperty.call(step, 'mode'), false);
  });

  it('超长检索词按 CHAT_PROGRESS_QUERY_MAX 截断并补省略号', () => {
    const long = 'x'.repeat(CHAT_PROGRESS_QUERY_MAX + 80);
    const step = toProgressStartStep({ type: 'tool_start', name: 'ki_search', query: long, mode: 'hybrid' }, 0);
    assert.equal(step.query, `${'x'.repeat(CHAT_PROGRESS_QUERY_MAX)}…`);
    assert.equal((step.query as string).length, CHAT_PROGRESS_QUERY_MAX + 1);
  });

  it('未超长的检索词不被改写（不得无谓加省略号）', () => {
    const exact = 'y'.repeat(CHAT_PROGRESS_QUERY_MAX);
    const step = toProgressStartStep({ type: 'tool_start', name: 'ki_search', query: exact, mode: 'fulltext' }, 0);
    assert.equal(step.query, exact);
  });

  it('截断幂等：已截断的 query 再截断结果不变（流式与落盘必须是同一份值）', () => {
    // tool-loop 在发 tool_start 时先截一次（保证生成中与落盘一致），落盘侧 capProgressQuery 兜底；
    // 若兜底不幂等，界面就会出现 "200 字符 + …" 与 "199 字符 + ……" 两副面孔。
    const long = 'x'.repeat(CHAT_PROGRESS_QUERY_MAX + 80);
    const once = toProgressStartStep({ type: 'tool_start', name: 'ki_search', query: long, mode: 'fulltext' }, 0).query as string;
    const twice = toProgressStartStep({ type: 'tool_start', name: 'ki_search', query: once, mode: 'fulltext' }, 0).query as string;
    assert.equal(twice, once);
    assert.equal(twice.endsWith('…'), true);
    assert.equal(twice.endsWith('……'), false, '不得叠出两个省略号');
  });

  it('缺 query / args 时不产出对应键（旧会话渲染分支依赖"键不存在"）', () => {
    const step = toProgressStartStep({ type: 'tool_start', name: 'ki_scope_list' }, 3);
    assert.equal(Object.prototype.hasOwnProperty.call(step, 'query'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(step, 'args'), false);
    assert.equal(step.afterChars, 3);
  });

  it('与 describe 串起来的真实形状：可直接 JSON 序列化进会话文件', () => {
    const info = getChatTool('ki_get_module_info')!;
    const parsed = info.parse('{"group":"k8s/x","relation":"第 4 课"}');
    const desc = info.describe(parsed);
    const step = toProgressStartStep({ type: 'tool_start', name: 'ki_get_module_info', ...(desc.args ? { args: desc.args } : {}) }, 0);
    const roundTrip = JSON.parse(JSON.stringify(step)) as typeof step;
    assert.deepEqual(roundTrip.args, desc.args, 'JSON 往返后不得丢字段/改类型');
    assert.equal(typeof roundTrip.args?.group, 'string');
  });
});
