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
import { GovernanceError } from '../governance-errors.js';
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

/**
 * 事件是否已置顶（2026-11-19）：`pinnedAt` 有值即为已置顶。
 *
 * 与 `isEventClosed` 一样只认字段本身，不做任何推导 —— 取消置顶是**删字段**，
 * 不是写 0 / false，所以这里不判真假值而是判有无。
 */
export function isEventPinned(event: Pick<EventRecord, 'pinnedAt'>): boolean {
  return typeof event.pinnedAt === 'number' && event.pinnedAt > 0;
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

/**
 * 按 ref 找事件，找不到抛 `EVENT_NOT_FOUND`（**带 `available`：前 5 条未收口事件**）。
 *
 * 为什么要放在最底层的 store 而不是某个业务模块：`event-service` / `members` /
 * `refs-service` 三处都要用它，而 `event-service` 已经 import `members`——把这份实现
 * 放在任一业务模块里，其余模块反向 import 就会成环。store 只依赖 fs 与 types，无环。
 *
 * 只读一次 events：`available` 复用同一次快照，不重复扫盘（历史实现里有两次读）。
 */
export function mustFindEvent(scope: string, ref: string): EventRecord {
  const events = readAllEvents(scope);
  const event = findEventIn(events, ref);
  if (event) return event;
  const available = events
    .filter((e) => !isEventClosed(e))
    .slice(0, 5)
    .map((e) => ({ id: e.id, shortId: e.shortId, title: e.title }));
  throw new GovernanceError('EVENT_NOT_FOUND', `事件「${ref}」不存在`, { available });
}
