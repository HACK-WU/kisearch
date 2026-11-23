/**
 * analysis-ask-store.ts —— 事件「追问这次分析」记录存储（2026-11-17 · S-06 / B2）
 *
 * 落点：`{scope}/.events/{eventId}.ask.json`
 *
 * 关键不变量：
 * 1. **独立文件**：不塞进 `.analysis.json` —— 后者会被「丢弃草稿」清空、被重新分析覆盖，
 *    追问记录必须跨多轮分析保留。
 * 2. **独立锁键**：`\0analysis-ask:<hash>`，与 `analysis` 锁分离，不与运行中的分析互相阻塞。
 * 3. **双重上限**：条数 200 + 字节 512KB，超限从**最旧**开始裁；写入前先裁后写。
 * 4. **删除与追加互斥**：`removeAskFile` 也走同一把锁，并在删除前复核事件仍在，
 *    避免「删除事件」与「追加问答」并发把文件重建成孤儿。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getEventsDir } from './store.js';
import { readJson } from '../store.js';
import { walWrite } from '../wal.js';
import { withScopeWriteLock } from '../scope-write-lock.js';
import type {
  AnalysisAskRunning,
  AnalysisAskTurn,
  AskRunningStep,
  EventAnalysisAskDoc,
} from './types.js';

/** 单文件字节上限（中文最坏 3B/字：200 轮 × 4000 字会到 ~4.8MB，必须按字节裁） */
export const ASK_DOC_MAX_BYTES = 512 * 1024;
/** 条数上限（与字节上限同时生效，先到先裁） */
export const ASK_DOC_MAX_TURNS = 200;

export function getAskPath(scope: string, eventId: string): string {
  return path.join(getEventsDir(scope), `${eventId}.ask.json`);
}

function askLockKey(scope: string, eventId: string): string {
  const hash = crypto.createHash('sha256').update(`${scope}\0${eventId}`).digest('hex').slice(0, 24);
  return `\u0000analysis-ask:${hash}`;
}

function emptyDoc(eventId: string): EventAnalysisAskDoc {
  return { version: 1, eventId, turns: [], updatedAt: Date.now() };
}

/** 读记录：文件缺失或损坏一律归一为空 doc（不抛，读取不该让页面挂掉） */
export function readAskDoc(scope: string, eventId: string): EventAnalysisAskDoc {
  const file = getAskPath(scope, eventId);
  let raw: EventAnalysisAskDoc | null = null;
  try {
    raw = readJson<EventAnalysisAskDoc>(file);
  } catch (err) {
    // `readJson` 对损坏 JSON 会抛 CORRUPT_JSON；追问记录不值得让整个接口 500
    console.warn(`[analysis-ask] 记录损坏，按空处理：${file}（${(err as Error).message.split('\n')[0]}）`);
    return emptyDoc(eventId);
  }
  if (!raw || !Array.isArray(raw.turns)) {
    if (raw !== null) console.warn(`[analysis-ask] 记录结构异常，按空处理：${file}`);
    return emptyDoc(eventId);
  }
  return {
    version: 1,
    eventId,
    turns: raw.turns.filter((t): t is AnalysisAskTurn => Boolean(t && typeof t.id === 'string')),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
}

/** 按字节 + 条数裁剪（保留最新） */
function trimTurns(turns: AnalysisAskTurn[]): { turns: AnalysisAskTurn[]; truncated: boolean } {
  let list = turns.slice(-ASK_DOC_MAX_TURNS);
  let truncated = list.length !== turns.length;
  let bytes = Buffer.byteLength(JSON.stringify({ version: 1, turns: list }));
  while (bytes > ASK_DOC_MAX_BYTES && list.length > 0) {
    list = list.slice(1);
    truncated = true;
    bytes = Buffer.byteLength(JSON.stringify({ version: 1, turns: list }));
  }
  return { turns: list, truncated };
}

export interface AppendAskTurnResult {
  doc: EventAnalysisAskDoc;
  /** 本次写入是否触发了裁剪（响应里回给前端） */
  truncated: boolean;
}

/** 追加一轮问答（持独立锁；先裁后写） */
export async function appendAskTurn(
  scope: string,
  eventId: string,
  turn: AnalysisAskTurn,
): Promise<AppendAskTurnResult> {
  return withScopeWriteLock(askLockKey(scope, eventId), 'analysis-ask', async () => {
    const cur = readAskDoc(scope, eventId);
    const trimmed = trimTurns([...cur.turns, turn]);
    const next: EventAnalysisAskDoc = {
      version: 1,
      eventId,
      turns: trimmed.turns,
      updatedAt: Date.now(),
    };
    walWrite(getAskPath(scope, eventId), next);
    return { doc: next, truncated: trimmed.truncated };
  });
}

/**
 * 标记某一轮补丁"被用户采纳"（S03 R-23 审计用）。
 *
 * 只在覆盖**成功之后**调用：失败时用户其实没采纳，先标记会造假。
 * 找不到该轮（记录被清空 / 裁剪掉）时静默返回 —— 审计字段不该让一次成功的覆盖变成失败。
 */
export async function markAskProposalAccepted(
  scope: string,
  eventId: string,
  turnId: string,
): Promise<void> {
  await withScopeWriteLock(askLockKey(scope, eventId), 'analysis-ask', async () => {
    const cur = readAskDoc(scope, eventId);
    const idx = cur.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) return;
    const turns = [...cur.turns];
    turns[idx] = { ...turns[idx]!, proposalAccepted: true };
    walWrite(getAskPath(scope, eventId), { version: 1, eventId, turns, updatedAt: Date.now() });
  });
}

/** 清空本事件追问记录，返回清掉的条数 */
export async function clearAskTurns(scope: string, eventId: string): Promise<number> {
  return withScopeWriteLock(askLockKey(scope, eventId), 'analysis-ask', async () => {
    const cur = readAskDoc(scope, eventId);
    const next: EventAnalysisAskDoc = { version: 1, eventId, turns: [], updatedAt: Date.now() };
    walWrite(getAskPath(scope, eventId), next);
    return cur.turns.length;
  });
}

/**
 * 事件删除时清理（同步强删，与 `removeAnalysisFile` 同规格）。
 *
 * 已知竞态：与并发 `appendAskTurn` 不互斥，极端情况下文件会被重建（成为孤儿）。
 * 取舍：删除事件本身已持 scope 锁、且追问要求草稿存在，实际窗口极小；
 * 若将来要彻底消除，把本函数改成 `withScopeWriteLock` + 锁内复核事件存在即可（需 async 化）。
 */
export function removeAskFile(scope: string, eventId: string): void {
  const file = getAskPath(scope, eventId);
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    console.warn(`[analysis-ask] 清理失败（忽略）：${file} ${(err as Error).message}`);
  }
  // 运行态也要清：否则事件删了、正在跑的那轮结束前，别的路径读到的仍是「有追问在进行」
  clearAskRunning(scope, eventId);
}

// ─── 进行中追问的运行态（2026-11-23 · #82）────────────────────────────

/**
 * 僵尸判定：超过这个时长没更新的运行态视为已死（进程被杀 / 卡住）。
 *
 * 取 15 分钟：单轮 LLM 请求上限 300s、追问最多 5 轮，正常最坏也在 25 分钟内；
 * 留足余量的同时，被杀进程留下的记录不会让页面永远显示「正在追答」。
 */
export const ASK_RUNNING_STALE_MS = 15 * 60 * 1000;
/** 节流写盘间隔：让切页/刷新回来的人看到尽量新的半截，又不至于把写盘打成洪峰 */
export const ASK_RUNNING_FLUSH_MS = 800;
/**
 * 单步正文上限 / 最多保留的步骤数（运行态的体积护栏）。
 *
 * 不加的话，长思考（每段增量都累积进同一步）+ 5 轮工具调用会让运行态到几百 KB，
 * 而它每 800ms 写一次、前端还每 2s 拉一次 —— IO 与带宽都被一个"预览"吃掉。
 * 步骤只用于重建过程区，保留最近若干步与截断后的文本足够表达"跑到哪了"。
 */
export const ASK_RUNNING_STEP_TEXT_MAX = 1200;
export const ASK_RUNNING_MAX_STEPS = 30;

/** 运行态落点：与 `.ask.json` 同目录、同前缀，但独立文件（历史记录不受影响） */
export function getAskRunningPath(scope: string, eventId: string): string {
  return path.join(getEventsDir(scope), `${eventId}.ask.running.json`);
}

/**
 * 读运行态：缺失 / 损坏 / 僵尸一律按「没有正在进行的追问」处理。
 *
 * 这条路径被 GET 高频调用（前端 2s 轮询），所以不抛错、不告警刷屏；
 * 僵尸记录顺手删掉，避免每次读都要重判。
 */
export function readAskRunning(
  scope: string,
  eventId: string,
  now = Date.now(),
): AnalysisAskRunning | null {
  const file = getAskRunningPath(scope, eventId);
  let raw: AnalysisAskRunning | null = null;
  try {
    raw = readJson<AnalysisAskRunning>(file);
  } catch {
    return null;
  }
  if (!raw || typeof raw.question !== 'string' || !Array.isArray(raw.steps)) return null;
  const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0;
  if (!updatedAt || now - updatedAt > ASK_RUNNING_STALE_MS) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 删不掉就当没有，不影响读取方 */
    }
    return null;
  }
  return {
    version: 1,
    // 旧文件（无 id）用 startedAt 兜底，仅供展示/清理，不参与并发比对
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${eventId}-${raw.startedAt ?? 0}`,
    eventId,
    question: raw.question,
    runId: typeof raw.runId === 'string' ? raw.runId : null,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : updatedAt,
    updatedAt,
    answer: typeof raw.answer === 'string' ? raw.answer : '',
    steps: raw.steps.filter((s): s is AskRunningStep => Boolean(s && typeof s.id === 'string')),
  };
}

/** 写运行态（同步落盘；调用方已做节流） */
export function writeAskRunning(scope: string, eventId: string, state: AnalysisAskRunning): void {
  walWrite(getAskRunningPath(scope, eventId), state);
}

/** 删除运行态；删不掉不抛（读侧本来就把缺失当无事） */
export function clearAskRunning(scope: string, eventId: string): void {
  try {
    fs.rmSync(getAskRunningPath(scope, eventId), { force: true });
  } catch (err) {
    console.warn(`[analysis-ask] 运行态清理失败（忽略）：${(err as Error).message}`);
  }
}

/** 运行态步骤裁剪：保留最近若干步，单步文本超限时截断（护栏见上方常量注释） */
function clipRunningSteps(steps: readonly AskRunningStep[]): AskRunningStep[] {
  return steps.slice(-ASK_RUNNING_MAX_STEPS).map((s) => (
    s.text.length > ASK_RUNNING_STEP_TEXT_MAX
      ? { ...s, text: `${s.text.slice(0, ASK_RUNNING_STEP_TEXT_MAX)}…` }
      : s
  ));
}

/** 运行态写入器：首写同步、后续节流，结束时自删 */
export interface AskRunningTracker {
  /** 合并一次快照（answer / steps）；内部节流写盘 */
  update(patch: { answer?: string; steps?: AskRunningStep[] }): void;
  /** 立刻落盘（测试与收口时用） */
  flush(): void;
  /** 清定时器并删除运行态（成功、失败、异常都必须调） */
  stop(): void;
}

/**
 * 开一次运行态跟踪。
 *
 * 首写是**同步**的：用户追问后立刻切页，回来必须能马上看到「正在追答 + 问题」，
 * 等到第一个 800ms 节流窗口才落盘就晚了。
 */
export function startAskRunning(
  scope: string,
  eventId: string,
  init: { question: string; runId: string | null; now?: number },
): AskRunningTracker {
  const startedAt = init.now ?? Date.now();
  const state: AnalysisAskRunning = {
    version: 1,
    id: `ar_${startedAt.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    eventId,
    question: init.question,
    runId: init.runId,
    startedAt,
    updatedAt: startedAt,
    answer: '',
    steps: [],
  };
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (stopped) return;
    try {
      state.updatedAt = Date.now();
      writeAskRunning(scope, eventId, state);
    } catch (err) {
      // 运行态只是「让回来的人看半截」，写不进去不能影响追问本身
      console.warn(`[analysis-ask] 运行态写入失败（忽略）：${(err as Error).message}`);
    }
  };

  const tracker: AskRunningTracker = {
    update(patch) {
      if (stopped) return;
      if (typeof patch.answer === 'string') state.answer = patch.answer;
      if (Array.isArray(patch.steps)) state.steps = clipRunningSteps(patch.steps);
      if (timer) return;
      timer = setTimeout(flush, ASK_RUNNING_FLUSH_MS);
      timer.unref?.();
    },
    flush,
    stop() {
      if (stopped) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      stopped = true;
      /*
       * 只删**自己这条**：同一事件极端并发两轮追问时，先结束的那轮不能把后结束的
       * 运行态抹掉（否则回来的人看到「没有在追答」，而实际上还在跑）。
       * 用运行态自己的 `id` 比对 —— 不能用 startedAt：同毫秒两轮会撞号。
       */
      const cur = readAskRunning(scope, eventId);
      if (cur && cur.id !== state.id) return;
      clearAskRunning(scope, eventId);
    },
  };

  flush();
  return tracker;
}
