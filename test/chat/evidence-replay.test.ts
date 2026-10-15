/**
 * 历史证据回放单测（REQ-20261015-001 · S-02）
 *
 * 锁住六条不变量（对应设计 S-02 §3.1 的 6 步算法与 §9 验证标准）：
 *   ① 切轮：assistant 的工具证据归属其**前面**那条 user 开启的轮次
 *   ② 只收 `phase === 'end'` 且 `kind !== 'skill'` 且有 `response.text` 的工具步骤
 *   ③ 本轮（最后一条 user）**不参与回放** —— 引用块由 renderRefsBlock 单独附加
 *   ④ 两级去重：历史引用之间保留最早；再与本轮引用比对剔除
 *   ⑤ 双预算：轮数（最近 N 轮）+ 字符总量（从新到旧累加、同轮内自后向前、超限截断当前条并停止）
 *   ⑥ **无证据零变化**：`renderEvidenceBlock` 返回 null，`withEvidenceBlock` 原样返回
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/evidence-replay.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_BUDGET } from '../../src/lib/chat/chat-contract.js';
import {
  DEFAULT_REPLAY_BUDGET,
  collectReplayItems,
  renderEvidenceBlock,
  withEvidenceBlock,
  type ReplayMessageLike,
  type ReplayRefLike,
  type ReplayStepLike,
} from '../../src/lib/chat/retrieval/replay.js';

// ── 构造 helper ────────────────────────────────────────────────

const user = (content: string, refs?: ReplayRefLike[]): ReplayMessageLike =>
  refs ? { role: 'user', content, refs } : { role: 'user', content };

const assistant = (progress?: ReplayStepLike[]): ReplayMessageLike =>
  progress ? { role: 'assistant', content: '答复', progress } : { role: 'assistant', content: '答复' };

const toolStart = (name: string): ReplayStepLike => ({ phase: 'start', kind: 'tool', name });
const toolEnd = (name: string, text: string, extra: Partial<ReplayStepLike> = {}): ReplayStepLike =>
  ({ phase: 'end', kind: 'tool', name, response: { text }, ...extra });

const ref = (group: string, doc: string, text: string): ReplayRefLike => ({ group, doc, text });

/** 造一轮：user（可带 refs）+ assistant（可带 progress）；本轮 user 无 refs 且 assistant 无 progress */
const turnOf = (refs?: ReplayRefLike[], progress?: ReplayStepLike[]): ReplayMessageLike[] => [
  user('问题', refs),
  assistant(progress),
];

// ─────────────────────────────────────────────────────────────

describe('证据回放 · 预算常量', () => {
  it('默认预算与 CHAT_BUDGET 同源（5 轮 / 10000 字符，实测校准值）', () => {
    assert.equal(DEFAULT_REPLAY_BUDGET.turns, CHAT_BUDGET.replayTurns);
    assert.equal(DEFAULT_REPLAY_BUDGET.chars, CHAT_BUDGET.replayMaxChars);
    assert.equal(DEFAULT_REPLAY_BUDGET.turns, 5);
    assert.equal(DEFAULT_REPLAY_BUDGET.chars, 10000);
  });
});

describe('证据回放 · 收集（切轮 / 归属 / 过滤）', () => {
  it('无历史证据 → 空数组（新会话零变化）', () => {
    const conv = { messages: [user('你好')] };
    assert.deepEqual(collectReplayItems(conv), []);
  });

  it('工具证据归属其前面的 user 轮次，且只用 end 条（start 被忽略）', () => {
    const conv = {
      messages: [
        ...turnOf(undefined, [toolStart('ki_search'), toolEnd('ki_search', '命中正文', { hits: 3 })]),
        user('追问'),
      ],
    };
    const items = collectReplayItems(conv);
    assert.equal(items.length, 1, 'start 不应产生条目');
    assert.equal(items[0].turn, 1);
    assert.equal(items[0].kind, 'tool');
    assert.equal(items[0].label, 'ki_search');
    assert.equal(items[0].text, '命中正文');
    assert.equal(items[0].hits, 3);
  });

  it('skill 步骤不参与回放（其正文由 loadedSkillBlocks 每轮重放）', () => {
    const conv = {
      messages: [
        ...turnOf(undefined, [
          { phase: 'end', kind: 'skill', name: 'builtin-retrieval', response: { text: 'skill 正文' } },
        ]),
        user('追问'),
      ],
    };
    assert.deepEqual(collectReplayItems(conv), []);
  });

  it('缺 response / 空 text 的工具步骤被跳过（旧记录兼容，零报错）', () => {
    const conv = {
      messages: [
        ...turnOf(undefined, [
          { phase: 'end', kind: 'tool', name: 'ki_search' },
          { phase: 'end', kind: 'tool', name: 'ki_search', response: { text: '' } },
        ]),
        user('追问'),
      ],
    };
    assert.deepEqual(collectReplayItems(conv), []);
  });

  it('**失败**步骤的响应不进入证据块（挑战 #1：历史错误不是可复用证据）', () => {
    const conv = {
      messages: [
        ...turnOf(undefined, [
          toolEnd('ki_search', '正常片段'),
          // 工具执行失败：progress 同样带 response（形如 {"error":...}）
          { phase: 'end' as const, kind: 'tool' as const, name: 'ki_search', error: '检索超时', response: { text: '{"error":"检索超时"}' } },
          // 模型幻觉出的未知工具：错误提示同样落 progress
          { phase: 'end' as const, kind: 'tool' as const, name: 'ghost_tool', error: '未知工具 ghost_tool', response: { text: '{"error":"未知工具"}' } },
        ]),
        user('本轮'),
      ],
    };
    const items = collectReplayItems(conv);
    assert.equal(items.length, 1, '只应保留成功的那一条');
    assert.equal(items[0].text, '正常片段');
  });

  it('truncated 透传（渲染时标注"当时已截断"）', () => {
    const conv = {
      messages: [
        ...turnOf(undefined, [toolEnd('ki_get_module_info', '半截 JSON', { response: { text: '半截 JSON', truncated: true } })]),
        user('追问'),
      ],
    };
    const items = collectReplayItems(conv);
    assert.equal(items[0].truncated, true);
  });

  it('**本轮不参与回放**（最后一条 user 及其后的 assistant 都被排除）', () => {
    const conv = {
      messages: [
        ...turnOf(undefined, [toolEnd('ki_search', '第 1 轮正文')]),
        ...turnOf(undefined, [toolEnd('ki_search', '本轮正文')]),
      ],
    };
    // 第 2 轮（totalTurns=2）是本轮 ⇒ 只剩第 1 轮
    const items = collectReplayItems(conv);
    assert.equal(items.length, 1);
    assert.equal(items[0].text, '第 1 轮正文');
    assert.equal(items[0].turn, 1);
  });
});

describe('证据回放 · 两级去重', () => {
  it('历史引用之间按 (group, doc, text) 去重，保留**最早**出现的轮次', () => {
    const r = ref('wiki', 'k8s.md', '同一段原文');
    const conv = {
      messages: [
        ...turnOf([r]),
        ...turnOf([r]), // 第 2 轮又引用同一份（前端 pendingRefs 持续携带的常见形态）
        user('追问'),
      ],
    };
    const items = collectReplayItems(conv);
    assert.equal(items.length, 1);
    assert.equal(items[0].turn, 1, '应保留最早引入的轮次');
  });

  it('与本轮引用重复的历史引用被剔除（同片段不得在一条 user 消息出现两次）', () => {
    const r = ref('wiki', 'k8s.md', '本轮也引用了这段');
    const conv = {
      messages: [
        ...turnOf([r]),
        user('追问', [r]), // 本轮引用同一份 → 已由 renderRefsBlock 附加 ⇒ 历史那份应剔除
      ],
    };
    // ⚠️ messages = [u1, a1, u2] —— 本轮 user 是 messages[2]
    assert.deepEqual(collectReplayItems(conv, undefined, conv.messages[2].refs), []);
  });

  it('本轮引用了 B 时，历史里的 A 仍照常回放', () => {
    const a = ref('wiki', 'a.md', 'A 段');
    const b = ref('wiki', 'b.md', 'B 段');
    const conv = {
      messages: [
        ...turnOf([a]),
        user('追问', [b]),
      ],
    };
    const items = collectReplayItems(conv, undefined, [b]);
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'a.md');
  });
});

describe('证据回放 · 双预算裁剪', () => {
  it('轮数预算：只回放最近 N 轮（更旧的整轮丢弃）', () => {
    const messages: ReplayMessageLike[] = [];
    for (let i = 1; i <= 8; i += 1) {
      messages.push(...turnOf(undefined, [toolEnd('ki_search', `第 ${i} 轮正文`)]));
    }
    messages.push(user('本轮追问')); // 第 9 轮 = 本轮
    const items = collectReplayItems({ messages }, { turns: 3, chars: 10000 });
    // 最近 3 轮（含本轮）= 第 7/8/9 轮；排除本轮 9 ⇒ 只剩 7、8
    assert.deepEqual(items.map((i) => i.turn), [7, 8]);
  });

  it('字符预算：从新到旧保留，超限时**截断当前条**并停止累加更旧项', () => {
    const conv = {
      messages: [
        ...turnOf(undefined, [toolEnd('ki_search', 'A'.repeat(60))]), // 第 1 轮（旧）
        ...turnOf(undefined, [toolEnd('ki_search', 'B'.repeat(60))]), // 第 2 轮（新）
        user('本轮'),
      ],
    };
    const items = collectReplayItems(conv, { turns: 5, chars: 80 });
    // 新的（B=60）先入，剩 20 → 旧的 A 被截断（保留 20 - marker 长度 后 + 标记）
    assert.equal(items.length, 2);
    assert.equal(items[0].turn, 1, '输出按轮次升序');
    assert.ok(items[0].text.endsWith('已按回放预算截断）'), '截断条需带标记');
    assert.equal(items[1].text, 'B'.repeat(60), '新证据保持完整');
  });

  it('同轮内多条：自后向前保留（较晚产生的证据优先）', () => {
    const conv = {
      messages: [
        ...turnOf(undefined, [
          toolEnd('ki_search', '早'),
          toolEnd('ki_get_module_info', '晚'),
        ]),
        user('本轮'),
      ],
    };
    const items = collectReplayItems(conv, { turns: 5, chars: 10000 });
    // 输出升序 ⇒ 轮内恢复为"自前向后"：早 → 晚
    assert.deepEqual(items.map((i) => i.label), ['ki_search', 'ki_get_module_info']);
  });
});

describe('证据回放 · 渲染与附加', () => {
  it('无条目 → null / 原样返回（逐字节零变化）', () => {
    assert.equal(renderEvidenceBlock([]), null);
    assert.equal(withEvidenceBlock('本轮问题', []), '本轮问题');
  });

  it('块头含三条判据；条目标注「更早第 N 次提问」与轮次内类别', () => {
    const conv = {
      messages: [
        ...turnOf([ref('wiki', 'k8s.md', '引用原文')], [toolEnd('ki_search', '检索正文', { hits: 5, response: { text: '检索正文', truncated: true } })]),
        user('本轮'),
      ],
    };
    const block = renderEvidenceBlock(collectReplayItems(conv));
    assert.ok(block);
    assert.match(block, /不要为确认而重复检索相同内容/);
    assert.match(block, /不是用户本轮的新输入/);
    assert.match(block, /\[更早第 1 次提问 · 用户引用\] 《k8s\.md》/);
    assert.match(block, /\[更早第 1 次提问 · ki_search 命中 5 条\]（当时已截断）/);
    assert.ok(block.includes('引用原文') && block.includes('检索正文'));
  });

  it('截断时剩余空间连标记都放不下 → 整条丢弃（**不超预算**）', () => {
    const conv = {
      messages: [
        ...turnOf(undefined, [toolEnd('ki_search', 'A'.repeat(60))]),
        ...turnOf(undefined, [toolEnd('ki_search', 'B'.repeat(60))]),
        user('本轮'),
      ],
    };
    // 预算 65：新的 B=60 先入，剩 5 —— 旧条 A 的标记（11 码点）放不下 ⇒ 丢弃 A
    const items = collectReplayItems(conv, { turns: 5, chars: 65 });
    assert.equal(items.length, 1);
    assert.equal(items[0].text, 'B'.repeat(60));
    const total = items.reduce((n, i) => n + Array.from(i.text).length, 0);
    assert.ok(total <= 65, `总量 ${total} 不得超过预算`);
  });

  it('emoji（代理对）按**码点**计数，不切代理对（与 serializeToolResponse 同口径）', () => {
    const conv = {
      messages: [
        ...turnOf(undefined, [toolEnd('ki_search', '😀'.repeat(30))]),
        ...turnOf(undefined, [toolEnd('ki_search', 'B'.repeat(60))]),
        user('本轮'),
      ],
    };
    const items = collectReplayItems(conv, { turns: 5, chars: 80 });
    const emoji = items[0];
    assert.ok(emoji.text.endsWith('已按回放预算截断）'));
    assert.equal(Array.from(emoji.text).length, 20, '9 码点正文 + 11 码点标记');
    assert.equal(emoji.text.includes('\uFFFD'), false, '不得切出半个代理对');
  });

  it('脏结构不抛错（messages 非数组 / progress 非数组）—— 与 tool-loop 的 try/catch 双保险', () => {
    assert.deepEqual(collectReplayItems({ messages: null as unknown as never[] }), []);
    assert.deepEqual(collectReplayItems({} as never), []);
    assert.deepEqual(
      collectReplayItems({ messages: [{ role: 'user', progress: null as unknown as never[] }] }),
      [],
    );
  });

  it('附加结果 = 原内容 + 分隔线 + 证据块（且不改动原内容）', () => {
    const conv = { messages: [...turnOf(undefined, [toolEnd('ki_search', '正文')]), user('本轮')] };
    const out = withEvidenceBlock('本轮问题', collectReplayItems(conv));
    assert.ok(out.startsWith('本轮问题\n\n---\n【本会话更早轮次已获取的知识库证据】'));
  });
});
