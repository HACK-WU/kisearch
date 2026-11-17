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

/**
 * 引用去重 / 定位的键：**必须含源库**（REQ-20261116-005）。
 *
 * 为什么不能只用 `group\0name`：跨库后两个库可以有同名同 group 的文档，
 * 用旧键会把第二篇判成"已存在"而**静默跳过**；删除时则会删错库那一条。
 *
 * 老数据没有 `sourceScope` → 用 `scope`（事件库）归一，与改造前的键完全等价，
 * 因此不需要任何迁移脚本。
 */
export function refKey(r: { scope?: string; sourceScope?: string; group: string; name: string }): string {
  return `${r.sourceScope ?? r.scope ?? ''}\u0000${r.group}\u0000${r.name}`;
}

export function addRefDocs(
  scope: string,
  eventId: string,
  incoming: EventRefDoc[],
  now: number,
): { added: EventRefDoc[]; skipped: EventRefDoc[] } {
  const current = readRefs(scope, eventId);
  const existing = new Set(current.map(refKey));
  const added: EventRefDoc[] = [];
  const skipped: EventRefDoc[] = [];
  const next = [...current];

  for (const ref of incoming) {
    // 入参缺 sourceScope 时按事件库归一，才能与磁盘上的老记录对上
    const normalized: EventRefDoc = ref.sourceScope === undefined && ref.scope === undefined
      ? { ...ref, scope }
      : ref.sourceScope === undefined
        ? { ...ref, sourceScope: ref.scope }
        : ref;
    if (existing.has(refKey(normalized))) {
      skipped.push(normalized);
      continue;
    }
    existing.add(refKey(normalized));
    next.push(normalized);
    added.push(normalized);
  }

  if (added.length > 0) writeRefs(scope, eventId, next, now);
  return { added, skipped };
}

/**
 * 删除一条引用。
 *
 * @param target.sourceScope 缺省 = 事件库（兼容老前端与老数据）
 */
export function removeRefDoc(
  scope: string,
  eventId: string,
  target: { sourceScope?: string; group: string; name: string },
  now: number,
): boolean {
  const current = readRefs(scope, eventId);
  const wanted = refKey({ scope, sourceScope: target.sourceScope, group: target.group, name: target.name });
  const next = current.filter((r) => refKey(r) !== wanted);
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
