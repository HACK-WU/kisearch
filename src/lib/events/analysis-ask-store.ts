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
import type { AnalysisAskTurn, EventAnalysisAskDoc } from './types.js';

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
}
