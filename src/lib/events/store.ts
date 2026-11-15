/**
 * 事件存储 · 读路径（B1 先建读取，B3 补写入）
 *
 * 落点：`{dataDir}/{scope}/.events/`
 *   _meta.json          { version, nextShortId }
 *   _types.json         { version, revision, types[] }
 *   {eventId}.json      EventRecord
 *   {eventId}.log.jsonl 流转日志
 *
 * 本文件在 B1 只服务「写入文档时校验事件是否可绑定」，因此：
 *   - **只读**：不创建目录、不写任何文件；
 *   - 单文件损坏 → 跳过并 warn（一篇坏事件不该让整个写入链路 500）；
 *   - `_` 前缀文件不是事件（元数据文件）。
 */

import fs from 'fs';
import path from 'path';
import { getKbDir, validateScope } from '../scope.js';
import { readJson } from '../store.js';
import type { EventRecord, EventTypeRecord, EventTypesDoc } from './types.js';

export function getEventsDir(scope: string): string {
  validateScope(scope);
  return path.join(getKbDir(scope), '.events');
}

/** 事件目录是否存在（读路径不创建） */
export function eventsDirExists(scope: string): boolean {
  try {
    return fs.statSync(getEventsDir(scope)).isDirectory();
  } catch {
    return false;
  }
}

export function readAllEvents(scope: string): EventRecord[] {
  const dir = getEventsDir(scope);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: EventRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue;
    try {
      const rec = readJson<EventRecord>(path.join(dir, name));
      if (rec && typeof rec.id === 'string' && typeof rec.stageKey === 'string') out.push(rec);
    } catch (err) {
      console.warn(`[events] 跳过损坏的事件文件 ${name}: ${(err as Error).message}`);
    }
  }
  return out;
}

export function readEventTypes(scope: string): EventTypeRecord[] {
  try {
    const doc = readJson<EventTypesDoc>(path.join(getEventsDir(scope), '_types.json'));
    return Array.isArray(doc?.types) ? doc!.types : [];
  } catch (err) {
    console.warn(`[events] 事件类型文件损坏，按空处理: ${(err as Error).message}`);
    return [];
  }
}

/**
 * 按 id 或 `#3` / `3` 查事件（MCP 与页面都传这两种写法）。
 *
 * 不抛异常：查不到返回 null，由调用方转成 `EVENT_NOT_FOUND` 并附可用列表。
 */
export function findEventIn(events: readonly EventRecord[], ref: string): EventRecord | null {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;

  const byId = events.find((e) => e.id === raw);
  if (byId) return byId;

  const shortRef = raw.replace(/^#/, '');
  if (!/^\d+$/.test(shortRef)) return null;
  const shortId = Number(shortRef);
  return events.find((e) => e.shortId === shortId) ?? null;
}

export function findEvent(scope: string, ref: string): EventRecord | null {
  return findEventIn(readAllEvents(scope), ref);
}

/** 事件是否已收口（唯一权威是 closedAt，不看是否停在末位阶段） */
export function isEventClosed(event: EventRecord): boolean {
  return event.closedAt !== null && event.closedAt !== undefined;
}
