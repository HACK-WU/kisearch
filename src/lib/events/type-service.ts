/**
 * 事件类型服务（REQ-20261113-004 · S-02 §3.5）
 *
 * 阶段约束（照抄实现会把功能做坏，逐条都有原因）：
 *   1. **只追加不删除**：已存在类型的阶段不能少。删一个阶段会让停在该阶段的事件变成
 *      悬空引用（`stageKey` 指向不存在的阶段），而事件记录不会因此报错，只会静默错位；
 *   2. **末位不可停用**：停用等于「永远进不去」，该类型的事件永远收不了口，只能靠
 *      `fallbackDays` 兜底清理；
 *   3. **`stageKey` 稳定**：拖动排序 / 改名都不动它。事件位置存的是 key，不是 index ——
 *      用 index 的话拖动一次所有事件就集体漂移一个阶段（S-02 §3.3）；
 *   4. **`terminalAction` 类型级**：不挂阶段。挂在阶段上时，追加一枚阶段就会让原终态
 *      动作失效（demo 的现状）。
 *
 * 读路径不建目录：`_types.json` 不存在时返回内置 3 类的内存视图，首次写操作才落盘。
 */

import { withScopeWriteLock } from '../scope-write-lock.js';
import { GovernanceError } from '../governance-errors.js';
import { buildBuiltinTypes, BUILTIN_EVENT_TYPE_IDS } from './builtin-types.js';
import { readTypesDoc, writeTypesDoc, readAllEvents } from './store.js';
import type { EventStage, EventTypeRecord, EventTypesDoc, Visibility } from './types.js';

const MAX_STAGES = 12;
const MIN_STAGES = 2;

function nowMs(): number {
  return Date.now();
}

/** 当前类型视图：文件不存在时用内置（不落盘） */
export function listTypes(scope: string): EventTypeRecord[] {
  const doc = readTypesDoc(scope);
  if (doc && Array.isArray(doc.types) && doc.types.length > 0) return doc.types;
  return buildBuiltinTypes(scope, nowMs());
}

export function getType(scope: string, id: string): EventTypeRecord | null {
  return listTypes(scope).find((t) => t.id === id) ?? null;
}

export function getTypeOrThrow(scope: string, id: string): EventTypeRecord {
  const type = getType(scope, id);
  if (!type) {
    throw new GovernanceError('TYPE_NOT_FOUND', `事件类型「${id}」不存在`, {
      available: listTypes(scope).map((t) => ({ id: t.id, name: t.name })),
    });
  }
  return type;
}

/** 落盘当前视图（首次写时把内置一并写下去，保证后续 revision 可追踪） */
function persist(scope: string, types: EventTypeRecord[]): EventTypesDoc {
  const doc: EventTypesDoc = { version: 1, revision: (readTypesDoc(scope)?.revision ?? 0) + 1, types };
  writeTypesDoc(scope, doc);
  return doc;
}

function nextTypeId(types: EventTypeRecord[]): string {
  const max = types.reduce((m, t) => {
    const match = /^et_(\d+)$/.exec(t.id);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return `et_${max + 1}`;
}

function maxStageNo(stages: EventStage[]): number {
  return stages.reduce((m, s) => {
    const match = /^st_(\d+)$/.exec(s.key);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
}

function validateStages(stages: EventStage[]): void {
  if (!Array.isArray(stages) || stages.length < MIN_STAGES) {
    throw new GovernanceError('TYPE_STAGES_TOO_FEW', `事件类型至少需要 ${MIN_STAGES} 个阶段（末位为终态）`);
  }
  if (stages.length > MAX_STAGES) {
    throw new GovernanceError('TYPE_STAGES_TOO_MANY', `事件类型最多 ${MAX_STAGES} 个阶段，收到 ${stages.length}`);
  }
  const names = stages.map((s) => s.name.trim());
  if (names.some((n) => !n)) {
    throw new GovernanceError('TYPE_STAGES_TOO_FEW', '阶段名不能为空');
  }
  if (new Set(names).size !== names.length) {
    throw new GovernanceError('TYPE_STAGES_TOO_FEW', `阶段名必须唯一：${names.join(' / ')}`);
  }
  if (stages[stages.length - 1].disabled) {
    throw new GovernanceError(
      'TERMINAL_STAGE_CANNOT_DISABLE',
      '末位阶段是终态，不能停用（停用后该类型的事件永远收不了口）',
    );
  }
}

export interface CreateTypeInput {
  name: string;
  stages?: Array<{ name: string; visibility: Visibility; disabled?: boolean }>;
  terminalAction?: 'keep' | 'trash';
  fallbackDays?: number | null;
}

export async function createType(scope: string, input: CreateTypeInput): Promise<EventTypeRecord> {
  return withScopeWriteLock(scope, 'event-type-write', async () => {
    const name = input.name?.trim();
    if (!name) throw new GovernanceError('TYPE_NOT_FOUND', '类型名不能为空');

    const types = listTypes(scope);
    if (types.some((t) => t.name === name)) {
      throw new GovernanceError('TYPE_IN_USE', `类型名「${name}」已存在`);
    }

    const rawStages = input.stages ?? [
      { name: '进行中', visibility: 'hidden' as Visibility },
      { name: '已完成', visibility: 'full' as Visibility },
    ];
    const stages: EventStage[] = rawStages.map((s, i) => ({
      key: `st_${i + 1}`,
      name: s.name.trim(),
      visibility: s.visibility,
      ...(s.disabled ? { disabled: true } : {}),
    }));
    validateStages(stages);

    const now = nowMs();
    const record: EventTypeRecord = {
      id: nextTypeId(types),
      scope,
      name,
      builtin: false,
      stages,
      terminalAction: input.terminalAction ?? 'keep',
      fallbackDays: input.fallbackDays === undefined ? 90 : input.fallbackDays,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    persist(scope, [...types, record]);
    return record;
  });
}

export interface UpdateTypePatch {
  /** 必填：乐观锁（N12：两个标签页同时编辑） */
  revision: number;
  name?: string;
  /** **只允许追加**：长度不得减少，已有 key 不得消失 */
  stages?: Array<{ key?: string; name: string; visibility: Visibility; disabled?: boolean }>;
  terminalAction?: 'keep' | 'trash';
  fallbackDays?: number | null;
}

export async function updateType(scope: string, id: string, patch: UpdateTypePatch): Promise<EventTypeRecord> {
  return withScopeWriteLock(scope, 'event-type-write', async () => {
    const types = listTypes(scope);
    const idx = types.findIndex((t) => t.id === id);
    if (idx < 0) {
      throw new GovernanceError('TYPE_NOT_FOUND', `事件类型「${id}」不存在`, {
        available: types.map((t) => ({ id: t.id, name: t.name })),
      });
    }
    const current = types[idx];
    if (patch.revision !== current.revision) {
      throw new GovernanceError(
        'REVISION_CONFLICT',
        `事件类型已被他人修改（当前版本 ${current.revision}，你的版本 ${patch.revision}），请刷新后重试`,
        { currentRevision: current.revision },
      );
    }

    let stages = current.stages;
    if (patch.stages) {
      const existingByKey = new Map(current.stages.map((s) => [s.key, s] as const));
      const nextKeys = new Set(patch.stages.map((s) => s.key).filter((k): k is string => Boolean(k)));

      // 已有阶段不许消失（只追加）
      for (const old of current.stages) {
        if (!nextKeys.has(old.key)) {
          throw new GovernanceError(
            'STAGE_DELETE_FORBIDDEN',
            `阶段「${old.name}」已存在于该类型，不能删除（只能追加）；停用它请用 disabled`,
          );
        }
      }

      let stageNo = maxStageNo(current.stages);
      stages = patch.stages.map((s) => {
        const old = s.key ? existingByKey.get(s.key) : undefined;
        if (old) {
          return {
            key: old.key,
            name: s.name.trim(),
            // 改名保留 originalName（Q6）：历史展示需要知道它曾叫什么
            ...(old.originalName ? { originalName: old.originalName } : old.name !== s.name.trim() ? { originalName: old.name } : {}),
            visibility: s.visibility,
            ...(s.disabled ? { disabled: true } : {}),
          };
        }
        stageNo += 1;
        return {
          key: `st_${stageNo}`,
          name: s.name.trim(),
          visibility: s.visibility,
          ...(s.disabled ? { disabled: true } : {}),
        };
      });
      validateStages(stages);
    }

    const nextName = patch.name?.trim() || current.name;
    const next: EventTypeRecord = {
      ...current,
      name: nextName,
      stages,
      terminalAction: patch.terminalAction ?? current.terminalAction,
      fallbackDays: patch.fallbackDays === undefined ? current.fallbackDays : patch.fallbackDays,
      revision: current.revision + 1,
      updatedAt: nowMs(),
    };

    const nextTypes = [...types];
    nextTypes[idx] = next;
    persist(scope, nextTypes);
    return next;
  });
}

export async function deleteType(scope: string, id: string): Promise<void> {
  return withScopeWriteLock(scope, 'event-type-write', async () => {
    const types = listTypes(scope);
    const target = types.find((t) => t.id === id);
    if (!target) throw new GovernanceError('TYPE_NOT_FOUND', `事件类型「${id}」不存在`);

    if (target.builtin || (BUILTIN_EVENT_TYPE_IDS as readonly string[]).includes(target.id)) {
      throw new GovernanceError('TYPE_BUILTIN', `「${target.name}」是内置类型，不能删除（可改阶段与可见性）`);
    }

    const inUse = readAllEvents(scope).filter((e) => e.typeId === id);
    if (inUse.length > 0) {
      throw new GovernanceError(
        'TYPE_IN_USE',
        `「${target.name}」仍被 ${inUse.length} 个事件使用（如 #${inUse[0].shortId} ${inUse[0].title}），不能删除`,
        { events: inUse.slice(0, 5).map((e) => ({ id: e.id, shortId: e.shortId, title: e.title })) },
      );
    }

    persist(scope, types.filter((t) => t.id !== id));
  });
}

/** 阶段可见性查表（流转时用；缺失/悬空 → full + 警告，见 S-03 N13） */
export function resolveStageVisibility(type: EventTypeRecord | null, stageKey: string): {
  visibility: Visibility;
  warning?: string;
} {
  if (!type) return { visibility: 'full', warning: '事件类型缺失，按 wiki 处理' };
  const stage = type.stages.find((s) => s.key === stageKey);
  if (!stage) return { visibility: 'full', warning: `阶段 ${stageKey} 不在类型「${type.name}」中（悬空引用）` };
  return { visibility: stage.visibility };
}
