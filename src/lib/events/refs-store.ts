/**
 * 参考文档存储（REQ-20261113-004 · S-05 §3.1）
 *
 * 落点：`{scope}/.events/{eventId}.refs.json`
 *
 * 为什么独立文件而不塞进 `{eventId}.json`：
 *   引用是高频小写（加一条、删一条），事件主体是低频写（流转、改名）。同文件会让
 *   两者互相覆盖 —— 并发下"加引用"和"流转"必须串行，而它们本无冲突。
 *
 * 硬约束：本层**只读写 refs 文件**，绝不碰 `Relation`。`A13` 的验收就是
 * 「加入/移除前后，被引文档的分片条目字节级不变」。
 */

import fs from 'fs';
import path from 'path';
import { getEventsDir } from './store.js';
import { readJson, writeJson } from '../store.js';
import type { EventRefDoc, RefsDoc } from './types.js';

export function getRefsPath(scope: string, eventId: string): string {
  return path.join(getEventsDir(scope), `${eventId}.refs.json`);
}

export function readRefs(scope: string, eventId: string): EventRefDoc[] {
  try {
    const doc = readJson<RefsDoc>(getRefsPath(scope, eventId));
    return Array.isArray(doc?.refs) ? doc!.refs : [];
  } catch (err) {
    console.warn(`[refs] 引用文件损坏，按空处理（${eventId}）：${(err as Error).message}`);
    return [];
  }
}

function writeRefs(scope: string, eventId: string, refs: EventRefDoc[], now: number): EventRefDoc[] {
  const dir = getEventsDir(scope);
  fs.mkdirSync(dir, { recursive: true });
  const doc: RefsDoc = { version: 1, eventId, refs, updatedAt: now };
  writeJson(getRefsPath(scope, eventId), doc as unknown as Record<string, unknown>);
  return refs;
}

export function addRefDocs(
  scope: string,
  eventId: string,
  incoming: EventRefDoc[],
  now: number,
): { added: EventRefDoc[]; skipped: EventRefDoc[] } {
  const current = readRefs(scope, eventId);
  const key = (r: { group: string; name: string }) => `${r.group}\u0000${r.name}`;
  const existing = new Set(current.map(key));
  const added: EventRefDoc[] = [];
  const skipped: EventRefDoc[] = [];
  const next = [...current];

  for (const ref of incoming) {
    if (existing.has(key(ref))) {
      skipped.push(ref);
      continue;
    }
    existing.add(key(ref));
    next.push(ref);
    added.push(ref);
  }

  if (added.length > 0) writeRefs(scope, eventId, next, now);
  return { added, skipped };
}

export function removeRefDoc(scope: string, eventId: string, group: string, name: string, now: number): boolean {
  const current = readRefs(scope, eventId);
  const next = current.filter((r) => !(r.group === group && r.name === name));
  if (next.length === current.length) return false;
  writeRefs(scope, eventId, next, now);
  return true;
}

/** 删除事件时一并删除（弹窗承诺「引用关系一并消失」） */
export function removeRefsFile(scope: string, eventId: string): void {
  try {
    fs.rmSync(getRefsPath(scope, eventId), { force: true });
  } catch (err) {
    console.warn(`[refs] 删除引用文件失败 ${eventId}: ${(err as Error).message}`);
  }
}
