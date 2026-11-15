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
import { walWrite } from '../wal.js';
import type { EventRecord, EventTypeRecord, EventTypesDoc, EventsMeta } from './types.js';

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

// ─────────────────────────────────────────────────────────────
// 写路径（B3）：事件 / 类型 / meta。调用方必须已持 scope 写锁
// ─────────────────────────────────────────────────────────────

export function getEventPath(scope: string, eventId: string): string {
  return path.join(getEventsDir(scope), `${eventId}.json`);
}

export function getTypesPath(scope: string): string {
  return path.join(getEventsDir(scope), '_types.json');
}

export function getMetaPath(scope: string): string {
  return path.join(getEventsDir(scope), '_meta.json');
}

/** 写事件文件（walWrite 原子写） */
export function writeEvent(scope: string, event: EventRecord): void {
  const dir = getEventsDir(scope);
  fs.mkdirSync(dir, { recursive: true });
  walWrite(getEventPath(scope, event.id), event as unknown as Record<string, unknown>);
}

export function removeEventFile(scope: string, eventId: string): void {
  try {
    fs.rmSync(getEventPath(scope, eventId), { force: true });
  } catch (err) {
    console.warn(`[events] 删除事件文件失败 ${eventId}: ${(err as Error).message}`);
  }
}

/** 读完整类型文档（含 revision）；文件不存在返回 null，由调用方决定是否用内置缺省 */
export function readTypesDoc(scope: string): EventTypesDoc | null {
  try {
    return readJson<EventTypesDoc>(getTypesPath(scope));
  } catch (err) {
    throw new Error(`事件类型文件损坏（${getTypesPath(scope)}）：${(err as Error).message}`);
  }
}

export function writeTypesDoc(scope: string, doc: EventTypesDoc): void {
  const dir = getEventsDir(scope);
  fs.mkdirSync(dir, { recursive: true });
  walWrite(getTypesPath(scope), doc as unknown as Record<string, unknown>);
}

export function readMeta(scope: string): EventsMeta {
  try {
    const meta = readJson<EventsMeta>(getMetaPath(scope));
    if (meta && Number.isInteger(meta.nextShortId) && meta.nextShortId > 0) return meta;
  } catch (err) {
    // meta 损坏不该让整个事件模块不可用：从现有事件重算一个安全起点
    console.warn(`[events] _meta.json 损坏，按现有事件重算 shortId：${(err as Error).message}`);
  }
  const maxShortId = readAllEvents(scope).reduce((max, e) => Math.max(max, e.shortId ?? 0), 0);
  return { version: 1, nextShortId: maxShortId + 1 };
}

export function writeMeta(scope: string, meta: EventsMeta): void {
  const dir = getEventsDir(scope);
  fs.mkdirSync(dir, { recursive: true });
  walWrite(getMetaPath(scope), meta as unknown as Record<string, unknown>);
}

/**
 * 分配下一个 shortId 并立即落盘。
 *
 * `shortId` 会出现在 AI 参数与聊天记录里，**删除后不复用**（S-02 决策 7）：
 * 复用会把"历史对话里的 #3"绑到另一个事件上。
 */
export function allocateShortId(scope: string): number {
  const meta = readMeta(scope);
  const next = meta.nextShortId;
  writeMeta(scope, { version: 1, nextShortId: next + 1 });
  return next;
}

/** 事件 id：时间戳 base36 + 6 位随机（项目无 ulid 依赖，不引新包） */
export function newEventId(now = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `evt_${now.toString(36)}_${rand}`;
}
