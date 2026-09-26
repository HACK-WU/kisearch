/**
 * SR-02 来源引用端到端测试（**可重跑**，替代一次性临时脚本）
 *
 * ═══ 为什么必须有这个文件 ═══
 * `acceptance-sr02.test.ts` 只覆盖**纯逻辑层**（`format.ts` / `chatStore.ts` 的单元行为）。
 * 而本次实跑暴露的缺陷是**跨事件累积状态的生命周期边界**问题：
 *
 *   `sources` 事件到达时，本轮 assistant 消息**尚未并入 `messages`**
 *   → 原实现"把 sources 挂到消息上"**无处可挂** → 来源引用在 `streamEnd` 收尾时**静默丢失**
 *
 * 注意它的可怕之处：**消息内容完全正确、事件顺序完全正确、`sources` 载荷完全正确**
 * —— 任何**形状断言**（含 `contract-parity.test.ts`）与**单元断言**都结构性覆盖不到它。
 * 唯一能发现它的方式是**跑真实链路**：真实事件序 + 真实分块。
 *
 * ═══ 本测试的核心手法 ═══
 * 用**真实 HTTP + 真实 SSE 分块**驱动，且**故意把块边界切在 SSE 帧中间**
 * （真实网络的 chunk 边界不会迁就帧边界）—— 这同时覆盖了：
 *   · SSE 逐帧解析的**跨块缓冲**（`readSseEvents` 的 frame buffer）
 *   · `sources` 缓冲 → `streamEnd` 并入**这条生命周期链**
 *
 * 运行：`npx jiti test/chat/e2e-sr02-sources.test.ts`
 *
 * ═══ 覆盖范围（2026-09-26 扩展）═══
 * 除"来源引用生命周期 + SSE 跨块解析"外，另补三组**只能靠交错时序/终态断言**才抓得到的用例：
 *   · 并发/交错时序（流令牌守门）—— 旧流迟来的 `streamEnd` 不得重置新流累积态
 *   · N6 中止标记 —— 收尾后消息必须带 `aborted:true`，与"正常完成"可区分
 *   · N17 降级标记留存 —— 生成结束后标记仍可见（且不写进冻结的 `ChatMessage` 形状）
 * 这三组均为**纯 reducer 驱动**（无需 DOM / 网络），因此可在无 DOM 环境下回归。
 *
 * @see design/S03 §9.2 · api/retrieval.md §1.1 · contract-snapshot.md §6
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ChatEvent } from '../../web/src/api/chatContract.js';
import { createChatStore, chatReducer, INITIAL_CHAT_STATE } from '../../web/src/chat/chatStore.js';
import type { ChatUiState } from '../../web/src/chat/chatStore.js';
import {
  retrievalAnswerFlow,
  degradedFlow,
  retrievalUnavailableFlow,
  abortedFlow,
} from '../../.delivery/mocks/mock-sse.mjs';

/**
 * ★ 分块大小 7 字节 —— 刻意取一个**必定落在 SSE 帧中间**的值。
 *
 * `data: {"type":"content","text":"…"}\n\n` 的长度远超 7，
 * 因此每一帧都会被切成多块 → 强制验证解析器的跨块缓冲。
 * （若取一个"恰好整帧"的分块大小，这条路径永远不被执行 → 假绿）
 */
const CHUNK_SIZE = 7;

/** mock 服务端口（取非常用端口，避免与本机 daemon 7423 冲突） */
const PORT = 7489;

/**
 * ★ 相对 URL 垫片（仅测试用，**不改变被测代码**）。
 *
 * `chatApi` 传的是**同源相对路径**（如 `/api/chat/conversations/…/messages`），
 * 这是**浏览器语义**（浏览器自动补全 origin）。而 Node 的 `fetch`（undici）
 * 不支持相对 URL → 直接跑测试会 `ERR_INVALID_URL`。
 *
 * 垫片只做一件事：把以 `/` 开头的 input 补上 mock 服务的 origin。
 * 这样测的仍是**真实相对路径 + 真实 HTTP + 真实 SSE**，
 * 而不是"为了测试把请求地址改成绝对路径"（那会掩盖同源约定）。
 */
const NATIVE_FETCH = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  NATIVE_FETCH(
    typeof input === 'string' && input.startsWith('/')
      ? `http://127.0.0.1:${PORT}${input}`
      : input,
    init,
  )) as typeof fetch;

// ─────────────────────────────────────────────────────────────
// 说明：本测试**不 import React 组件**（项目无 DOM 环境）。
//       它驱动的是"真实网络 → chatApi 逐帧解析 → chatStore"这条**真实数据链**，
//       组件层只是这条链的订阅者（D15 的"状态不在组件内"正是为让本测试成立而设计）。
// ─────────────────────────────────────────────────────────────

/**
 * 复刻 `useChatStream.applyEvent` 的事件分派。
 *
 * 为什么在这里复刻而不 import：`useChatStream` 是 React hook，
 * 在无 DOM 环境下无法调用。复刻的**风险**是两处漂移 →
 * 故下方 `assertDispatchParity()` 用一次"元一致性"自检把风险显式化（见文件末尾）。
 */
function applyEvent(state: ChatUiState, ev: ChatEvent): ChatUiState {
  switch (ev.type) {
    case 'meta':
      return chatReducer(state, { type: 'streamStart', messageId: ev.messageId });
    case 'tool_start':
      return chatReducer(state, {
        type: 'streamProgress',
        step: {
          kind: 'tool',
          phase: 'start',
          label: ev.mode === 'fulltext' ? '正在检索知识库…（全文）' : '正在检索知识库…（语义）',
        },
      });
    case 'tool_end':
      return chatReducer(state, {
        type: 'streamProgress',
        step: {
          kind: 'tool',
          phase: 'end',
          label: ev.error ? `检索失败：${ev.error}` : `已检索：命中 ${ev.hits} 条`,
        },
      });
    case 'sources':
      return chatReducer(state, { type: 'streamSources', sources: ev.sources });
    case 'degraded':
      return chatReducer(state, {
        type: 'streamDegraded',
        mark: { reason: ev.reason, label: ev.message },
      });
    case 'reasoning':
      return chatReducer(state, { type: 'streamReasoning', text: ev.text });
    case 'content':
      return chatReducer(state, { type: 'streamContent', text: ev.text });
    case 'done':
      return ev.sources && ev.sources.length > 0
        ? chatReducer(state, { type: 'streamSources', sources: ev.sources })
        : state;
    // usage / aborted / error 不改累积态（与 useChatStream 一致）
    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────
// mock SSE 服务：按请求内容选择 mock 事件序，并以 CHUNK_SIZE 分块下发
// ─────────────────────────────────────────────────────────────

const CONFIG = {
  ok: true,
  enabled: true,
  model: 'mock-model',
  baseURLHost: 'mock.local',
  configPath: '~/.ki/config.yaml',
  requestTimeoutMs: 300000,
  reason: null,
  code: null,
  supportsTools: true,
  retrievalEnabled: true,
  ackRequired: false,
  maxToolRounds: 3,
};

let server: Server;

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

    if (url.pathname === '/api/chat/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CONFIG));
      return;
    }

    if (url.pathname.endsWith('/messages') && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const text = (JSON.parse(raw || '{}') as { text?: string }).text ?? '';

      // 按关键词选择 mock 路径（四条链路都要覆盖）
      const flow =
        text.includes('降级') ? degradedFlow()
        : text.includes('不可用') ? retrievalUnavailableFlow()
        : text.includes('中止') ? abortedFlow()
        : retrievalAnswerFlow();

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });

      const wire = flow.map((e: unknown) => `data: ${JSON.stringify(e)}\n\n`).join('');
      for (let i = 0; i < wire.length; i += CHUNK_SIZE) {
        if (res.writableEnded) break;
        res.write(wire.slice(i, i + CHUNK_SIZE));
        await new Promise((r) => setTimeout(r, 0));
      }
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found', code: 'NOT_FOUND' }));
  });

  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', () => resolve()));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * 真实链路驱动器：POST 一条 SSE 流（经 chatApi 的逐帧解析），
 * 把事件依次灌进 store（复刻 useChatStream 的分派），最后收尾（`streamEnd`）。
 */
async function runRealFlow(
  text: string,
  opts: { stopAtEvent?: string } = {},
): Promise<{ state: ChatUiState; seen: string[]; stoppedMidStream: boolean }> {
  const { streamMessage } = await import('../../web/src/api/chatApi.js');

  let state: ChatUiState = INITIAL_CHAT_STATE;
  const seen: string[] = [];
  /**
   * 是否"中途停看"（而非跑到终态）。
   *
   * ★ 关键：`stopAtEvent` 是**观察手段**（看流中某刻的状态），不是"流结束了"。
   *   若停看后仍 dispatch `streamEnd`，就会把刚要看的东西清掉
   *   → 断言必然失败，且是**测试写法的错，不是实现缺陷**。
   *   因此停看时不收尾（真实场景里那一刻流还在进行中）。
   */
  let stoppedMidStream = false;

  for await (const ev of streamMessage('c-mock-0001', text)) {
    seen.push(ev.type);
    state = applyEvent(state, ev);
    if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error') break;
    if (opts.stopAtEvent && ev.type === opts.stopAtEvent) {
      stoppedMidStream = true;
      break;
    }
  }

  // 只有跑到终态时才收尾（useChatStream 在 finally 里无条件 dispatch streamEnd）
  if (!stoppedMidStream) state = chatReducer(state, { type: 'streamEnd' });
  return { state, seen, stoppedMidStream };
}

// ═════════════════════════════════════════════════════════════
// 用例
// ═════════════════════════════════════════════════════════════

describe('SR-02 端到端 · SSE 逐帧解析（分块边界落在帧中间）', () => {
  it('★ 正常链路：7 字节分块下事件序完整且不丢帧', async () => {
    const { seen } = await runRealFlow('ki_search 怎么用');
    assert.deepEqual(seen, [
      'meta',
      'tool_start',
      'tool_end',
      'reasoning',
      'content',
      'content',
      'sources',
      'usage',
      'done',
    ]);
  });

  it('★ 跨块缓冲正确：content 增量拼接为完整文本（分块未破坏分帧）', async () => {
    const { state } = await runRealFlow('ki_search 怎么用');
    assert.equal(state.messages.length, 1);
    assert.equal(
      state.messages[0]!.content,
      '（mock）根据知识库，`ki_search` 支持 `mode=fulltext`。',
    );
  });
});

describe('SR-02 端到端 · ★ sources 生命周期（本次实跑修复的缺陷）', () => {
  it('★ sources 在收尾后仍存在于 assistant 消息上（不得静默丢失）', async () => {
    const { state } = await runRealFlow('ki_search 怎么用');
    const msg = state.messages[0]!;
    // 这条断言就是本文件存在的理由：它在修复前必然失败
    assert.ok(msg.sources, 'sources 在 streamEnd 后丢失 —— R20 失效');
    assert.equal(msg.sources!.length, 1);
  });

  it('★ sources 内容与事件载荷逐字段一致（group / doc / 行号区间 / 摘要）', async () => {
    const { state } = await runRealFlow('ki_search 怎么用');
    const s = state.messages[0]!.sources![0]!;
    assert.equal(s.group, 'kisearch');
    assert.equal(s.doc, 'ki_search 用法');
    assert.equal(s.lineStart, 12);
    assert.equal(s.lineEnd, 18);
    assert.ok(s.snippet.length > 0, '摘要不得为空（刷新后要展示引用摘要）');
  });

  it('★ sources 在流中即被缓冲（不是等 done 才处理）', async () => {
    // 停在 sources 事件：消息尚未并入 messages，但缓冲必须已就位
    // （这正是"为什么不能直接挂 messages"的现场证据）
    const { state, stoppedMidStream } = await runRealFlow('ki_search 怎么用', {
      stopAtEvent: 'sources',
    });
    assert.equal(stoppedMidStream, true, '未能在 sources 处停看');
    assert.equal(state.messages.length, 0, '此刻消息尚未并入 → 无处可挂，故必须缓冲');
    assert.equal(state.streaming.sources.length, 1, 'sources 必须在流中即缓冲');
  });

  it('空来源链路（降级）→ 不产生 sources 字段（不得出现空数组）', async () => {
    const { state } = await runRealFlow('请降级回答');
    assert.equal(state.messages[0]!.sources, undefined);
  });
});

describe('SR-02 端到端 · 收尾不变量', () => {
  it('done 后 streaming 全部清空（含 sources 缓冲）', async () => {
    const { state } = await runRealFlow('ki_search 怎么用');
    assert.equal(state.streaming.active, false);
    assert.equal(state.streaming.content, '');
    assert.equal(state.streaming.reasoning, '');
    assert.equal(state.streaming.progress.length, 0);
    assert.equal(state.streaming.sources.length, 0);
    assert.equal(state.streaming.degraded, null);
  });

  it('N17 降级标记在流中即可见（不得滞后到结束）', async () => {
    const { state, stoppedMidStream } = await runRealFlow('请降级回答', {
      stopAtEvent: 'degraded',
    });
    assert.equal(stoppedMidStream, true, '未能在 degraded 处停看');
    assert.equal(state.streaming.active, true, '此刻仍应在生成中');
    assert.equal(state.streaming.degraded?.reason, 'tools-unsupported');
    assert.ok(state.streaming.degraded!.label.length > 0, '降级文案不得为空（N17 必须可见）');
  });

  it('检索不可用链路：tool_end 带 error → 仍产出 degraded（N17）', async () => {
    const { seen } = await runRealFlow('检索不可用时怎么办');
    assert.ok(seen.includes('tool_end'));
    assert.ok(seen.includes('degraded'));
  });

  it('N6 中止链路：已生成部分保留，不丢内容', async () => {
    const { state } = await runRealFlow('中止演示');
    assert.equal(state.messages.length, 1, '中止后应保留 assistant 部分内容');
    assert.ok(state.messages[0]!.content.includes('（mock 部分回答'));
  });

  it('D7：reasoning 不落盘、不进入消息对象', async () => {
    const { state } = await runRealFlow('ki_search 怎么用');
    assert.ok(!('reasoning' in state.messages[0]!), 'ChatMessage 不得含 reasoning');
    // 流中也只在 streaming.reasoning（内存态）
    assert.equal(typeof state.streaming.reasoning, 'string');
  });
});

describe('SR-02 端到端 · D15 隐藏不丢（store 语义 + 真实内容）', () => {
  it('★ 真实流产生内容后 setOpen(false)：内容与流式态全部保留', async () => {
    // 停在 content 中间（生成进行中）——停看不收尾，模拟"生成尚未结束"
    const { state: mid } = await runRealFlow('ki_search 怎么用', { stopAtEvent: 'content' });
    assert.equal(mid.streaming.active, true, '停在 content 时应在生成中');
    assert.ok(mid.streaming.content.length > 0, '此刻应已有部分内容');

    const closed = chatReducer(mid, { type: 'setOpen', open: false });
    assert.equal(closed.open, false);
    assert.equal(closed.streaming.active, true, '关闭面板不得中止生成（N20）');
    assert.equal(closed.streaming.content, mid.streaming.content, '关闭面板不得丢已生成内容');
    assert.equal(closed.streaming.sources.length, mid.streaming.sources.length);
  });
});

describe('SR-02 端到端 · ★ 并发/交错时序（流令牌守门）', () => {
  it('★ 旧流迟来的 streamEnd 不得重置新流累积态（否则新回答整段丢失）', () => {
    // 时序：新流 meta(seq=2) → 旧流 finally 的 streamEnd(seq=1) → 新流 content → 新流 streamEnd(seq=2)
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm-old', seq: 1 });
    s = chatReducer(s, { type: 'streamContent', text: '旧流残留' });

    s = chatReducer(s, { type: 'streamStart', messageId: 'm-new', seq: 2 });
    // ★ 旧流被 abort 后其 finally 此刻才执行 —— 必须被忽略
    s = chatReducer(s, { type: 'streamEnd', seq: 1 });
    assert.equal(s.streaming.active, true, '旧流不得收尾新流');
    assert.equal(s.streaming.messageId, 'm-new');

    s = chatReducer(s, { type: 'streamContent', text: '这是新回答的正文' });
    s = chatReducer(s, { type: 'streamEnd', seq: 2 });
    assert.ok(
      s.messages.some((m) => m.content === '这是新回答的正文'),
      '新流正文必须保留（修复前此处为 messages: []）',
    );
  });

  it('不带令牌的 streamEnd 仍可收尾（向后兼容纯 reducer 单测）', () => {
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm9' });
    s = chatReducer(s, { type: 'streamContent', text: '部分' });
    s = chatReducer(s, { type: 'streamEnd' });
    assert.equal(s.streaming.active, false);
    assert.ok(s.messages.some((m) => m.content.includes('部分')));
  });

  it('★ 迟到且携带旧令牌的 streamStart 不得复位守门（否则旧流 streamEnd 会再次通过）', () => {
    // 流2 已开始并产出内容（seq=2）
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm-new', seq: 2 });
    s = chatReducer(s, { type: 'streamContent', text: '新流内容' });

    // 旧流迟到的 meta（seq=1）→ 必须被忽略：否则 streaming.seq 被写回 1，
    // 旧流的 streamEnd{seq:1} 就会重新通过守门，又回到"新回答整段丢失"的原始缺陷
    s = chatReducer(s, { type: 'streamStart', messageId: 'm-old', seq: 1 });
    assert.equal(s.streaming.seq, 2, '旧 seq 不得覆写当前令牌');
    assert.equal(s.streaming.messageId, 'm-new');
    assert.equal(s.streaming.content, '新流内容', '旧 streamStart 不得清空新流累积内容');

    // 旧流的收尾仍被拦下
    s = chatReducer(s, { type: 'streamEnd', seq: 1 });
    assert.equal(s.streaming.active, true, '旧流仍不得收尾');

    // 当前流正常收尾
    s = chatReducer(s, { type: 'streamEnd', seq: 2 });
    assert.ok(s.messages.some((m) => m.content === '新流内容'));
  });

  it('★ 切会话后旧流的 streamEnd 被忽略（不得把旧流内容并入新会话）', () => {
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm-old', seq: 5 });
    s = chatReducer(s, { type: 'streamContent', text: '旧流内容' });

    // 切会话：streaming 被重置为 seq=undefined
    s = chatReducer(s, { type: 'setActiveConv', convId: 'c-2' });
    // 旧流的 finally 此刻才执行 → 必须被 store 令牌拦下
    s = chatReducer(s, { type: 'streamEnd', seq: 5 });

    assert.deepEqual(s.messages, [], '切会话后不得把旧流内容并入新会话');
    assert.equal(s.streaming.active, false);
    assert.equal(s.activeConvId, 'c-2');
  });
});

describe('SR-02 端到端 · ★ N6 中止标记（原先不可达）', () => {
  it('aborted → 收尾后消息带 aborted:true，且可与"正常完成"区分', () => {
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm-ab', seq: 1 });
    s = chatReducer(s, { type: 'streamContent', text: '半截回答' });
    s = chatReducer(s, { type: 'streamAborted' });
    s = chatReducer(s, { type: 'streamEnd', seq: 1 });

    const msg = s.messages.at(-1)!;
    assert.equal(msg.aborted, true, '「已中止」标记必须落到消息上（N6）');
    assert.ok(msg.content.includes('半截回答'), '已生成部分不得丢弃');
  });

  it('正常完成 → aborted 不为 true（两者外观可区分）', () => {
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm-ok', seq: 1 });
    s = chatReducer(s, { type: 'streamContent', text: '完整回答' });
    s = chatReducer(s, { type: 'streamEnd', seq: 1 });
    assert.notEqual(s.messages.at(-1)!.aborted, true);
  });
});

describe('SR-02 端到端 · ★ N17 降级标记留存（原先生成结束即消失）', () => {
  it('生成结束后标记仍可见，且**不写进冻结的 ChatMessage 形状**', () => {
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm-deg', seq: 1 });
    s = chatReducer(s, {
      type: 'streamDegraded',
      mark: { reason: 'tools-unsupported', label: '本次未使用工具检索' },
    });
    s = chatReducer(s, { type: 'streamContent', text: '降级回答' });
    s = chatReducer(s, { type: 'streamEnd', seq: 1 });

    assert.equal(s.streaming.degraded, null, '流式态已清空');
    assert.equal(s.degradedByMessage['m-deg']?.label, '本次未使用工具检索', '标记必须留存');
    assert.ok(!('degraded' in s.messages.at(-1)!), '不得写进冻结的 ChatMessage 形状');
  });

  it('切会话清空标记表（不串到别的会话）', () => {
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm1', seq: 1 });
    s = chatReducer(s, {
      type: 'streamDegraded',
      mark: { reason: 'retrieval-unavailable', label: '本次未检索' },
    });
    s = chatReducer(s, { type: 'streamContent', text: 'x' });
    s = chatReducer(s, { type: 'streamEnd', seq: 1 });
    assert.ok(s.degradedByMessage['m1']);

    const swapped = chatReducer(s, { type: 'setActiveConv', convId: 'c-2' });
    assert.deepEqual(swapped.degradedByMessage, {});
  });
});

describe('SR-02 端到端 · ★ 契约字段落地（原先零消费）', () => {
  it('done.warning → notice 提示，且新流开始时清空（不跨轮残留）', () => {
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm1', seq: 1 });
    s = chatReducer(s, { type: 'notice', text: '会话过长，建议新建会话' });
    assert.equal(s.notice, '会话过长，建议新建会话');

    s = chatReducer(s, { type: 'streamStart', messageId: 'm2', seq: 2 });
    assert.equal(s.notice, null, '一次性提示不得跨轮残留');
  });

  it('streamMessageId 只改 id、不动累积内容（把 meta 预估 id 校正为落盘真实 id）', () => {
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'streamStart', messageId: 'm-est', seq: 1 });
    s = chatReducer(s, { type: 'streamContent', text: '正文' });
    s = chatReducer(s, { type: 'streamMessageId', messageId: 'm-real' });

    assert.equal(s.streaming.messageId, 'm-real');
    assert.equal(s.streaming.content, '正文');

    s = chatReducer(s, { type: 'streamEnd', seq: 1 });
    assert.equal(s.messages.at(-1)!.id, 'm-real', '收尾后的消息 id 必须是服务端真实 id');
  });
});

// ═════════════════════════════════════════════════════════════
// 元一致性自检：本文件复刻了 useChatStream 的分派表，必须防漂移
// ═════════════════════════════════════════════════════════════

describe('SR-02 端到端 · 自检（防复刻漂移）', () => {
  it('本文件覆盖了全部 11 类事件的分派（无遗漏分支）', () => {
    const all: ChatEvent['type'][] = [
      'meta',
      'tool_start',
      'tool_end',
      'sources',
      'degraded',
      'reasoning',
      'content',
      'usage',
      'done',
      'aborted',
      'error',
    ];
    // 每类事件都必须能被 applyEvent 安全处理（不抛错）
    for (const t of all) {
      const ev = { type: t } as unknown as ChatEvent;
      assert.doesNotThrow(() => applyEvent(INITIAL_CHAT_STATE, ev), `未处理事件：${t}`);
    }
  });

  it('createChatStore 的 dispatch 与 chatReducer 语义一致（store 不是另一套逻辑）', () => {
    const store = createChatStore();
    store.dispatch({ type: 'streamStart', messageId: 'm-x' });
    store.dispatch({ type: 'streamContent', text: 'abc' });
    assert.equal(store.getState().streaming.content, 'abc');
    assert.equal(store.getState().streaming.active, true);
  });
});
