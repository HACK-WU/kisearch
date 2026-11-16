/**
 * 背景 / 来源**不得进入模型回放**（REQ-20261116-003 · S-01 核心不变量）
 *
 * 背景与来源是这次为"页面回看"新增的落盘字段。它们一旦跟着历史进上游上下文：
 * · 背景最多 2000 字符/轮，逐轮重复会撞穿 `ASK_CONTEXT_MAX_CHARS`（60K）；
 * · 也直接违反「背景只对本轮生效」的既有语义（REQ-20261115-001）。
 *
 * 这条约束**没有任何运行时提示**，只有本文件守着。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/ask-replay-excludes-background.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { replayMessagesForModel } from '../src/lib/chat/ask/ask-runner.js';
import type { AskSessionMessage } from '../src/lib/chat/ask/ask-store.js';

const BG = '项目 kisearch 0.1.0，本机 macOS，启动 daemon 时报 worker not open，已试重启无效。';

function history(): AskSessionMessage[] {
  return [
    { role: 'user', content: '怎么排查 worker not open？', at: '2026-11-16T04:00:00.000Z', background: BG },
    {
      role: 'assistant',
      content: '先看 daemon 日志里的 worker 启动错误。',
      at: '2026-11-16T04:00:00.000Z',
      sources: [{ group: '部署运维', doc: 'daemon', lineStart: 10, lineEnd: 20, snippet: 'worker not open 的三种成因' }],
    },
    { role: 'user', content: '那日志在哪？', at: '2026-11-16T04:02:00.000Z' },
  ];
}

describe('模型回放投影', () => {
  it('只保留 role / content / at 三个字段', () => {
    const out = replayMessagesForModel(history());
    for (const m of out) {
      assert.deepEqual(Object.keys(m).sort(), ['at', 'content', 'role']);
    }
  });

  it('背景与来源原文不出现在回放结果里', () => {
    const json = JSON.stringify(replayMessagesForModel(history()));
    assert.ok(!json.includes('项目 kisearch 0.1.0'), '背景正文泄漏进上下文');
    assert.ok(!json.includes('worker not open 的三种成因'), '来源片段泄漏进上下文');
    assert.ok(!json.includes('"background"'));
    assert.ok(!json.includes('"sources"'));
  });

  it('回放结果的体量与"去掉展示物"的版本逐字节一致', () => {
    const withExtras = JSON.stringify(replayMessagesForModel(history()));
    const plain = JSON.stringify(
      history().map((m) => ({ role: m.role, content: m.content, at: m.at })),
    );
    assert.equal(withExtras, plain);
  });
});
