/**
 * analysis-ask.test.ts —— B2「追问这次分析」存储与执行器单测
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-ask.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { registerTestScope, cleanupTestConfig } from '../test-config.js';
import { initScope } from '../../src/lib/store.js';
import { getKbDir } from '../../src/lib/scope.js';
import { createEvent } from '../../src/lib/events/event-service.js';
import { getAnalysisPath, writeDraftStart } from '../../src/lib/events/analysis-store.js';
import { askEventAnalysis } from '../../src/lib/events/analysis-ask-runner.js';
import {
  appendAskTurn,
  clearAskTurns,
  getAskPath,
  readAskDoc,
} from '../../src/lib/events/analysis-ask-store.js';
import { GovernanceError } from '../../src/lib/governance-errors.js';
import type { AnalysisAskTurn } from '../../src/lib/events/types.js';

const scope = `ana-ask-${Date.now()}`;

before(() => {
  registerTestScope(scope);
  initScope(scope);
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

function turn(id: string, at = Date.now()): AnalysisAskTurn {
  return { id, question: `问 ${id}`, answer: `答 ${id}`, runId: 'run_1', at };
}

const cfg = {
  llm: { baseURL: 'http://127.0.0.1:1', apiKey: 'k', model: 'm' },
  _configPath: '/tmp/ki-ask-cfg.json',
} as never;

const okLlm = { enabled: true, ackRequired: false, supportsTools: true } as never;
const offLlm = { enabled: false, ackRequired: false, supportsTools: true, reason: '未配置模型' } as never;

async function seedDraft(eventId: string): Promise<void> {
  await writeDraftStart(scope, eventId, {
    runId: 'run_1',
    status: 'ready',
    targetDir: '/tmp/repo',
    commit: 'abc1234',
    conclusion: '根因是 token 为空未兜底',
    candidates: [
      { id: 'c1', file: 'src/login.ts', line: 3, snippet: 'throw err', why: '未兜底', confidence: 0.9 },
    ],
    unconfirmed: [],
    steps: [],
    stats: { turns: 1, filesRead: 1, tokens: 10, ms: 20 },
    startedAt: Date.now() - 5_000,
    updatedAt: Date.now() - 5_000,
  });
}

describe('B2 追问记录存储', () => {
  it('① 追加 / 读取 / 清空；文件缺失按空处理', async () => {
    const ev = await createEvent(scope, { title: '追问存储', typeId: 'et_1' });
    assert.equal(readAskDoc(scope, ev.id).turns.length, 0, '缺失文件必须归一为空 doc');

    await appendAskTurn(scope, ev.id, turn('a1'));
    const saved = await appendAskTurn(scope, ev.id, turn('a2'));
    assert.equal(saved.doc.turns.length, 2);
    assert.equal(readAskDoc(scope, ev.id).turns[1]!.id, 'a2');
    assert.ok(fs.existsSync(getAskPath(scope, ev.id)), '落点应为 {eventId}.ask.json');

    const cleared = await clearAskTurns(scope, ev.id);
    assert.equal(cleared, 2);
    assert.equal(readAskDoc(scope, ev.id).turns.length, 0);
  });

  it('② 损坏文件不抛错、按空处理', async () => {
    const ev = await createEvent(scope, { title: '损坏记录', typeId: 'et_1' });
    fs.writeFileSync(getAskPath(scope, ev.id), '{ not json', 'utf8');
    const doc = readAskDoc(scope, ev.id);
    assert.equal(doc.turns.length, 0);
    assert.equal(doc.version, 1);
  });
});

describe('B2 追问执行器闸门', () => {
  it('③ 无草稿 → ANALYSIS_DRAFT_NOT_FOUND（404）', async () => {
    const ev = await createEvent(scope, { title: '未分析就追问', typeId: 'et_1' });
    await assert.rejects(
      () => askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
        question: '为什么？',
        deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => okLlm },
      }),
      (err: unknown) => err instanceof GovernanceError && err.code === 'ANALYSIS_DRAFT_NOT_FOUND',
    );
  });

  it('④ 问题为空 / 超长 → ANALYSIS_ASK_QUESTION_TOO_LONG（400）', async () => {
    const ev = await createEvent(scope, { title: '问题长度', typeId: 'et_1' });
    await seedDraft(ev.id);
    await assert.rejects(
      () => askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
        question: '   ',
        deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => okLlm },
      }),
      (err: unknown) => err instanceof GovernanceError && err.code === 'ANALYSIS_ASK_QUESTION_TOO_LONG',
    );
    await assert.rejects(
      () => askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
        question: 'x'.repeat(4001),
        deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => okLlm },
      }),
      (err: unknown) => err instanceof GovernanceError && err.code === 'ANALYSIS_ASK_QUESTION_TOO_LONG',
    );
  });

  it('⑤ 模型未配置 → ANALYSIS_LLM_UNAVAILABLE（503）', async () => {
    const ev = await createEvent(scope, { title: '模型不可用', typeId: 'et_1' });
    await seedDraft(ev.id);
    await assert.rejects(
      () => askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
        question: '为什么？',
        deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => offLlm },
      }),
      (err: unknown) => err instanceof GovernanceError && err.code === 'ANALYSIS_LLM_UNAVAILABLE',
    );
  });

  it('⑥ 正常路径：上下文带结论与候选、回答落库、并发闸释放', async () => {
    const ev = await createEvent(scope, { title: '正常追问', typeId: 'et_1' });
    await seedDraft(ev.id);

    let seen = '';
    async function* fakeStream(
      messages: Array<{ role: string; content: string }>,
    ): AsyncGenerator<{ type: string; text?: string; promptTokens?: number; completionTokens?: number }> {
      seen = messages.map((m) => m.content).join('\n');
      yield { type: 'content', text: '因为登录守卫在解构前读了 token。' };
      yield { type: 'usage', promptTokens: 100, completionTokens: 20 };
    }

    const deltas: string[] = [];
    const res = await askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '为什么白屏？',
      onDelta: (t) => deltas.push(t),
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: () => okLlm,
        streamChatFn: fakeStream as never,
      },
    });

    assert.equal(res.turn.answer, '因为登录守卫在解构前读了 token。');
    assert.deepEqual(deltas, ['因为登录守卫在解构前读了 token。'], 'SSE 通道必须逐段回调增量');
    assert.equal(res.turn.runId, 'run_1');
    assert.equal(res.turn.usage?.promptTokens, 100);
    assert.match(seen, /根因是 token 为空未兜底/, '上下文必须带结论');
    assert.match(seen, /src\/login\.ts:3/, '上下文必须带候选位置');
    assert.equal(readAskDoc(scope, ev.id).turns.length, 1, '回答必须落库');

    // 第二次仍能进：说明 finally 释放了并发闸
    const second = await askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '还有别的可能吗？',
      deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => okLlm, streamChatFn: fakeStream as never },
    });
    assert.ok(second.turn.id);
    assert.equal(readAskDoc(scope, ev.id).turns.length, 2);
  });

  it('⑦ 硬超时且无内容 → ANALYSIS_ASK_TIMEOUT（504），不落库', async () => {
    const ev = await createEvent(scope, { title: '超时', typeId: 'et_1' });
    await seedDraft(ev.id);
    async function* hang(signal?: AbortSignal): AsyncGenerator<never> {
      void signal;
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error('aborted');
    }
    await assert.rejects(
      () => askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
        question: '超时测试',
        deps: {
          loadConfigFn: () => cfg,
          resolveLlmStatusFn: () => okLlm,
          streamChatFn: hang as never,
          hardTimeoutMs: 5,
        },
      }),
      (err: unknown) => err instanceof GovernanceError && err.code === 'ANALYSIS_ASK_TIMEOUT',
    );
    assert.equal(readAskDoc(scope, ev.id).turns.length, 0, '无内容的超时不得落库');
  });
});

// 防未使用告警：getAnalysisPath 在别处用不到，但保留导入便于调试定位
void getAnalysisPath;
