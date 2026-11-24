/**
 * analysis-ask-cancel.test.ts —— 追问「停止」（2026-11-24）
 *
 * 锁住的不变量：
 *   1) 停止真的中断上游：abort 信号送达、不再继续下一轮；
 *   2) 已生成内容保留：有正文时**照常落库**成正式记录（同分析 partial 语义），
 *      但**不记**「追问完成/失败」徽标 —— 那是用户自己刚做的动作；
 *   3) 一字未生成时抛 `ANALYSIS_ASK_CANCELED`（不是 `ANALYSIS_ASK_TIMEOUT`，
 *      否则前端会显示"回答超时，请重试"，把主动停止说成故障）；
 *   4) 幂等：没有在跑的轮次返回 false，不报错；
 *   5) 运行态与「追问中」标记在所有出口都被清掉（否则页面永远显示"正在追答"）。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-ask-cancel.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { registerTestScope, cleanupTestConfig } from '../test-config.js';
import { initScope } from '../../src/lib/store.js';
import { getKbDir } from '../../src/lib/scope.js';
import { createEvent } from '../../src/lib/events/event-service.js';
import { writeDraftStart } from '../../src/lib/events/analysis-store.js';
import {
  askEventAnalysis,
  cancelEventAsk,
  listActiveAskIds,
  listFinishedAsks,
} from '../../src/lib/events/analysis-ask-runner.js';
import { readAskDoc, readAskRunning } from '../../src/lib/events/analysis-ask-store.js';
import type { GovernanceError } from '../../src/lib/governance-errors.js';

const scope = `ana-ask-cancel-${Date.now()}`;

before(() => {
  registerTestScope(scope);
  initScope(scope);
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

const cfg = {
  llm: { baseURL: 'http://127.0.0.1:1', apiKey: 'k', model: 'm' },
  _configPath: '/tmp/ki-ask-cancel-cfg.json',
} as never;

const okLlm = { enabled: true, ackRequired: false, supportsTools: true } as never;

async function seedDraft(eventId: string): Promise<void> {
  await writeDraftStart(scope, eventId, {
    runId: 'run_1',
    status: 'ready',
    targetDir: '/tmp/repo',
    commit: 'abc1234',
    conclusion: '根因是 token 为空未兜底',
    candidates: [],
    unconfirmed: [],
    steps: [],
    stats: { turns: 1, filesRead: 0, tokens: 0, ms: 1 },
    startedAt: Date.now() - 5_000,
    updatedAt: Date.now() - 5_000,
  });
}

/** 等到「已经进入上游等待点」再返回，测试据此在正确的时刻发停止请求 */
function gate(): { reached: Promise<void>; open: () => void } {
  let open!: () => void;
  const reached = new Promise<void>((resolve) => { open = resolve; });
  return { reached, open };
}

/** 停在等 abort 的流：收到 abort 后按真实上游的行为抛错 */
async function* waitForAbort(signal: AbortSignal): AsyncGenerator<{ type: string; text?: string }> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  throw new Error('aborted by user');
}

describe('停止追问', () => {
  it('① 有半截内容：abort 生效、内容照样落库，但不记「追问完成」徽标', async () => {
    const ev = await createEvent(scope, { title: '停止保留内容', typeId: 'et_1' });
    await seedDraft(ev.id);
    const g = gate();

    async function* slowStream(signal: AbortSignal): AsyncGenerator<{ type: string; text?: string }> {
      yield { type: 'content', text: '半截答案。' };
      g.open();
      yield* waitForAbort(signal);
    }

    const running = askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '为什么？',
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: () => okLlm,
        streamChatFn: slowStream as never,
      },
    });

    await g.reached;
    assert.equal(cancelEventAsk(scope, ev.id), true, '运行中停止必须返回 true');
    const res = await running;

    assert.equal(res.turn.answer, '半截答案。', '已生成的部分必须保留（同分析 partial 语义）');
    assert.equal(readAskDoc(scope, ev.id).turns.length, 1, '保留的部分要落库成正式记录');
    assert.equal(readAskRunning(scope, ev.id), null, '运行态必须删掉');
    assert.equal(listActiveAskIds(scope).includes(ev.id), false, '「追问中」标记要撤掉');
    assert.equal(
      listFinishedAsks(scope).find((f) => f.eventId === ev.id),
      undefined,
      '主动停止不记结束态 —— 否则列表会打「追问完成/失败」，那是用户自己刚做的动作',
    );
  });

  it('② 一字未生成：抛 ANALYSIS_ASK_CANCELED（不是超时），且不记徽标', async () => {
    const ev = await createEvent(scope, { title: '停止无内容', typeId: 'et_1' });
    await seedDraft(ev.id);
    const g = gate();

    async function* silentStream(signal: AbortSignal): AsyncGenerator<{ type: string; text?: string }> {
      g.open();
      yield* waitForAbort(signal);
    }

    const running = askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '什么都没生成',
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: () => okLlm,
        streamChatFn: silentStream as never,
      },
    });

    await g.reached;
    assert.equal(cancelEventAsk(scope, ev.id), true);
    await assert.rejects(
      () => running,
      (err) => {
        assert.equal((err as GovernanceError).code, 'ANALYSIS_ASK_CANCELED');
        return true;
      },
    );

    assert.equal(readAskDoc(scope, ev.id).turns.length, 0, '没有内容就不该落库');
    assert.equal(readAskRunning(scope, ev.id), null);
    assert.equal(listActiveAskIds(scope).includes(ev.id), false);
    assert.equal(listFinishedAsks(scope).find((f) => f.eventId === ev.id), undefined);
  });

  it('③ 幂等：没有在跑的轮次返回 false', async () => {
    const ev = await createEvent(scope, { title: '空停', typeId: 'et_1' });
    await seedDraft(ev.id);
    assert.equal(cancelEventAsk(scope, ev.id), false, '没在跑不是错误，只是没有可停的东西');
  });

  it('④ 停止后不再发起新的上游调用（每轮开头复查 abort）', async () => {
    const ev = await createEvent(scope, { title: '停止后不续轮', typeId: 'et_1' });
    await seedDraft(ev.id);
    let calls = 0;
    const g = gate();

    async function* toolThenHang(signal: AbortSignal): AsyncGenerator<{ type: string; text?: string }> {
      calls += 1;
      if (calls === 1) {
        // 第一轮先要一次工具（带内容，避免被当成最终作答轮）
        yield { type: 'content', text: '我先查一下。' };
        yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'ki_search', arguments: '{"scope":"x","query":"y"}' }] } as never;
        g.open();
        yield* waitForAbort(signal);
        return;
      }
      // 第二轮不该被发起 —— 只有 abort 检查失效才会走到这里
      yield { type: 'content', text: '不该出现。' };
    }

    const running = askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '工具轮里停止',
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: () => okLlm,
        streamChatFn: toolThenHang as never,
        kbExecutor: { search: async () => ({ ok: true, results: [] }) },
      },
    });

    await g.reached;
    assert.equal(cancelEventAsk(scope, ev.id), true);
    // 第一轮的过渡语会被当成"最终作答"收口（roundContent 非空），这是既有口径
    await running;
    assert.equal(calls, 1, '停止后不得再发起下一轮上游调用');
  });
});
