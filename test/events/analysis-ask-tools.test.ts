/**
 * analysis-ask-tools.test.ts —— 追问带工具再调查（2026-11-19）核心闸门单测
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-ask-tools.test.ts
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
import { readAskDoc } from '../../src/lib/events/analysis-ask-store.js';
import { GovernanceError } from '../../src/lib/governance-errors.js';

const scope = `ana-ask-tools-${Date.now()}`;
let tmpDir = '';
let repoDir = '';
let cfg: never;

before(() => {
  registerTestScope(scope);
  initScope(scope);
  tmpDir = fs.mkdtempSync('/tmp/ki-ask-tools-');
  repoDir = `${tmpDir}/repo`;
  fs.mkdirSync(`${repoDir}/src`, { recursive: true });
  fs.writeFileSync(`${repoDir}/src/app.ts`, 'const a = 1;\n', 'utf8');
  const chatDir = `${tmpDir}/chat`;
  fs.mkdirSync(chatDir, { recursive: true });
  // readPromptConfig 从磁盘读：把分析目标目录写进 prompt-config.json 才会注册 fs_* 工具
  fs.writeFileSync(`${chatDir}/prompt-config.json`, JSON.stringify({
    version: 1,
    analysis: {
      targetDirs: { byScope: { [scope]: repoDir }, defaultDir: '' },
      tools: { fs_read: true, fs_grep: true, fs_find: true, fs_ls: true },
    },
  }), 'utf8');
  cfg = {
    dataDir: `${tmpDir}/data`,
    chatDir,
    llm: { baseURL: 'http://localhost', model: 'test', apiKey: 'k', kbDisclosureAck: true, supportsTools: true },
  } as never;
});

after(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

const okLlm = { enabled: true, ackRequired: false, supportsTools: true } as never;

async function seedDraft(eventId: string): Promise<void> {
  await writeDraftStart(scope, eventId, {
    runId: 'run_1', status: 'ready', targetDir: repoDir, commit: 'abc',
    conclusion: '根因在 app.ts', candidates: [], unconfirmed: [], steps: [],
    stats: { turns: 1, filesRead: 0, tokens: 0, ms: 0 },
    startedAt: Date.now(), updatedAt: Date.now(),
  });
}

describe('追问带工具（2026-11-19）', () => {
  it('① 一轮工具调用后作答：toolCalls 落盘 + onEvent 收到 tool 事件', async () => {
    const ev = await createEvent(scope, { title: '工具一轮', typeId: 'et_1' });
    await seedDraft(ev.id);
    let round = 0;
    async function* stream(messages: Array<{ role: string }>): AsyncGenerator<Record<string, unknown>> {
      round += 1;
      if (round === 1) {
        yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'fs_read', arguments: '{"path":"src/app.ts"}' }] };
      } else {
        assert.ok(messages.some((m) => m.role === 'tool'), '第二轮必须带上工具结果');
        yield { type: 'content', text: '文件里是 const a = 1。' };
        yield { type: 'usage', promptTokens: 10, completionTokens: 5 };
      }
    }
    const events: Array<{ type: string; step?: { id: string; kind: string; text: string } }> = [];
    const res = await askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '读一下 app.ts',
      onEvent: (e) => events.push(e),
      deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => okLlm, streamChatFn: stream as never },
    });
    assert.equal(res.turn.answer, '文件里是 const a = 1。');
    assert.deepEqual(res.turn.toolCalls, [{ name: 'fs_read', at: res.turn.at }]);
    assert.ok(events.some((e) => e.type === 'tool'), '必须推 tool 进度事件');
    const stepEvents = events.filter((e) => e.type === 'step' && e.step);
    assert.ok(stepEvents.some((e) => e.step!.kind === 'tool'), '步骤流必须含查证步骤');
    const answerSteps = stepEvents.filter((e) => e.step!.kind === 'answer');
    assert.ok(answerSteps.length > 0, '步骤流必须含作答步骤');
    assert.equal(answerSteps[answerSteps.length - 1]!.step!.text, '文件里是 const a = 1。', '作答步骤 text 必须是累积全文');
    assert.equal(readAskDoc(scope, ev.id).turns.length, 1);
  });

  it('②b 中间轮过渡语不进答案：只有最终轮 content 成为 answer', async () => {
    const ev = await createEvent(scope, { title: '过渡语隔离', typeId: 'et_1' });
    await seedDraft(ev.id);
    let round = 0;
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      round += 1;
      if (round === 1) {
        yield { type: 'content', text: '我先读一下该 handler 和存储实现，确认它的语义。' };
        yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'fs_read', arguments: '{"path":"src/app.ts"}' }] };
      } else {
        yield { type: 'content', text: 'find-summary 是保存/读取 AI 查找结论的端点。' };
      }
    }
    const deltas: string[] = [];
    const res = await askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: 'find-summary 是什么',
      onDelta: (t) => deltas.push(t),
      deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => okLlm, streamChatFn: stream as never },
    });
    assert.equal(res.turn.answer, 'find-summary 是保存/读取 AI 查找结论的端点。',
      '答案必须是最终轮 content，不能掺入中间轮过渡语');
    assert.deepEqual(deltas, ['find-summary 是保存/读取 AI 查找结论的端点。'],
      'SSE delta 只应推最终答案一次');
  });

  it('② 达轮次上限强制作答：不无限循环', async () => {
    const ev = await createEvent(scope, { title: '轮次上限', typeId: 'et_1' });
    await seedDraft(ev.id);
    let calls = 0;
    async function* stream(_messages: unknown, opts?: { tools?: unknown }): AsyncGenerator<Record<string, unknown>> {
      calls += 1;
      // 强制作答轮（tools 被移除）必须吐正文，否则就是模型不配合 —— 这里模拟配合
      if (opts?.tools) yield { type: 'tool_calls', calls: [{ id: `c${calls}`, name: 'fs_ls', arguments: '{}' }] };
      else yield { type: 'content', text: '到达上限后的作答。' };
    }
    const res = await askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '一直查',
      deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => okLlm, streamChatFn: stream as never },
    });
    assert.equal(res.turn.answer, '到达上限后的作答。');
    assert.ok(calls <= 7, `轮次应被 5 轮上限约束，实际 ${calls}`);
  });

  it('③ 上下文含已挂参考文档清单（仅名称，无正文）', async () => {
    const ev = await createEvent(scope, { title: '文档清单', typeId: 'et_1' });
    await seedDraft(ev.id);
    // 直接写 refs 文件（辅助函数不存在则用 fs）
    const refsPath = `${getKbDir(scope)}/.events/${ev.id}.refs.json`;
    fs.mkdirSync(`${getKbDir(scope)}/.events`, { recursive: true });
    fs.writeFileSync(refsPath, JSON.stringify({
      version: 1, eventId: ev.id, refs: [{ scope, group: '决策记录/事件页', name: '状态徽标', addedBy: 'human', addedAt: 1 }], updatedAt: 1,
    }), 'utf8');
    let seen = '';
    async function* stream(messages: Array<{ role: string; content: string }>): AsyncGenerator<Record<string, unknown>> {
      seen = messages.map((m) => m.content).join('\n');
      yield { type: 'content', text: '知道了。' };
    }
    await askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '参考文档是什么',
      deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => okLlm, streamChatFn: stream as never },
    });
    assert.match(seen, /状态徽标/, '上下文必须含参考文档名称');
    assert.match(seen, /attached_docs/, '必须含 attached_docs 块');
  });

  it('④ 未授权工具被拒（返回 error 而非崩溃）', async () => {
    const ev = await createEvent(scope, { title: '未授权工具', typeId: 'et_1' });
    await seedDraft(ev.id);
    let round = 0;
    async function* stream(): AsyncGenerator<Record<string, unknown>> {
      round += 1;
      if (round === 1) yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'ki_event_delete', arguments: '{}' }] };
      else yield { type: 'content', text: '那个工具不可用。' };
    }
    const res = await askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
      question: '删掉事件',
      deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => okLlm, streamChatFn: stream as never },
    });
    assert.match(res.turn.answer, /不可用/);
  });

  it('⑤ 独立限流：6 次/60s 后 ANALYSIS_FOLLOWUP_RATE_LIMITED', async () => {
    const ev = await createEvent(scope, { title: '限流', typeId: 'et_1' });
    await seedDraft(ev.id);
    async function* stream(): AsyncGenerator<Record<string, unknown>> { yield { type: 'content', text: 'ok' }; }
    // 前 6 次成功（用不同 principalKey 避免与前面用例的窗口叠加）
    for (let i = 0; i < 6; i += 1) {
      await askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
        question: `q${i}`, principalKey: 'rate-test',
        deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => okLlm, streamChatFn: stream as never },
      });
    }
    await assert.rejects(
      () => askEventAnalysis(scope, { id: ev.id, title: ev.title }, {
        question: 'q7', principalKey: 'rate-test',
        deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: () => okLlm, streamChatFn: stream as never },
      }),
      (err: unknown) => err instanceof GovernanceError && err.code === 'ANALYSIS_FOLLOWUP_RATE_LIMITED',
    );
  });
});
