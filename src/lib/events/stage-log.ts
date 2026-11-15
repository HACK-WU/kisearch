/**
 * 流转日志（REQ-20261113-004 · S-02 §3.2）
 *
 * 落点：`{scope}/.events/{eventId}.log.jsonl`，一行一条 `EventStageLog`。
 *
 * 写入顺序（S-02 决策 5）：**状态先写、日志后追加**，日志失败不回滚状态。
 * 反序会产生「日志说有、状态说没有」的假记录，比缺一条日志更难排查。
 * 当前状态不依赖日志推导（`EventRecord.stageKey` / `closedAt` 是权威），所以丢一条只影响审计。
 *
 * 追加写用 `appendFileSync`：单行 ≤ 4KB，POSIX 下 O_APPEND 单次写是原子的；
 * 同一事件的并发流转本就被 scope 写锁串行化。
 */

import fs from 'fs';
import path from 'path';
import { getEventsDir } from './store.js';
import type { EventStageLog } from './types.js';

function logPath(scope: string, eventId: string): string {
  return path.join(getEventsDir(scope), `${eventId}.log.jsonl`);
}

/** 追加一条流转记录；失败只 warn，不影响主流程 */
export function appendStageLog(scope: string, entry: EventStageLog): { ok: boolean; warning?: string } {
  try {
    fs.mkdirSync(getEventsDir(scope), { recursive: true });
    fs.appendFileSync(logPath(scope, entry.eventId), `${JSON.stringify(entry)}\n`, 'utf-8');
    return { ok: true };
  } catch (err) {
    const warning = `流转日志写入失败（事件状态已生效）：${(err as Error).message}`;
    console.warn(`[events] ${warning}`);
    return { ok: false, warning };
  }
}

/** 读取某事件的全部流转记录（按写入顺序） */
export function readStageLogs(scope: string, eventId: string): EventStageLog[] {
  const file = logPath(scope, eventId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const out: EventStageLog[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as EventStageLog;
      if (parsed && typeof parsed.toKey === 'string') out.push(parsed);
    } catch {
      // 半行（进程被杀）跳过：审计日志不因一行坏数据整体不可读
    }
  }
  return out;
}

/** 删除事件时一并删除日志（弹窗承诺「流转记录一并消失」） */
export function removeStageLog(scope: string, eventId: string): void {
  try {
    fs.rmSync(logPath(scope, eventId), { force: true });
  } catch (err) {
    console.warn(`[events] 删除流转日志失败 ${eventId}: ${(err as Error).message}`);
  }
}
