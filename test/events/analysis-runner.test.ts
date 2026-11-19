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
import { defaultPromptConfig, savePromptConfig } from '../../src/lib/chat/prompt-config.js';
import { createEvent, transitionEvent } from '../../src/lib/events/event-service.js';
import { addRefs } from '../../src/lib/events/refs-service.js';
import { writeGroupCache } from '../../src/lib/group-cache.js';
import type { Relation } from '../../src/lib/scoring.js';
import { GovernanceError } from '../../src/lib/governance-errors.js';
import {
  cancelEventAnalysis,
  formatRecallBlock,
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

/** 不关心「开场预取」的用例用这个：直接返回跳过，避免真的去打上游模型 */
const skipRecall: NonNullable<AnalysisRunnerDeps['recallFn']> = async () => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'TEST_SKIP' }) }],
  isError: true,
});

describe('开场预取的两块纯函数', () => {
  it('formatRecallBlock 的条数跟随调用方给的 limit（不写死）', () => {
    const res = {
      summary: 's',
      candidates: Array.from({ length: 8 }, (_, i) => ({ group: 'g', name: `n${i}`, why: 'w' })),
      uncertainties: ['u1', 'u2', 'u3', 'u4'],
    };
    const five = formatRecallBlock(res, 5);
    assert.equal(five.split('\n').filter((l) => l.startsWith('- g | n')).length, 5, '默认 5 条');
    const eight = formatRecallBlock(res, 8);
    assert.equal(eight.split('\n').filter((l) => l.startsWith('- g | n')).length, 8, 'limit=8 时不能还被截成 5');
    assert.ok(eight.includes('判断不了的点'), '未确认点要带出来');
    assert.ok(eight.split('\n').filter((l) => l.startsWith('- u')).length <= 3, '未确认点仍限 3 条');
  });
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

    // ① 门禁用例把 skill 正文写成了 'c'：这里装回**真实**内置 skill，否则断言不到真文案
    // （targetDirs 必须一起给：savePromptConfig 的 analysis 段是整段替换，不是深合并）
    savePromptConfig(cfg, {
      analysis: {
        targetDirs: { byScope: { [scope]: repoDir } },
        skills: [defaultPromptConfig().analysis!.skills[0]!],
      },
    });

    const seenFirstUserMessages: string[] = [];
    /** 第 1 轮的 system 提示与工具面（钉住「内置 skill 正文常驻注入」）。 */
    const seenSystemPrompts: string[] = [];
    const seenToolNames: string[][] = [];
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
        seenSystemPrompts.push(messages.find((m) => m.role === 'system')?.content ?? '');
        seenToolNames.push((opts?.tools ?? []).map((t) => t.function.name));
        // 思考片段：只用于过程区展示，必须原样落盘（2026-11-18）
        yield { type: 'reasoning', text: '先看 KB 里记录的现象，再用 grep 定位关键词' };
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
      // 第 3 轮输出 JSON：含 1 个真实位置 + 1 个幻觉路径 + 1 个越界行号；
      // chain 里再掺一条非法 kind、一条指向幻觉位置的 ref、一条挂在非根因节点上的分支
      yield {
        type: 'content',
        text: JSON.stringify({
          conclusion: '根因是 token 为空时未兜底：登录守卫在解构前就读取了 token，缺失即抛错。',
          chain: [
            { kind: 'symptom', text: '登录时提示 TOKEN_MISSING' },
            { kind: 'cause', text: '守卫在解构前读取 token', ref: 'src/login.ts:3', branches: ['挂在原因上的分支应被丢弃'] },
            { kind: 'bogus', text: '非法类型应被丢弃' },
            { kind: 'root', text: '未对空 token 兜底', ref: 'src/ghost.ts:10', branches: ['token 来自 localStorage', '冷启动时 token 尚未写入'] },
            { kind: 'impact', text: '登录直接失败，用户无法进入' },
            { kind: 'fix', text: '解构前判空并给出可操作的提示' },
          ],
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

    const recallCalls: Array<{ scope: string; task: string; limit: number }> = [];
    const deps: AnalysisRunnerDeps = {
      loadConfigFn: () => cfg,
      resolveLlmStatusFn: okLlmStatus,
      streamChatFn: fakeStream as typeof import('../../src/lib/chat/llm-client.js').streamChat,
      // 开场预取（ki_recall）——生产实现不在这里跑，只验证「调用 + 注入」这一层
      // ★ 按生产形状返回 MCP 信封：真机曾因为直接读 res.ok 把「成功 0 命中」误判成「不可用」
      recallFn: async (a) => {
        recallCalls.push(a);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              summary: '记忆里有同类事件与已定方案',
              candidates: [{ group: '排查记录', name: '登录故障笔记', why: '记录了 TOKEN_MISSING 的触发条件' }],
              uncertainties: ['未见上层重试逻辑'],
            }),
          }],
        };
      },
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

    // ── 开场预取（ki_recall）：程序调用一次并注入上下文，不靠模型自觉 ──
    assert.equal(recallCalls.length, 1, '每次分析只预取一次（模型调不到该工具，无递归风险）');
    assert.equal(recallCalls[0]!.scope, scope, '预取必须落在事件所在库');
    assert.ok(recallCalls[0]!.task.includes('登录报错 TOKEN_MISSING'), '画像要带事件标题');
    assert.ok(recallCalls[0]!.task.includes('移动端登录后偶发报错'), '画像要带事件描述');
    assert.ok(
      recallCalls[0]!.task.includes('排查记录 | 登录故障笔记'),
      '画像要带关联/参考文档的 group 路径与名称',
    );
    assert.ok(
      seenFirstUserMessages[0]!.includes('【知识库预取'),
      '预取结果必须进首轮 user 消息，否则等于没跑',
    );
    assert.ok(seenFirstUserMessages[0]!.includes('建议先读'), '要给出「建议先读」清单');
    const recallStep = (finalDoc.draft?.steps ?? []).find((st) => st.name === 'recall');
    assert.ok(recallStep, '预取要落成一条步骤，用户能在过程区看到它跑过');
    assert.ok(
      (recallStep!.title ?? '').includes('建议先读 1 篇'),
      `步骤标题要说明预取结果，实际：${recallStep!.title}`,
    );

    // ── 内置 skill 正文常驻（2026-11-19 真机 #48：33 轮一次 use_skill 都没调）──
    assert.ok(
      seenSystemPrompts[0]!.includes('【已加载 Skill：code-locate】'),
      '内置 code-locate 正文必须直接进 system：挂在 use_skill 后面等于没写',
    );
    assert.ok(
      seenSystemPrompts[0]!.includes('先看预取清单，再搜代码'),
      '检索纪律必须真的进上下文（真机 #48 那句只存在于按需加载的正文里，等于没写）',
    );
    assert.equal(
      seenSystemPrompts[0]!.includes('【AI 分析可用 Skill 目录'),
      false,
      '只有内置 skill 时不该再挂一份按需加载目录（正文已常驻）',
    );
    assert.equal(
      seenToolNames[0]!.includes('use_skill'),
      false,
      '没有自建 skill 时不该注册 use_skill，避免模型浪费一轮去加载已注入的方法论',
    );
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

    // ── 结论因果链（2026-11-19）：非法项丢弃、引用跟着候选校验一起剪 ──
    const chain = finalDoc.draft?.chain ?? [];
    assert.deepEqual(
      chain.map((n) => n.kind),
      ['symptom', 'cause', 'root', 'impact', 'fix'],
      '非法 kind 必须丢弃，节点顺序保持因果顺序',
    );
    assert.equal(chain.length, 5, '节点上限 5：多余节点不得进入落盘结果');
    assert.equal(chain[1]!.ref, 'src/login.ts:3', '指向真实候选的引用必须保留');
    assert.equal(chain[1]!.branches, undefined, 'branches 只允许挂在 root 上');
    assert.equal(chain[2]!.ref, undefined, '指向幻觉位置的引用必须被剪掉（节点文本保留）');
    assert.deepEqual(
      chain[2]!.branches,
      ['token 来自 localStorage', '冷启动时 token 尚未写入'],
      '根因下的触发条件必须原样保留',
    );
    // ── 调用明细：入参 / 返回 / 思考（2026-11-18，MCP 与本地工具同一条路径）──
    const toolSteps = (finalDoc.draft?.steps ?? []).filter((s) => (s.calls?.length ?? 0) > 0);
    assert.ok(toolSteps.length >= 2, '应有至少两轮带工具调用的步骤');
    const mcpCall = toolSteps[0]!.calls!.find((c) => c.name === 'ki_get_module_info');
    assert.ok(mcpCall, 'MCP 工具调用必须出现在过程里');
    assert.match(mcpCall!.args ?? '', /排查记录/, 'MCP 调用入参必须落盘');
    assert.ok((mcpCall!.response ?? '').length > 0, 'MCP 工具返回必须落盘（用户要能查看）');
    assert.equal(typeof mcpCall!.responseChars, 'number', '必须记录返回原文长度，供 UI 标「已截断」');
    assert.ok(
      (finalDoc.draft?.steps ?? []).some((s) => s.thinking?.includes('先看 KB')),
      '模型思考片段必须落盘到 steps[].thinking',
    );

    assert.ok(finalDoc.draft?.unconfirmed.some((u) => u.includes('src/ghost.ts')));
    assert.ok(finalDoc.draft?.unconfirmed.some((u) => u.includes('999')));
  });

  it('③ 总时长不再设限：时间推到 10 分钟也不会被强制收尾', async () => {
    const ev = await createEvent(scope, { title: '无总超时验证', typeId: 'et_1' });
    /*
     * 2026-11-18 用户拍板取消 90s 硬超时 + 75s 软收尾：原来 deps 里能注入 hard/softTimeoutMs
     * 把分析掐断，现在这两个注入口一并删除。这里用假时钟把"这一轮"推进 10 分钟，
     * 断言分析照常收尾，不会落 TIMEOUT。
     */
    let clock = Date.now();
    const slowButHealthy = async function* (): AsyncGenerator<StreamPart> {
      clock += 10 * 60_000;
      yield { type: 'content', text: JSON.stringify({ conclusion: '十分钟后才给结论', candidates: [], unconfirmed: [] }) };
      yield { type: 'done', finishReason: 'stop' };
    };

    await startEventAnalysis(scope, ev.id, {
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: okLlmStatus,
        nowFn: () => clock,
        recallFn: skipRecall,
        streamChatFn: slowButHealthy as typeof import('../../src/lib/chat/llm-client.js').streamChat,
      },
    });
    const doc = await waitDone(scope, ev.id);
    assert.notEqual(doc.draft?.errorCode, 'TIMEOUT', '不得再有总时长掐断');
    assert.equal(doc.draft?.conclusion, '十分钟后才给结论', '跑得久也要把结论完整落下来');
    // 无候选仍走 NO_RESULT（与超时无关的既有语义）
    assert.equal(doc.draft?.errorCode, 'NO_RESULT');
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
        recallFn: skipRecall,
        streamChatFn: hangingStream as typeof import('../../src/lib/chat/llm-client.js').streamChat,
        hardTimeoutMs: 30_000,
        softTimeoutMs: 30_000,
      },
    });

    /*
     * 等第一轮真的发出去再取消：开场预取（recall）会先跑一步，
     * 立刻取消会打在预取上、stream 根本不会启动 —— 那不是本用例要覆盖的路径。
     */
    for (let i = 0; i < 200 && upstreamCalls === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(upstreamCalls, 1, '应已进入第一轮上游调用（等 stream 挂起）');

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
        recallFn: skipRecall,
        streamChatFn: fakeStream as typeof import('../../src/lib/chat/llm-client.js').streamChat,
      },
    });
    const doc = await waitDone(scope, ev.id);
    assert.equal(doc.draft?.status, 'partial', '已产出候选时停止应落 partial，候选仍可确认');
    assert.equal(doc.draft?.errorCode, 'ANALYSIS_CANCELED');
    assert.equal(doc.draft?.candidates.length, 1, '停止不该丢弃已产出的候选');
    assert.equal(doc.draft?.conclusion, null, '模型未给结论时必须落 null（前端据此整块不渲染）');
  });

  it('⑥ 思考增量落盘：running 期间 liveThinking 可读，轮末并入 step 并清空', async () => {
    const ev = await createEvent(scope, { title: '思考流式落盘验证', typeId: 'et_1' });
    /** 20000 字上限之外的尾巴：用于验证 thinkingChars 记录原文长度（2026-11-18 由 2000 放宽） */
    const longTail = '乙'.repeat(25_000);
    const seenLive: Array<string | undefined> = [];
    let callTurn = 0;

    const fakeStream = async function* (): AsyncGenerator<StreamPart> {
      callTurn += 1;
      if (callTurn === 1) {
        /*
         * 分两段 reasoning。async generator 从 yield 恢复的前提是消费者已处理完上一段
         * （即 `for await` 的 body 跑完、包含那次节流写盘），所以此刻读到的是"刚写完的"增量。
         * 节流窗口 1s 内的第二段不会再写 —— 这正是要验证的节流行为。
         */
        yield { type: 'reasoning', text: '第一段思考' };
        seenLive.push(readNormalizedAnalysisDoc(scope, ev.id).draft?.liveThinking?.text);
        yield { type: 'reasoning', text: longTail };
        yield {
          type: 'tool_calls',
          calls: [{ id: 'c6', name: 'fs_read', arguments: JSON.stringify({ path: 'src/login.ts', offset: 1, limit: 5 }) }],
        };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      // 第二轮开始：上一轮已并入 steps，实时副本必须已被清空
      seenLive.push(readNormalizedAnalysisDoc(scope, ev.id).draft?.liveThinking?.text);
      yield { type: 'content', text: JSON.stringify({ candidates: [], unconfirmed: [] }) };
      yield { type: 'done', finishReason: 'stop' };
    };

    await startEventAnalysis(scope, ev.id, {
      deps: {
        loadConfigFn: () => cfg,
        resolveLlmStatusFn: okLlmStatus,
        streamChatFn: fakeStream as typeof import('../../src/lib/chat/llm-client.js').streamChat,
      },
    });

    const finalDoc = await waitDone(scope, ev.id);
    assert.equal(seenLive[0], '第一段思考', 'running 期间必须能读到增量思考（否则前端仍是"一轮跳一次"）');
    assert.equal(seenLive[1], undefined, '本轮并入 steps 后必须清空 liveThinking（否则同一段会展示两遍）');

    const thinkingStep = (finalDoc.draft?.steps ?? []).find((s) => s.thinking);
    assert.ok(thinkingStep, '轮末思考仍要随 step 落盘');
    assert.ok(thinkingStep!.thinking!.startsWith('第一段思考'));
    assert.equal(thinkingStep!.thinking!.length, 20_000, '异常兜底上限 20 000 字（2000 字会把正常思考砍尾）');
    assert.ok(
      (thinkingStep!.thinkingChars ?? 0) > 20_000,
      `thinkingChars 要记截断前的原文长度，实际 ${thinkingStep!.thinkingChars}`,
    );
    assert.equal(finalDoc.draft?.liveThinking, undefined, '收尾终态不得残留 liveThinking');
  });
});
