/**
 * find-runner.test.ts —— 「AI 查找」深度通道（REQ-20261116-005 二期 · S-03）
 *
 * 覆盖五组：
 *   ① 门禁 5 路：未配模型 / 未确认外发 / 不支持工具 / 工具全关 / 同事件并发；
 *   ② 工具作用域注入：`ki_search` 的 scope 一律被 targets 覆盖，越界 scope 回给模型而不抛用户；
 *   ③ 三重校验：越界库 / 文档不存在 / 已作为关联或参考 → 进 `unconfirmed` 并剔除；
 *   ④ 预算：轮次用尽 → `partial.rounds`，候选上限截断；
 *   ⑤ 超时无候选 → `FIND_TIMEOUT`（不返回空成功）。
 *
 * 运行：npx jiti test/events/find-runner.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from '../test-config.js';
import { initScope } from '../../src/lib/store.js';
import { getKbDir } from '../../src/lib/scope.js';
import { loadGroupCache, writeGroupCache } from '../../src/lib/group-cache.js';
import type { Relation } from '../../src/lib/scoring.js';
import type { KiConfig } from '../../src/lib/config.js';
import { defaultFindConfig } from '../../src/lib/chat/prompt-config.js';
import { createEvent } from '../../src/lib/events/event-service.js';
import { addRefs } from '../../src/lib/events/refs-service.js';
import { runDeepFind, type DeepFindDeps } from '../../src/lib/events/find-runner.js';
import { runDeepFindAsSearchResult } from '../../src/lib/events/find-service.js';
import { GovernanceError } from '../../src/lib/governance-errors.js';
import type { ChatTurn, LlmStatus, StreamPart } from '../../src/lib/chat/llm-client.js';

const scope = `find-run-${Date.now()}`;
const GROUP = '部署运维';
const ART_A = '发布与回滚手册';
const ART_B = '值班检查清单';

let cfg: KiConfig;

function okStatus(): LlmStatus {
  return {
    enabled: true,
    reason: null,
    supportsImages: false,
    supportsTools: true,
    ackRequired: false,
    model: 'fake-model',
    baseURL: 'http://localhost',
    contextChars: 1_000_000,
    maxToolRounds: Infinity,
    askMaxRounds: 6,
    askSessionTtlMs: 600_000,
  };
}

function seed(name: string): void {
  const rel: Relation = {
    id: `rel_${name.length}_${name.replace(/\W/g, '')}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
  };
  const doc = loadGroupCache(scope, GROUP) ?? { version: 1, scope, hot_relations: [], keywords: [], updatedAt: null };
  doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
  doc.hot_relations.push(rel);
  writeGroupCache(scope, GROUP, doc);
}

/** 一轮只回工具调用；最后一轮回候选 JSON */
function scriptedStream(script: Array<{ text?: string; calls?: Array<{ name: string; args: unknown }> }>) {
  let turn = 0;
  const seen: ChatTurn[][] = [];
  const fn = async function* (messages: ChatTurn[]): AsyncGenerator<StreamPart> {
    seen.push(messages.map((m) => ({ ...m })));
    const step = script[Math.min(turn, script.length - 1)]!;
    turn += 1;
    if (step.calls) {
      yield {
        type: 'tool_calls',
        calls: step.calls.map((c, i) => ({ id: `c${turn}-${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
      };
      return;
    }
    yield { type: 'content', text: step.text ?? '' };
  };
  return { fn, seen, turns: () => turn };
}

function baseConfig(over: Partial<ReturnType<typeof defaultFindConfig>> = {}) {
  const d = defaultFindConfig();
  return { ...d, ...over };
}

function deps(over: Partial<DeepFindDeps> & { stream: DeepFindDeps['llm'] } ): DeepFindDeps {
  return {
    targets: [scope],
    config: baseConfig(),
    kiConfig: cfg,
    llm: over.stream!,
    ...over,
  };
}

before(() => {
  registerTestScope(scope);
  initScope(scope);
  seed(ART_A);
  seed(ART_B);
  cfg = {
    dataDir: path.dirname(getKbDir(scope)),
    chatDir: path.join(path.dirname(getKbDir(scope)), 'chat'),
    // 额度给足：本文件多次调用，避免撞到日配额干扰断言
    llm: { baseURL: 'http://localhost', model: 'fake-model', apiKey: 'k', analysisDailyLimit: 1_000 },
  } as KiConfig;
});

after(() => {
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('① 门禁', () => {
  it('模型未就绪 / 未确认外发 / 不支持工具 / 工具全关 各有独立错误码', async () => {
    const ev = await createEvent(scope, { title: '门禁验证', typeId: 'et_1' });
    const noop = { stream: scriptedStream([{ text: '[]' }]).fn, status: () => okStatus() };

    await assert.rejects(
      () => runDeepFind(scope, ev.id, deps({ stream: { ...noop, status: () => ({ ...okStatus(), enabled: false, reason: '未配置模型' }) } })),
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_LLM_UNAVAILABLE',
    );
    await assert.rejects(
      () => runDeepFind(scope, ev.id, deps({ stream: { ...noop, status: () => ({ ...okStatus(), ackRequired: true }) } })),
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_DISCLOSURE_REQUIRED',
    );
    await assert.rejects(
      () => runDeepFind(scope, ev.id, deps({ stream: { ...noop, status: () => ({ ...okStatus(), supportsTools: false }) } })),
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_TOOLS_UNSUPPORTED',
    );
    await assert.rejects(
      () => runDeepFind(scope, ev.id, deps({
        stream: noop,
        config: baseConfig({
          tools: { ki_search: false, ki_get_module_info: false, ki_group_list: false, ki_tag_list: false },
        }),
      })),
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_TOOLS_ALL_DISABLED',
    );
  });

  it('同一事件并发 → FIND_BUSY（直接拒绝，不复用）', async () => {
    const ev = await createEvent(scope, { title: '并发验证', typeId: 'et_1' });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hanging = async function* (): AsyncGenerator<StreamPart> {
      await gate;
      yield { type: 'content', text: '[]' };
    };
    const first = runDeepFind(scope, ev.id, deps({ stream: { stream: hanging, status: () => okStatus() } }));
    await assert.rejects(
      () => runDeepFind(scope, ev.id, deps({ stream: { stream: scriptedStream([{ text: '[]' }]).fn, status: () => okStatus() } })),
      (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_BUSY',
    );
    release();
    await first;
  });
});

describe('② 工具作用域注入 + ③ 三重校验', () => {
  it('ki_search 的 scope 被覆盖为检索范围；越界 scope 回给模型而不是抛用户；三类候选被剔除', async () => {
    const ev = await createEvent(scope, { title: '发布后回滚失败', typeId: 'et_1' });
    // 已作为关联文档：模型再给一次应被剔除
    await createEvent(scope, { title: '占位事件', typeId: 'et_1' });

    const script = scriptedStream([
      {
        calls: [
          { name: 'ki_search', args: { query: '回滚', scope: 'evil-scope' } },
          { name: 'ki_get_module_info', args: { scope: 'evil-scope', group: GROUP, relation: ART_A } },
        ],
      },
      {
        text: [
          '```json',
          JSON.stringify([
            { sourceScope: scope, group: GROUP, name: ART_A, reason: '命中回滚步骤' },
            { sourceScope: 'evil-scope', group: GROUP, name: '别的库文档', reason: '越界' },
            { sourceScope: scope, group: GROUP, name: '并不存在的文档', reason: '编的' },
          ]),
          '```',
        ].join('\n'),
      },
    ]);

    const askedScopes: string[] = [];
    const searched: string[] = [];
    const result = await runDeepFind(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
      search: async ({ scope: s, query }) => {
        askedScopes.push(s);
        searched.push(query);
        return { results: [{ scope, group: GROUP, relation: ART_A, score: 0.82 }] };
      },
      getModuleInfo: async () => ({ content: '正文' }),
    }));

    assert.deepEqual(askedScopes, [scope], 'ki_search 的 scope 必须是检索范围，不能被模型传的覆盖');
    assert.deepEqual(searched, ['回滚']);
    // 越界 scope 的读正文请求应以"给模型看的错误"回填
    const toolMessages = script.seen[1]!.filter((m) => m.role === 'tool').map((m) => String(m.content));
    assert.ok(toolMessages.some((t) => t.includes('不在本次检索范围内')), `越界 scope 应回给模型：${toolMessages.join(' | ')}`);

    assert.equal(result.candidates.length, 1, '只有真实存在且在范围内的那篇留下');
    const kept = result.candidates[0]!;
    assert.equal(kept.origin, 'deep');
    assert.equal(kept.scope, scope);
    assert.equal(kept.name, ART_A);
    assert.equal(kept.score, 0.82, 'score 取该库内最后一次检索命中分');
    assert.equal(kept.chunkHits, 0, '深度通道没有 chunk 聚合，用 0 表示未统计');
    assert.deepEqual(
      result.unconfirmed.map((u) => u.reason).sort(),
      ['not-found', 'out-of-scope'],
    );
    assert.equal(result.unconfirmedCount, 2);

    const names = result.steps.map((s) => s.name);
    assert.ok(names.includes('understand') && names.includes('tools') && names.includes('verify'), names.join(','));
    const toolStep = result.steps.find((s) => s.name === 'tools')!;
    assert.equal(toolStep.calls?.length, 2, '每个工具调用都要有一条真实调用行');
    assert.ok(toolStep.calls?.some((c) => c.note?.includes('覆盖模型传入的 scope')), '覆盖 scope 要留痕');
  });
});

describe('③b 已用过的文档', () => {
  it('已经在参考文档里的再出现 → unconfirmed: already-used', async () => {
    const ev = await createEvent(scope, { title: '是否已加入验证', typeId: 'et_1' });
    addRefs(scope, ev.id, { docs: [{ group: GROUP, name: ART_A }], addedBy: 'manual' });
    const script = scriptedStream([{
      text: JSON.stringify([{ sourceScope: scope, group: GROUP, name: ART_A, reason: '重复' }]),
    }]);
    const result = await runDeepFind(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
    }));
    assert.equal(result.candidates.length, 0);
    assert.equal(result.unconfirmed[0]?.reason, 'already-used');
  });
});

describe('④ 预算', () => {
  it('轮次用尽 → partial.rounds，仍返回已拿到的候选', async () => {
    const ev = await createEvent(scope, { title: '轮次预算验证', typeId: 'et_1' });
    // 第 1 轮走工具（用满唯一额度），第 2 轮被强制收尾 → 直接给候选
    const script = scriptedStream([
      { calls: [{ name: 'ki_search', args: { query: '回滚' } }] },
      { text: JSON.stringify([{ sourceScope: scope, group: GROUP, name: ART_B, reason: '命中' }]) },
    ]);
    const result = await runDeepFind(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
      search: async () => ({ results: [] }),
      config: baseConfig({ maxRounds: 1 }),
    }));
    assert.equal(result.partial?.reason, 'rounds');
    assert.equal(result.candidates.length, 1);
  });

  it('候选上限截断', async () => {
    const ev = await createEvent(scope, { title: '候选上限验证', typeId: 'et_1' });
    const script = scriptedStream([{
      text: JSON.stringify([
        { sourceScope: scope, group: GROUP, name: ART_A, reason: 'a' },
        { sourceScope: scope, group: GROUP, name: ART_B, reason: 'b' },
      ]),
    }]);
    const result = await runDeepFind(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
      config: baseConfig({ maxCandidates: 1 }),
    }));
    assert.equal(result.candidates.length, 1);
    assert.equal(result.unconfirmed[0]?.reason, 'truncated', '超上限的候选要透出，不能静默丢');
    assert.equal(result.unconfirmedCount, 1);
  });
});

describe('⑤ 超时', () => {
  it('超时且无候选 → FIND_TIMEOUT（不返回空成功）', async () => {
    const ev = await createEvent(scope, { title: '超时验证', typeId: 'et_1' });
    const hang = async function* (_m: ChatTurn[], opts?: { signal?: AbortSignal }): AsyncGenerator<StreamPart> {
      await new Promise<void>((resolve) => {
        opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'content', text: '' };
    };
    // 硬超时定时器是 unref 的（生产里不该撑着进程），测试需要一个活跃 handle 让它真的触发
    const keepAlive = setTimeout(() => {}, 5_000);
    try {
      await assert.rejects(
        () => runDeepFind(scope, ev.id, deps({
          stream: { stream: hang as never, status: () => okStatus() },
          config: baseConfig({ timeoutMs: 1_000 }),
        })),
        (e: unknown) => e instanceof GovernanceError && e.code === 'FIND_TIMEOUT',
      );
    } finally {
      clearTimeout(keepAlive);
    }
  });
});

describe('⑥ 服务层形状（与快速通道同形，前端一套渲染）', () => {
  it('补全 total / totalByScope / targets / excluded，无候选时 reason=no-hits 且 parsed 如实', async () => {
    const ev = await createEvent(scope, { title: '服务层形状验证', typeId: 'et_1' });
    const script = scriptedStream([{ text: '模型说：我没有找到相关文档（不是 JSON）' }]);
    const result = await runDeepFindAsSearchResult(scope, ev.id, deps({
      stream: { stream: script.fn, status: () => okStatus() },
    }));

    assert.deepEqual(result.targets, [scope]);
    assert.ok(result.totalByScope?.[0]?.docs >= 2, `库统计要有值：${JSON.stringify(result.totalByScope)}`);
    assert.equal(result.total, result.totalByScope?.[0]?.docs);
    assert.equal(result.reason, 'no-hits', '无候选走 no-hits，具体原因靠 parsed 区分');
    assert.equal(result.parsed, false, '模型输出不是 JSON 时必须如实标 parsed:false');
    assert.equal(result.candidates.length, 0);
    assert.ok(result.steps.some((s) => s.name === 'verify'));
    assert.deepEqual(result.excluded.associated, []);
  });
});

describe('⑦ auto-review 修复锁（预算语义 / 名次 / excluded 口径）', () => {
  it('预算不被 llm.requestTimeoutMs 夹取；库内名次按分数降序；excluded 只给文档名', async () => {
    const ev = await createEvent(scope, {
      title: '预算与名次验证',
      typeId: 'et_1',
      docs: [{ group: GROUP, name: ART_A }],
    });
    const script = scriptedStream([
      { calls: [{ name: 'ki_search', args: { query: '回滚' } }] },
      { text: JSON.stringify([{ sourceScope: scope, group: GROUP, name: ART_B, reason: '命中' }]) },
    ]);
    const r = await runDeepFindAsSearchResult(scope, ev.id, {
      targets: [scope],
      config: baseConfig({ timeoutMs: 45_000 }),
      // 单轮请求上限配得很小：不得因此把整次查找的总预算也压到 5s
      kiConfig: {
        ...cfg,
        llm: { ...(cfg.llm as object), requestTimeoutMs: 5_000 } as KiConfig['llm'],
      },
      llm: { stream: script.fn, status: () => okStatus() },
      // 两篇都命中，ART_B 分数更高 → 名次应为 1
      search: async () => ({
        results: [
          { scope, group: GROUP, relation: ART_B, score: 0.9 },
          { scope, group: GROUP, relation: ART_A, score: 0.4 },
        ],
      }),
    });

    const understand = r.steps.find((x) => x.name === 'understand')!;
    assert.equal(understand.metrics.timeoutMs, 45_000, '总预算取 find.timeoutMs，不被 llm.requestTimeoutMs 夹取');
    assert.equal(r.candidates[0]?.rankInScope, 1, '名次按分数降序算，不是命中出现顺序');
    assert.deepEqual(r.excluded.associated, [ART_A], 'excluded 与快速通道同口径：只给文档名');
  });
});
