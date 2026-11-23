/**
 * analysis-ask-running.test.ts —— 进行中追问的运行态（#82）
 *
 * 锁住的不变量：
 *   1) 追问一开始就把运行态同步落盘（切页回来必须马上看到「正在追答 + 问题」）；
 *   2) 流式中途按节流把半截答案写进运行态（回来至少能看到已生成的部分）；
 *   3) 成功 / 失败（无内容超时）都删除运行态 —— 留着会让页面永远显示「正在追答」；
 *   4) 僵尸运行态（进程被杀留下的）读时按无运行态处理并清掉；
 *   5) 删除事件时连带清运行态（避免残留）。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-ask-running.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { registerTestScope, cleanupTestConfig } from '../test-config.js';
import { initScope } from '../../src/lib/store.js';
import { getKbDir } from '../../src/lib/scope.js';
import { createEvent } from '../../src/lib/events/event-service.js';
import { writeDraftStart } from '../../src/lib/events/analysis-store.js';
import { askEventAnalysis } from '../../src/lib/events/analysis-ask-runner.js';
import {
  ASK_RUNNING_FLUSH_MS,
  ASK_RUNNING_MAX_STEPS,
  ASK_RUNNING_STALE_MS,
  ASK_RUNNING_STEP_TEXT_MAX,
  clearAskRunning,
  getAskRunningPath,
  readAskDoc,
  readAskRunning,
  removeAskFile,
  startAskRunning,
  writeAskRunning,
} from '../../src/lib/events/analysis-ask-store.js';
import type { AnalysisAskRunning } from '../../src/lib/events/types.js';

const scope = `ana-ask-run-${Date.now()}`;

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
  _configPath: '/tmp/ki-ask-run-cfg.json',
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

describe('运行态：读写与僵尸判定', () => {
  it('① 写入后可读回；按 updatedAt 判僵尸并清理', async () => {
    const ev = await createEvent(scope, { title: '运行态读写', typeId: 'et_1' });
    const state: AnalysisAskRunning = {
      version: 1,
      id: 'ar_test_1',
      eventId: ev.id,
      question: '为什么白屏？',
      runId: 'run_1',
      startedAt: 100,
      updatedAt: Date.now(),
      answer: '因为 token',
      steps: [],
    };
    writeAskRunning(scope, ev.id, state);
    const got = readAskRunning(scope, ev.id);
    assert.equal(got?.question, '为什么白屏？');
    assert.ok(fs.existsSync(getAskRunningPath(scope, ev.id)));

    // 僵尸：更新时间超出阈值 → 读为 null，且文件被清掉
    writeAskRunning(scope, ev.id, { ...state, updatedAt: Date.now() - ASK_RUNNING_STALE_MS - 1 });
    assert.equal(readAskRunning(scope, ev.id), null);
    assert.equal(fs.existsSync(getAskRunningPath(scope, ev.id)), false, '僵尸记录应顺手删除');

    clearAskRunning(scope, ev.id);
  });

  it('② 删除事件时连带清运行态', async () => {
    const ev = await createEvent(scope, { title: '删除清理', typeId: 'et_1' });
    writeAskRunning(scope, ev.id, {
      version: 1,
      id: 'ar_test_2',
      eventId: ev.id,
      question: 'q',
      runId: null,
      startedAt: 1,
      updatedAt: Date.now(),
      answer: '',
      steps: [],
    });
    removeAskFile(scope, ev.id);
    assert.equal(readAskRunning(scope, ev.id), null);
    assert.equal(fs.existsSync(getAskRunningPath(scope, ev.id)), false);
  });
});

describe('运行态：追问生命周期', () => {
  it('③ 一开始就落盘（同步首写），成功后删除', async () => {
    const ev = await createEvent(scope, { title: '首写', typeId: 'et_1' });
    await seedDraft(ev.id);

    let seenOnStart: AnalysisAskRunning | null = null;
    async function* fakeStream(): AsyncGenerator<{ type: string; text?: string }> {
      // 首个 token 之前读一次：运行态必须已经在了（否则切页回来什么都看不到）
      seenOnStart = readAskRunning(scope, ev.id);
      yield { type: 'content', text: '答：token 兜底缺失。' };
    }

    const res = await askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '为什么白屏？',
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: () => okLlm,
        streamChatFn: fakeStream as never,
      },
    });

    assert.ok(seenOnStart, '追问一开始就必须能读到运行态');
    assert.equal(seenOnStart!.question, '为什么白屏？');
    assert.equal(seenOnStart!.runId, 'run_1');
    assert.equal(readAskRunning(scope, ev.id), null, '成功后必须删除运行态');
    assert.equal(readAskDoc(scope, ev.id).turns.length, 1, '正式记录仍要落库');
    assert.equal(res.turn.answer, '答：token 兜底缺失。');
  });

  it('④ 流式中途把半截答案节流写进运行态', async () => {
    const ev = await createEvent(scope, { title: '半截', typeId: 'et_1' });
    await seedDraft(ev.id);

    let midSteps: string[] = [];
    let calls = 0;
    async function* fakeStream(): AsyncGenerator<{ type: string; text?: string }> {
      calls += 1;
      if (calls === 1) {
        // 第一轮：过渡语 + 一次工具调用（answer 仍为空，但步骤已产生）
        yield { type: 'content', text: '我先读一下源码。' };
        yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'not_enabled', arguments: '{}' }] } as never;
        return;
      }
      // 第二轮（最终作答）：先等一个节流窗口，检查中途快照，再吐正式答案
      await new Promise((resolve) => setTimeout(resolve, ASK_RUNNING_FLUSH_MS + 200));
      midSteps = (readAskRunning(scope, ev.id)?.steps ?? []).map((s) => `${s.kind}:${s.label}`);
      yield { type: 'content', text: '最终答案。' };
    }

    const res = await askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '继续查',
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: () => okLlm,
        streamChatFn: fakeStream as never,
      },
    });

    assert.ok(midSteps.length >= 2, `中途必须有过程步骤落盘，实际：${midSteps.join(' | ')}`);
    assert.ok(midSteps.some((s) => s.startsWith('thinking:')), '中间轮过渡语应作为 thinking 步骤进运行态');
    assert.ok(midSteps.some((s) => s.startsWith('tool:')), '工具调用步骤应进运行态');
    assert.equal(res.turn.answer, '最终答案。');
    assert.equal(readAskRunning(scope, ev.id), null, '完成后删除');
  });

  it('⑤ 无内容超时（失败出口）也删除运行态', async () => {
    const ev = await createEvent(scope, { title: '失败清理', typeId: 'et_1' });
    await seedDraft(ev.id);

    async function* hang(signal?: AbortSignal): AsyncGenerator<never> {
      void signal;
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error('aborted');
    }

    await assert.rejects(
      () => askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
        question: '超时',
        deps: {
          loadConfigFn: () => cfg,
          resolveLlmStatusFn: () => okLlm,
          streamChatFn: hang as never,
        },
      }),
    );
    assert.equal(readAskRunning(scope, ev.id), null, '失败也必须清掉运行态，否则永远显示「正在追答」');
  });

  it('⑥ 单轮流式：运行态实时反映已生成的正文（切页回来要看得到半截答案）', async () => {
    const ev = await createEvent(scope, { title: '半截答案', typeId: 'et_1' });
    await seedDraft(ev.id);

    let midAnswer = '';
    async function* fakeStream(): AsyncGenerator<{ type: string; text?: string }> {
      yield { type: 'content', text: '第一段。' };
      await new Promise((resolve) => setTimeout(resolve, ASK_RUNNING_FLUSH_MS + 200));
      midAnswer = readAskRunning(scope, ev.id)?.answer ?? '';
      yield { type: 'content', text: '第二段。' };
    }

    const res = await askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '半截答案测试',
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: () => okLlm,
        streamChatFn: fakeStream as never,
      },
    });

    assert.equal(midAnswer, '第一段。', '正文是流式产生的，运行态必须逐段跟（否则回来只有步骤、没有半截答案）');
    assert.equal(res.turn.answer, '第一段。第二段。');
    assert.equal(readAskRunning(scope, ev.id), null);
  });

  it('⑦ 运行态体积护栏：只留最近 N 步，单步文本截断', async () => {
    const ev = await createEvent(scope, { title: '裁剪', typeId: 'et_1' });
    const tracker = startAskRunning(scope, ev.id, { question: 'q' });
    const steps = Array.from({ length: ASK_RUNNING_MAX_STEPS + 10 }, (_, i) => ({
      id: `s${i}`,
      kind: 'thinking' as const,
      label: 'l',
      text: 'x'.repeat(ASK_RUNNING_STEP_TEXT_MAX + 100),
      at: i,
    }));
    tracker.update({ steps });
    tracker.flush();

    const got = readAskRunning(scope, ev.id);
    assert.ok(got);
    assert.equal(got!.steps.length, ASK_RUNNING_MAX_STEPS, '只保留最近若干步');
    assert.equal(got!.steps[got!.steps.length - 1]!.id, `s${ASK_RUNNING_MAX_STEPS + 9}`, '保留的是最近那批');
    assert.ok(
      got!.steps.every((s) => s.text.length <= ASK_RUNNING_STEP_TEXT_MAX + 1),
      '单步文本必须截断，否则长思考会把运行态撑到几百 KB',
    );
    tracker.stop();
  });

  it('⑧ 并发两轮：先结束的那轮不误删后写的运行态', async () => {
    const ev = await createEvent(scope, { title: '并发', typeId: 'et_1' });
    // 直接驱动 tracker：runner 内部顺序无法从外部编排
    const a = startAskRunning(scope, ev.id, { question: 'A 轮' });
    const b = startAskRunning(scope, ev.id, { question: 'B 轮' });
    assert.equal(readAskRunning(scope, ev.id)?.question, 'B 轮', '后写覆盖前写（单文件只能表示一轮）');

    a.stop();
    assert.equal(
      readAskRunning(scope, ev.id)?.question,
      'B 轮',
      '先结束的 A 不能把 B 的运行态删掉（否则回来看到「没有在追答」）',
    );

    b.stop();
    assert.equal(readAskRunning(scope, ev.id), null, 'B 结束时清干净');
  });
});
