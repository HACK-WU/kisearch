/**
 * find-runner.ts —— 「AI 查找」深度通道的并发槽与上下文装配（REQ-20261116-005 二期 · S-03）
 *
 * 2026-11-19：旧执行器 `runDeepFind` 已删除（运行期改走 `deep-find-core.runDeepFindCore`，
 * 与 `ki_recall` 共用同一个模型循环）。本文件只保留仍在用的四块：
 *   ① **并发 / 排队**：不同事件可并行（默认 3 个），**同一 `(scope, eventId)` 串行排队**
 *      （复用会让两个人看到同一份进行中结果）。队列满 / 等待超时才拒绝。
 *   ② 上下文装配 `buildFindContext`；③ 候选块解析 `parseCandidateBlock`；
 *   ④ 两条通道共用的出参类型（`DeepFindResult` / `DeepFindDeps` / `UnconfirmedCandidate`）。
 *
 * 工具作用域由共享执行器（`recall/tool-runner.makeRecallToolRunner`）注入，候选三重校验
 * （范围 → 存在性 → 未已用）在 `deep-find-core`；本文件不再持有这两份逻辑。
 */

import type { KiConfig } from '../config.js';
import type { ChatTurn, LlmStatus, LlmStreamPart } from '../chat/llm-client.js';
import type { FindConfig } from '../chat/prompt-config.js';
import type { GroundedToolRunner } from '../recall/run-recall.js';
import { GovernanceError } from '../governance-errors.js';
import type { RefCandidate, RefSearchStep } from './refs-service.js';
import type { EventRecord } from './types.js';

/**
 * 整次深度查找的硬超时（防挂死兜底）。
 *
 * 2026-11-18：轮次 / 候选数 / 超时三项预算**整体取消**（用户拍板"直接取消"），
 * 只留这一条**硬编码、不可配、不进设置页**的安全线 —— 模型卡住时请求不会永不返回。
 * 2026-11-19：执行位置随旧 `runDeepFind` 删除迁到 `find-service`（能力不跟着旧函数走）。
 */
export const FIND_HARD_TIMEOUT_MS = 45_000;

// ─── 并发与排队（REQ-20261116-005 二期）────────────────────────────

/**
 * 跨事件并行执行上限。
 *
 * 为什么不是 1：不同事件之间没有共享状态（各自的 events / refs / 分片），限制成 1 只会
 * 让两个人互相等。真实瓶颈在下面两层，这里只是"别让一次点 20 个把上游打满"。
 *   ① 工具调用：`OperationCoordinator` 的 read 车道（`maxWorkers = min(4, CPU)`）本来就会排队；
 *   ② 上游模型：每次 `streamChat` 独立 HTTP 请求，无全局池化。
 */
export const FIND_MAX_CONCURRENT = 3;
/** 等待队列上限（跨所有事件合计）；满了直接拒绝，不让请求无限堆积 */
export const FIND_QUEUE_MAX = 8;
/** 单次排队等待上限；超过即放弃（客户端不会为此无限等） */
export const FIND_QUEUE_WAIT_MS = 20_000;

interface FindWaiter {
  key: string;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * 运行时限制（模块级：生产恒为默认值；单测可用 `deps.limits` 临时收窄）。
 * 放在模块级是因为 `pump` 需要在不带参数的情况下做调度。
 */
const findLimits = {
  maxConcurrent: FIND_MAX_CONCURRENT,
  queueMax: FIND_QUEUE_MAX,
  queueWaitMs: FIND_QUEUE_WAIT_MS,
};

let activeFindRuns = 0;
const runningKeys = new Set<string>();
const findWaiters: FindWaiter[] = [];

function runKey(scope: string, eventId: string): string {
  return `deep\u0000${scope}\u0000${eventId}`;
}

/**
 * **仅单测用**：把并发 / 队列限制与运行时状态复位。
 * 生产不调用（默认值随进程启动固定）。测试之间必须复位，否则前一个用例收窄的上限会漏给下一个。
 */
export function resetFindConcurrencyForTest(): void {
  findLimits.maxConcurrent = FIND_MAX_CONCURRENT;
  findLimits.queueMax = FIND_QUEUE_MAX;
  findLimits.queueWaitMs = FIND_QUEUE_WAIT_MS;
  activeFindRuns = 0;
  runningKeys.clear();
  findWaiters.length = 0;
}

/** 当前并发快照（排障用：前端/日志想知道"卡在队列还是在跑"） */
export function deepFindConcurrency(): { active: number; max: number; queued: number } {
  return { active: activeFindRuns, max: findLimits.maxConcurrent, queued: findWaiters.length };
}

/**
 * **仅单测用**：把并发 / 队列上限收窄到可测规模（生产不调用）。
 * 与 `resetFindConcurrencyForTest` 成对：每个用例前复位，否则收窄值会漏给下一个。
 */
export function setFindLimitsForTest(limits: { maxConcurrent?: number; queueMax?: number; queueWaitMs?: number }): void {
  Object.assign(findLimits, limits);
}

/**
 * 调度：只要还有空位，就按 FIFO 启动**同一个 key 最早的那个**等待者。
 * 同 key 串行靠"前面还有同 key 等待者就跳过"实现，而不是另外加锁。
 */
function pumpFindQueue(): void {
  for (let i = 0; i < findWaiters.length; ) {
    const w = findWaiters[i]!;
    const sameKeyEarlier = findWaiters.slice(0, i).some((x) => x.key === w.key);
    if (activeFindRuns >= findLimits.maxConcurrent || runningKeys.has(w.key) || sameKeyEarlier) {
      i += 1;
      continue;
    }
    findWaiters.splice(i, 1);
    activeFindRuns += 1;
    runningKeys.add(w.key);
    w.resolve();
  }
}

/**
 * 取一个执行槽位（必要时排队）。
 *
 * @param signal 前端断开时出队并中止，避免"用户早关页面了还在排"
 */
/**
 * 取并发槽（上限 `FIND_MAX_CONCURRENT` + 排队 `FIND_QUEUE_MAX` + 等待 `FIND_QUEUE_WAIT_MS`）。
 * 2026-11-19 导出：`deep-find-core`（共享内核实现）切换时要用同一套并发保护，
 * 否则两条实现各排一套队列，上限形同虚设。
 */
export async function acquireFindSlot(key: string, signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw new GovernanceError('FIND_CANCELED', '查找已被中止');
  // 有空位且没有同 key 在跑/在等 → 直接跑，不进队列（省掉一次微任务与定时器）
  if (!runningKeys.has(key) && !findWaiters.some((w) => w.key === key) && activeFindRuns < findLimits.maxConcurrent) {
    activeFindRuns += 1;
    runningKeys.add(key);
    return 0;
  }
  const enqueuedAt = Date.now();
  if (findWaiters.length >= findLimits.queueMax) {
    throw new GovernanceError(
      'FIND_BUSY',
      `深度查找队列已满（最多 ${findLimits.queueMax} 个排队），请稍后再试或改用快速查找`,
      { active: activeFindRuns, max: findLimits.maxConcurrent, queued: findWaiters.length },
    );
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let settled = false;
    /*
     * 三种结局（出队执行 / 排队超时 / 前端断开）都必须走同一个 `settle`：
     * 任一出口漏了出队，队列里就会留下一具"幽灵"，把位置占死到进程重启。
     */
    const settle = (finalize: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      const idx = findWaiters.indexOf(waiter);
      if (idx >= 0) findWaiters.splice(idx, 1);
      finalize();
    };
    const waiter: FindWaiter = {
      key,
      resolve: () => settle(resolve),
      reject: (err) => settle(() => reject(err)),
    };
    timer = setTimeout(() => {
      waiter.reject(new GovernanceError(
        'FIND_QUEUE_TIMEOUT',
        `排队等待超过 ${Math.round(findLimits.queueWaitMs / 1000)} 秒，请稍后再试或改用快速查找`,
      ));
    }, findLimits.queueWaitMs);
    onAbort = (): void => waiter.reject(new GovernanceError('FIND_CANCELED', '查找已被中止'));
    signal?.addEventListener('abort', onAbort, { once: true });
    findWaiters.push(waiter);
    pumpFindQueue();
  });
  // 同步请求没法中途告知"排在第几位"，只能事后把等了多久如实告诉面板
  return Date.now() - enqueuedAt;
}

/**
 * 释放并发槽。**必须放在 finally**：异常路径漏放会让该 key 永久占位。
 * 2026-11-19 导出（与 `acquireFindSlot` 成对，供切换期的新实现复用）。
 */
export function releaseFindSlot(key: string): void {
  runningKeys.delete(key);
  activeFindRuns = Math.max(0, activeFindRuns - 1);
  pumpFindQueue();
}

export interface UnconfirmedCandidate {
  group: string;
  name: string;
  sourceScope?: string;
  /** 未通过校验的具体原因（前端折叠展示，供排障） */
  reason: 'out-of-scope' | 'not-found' | 'already-used' | 'malformed' | 'truncated';
}

export interface DeepFindResult {
  candidates: RefCandidate[];
  /** 模型给出但未通过校验的项 */
  unconfirmed: UnconfirmedCandidate[];
  steps: RefSearchStep[];
  /** 实际发给检索的 query（模型自己生成的，这里给的是首轮线索，仅作面板展示） */
  query: string;
  durationMs: number;
  /**
   * 提前结束（结果不完整）：`timeout` = 硬超时；`budget` = 工具调用次数用尽（2026-11-19）。
   * `usedCalls` = 实际执行过的工具调用数，面板据此说出"用满 N 次"而不是只报轮次。
   */
  partial?: { reason: 'timeout' | 'budget'; usedRounds: number; usedCalls?: number };
  unconfirmedCount: number;
  /** 模型输出不可解析时置 false（前端据此显示"模型未给出可解析结果"而不是"没有相关文档"） */
  parsed: boolean;
  /** 模型写的整体结论（3 句以内；0 候选时说明查了什么、为什么没有） */
  summary?: string;
  /** 模型判断不了的点（如实交代不确定性，不要调用方补信息） */
  uncertainties?: string[];
  /** 模型提到但未通过校验（没读全 / 重复）被剔除的条数 */
  droppedCount?: number;
  /**
   * 本次所有检索轮次的**聚合检索模式**：
   * 全部轮次都走全文 → `fulltext`（面板必须如实显示"仅全文"）；只要有一轮走了语义 → `hybrid`。
   * 没有任何检索（模型直接凭清单判断）也按 `hybrid`（不声称降级）。
   */
  mode: 'hybrid' | 'fulltext';
}

export interface DeepFindDeps {
  /** 检索范围（`resolveFindTargets` 的结果）；工具作用域的唯一来源 */
  targets: string[];
  /** 查找配置；缺省从 `prompt-config` 域读（HTTP 会传同一份，测试可覆盖个别字段） */
  config?: FindConfig;
  /** 配置（用于 LLM 门禁与单轮请求超时）；缺省 `loadConfig()` */
  kiConfig?: KiConfig;
  llm?: {
    stream: (messages: ChatTurn[], opts?: Record<string, unknown>) => AsyncGenerator<LlmStreamPart>;
    status: (cfg: KiConfig) => LlmStatus;
  };
  /**
   * **仅单测用**：工具执行器注入（生产走 `makeRecallToolRunner`）。
   * 形状与共享内核一致，`read` 用于"候选必须真读过正文"的校验。
   */
  runTool?: GroundedToolRunner;
  /** 视图名 → 成员库（默认读 `views.json`）；用于把视图名纠错成成员库 */
  viewMembers?: (name: string) => string[] | null;
  /**
   * 工具调用进度回调（2026-11-19）：SSE 面板据此边跑边显示。
   * 只在 `stream=1` 时注入；不注入时行为与之前完全一致。
   */
  onProgress?: (call: { name: string; args: Record<string, unknown>; ms: number; ok: boolean; round: number }) => void;
  /** 前端断开时中止（与硬超时共用 signal，靠 `timedOut` 标记区分终态） */
  signal?: AbortSignal;
  /**
   * **仅单测用**：覆盖硬超时（生产不传 = `FIND_HARD_TIMEOUT_MS` 45s）。
   *
   * 2026-11-18 起超时不再可配（用户侧无 `find.timeoutMs`），否则单测要真等 45s。
   */
  hardTimeoutMs?: number;
  /**
   * **仅单测用**：把并发 / 队列上限收窄到可测规模（生产不传 = 默认值）。
   * 不放进 `FindConfig`：这是部署侧容量参数，不该成为用户在设置页能改的东西。
   */
  limits?: { maxConcurrent?: number; queueMax?: number; queueWaitMs?: number };
  nowFn?: () => number;
}

/** 事件上下文（只给清单，不给正文 —— 正文由模型按需读） */
export function buildFindContext(args: {
  event: EventRecord;
  typeName: string | null;
  stageKey: string;
  members: Array<{ group: string; name: string }>;
  refs: Array<{ group: string; name: string; sourceScope: string }>;
  targets: string[];
  viewOf: (name: string) => string[] | null;
}): string {
  const { event, typeName, stageKey, members, refs, targets, viewOf } = args;
  const targetText = targets.map((t) => {
    const view = viewOf(t);
    return view ? `${t}（视图 · ${view.length} 个成员库）` : `${t}（知识库）`;
  }).join(' / ');
  const listOf = (items: string[]): string => (items.length === 0 ? '（无）' : `\n${items.map((x) => `- ${x}`).join('\n')}`);

  return [
    '<find-request>',
    `事件：#${event.shortId} ${event.title} · ${typeName ?? '未分类'} · ${stageKey}`,
    ...(event.description?.trim() ? ['<event-description>', event.description.trim().slice(0, 2_000), '</event-description>'] : []),
    `关联文档（${members.length} 篇，仅路径与名称）：${listOf(members.map((m) => `${m.group}/${m.name}`))}`,
    `已有参考文档（${refs.length} 篇）：${listOf(refs.map((r) => `${r.sourceScope && r.sourceScope !== targets[0] ? `[${r.sourceScope}] ` : ''}${r.group}/${r.name}`))}`,
    '</find-request>',
    '',
    '<find-scope>',
    `本次可检索范围：${targetText}`,
    '只能在此范围内检索与读取正文；范围外的库一律不可用。',
    '</find-scope>',
  ].join('\n');
}

