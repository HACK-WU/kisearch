/**
 * SR-02 片级验收测试（**骨架期应为【红】**）
 *
 * 验的是：**前端行为是否达成需求验收项** —— 断言由 `requirement.md` 的
 * R3 / R8 / R11a / R20 / R25 与 N6 / N17 / N20 派生。
 *
 * ⚠️ 只覆盖**纯逻辑层**（`format.ts` / `chatStore.ts`，无 JSX）——
 *    组件渲染与 SSE 消费需 DOM/网络环境，属实现期验证（见 `slice.md` 的验收表）。
 * ⚠️ 实现方不得修改本文件断言（同 SR-01）。
 *
 * 运行：`npx jiti test/chat/acceptance-sr02.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatLineRange, DEGRADED_LABELS, sourceRefTitle } from '../../web/src/chat/format.js';
import { chatReducer, INITIAL_CHAT_STATE } from '../../web/src/chat/chatStore.js';

describe('SR-02 验收 · R20 来源引用展示', () => {
  it('行号区间正常显示', () => {
    assert.equal(formatLineRange({ lineStart: 12, lineEnd: 18 }), 'L12-18');
    assert.equal(formatLineRange({ lineStart: 12, lineEnd: 12 }), 'L12');
  });

  it('★ lineStart=0（文档级定位）→ 不显示行号，**不得显示 "0-0"**', () => {
    const s = formatLineRange({ lineStart: 0, lineEnd: 0 });
    assert.equal(s, '');
    assert.ok(!s.includes('0-0'));
  });

  it('标题在行号缺失时只显示 group / doc', () => {
    const t = sourceRefTitle({ group: 'g', doc: 'd.md', lineStart: 0, lineEnd: 0, snippet: '' });
    assert.equal(t, 'd.md · g');
  });
});

describe('SR-02 验收 · N17 降级必须可见', () => {
  it('三类降级原因都有用户可见文案（不得静默）', () => {
    for (const r of ['tools-unsupported', 'retrieval-unavailable', 'semantic-degraded'] as const) {
      assert.ok(DEGRADED_LABELS[r] && DEGRADED_LABELS[r].length > 0, `${r} 缺文案`);
    }
  });

  it('"本次未检索"与"未使用工具检索"是不同文案（用户可区分）', () => {
    assert.notEqual(DEGRADED_LABELS['retrieval-unavailable'], DEGRADED_LABELS['tools-unsupported']);
  });
});

describe('SR-02 验收 · R25/N20 隐藏面板不丢内容', () => {
  it('setOpen(false) 不清空 messages 与流式态（关闭 = 隐藏，不卸载）', () => {
    const withContent = {
      ...INITIAL_CHAT_STATE,
      messages: [{ id: 'm1', role: 'user' as const, content: 'hi', at: '' }],
      streaming: { ...INITIAL_CHAT_STATE.streaming, active: true, content: '部分回答' },
    };
    const closed = chatReducer(withContent, { type: 'setOpen', open: false });
    assert.equal(closed.open, false);
    assert.equal(closed.messages.length, 1, '关闭面板不应清空消息');
    assert.equal(closed.streaming.active, true, '关闭面板不应中止生成（N20）');
    assert.equal(closed.streaming.content, '部分回答');
  });

  it('切会话（setActiveConv）才清空当前会话态', () => {
    const withContent = {
      ...INITIAL_CHAT_STATE,
      messages: [{ id: 'm1', role: 'user' as const, content: 'hi', at: '' }],
    };
    const swapped = chatReducer(withContent, { type: 'setActiveConv', convId: 'c-2' });
    assert.equal(swapped.activeConvId, 'c-2');
    assert.equal(swapped.messages.length, 0);
  });
});

describe('SR-02 验收 · R11a 生成中状态（骨架期为红）', () => {
  it('流式内容累积（依赖 useChatStream 实现）', () => {
    const s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm9' });
    assert.equal(s.streaming.active, true);
  });

  it('工具步骤进入 progress（"每一秒都有反馈"）', () => {
    const s = chatReducer(INITIAL_CHAT_STATE, {
      type: 'streamProgress',
      step: { kind: 'tool', phase: 'start', label: '正在检索知识库…' },
    });
    assert.equal(s.streaming.progress.length, 1);
  });
});

describe('SR-02 验收 · N6 中止保留已生成部分（骨架期为红）', () => {
  it('streamEnd 后内容并入 messages 且 streaming 清空', () => {
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm9' });
    s = chatReducer(s, { type: 'streamContent', text: '部分' });
    s = chatReducer(s, { type: 'streamEnd' });
    assert.equal(s.streaming.active, false);
    assert.equal(s.streaming.content, '');
    assert.ok(s.messages.some((m) => m.content.includes('部分')), '已生成部分不得丢弃');
  });
});
