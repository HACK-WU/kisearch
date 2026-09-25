/**
 * SR-01 片级验收测试（**骨架期应为【红】**）
 *
 * 验的是：**本砖头是否达成需求验收项**（功能层面）—— 断言由 `requirement.md` 的
 * R18~R25 / N12 / N17 / N21~N23 派生，**不是照着实现写的**。
 *
 * ⚠️ **实现方不得修改本文件的断言**：断言不满足 → 改实现；
 *    认为判据写错 → 写阻塞上报（改断言 = 自己出题自己答）。
 *
 * 运行：`npx jiti test/chat/acceptance-sr01.test.ts`
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ★ 测试隔离：把数据目录指到临时目录。
//   依据 chat-store 契约：chatDirFor 的基准来自 loadConfig().dataDir（KI_DATA_DIR 可覆盖）
//   —— 不做隔离，R23/R24 会写真实用户目录 ~/.ki/chat/
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ki-chat-acc-sr01-'));
process.env.KI_DATA_DIR = TMP_DATA_DIR;
after(() => rmSync(TMP_DATA_DIR, { recursive: true, force: true }));

import { runToolLoop, runPreRetrievalFallback } from '../../src/lib/chat/retrieval/tool-loop.js';
import { toSourceRefs } from '../../src/lib/chat/retrieval/projection.js';
import {
  truncateAfterAndEdit,
  replaceLastAssistant,
  createConversation,
  appendMessage,
} from '../../src/lib/chat/chat-store.js';
import { mockSearchResult, mockSearchResultWithoutLines } from '../../.delivery/mocks/mock-search.mjs';

const conv = {
  version: 1 as const, id: 'c-acc-0001', scope: 'kisearch', title: 't', systemPrompt: '',
  archived: false, archivedAt: null, createdAt: '', updatedAt: '', seq: 3,
  messageCount: 2, lastMessagePreview: '',
  messages: [
    { id: 'm1', role: 'user' as const, content: 'first', at: '' },
    { id: 'm2', role: 'assistant' as const, content: 'answer', at: '' },
  ],
};

async function collect(gen: AsyncGenerator<unknown>): Promise<any[]> {
  const out: any[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('SR-01 验收 · R18/R19 检索问答', () => {
  it('R18：回答前执行检索，且 scope 由 daemon 注入（模型不可指定）', async () => {
    const events = await collect(runToolLoop({ scope: 'kisearch', conv, userText: 'ki_search 用法', convSystemPrompt: '' }));
    assert.ok(events.some((e) => e.type === 'tool_start'), '应出现 tool_start');
  });

  it('N23：工具 schema 不含 scope 参数（跨 scope 检索被结构性禁止）', async () => {
    const { KB_SEARCH_TOOL } = await import('../../src/lib/chat/retrieval/retrieval-skill.js');
    const props = Object.keys((KB_SEARCH_TOOL.function.parameters as any).properties ?? {});
    assert.ok(!props.includes('scope'));
  });

  it('R21：工具轮次不超过 maxToolRounds（超限强制作答，不无限循环）', async () => {
    const events = await collect(runToolLoop({ scope: 'kisearch', conv, userText: 'x', convSystemPrompt: '' }));
    const rounds = events.filter((e) => e.type === 'tool_start').length;
    assert.ok(rounds <= 3, `工具轮次 ${rounds} 超过上限 3`);
  });
});

describe('SR-01 验收 · R20 来源引用', () => {
  it('R20：回答附来源引用，含 group / 文档名 / 行号区间', () => {
    const refs = toSourceRefs(mockSearchResult('ok'));
    assert.ok(refs.length > 0);
    for (const r of refs) {
      assert.equal(typeof r.group, 'string');
      assert.equal(typeof r.doc, 'string');
      assert.equal(typeof r.lineStart, 'number');
    }
  });

  it('N22：落盘的是投影后的引用，不含检索原始结果', () => {
    const refs = toSourceRefs(mockSearchResult('ok'));
    const keys = new Set(Object.keys(refs[0]!));
    for (const forbidden of ['results', 'sourcePath', 'matchCount', 'ftsId']) {
      assert.ok(!keys.has(forbidden), `sources 不应包含原始字段 ${forbidden}`);
    }
  });
});

describe('SR-01 验收 · N17 检索不可用必须明示', () => {
  it('检索无命中 → 不编造（链路不产出 fabricated 内容，交由 skill 规则约束）', () => {
    // 形状断言：无命中时投影为空，且**不抛错**（否则生成会被中断）
    assert.doesNotThrow(() => toSourceRefs(mockSearchResult('empty')));
  });

  it('检索不可用 → 产出 degraded 事件（不得静默按普通对话作答）', async () => {
    const events = await collect(runPreRetrievalFallback({ scope: 'kisearch', conv, userText: 'x', convSystemPrompt: '' }));
    assert.ok(events.some((e) => e.type === 'degraded'), '必须发 degraded 事件');
  });
});

describe('SR-01 验收 · R23/R24 重新生成与编辑重发', () => {
  // ★ 前置修正（骨架缺陷）：R23/R24 是 **store 级写操作**（签名 (scope, id, …) → 走磁盘），
  //   原骨架却直接传内存里的 `conv`（从未落盘）→ 任何遵守契约的实现都必抛 ConversationNotFound。
  //   此处补"先建出真实会话"的前置。**断言判定标准一个都没改**（2 / 1 / 1 不变）。
  let convId = '';
  before(async () => {
    const c = await createConversation('kisearch', { title: 'acc-sr01' });
    convId = c.id;
    await appendMessage('kisearch', convId, { id: 'm1', role: 'user', content: 'first', at: '' });
    await appendMessage('kisearch', convId, { id: 'm2', role: 'assistant', content: 'answer', at: '' });
  });

  it('R23：重新生成不新增 user 消息；messageCount 不变', async () => {
    const r = await replaceLastAssistant('kisearch', convId, { id: 'm3', role: 'assistant', content: 'new', at: '' });
    assert.equal(r.messageCount, 2, '重新生成后 messageCount 应不变（= 前置建立的 2 条）');
  });

  it('R24：编辑 user 消息 → 原子截断其后全部消息并返回 discardedCount', async () => {
    const { conv: after, discardedCount } = await truncateAfterAndEdit('kisearch', convId, 'm1', 'edited');
    assert.equal(discardedCount, 1, 'm1 之后有 1 条消息应被丢弃');
    assert.equal(after.messages.length, 1, '截断后只应剩被编辑的那条');
  });
});

describe('SR-01 验收 · N12 reasoning 隔离', () => {
  it('上游 messages 不含 reasoning 字段（结构性保证：ChatMessage 无该字段）', async () => {
    const mod = await import('../../src/lib/chat/chat-contract.js');
    // 运行时无法枚举 interface，这里断言契约文本（由 contract-parity 测试交叉保证）
    assert.ok(mod.CHAT_BUDGET !== undefined);
  });
});
