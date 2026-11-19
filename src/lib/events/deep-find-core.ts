/**
 * 「AI 查找」的模型通道 · 基于共享内核的实现（REQ-20261118-004 合并，2026-11-19）。
 *
 * 为什么要新文件而不是改 `find-runner`：后者把「循环 / 工具执行 / 三重校验 / 并发队列」
 * 全塞在一个 1000 行函数里，且 `steps`、`hitScores`、`saw*Search` 在**两个作用域**各声明一次 ——
 * 原地替换会连带打断面板数据（实测 tsc 报 9 处，已回滚）。所以这里做**同签名的第二实现**，
 * 验证通过后再切调用点、最后删旧循环。
 *
 * 与 `ki_recall` 的关系：**同一份内核**（`runGroundedRecall`）+ **同一份工具执行器**
 * （`makeRecallToolRunner`）。差异只在三处，且都不在循环里：
 *   ① 输入装配：事件 → 用户消息（`buildFindContext`）
 *   ② 强制 skill：`refs-locate`（挑参考文档）而非 `task-recall`
 *   ③ 产物落点：候选进面板、由人勾选写入 refs（`ki_recall` 是 agent 直接消费）
 */

import type { ChatTurn, LlmStreamPart } from '../chat/llm-client.js';
import { streamChat } from '../chat/llm-client.js';
import { GROUNDED_OUTPUT_SPEC, runGroundedRecall } from '../recall/run-recall.js';
import { makeRecallToolRunner } from '../recall/tool-runner.js';
import { readAllGroupCaches } from '../group-cache.js';
import { FIND_DEFAULT_TOOL_CALLS } from '../chat/prompt-config.js';
import { resolveVisibilityOfRelation } from '../visibility-index.js';
import { buildFindContext, type DeepFindDeps, type DeepFindResult, type UnconfirmedCandidate } from './find-runner.js';
import type { RefCandidate, RefSearchStep } from './refs-service.js';
import type { Visibility } from './types.js';

const TOOL_RESPONSE_CHARS = 10_000;
const DEFAULT_MAX_ROUNDS = 6;

export interface DeepFindCoreArgs {
  event: Parameters<typeof buildFindContext>[0]['event'];
  eventType: { name: string } | null;
  members: Parameters<typeof buildFindContext>[0]['members'];
  refs: Parameters<typeof buildFindContext>[0]['refs'];
  /** 允许检索的物理库（调用方已解析并鉴权） */
  targets: string[];
  viewOf: (name: string) => string[] | null;
  /** 提示词与 skill（来自 `prompt-config.find`，与 `ki_recall` 同一份域） */
  prompt: string;
  /** 本场景要内联的 skill 正文（`refs-locate`） */
  skills: Array<{ name: string; content: string; enabled: boolean }>;
  /** 已关联 / 已参考文档的 key（`scope\0group\0name`），不进候选 */
  usedKeys: ReadonlySet<string>;
  /**
   * 工具开关（来自 `prompt-config.find.tools`）。
   * 缺省全开：调用方漏传时不能把工具面收成空（老客户端没有这个字段）。
   */
  tools?: Record<string, boolean>;
  /**
   * 单次查找允许的工具调用次数上限（来自 `prompt-config.find.maxToolCalls`）。
   *
   * 缺省按 `FIND_DEFAULT_TOOL_CALLS`（15）处理：AI 查找**没有"不限制"档**，
   * 配置缺失或调用方漏传都不能退化成无限调用。
   */
  maxToolCalls?: number;
  llm: Record<string, unknown>;
  now?: () => number;
  signal?: AbortSignal;
  /** 工具调用进度（供 SSE 面板边跑边显示） */
  onProgress?: (call: { name: string; args: Record<string, unknown>; ms: number; ok: boolean; round: number }) => void;
  /** 测试注入 */
  stream?: (messages: ChatTurn[], opts?: Record<string, unknown>) => AsyncGenerator<LlmStreamPart>;
  /** 分片缓存读取（测试注入，避免依赖真实 kb 目录） */
  cachesOf?: (scope: string) => ReturnType<typeof readAllGroupCaches>;
  /** 工具执行器（测试注入，避免真检索） */
  runTool?: Parameters<typeof runGroundedRecall>[0]['runTool'];
}

function toolLabel(name: string): string {
  switch (name) {
    case 'ki_search': return '检索知识库';
    case 'ki_get_module_info': return '读取文档正文';
    case 'ki_group_list': return '查看知识树';
    case 'ki_tag_list': return '查看标签';
    default: return name;
  }
}

/**
 * 工具调用预算说明（每轮都会追加 —— 查找路径恒有上限，没有"不限制"档）。
 *
 * 为什么由**代码**追加、不放进用户可编辑的「检索定位提示词」：预算与执行侧的上限是同一份数，
 * 让用户改提示词就能改预算的话，两边迟早对不上（改了提示词 ≠ 运行期真的限那么多）。
 *
 * 为什么非要说给模型：只硬截断的话，模型会把次数花在试探性检索上，撞墙后才被迫收口，
 * 候选质量明显下降；提前告知它能按"先定位、再读正文"的顺序分配次数。
 */
function toolCallBudgetNote(maxToolCalls: number): string {
  return [
    '## 工具调用预算',
    `本次最多可以调用 ${maxToolCalls} 次工具（检索与读正文合计），次数用尽后你会被要求立刻收口。`,
    '先规划再动手：先用最少的检索定位，再读最可能相关的正文；不要用近似重复的检索反复试探。',
  ].join('\n');
}

/**
 * 模型通道主流程：**共享内核** → 三重校验 → 面板装配。
 *
 * ⚠️ 并发队列仍由 `find-runner` 负责（调用方在切过来之前先取槽），本函数只管一次调用。
 */
export async function runDeepFindCore(args: DeepFindCoreArgs): Promise<DeepFindResult> {
  const now = args.now ?? Date.now;
  const started = now();
  /*
   * 允许出现的**物理库**：targets 里的视图要展开成成员库。
   * 只比对 `targets.includes(src)` 会把视图成员的候选全判成越界（2026-11-17 真机缺陷）。
   * 视图名本身仍不可作为文档所在库（下面的 `viewOf(src) !== null` 拦掉）。
   */
  const allowed = new Set<string>();
  for (const t of args.targets) {
    allowed.add(t);
    const members = args.viewOf(t);
    if (members) for (const m of members) allowed.add(m);
  }
  /*
   * 没有"不限制"档：漏传 / 配置缺字段都按默认 15 次兜住。
   *
   * ⚠️ 必须与内核（`run-recall.ts`）用**同一套归一化**（整数 + 正数），否则会出现两类漂移：
   *   · `Infinity` → 内核判非法降级成"不限制"，而提示词写着"最多 Infinity 次"；
   *   · `2.5` → 提示词说 2.5，内核 floor 成 2，模型按 2.5 规划、实际只能跑 2 次。
   */
  const rawCalls = args.maxToolCalls;
  const maxToolCalls = typeof rawCalls === 'number' && Number.isInteger(rawCalls) && rawCalls > 0
    ? rawCalls
    : FIND_DEFAULT_TOOL_CALLS;

  const systemPrompt = [
    args.prompt.trim(),
    ...args.skills.filter((s) => s.enabled).map((s) => `### ${s.name}\n${s.content.trim()}`),
    toolCallBudgetNote(maxToolCalls),
    GROUNDED_OUTPUT_SPEC,
  ].filter(Boolean).join('\n\n');

  const grounded = await runGroundedRecall({
    systemPrompt,
    userMessage: buildFindContext({
      event: args.event,
      typeName: args.eventType?.name ?? null,
      stageKey: args.event.stageKey,
      members: args.members,
      refs: args.refs,
      targets: args.targets,
      viewOf: args.viewOf,
    }),
    exclude: [...args.usedKeys],
    limit: 20,
    tools: args.tools ?? { ki_search: true, ki_get_module_info: true, ki_group_list: true, ki_tag_list: true },
    maxRounds: DEFAULT_MAX_ROUNDS,
    maxToolCalls,
    llm: args.llm,
    stream: args.stream ?? ((messages, opts) => streamChat(messages, opts as never)),
    runTool: args.runTool ?? makeRecallToolRunner({ targets: args.targets, toolChars: TOOL_RESPONSE_CHARS }),
    now,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.onProgress ? { onToolCall: args.onProgress } : {}),
  });

  const unconfirmed: UnconfirmedCandidate[] = [];
  const candidates: RefCandidate[] = [];
  const seen = new Set<string>();
  const caches = new Map<string, ReturnType<typeof readAllGroupCaches>>();
  const cachesOf = (s: string): ReturnType<typeof readAllGroupCaches> => {
    if (args.cachesOf) return args.cachesOf(s);
    let c = caches.get(s);
    if (!c) {
      c = readAllGroupCaches(s);
      caches.set(s, c);
    }
    return c;
  };

  for (const hit of grounded.candidates) {
    const src = hit.scope;
    // ① 范围（视图名不是库，同样算越界）
    if (!allowed.has(src) || args.viewOf(src) !== null) {
      unconfirmed.push({ group: hit.group, name: hit.name, sourceScope: src, reason: 'out-of-scope' });
      continue;
    }
    // ② 存在性
    const rel = cachesOf(src).get(hit.group)?.hot_relations.find((r) => r.text === hit.name);
    if (!rel) {
      unconfirmed.push({ group: hit.group, name: hit.name, sourceScope: src, reason: 'not-found' });
      continue;
    }
    // ③ 未已用
    const key = `${src}\u0000${hit.group}\u0000${hit.name}`;
    if (args.usedKeys.has(key) || seen.has(key)) {
      unconfirmed.push({ group: hit.group, name: hit.name, sourceScope: src, reason: 'already-used' });
      continue;
    }
    seen.add(key);

    const visibility: Visibility = resolveVisibilityOfRelation(src, rel).mode;
    candidates.push({
      origin: 'deep',
      scope: src,
      group: hit.group,
      name: hit.name,
      // 共享内核不产出检索分数（模型按正文判断，不按分数），面板按 0 展示
      score: 0,
      // 只读到片段时如实标注（面板的 why 列会原样展示）
      why: hit.evidence === 'snippet' ? `${hit.why}（仅读到片段）` : hit.why,
      matchedKeywords: [],
      chunkHits: 0,
      weak: false,
      visibility,
    });
  }

  const steps: RefSearchStep[] = grounded.toolTrace.length > 0
    ? [{
      name: 'tools' as const,
      ms: grounded.durationMs,
      metrics: {
        calls: grounded.toolTrace.length,
        ok: grounded.toolTrace.filter((t) => t.ok).length,
        rounds: grounded.rounds,
      },
      calls: grounded.toolTrace.map((t) => ({
        kind: 'tool' as const,
        name: t.name,
        label: toolLabel(t.name),
        ms: t.ms,
        args: JSON.stringify(t.args).slice(0, 300),
        ...(t.ok ? {} : { note: '调用返回错误' }),
      })),
    }]
    : [];

  return {
    candidates,
    unconfirmed,
    steps,
    query: '',
    durationMs: now() - started,
    // 收口原因由内核给（budget = 工具调用次数用尽 / timeout = 超时）；只有片段降级时无原因，
    // 按历史口径仍报 timeout（`usedCalls` 让面板能如实说"用满 N 次"）
    ...(grounded.partial
      ? {
        partial: {
          reason: grounded.stopReason === 'budget' ? 'budget' as const : 'timeout' as const,
          usedRounds: grounded.rounds,
          usedCalls: grounded.toolTrace.length,
        },
      }
      : {}),
    unconfirmedCount: unconfirmed.length,
    parsed: grounded.parsedOk,
    // 与 `ki_recall` 同源的结论字段：MCP 侧一直在用，面板也应当能看到同一份
    ...(grounded.summary ? { summary: grounded.summary } : {}),
    ...(grounded.dropped > 0 ? { droppedCount: grounded.dropped } : {}),
    ...(grounded.uncertainties.length > 0 ? { uncertainties: grounded.uncertainties } : {}),
    // 内核按"实际发生的检索"聚合：全部降级才 fulltext，没有检索则不声称降级
    mode: grounded.mode ?? 'hybrid',
  };
}
