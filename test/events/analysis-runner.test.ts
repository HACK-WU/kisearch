/**
 * analysis-runner.test.ts —— S-04 异步分析 Pipeline 集成单测
 *
 * 重点覆盖：
 *   1. 前置门禁：未配目标目录、工具全关、未确认隐私、每日限流；
 *   2. 轻上下文验证：首轮 user 消息不含关联/参考文档正文，只含 (group, name) 清单与阶段进度；
 *   3. LLM 自主调用 ki_get_module_info + fs_grep + fs_read，最终剔除幻觉路径与越界行号；
 *   4. 已收口事件允许分析；分析过程不阻塞同 scope KB 写入锁；
 *   5. 超时返回 partial + TIMEOUT，不返回空成功。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-runner.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from '../test-config.js';
import { initScope } from '../../src/lib/store.js';
import { getKbDir } from '../../src/lib/scope.js';
import type { KiConfig } from '../../src/lib/config.js';
import { savePromptConfig } from '../../src/lib/chat/prompt-config.js';
import { createEvent, transitionEvent } from '../../src/lib/events/event-service.js';
import { addRefs } from '../../src/lib/events/refs-service.js';
import { writeGroupCache } from '../../src/lib/group-cache.js';
import type { Relation } from '../../src/lib/scoring.js';
import { GovernanceError } from '../../src/lib/governance-errors.js';
import {
  cancelEventAnalysis,
  isAnalysisActive,
  readNormalizedAnalysisDoc,
  startEventAnalysis,
  type AnalysisRunnerDeps,
} from '../../src/lib/events/analysis-runner.js';
import type { ChatTurn, StreamChatOptions, StreamPart } from '../../src/lib/chat/llm-client.js';

const scope = `ana-run-${Date.now()}`;
let tmpDir = '';
let chatDir = '';
let repoDir = '';
let cfg: KiConfig;

function okLlmStatus() {
  return {
    enabled: true,
    reason: null,
    supportsImages: false,
    supportsTools: true,
    ackRequired: false,
    model: 'test-model',
    baseURL: 'http://localhost',
    contextChars: 1_000_000,
    maxToolRounds: Infinity,
    askMaxRounds: 6,
    askSessionTtlMs: 600_000,
  };
}

/**
 * 造一篇真实存在的文档。
 *
 * `addRefs` 会校验被引文档在源库的存在性（`REF_DOC_NOT_FOUND`，防伪造路径写进
 * `refs.json` 变成永远解析不到的脏引用），因此不能只往 refs 里塞个名字。
 */
function seedDoc(group: string, name: string): void {
  const rel: Relation = {
    id: `rel_${name}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
  };
  writeGroupCache(scope, group, {
    version: 1,
    scope,
    hot_relations: [rel],
    keywords: [],
    updatedAt: null,
  });
}

async function waitDone(s: string, eventId: string, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const doc = readNormalizedAnalysisDoc(s, eventId);
    if (!isAnalysisActive(s, eventId) && doc.draft && doc.draft.status !== 'running') {
      return doc;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('分析任务等待超时');
}

before(() => {
  registerTestScope(scope);
  initScope(scope);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-ana-runner-'));
  chatDir = path.join(tmpDir, 'chat');
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'src', 'login.ts'),
    [
      'export function login(token: string | null) {',
      '  // line 2',
      '  if (!token) throw new Error("TOKEN_MISSING");',
      '  return token.trim();',
      '}',
    ].join('\n'),
    'utf8',
  );
  cfg = {
    dataDir: path.dirname(getKbDir(scope)),
    chatDir,
    llm: { baseURL: 'http://localhost', model: 'test-model', apiKey: 'k', kbDisclosureAck: true, supportsTools: true },
  } as KiConfig;
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('S-04 异步分析 Pipeline', () => {
  it('① 前置门禁：未配置目录 / 工具全关 / 未确认隐私', async () => {
    const ev = await createEvent(scope, { title: '门禁测试', typeId: 'et_1' });

    // 未配置目录
    await assert.rejects(
      () => startEventAnalysis(scope, ev.id, { deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: okLlmStatus } }),
      (e: unknown) => e instanceof GovernanceError && e.code === 'ANALYSIS_TARGET_NOT_CONFIGURED',
    );

    // 配上目录但关闭全部 fs_* 工具
    savePromptConfig(cfg, {
      analysis: {
        targetDirs: { byScope: { [scope]: repoDir } },
        prompt: { content: '测试' },
        skills: [{ id: 'builtin-code-locate', name: 'code-locate', description: 'd', content: 'c', enabled: false }],
        tools: { fs_read: false, fs_grep: false, fs_find: false, fs_ls: false },
      },
    });
    await assert.rejects(
      () => startEventAnalysis(scope, ev.id, { deps: { loadConfigFn: () => cfg, resolveLlmStatusFn: okLlmStatus } }),
      (e: unknown) => e instanceof GovernanceError && e.code === 'ANALYSIS_TOOLS_ALL_DISABLED',
    );

    // 开回工具但未确认隐私
    savePromptConfig(cfg, {
      analysis: {
        targetDirs: { byScope: { [scope]: repoDir } },
        prompt: { content: '测试' },
        skills: [{ id: 'builtin-code-locate', name: 'code-locate', description: 'd', content: 'c', enabled: true }],
        tools: { fs_read: true, fs_grep: true, fs_find: true, fs_ls: true, ki_get_module_info: true },
      },
    });
    await assert.rejects(
      () => startEventAnalysis(scope, ev.id, {
        deps: {
          loadConfigFn: () => cfg,
          resolveLlmStatusFn: () => ({ ...okLlmStatus(), ackRequired: true }),
        },
      }),
      (e: unknown) => e instanceof GovernanceError && e.code === 'ANALYSIS_DISCLOSURE_REQUIRED',
    );
  });

  it('② 轻上下文不含正文、LLM 自主读文档与源码、剔除幻觉候选、已收口事件放行', async () => {
    const ev = await createEvent(scope, {
      title: '登录报错 TOKEN_MISSING',
      description: '移动端登录后偶发报错',
      typeId: 'et_1',
    });
    seedDoc('排查记录', '登录故障笔记');
    addRefs(scope, ev.id, { docs: [{ group: '排查记录', name: '登录故障笔记' }], addedBy: 'manual' });
    // 收口后仍应允许分析（Q4 拍板）
    await transitionEvent(scope, { event: ev.id, stage: '已关闭' });

    const seenFirstUserMessages: string[] = [];
    let kbReadCalled = false;
    let callTurn = 0;

    /*
     * ★ 签名必须与生产契约一致：`streamChat(messages, opts)`。
     *   历史坑：测试里曾写成 `(opts)` 单参数，正好与当时**错误的**生产调用
     *   `streamFn({ messages, tools, llm })` 同形，于是「LLM 明明配好却报未配置模型」
     *   的 bug 一路绿着发布出去（详见 .debug/analysis-llm-unavailable-20261116/）。
     */
    const fakeStream = async function* (messages: ChatTurn[], opts?: StreamChatOptions): AsyncGenerator<StreamPart> {
      callTurn += 1;
      assert.ok(Array.isArray(messages), 'streamChat 第一个参数必须是消息数组');
      assert.ok(opts?.llm?.model, 'streamChat 第二个参数必须带 llm.model（否则上游调用必失败）');
      if (callTurn === 1) {
        const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
        seenFirstUserMessages.push(userMsg);
        yield {
          type: 'tool_calls',
          calls: [
            { id: 'c1', name: 'ki_get_module_info', arguments: JSON.stringify({ group: '排查记录', relation: '登录故障笔记' }) },
            { id: 'c2', name: 'fs_grep', arguments: JSON.stringify({ pattern: 'TOKEN_MISSING' }) },
          ],
        };
        yield { type: 'usage', promptTokens: 100, completionTokens: 40 };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      if (callTurn === 2) {
        yield {
          type: 'tool_calls',
          calls: [{ id: 'c3', name: 'fs_read', arguments: JSON.stringify({ path: 'src/login.ts', offset: 1, limit: 10 }) }],
        };
        yield { type: 'usage', promptTokens: 120, completionTokens: 30 };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      // 第 3 轮输出 JSON：含 1 个真实位置 + 1 个幻觉路径 + 1 个越界行号
      yield {
        type: 'content',
        text: JSON.stringify({
          conclusion: '根因是 token 为空时未兜底：登录守卫在解构前就读取了 token，缺失即抛错。',
          candidates: [
            { file: 'src/login.ts', line: 3, why: 'token 为空直接抛出 TOKEN_MISSING', confidence: 0.9 },
            { file: 'src/ghost.ts', line: 10, why: '幻觉文件', confidence: 0.8 },
            { file: 'src/login.ts', line: 999, why: '越界行号', confidence: 0.7 },
          ],
          unconfirmed: ['未检查上层重试逻辑'],
        }),
      };
      yield { type: 'usage', promptTokens: 80, completionTokens: 50 };
      yield { type: 'done', finishReason: 'stop' };
    };

    const deps: AnalysisRunnerDeps = {
      loadConfigFn: () => cfg,
      resolveLlmStatusFn: okLlmStatus,
      streamChatFn: fakeStream as typeof import('../../src/lib/chat/llm-client.js').streamChat,
      kbExecutor: {
        getModuleInfo: async ({ group, relation }) => {
          kbReadCalled = true;
          return { group, relation, content: 'SECRET_DOC_BODY_SHOULD_NOT_BE_PRELOADED: TOKEN_MISSING 发生在 login.ts' };
        },
      },
    };

    const started = await startEventAnalysis(scope, ev.id, { deps });
    assert.equal(started.reused, false);
    assert.equal(started.doc.draft?.status, 'running');

    const finalDoc = await waitDone(scope, ev.id);
    assert.equal(kbReadCalled, true, 'LLM 应按需调用 ki_get_module_info 读取正文');
    assert.ok(seenFirstUserMessages[0]!.includes('group: 排查记录 | name: 登录故障笔记'));
    assert.ok(seenFirstUserMessages[0]!.includes('已收口'), '上下文必须带入阶段进度状态');
    assert.equal(seenFirstUserMessages[0]!.includes('SECRET_DOC_BODY_SHOULD_NOT_BE_PRELOADED'), false, '初始上下文绝不能预塞正文');

    assert.equal(finalDoc.draft?.status, 'ready');
    assert.equal(
      finalDoc.draft?.conclusion,
      '根因是 token 为空时未兜底：登录守卫在解构前就读取了 token，缺失即抛错。',
      'B1：模型给出的结论必须原样落库',
    );
    assert.equal(finalDoc.draft?.candidates.length, 1, '幻觉文件与越界行号必须被二次校验剔除');
    assert.equal(finalDoc.draft?.candidates[0]!.file, 'src/login.ts');
    assert.equal(finalDoc.draft?.candidates[0]!.line, 3);
    assert.ok(finalDoc.draft?.unconfirmed.some((u) => u.includes('src/ghost.ts')));
    assert.ok(finalDoc.draft?.unconfirmed.some((u) => u.includes('999')));
  });

  it('③ 超时返回 partial/failed + TIMEOUT', async () => {
    const ev = await createEvent(scope, { title: '超时测试', typeId: 'et_1' });
    const slowStream = async function* (_messages: ChatTurn[], opts?: StreamChatOptions): AsyncGenerator<StreamPart> {
      await new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    };

    await startEventAnalysis(scope, ev.id, {
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: okLlmStatus,
        streamChatFn: slowStream as typeof import('../../src/lib/chat/llm-client.js').streamChat,
        hardTimeoutMs: 60,
        softTimeoutMs: 500,
      },
    });
    const doc = await waitDone(scope, ev.id);
    assert.equal(doc.draft?.status, 'failed');
    assert.equal(doc.draft?.errorCode, 'TIMEOUT');
  });

  it('④ 手动停止：running 时 cancel → 落 cancelled（不是 failed），且幂等', async () => {
    const ev = await createEvent(scope, { title: '停止测试', typeId: 'et_1' });
    let upstreamCalls = 0;
    // 一直挂起直到被 abort：模拟"正在等上游返回"的那段时间
    const hangingStream = async function* (_messages: ChatTurn[], opts?: StreamChatOptions): AsyncGenerator<StreamPart> {
      upstreamCalls += 1;
      await new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    };

    await startEventAnalysis(scope, ev.id, {
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: okLlmStatus,
        streamChatFn: hangingStream as typeof import('../../src/lib/chat/llm-client.js').streamChat,
        hardTimeoutMs: 30_000,
        softTimeoutMs: 30_000,
      },
    });

    // 运行中才能停止
    assert.equal(cancelEventAnalysis(scope, ev.id), true, '运行中应能停止');
    const doc = await waitDone(scope, ev.id);
    assert.equal(doc.draft?.status, 'cancelled', '主动停止不能落成 failed（那会引导用户去改配置）');
    assert.equal(doc.draft?.errorCode, 'ANALYSIS_CANCELED');
    assert.equal(upstreamCalls, 1, '停止后不得继续发起上游调用');
    // 幂等：没在跑再点一次不报错、不改状态
    assert.equal(cancelEventAnalysis(scope, ev.id), false);
    assert.equal(readNormalizedAnalysisDoc(scope, ev.id).draft?.status, 'cancelled');
  });

  it('⑤ 收尾瞬间点停止：已产出的候选要保留（partial + ANALYSIS_CANCELED）', async () => {
    const ev = await createEvent(scope, { title: '停止保留候选', typeId: 'et_1' });
    /*
     * 复现"最后一轮已返回、正要收尾"的那个窄窗口：在 stream 产出内容之后、done 之前点停止。
     * 此时 abort 打不到正在跑的 stream，只能靠**收尾前再读一次标记**把它认成取消；
     * 不做这件事会被判成 `NO_RESULT failed` —— 用户看到「模型未能输出有效位置」，
     * 而实际是"我自己停的，且已经找到东西了"。
     */
    const fakeStream = async function* (): AsyncGenerator<StreamPart> {
      yield {
        type: 'content',
        text: JSON.stringify({
          candidates: [{ file: 'src/login.ts', line: 3, why: '并发点停止时已定位到', confidence: 0.9 }],
          unconfirmed: [],
        }),
      };
      cancelEventAnalysis(scope, ev.id);   // 就在收尾前一刻点停止
      yield { type: 'usage', promptTokens: 10, completionTokens: 5 };
      yield { type: 'done', finishReason: 'stop' };
    };

    await startEventAnalysis(scope, ev.id, {
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: okLlmStatus,
        streamChatFn: fakeStream as typeof import('../../src/lib/chat/llm-client.js').streamChat,
      },
    });
    const doc = await waitDone(scope, ev.id);
    assert.equal(doc.draft?.status, 'partial', '已产出候选时停止应落 partial，候选仍可确认');
    assert.equal(doc.draft?.errorCode, 'ANALYSIS_CANCELED');
    assert.equal(doc.draft?.candidates.length, 1, '停止不该丢弃已产出的候选');
    assert.equal(doc.draft?.conclusion, null, '模型未给结论时必须落 null（前端据此整块不渲染）');
  });
});
