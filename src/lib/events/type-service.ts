/**
 * 事件类型服务（REQ-20261113-004 · S-02 §3.5）
 *
 * 阶段约束（照抄实现会把功能做坏，逐条都有原因）：
 *   1. **只追加不删除**：已存在类型的阶段不能少。删一个阶段会让停在该阶段的事件变成
 *      悬空引用（`stageKey` 指向不存在的阶段），而事件记录不会因此报错，只会静默错位；
 *   2. **末位不可停用**：停用等于「永远进不去」，该类型的事件永远收不了口。
 *      此处原本写「只能靠 `fallbackDays` 兜底清理」，但兜底任务从未实现（事件 #76，
 *      `fallbackDays` 至今无消费点）—— 所以这条约束现在是**硬**的：真停用了末位，
 *      事件只能人工在页面捞，别指望自动清理；
 *   3. **`stageKey` 稳定**：拖动排序 / 改名都不动它。事件位置存的是 key，不是 index ——
 *      用 index 的话拖动一次所有事件就集体漂移一个阶段（S-02 §3.3）；
 *   4. **`terminalAction` 类型级**：不挂阶段。挂在阶段上时，追加一枚阶段就会让原终态
 *      动作失效（demo 的现状）。
 *   5. **末位名固定为「已关闭」**（2026-11-26）：改名 / 后移 / 删除一律拒绝，创建时自动补、
 *      追加时自动插到它之前。收口判定按末位 index，靠的正是「末位唯一且语义统一」。
 *
 * 读路径不建目录：`_types.json` 不存在时返回内置 3 类的内存视图，首次写操作才落盘。
 */

import { withScopeWriteLock } from '../scope-write-lock.js';
import { GovernanceError } from '../governance-errors.js';
import { buildBuiltinTypes } from './builtin-types.js';
import { readTypesDoc, writeTypesDoc, readAllEvents } from './store.js';
import { EVENT_TYPE_DESCRIPTION_MAX_CHARS, TERMINAL_STAGE_NAME } from './types.js';
import type { EventStage, EventTypeRecord, EventTypesDoc, Visibility } from './types.js';

/** 导出给迁移工具复用：直写 `_types.json` 的路径（migrate-*.ts）绕过了 `validateStages`，需自己兜这两条 */
export const MAX_STAGES = 12;
const MIN_STAGES = 2;

/**
 * 类型描述归一（REQ-20261123-007 · S-01）。
 *
 * 三种输入必须区分开，否则 PATCH 会误伤：
 *   · `undefined` → 不改（PATCH 语义：省略即保持）
 *   · `null` / 空串 / 纯空白 → **清除**（落盘时删字段，不写空串）
 *   · 超长 → fail-loud，不容忍静默截断（截断后用户看到的与他写的不是一回事）
 */
function normalizeTypeDescription(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  const text = String(input ?? '').trim();
  if (!text) return undefined;
  if (text.length > EVENT_TYPE_DESCRIPTION_MAX_CHARS) {
    throw new GovernanceError(
      'TYPE_DESCRIPTION_TOO_LONG',
      `类型描述 ${text.length} 字，超过上限 ${EVENT_TYPE_DESCRIPTION_MAX_CHARS} 字`,
    );
  }
  return text;
}

function nowMs(): number {
  return Date.now();
}

/** 当前类型视图：文件不存在时用内置（不落盘） */
export function listTypes(scope: string): EventTypeRecord[] {
  const doc = readTypesDoc(scope);
  if (doc && Array.isArray(doc.types) && doc.types.length > 0) return mergeBuiltinTypes(scope, doc.types);
  return buildBuiltinTypes(scope, nowMs());
}

/**
 * 把内置定义合进盘上视图（REQ-20261123-007 · S-02）。
 *
 * 为什么需要：内置定义原先只在 `_types.json` 缺失时生效，一旦落盘就再也不参与 ——
 * 新增的内置类型（技术债）永远到不了已有库。这里改为**读时并集**：
 *   · 盘上已有同名条目 → 视作「认领」，只补 `builtin: true`，**其余字段一律以盘上为准**
 *     （否则用户对内置做过的阶段与可见性调整会在每次读时被代码常量打回，等于改了立刻失效）；
 *   · 盘上没有 → 按内置 id 追加；id 已被别的类型占用时**改分配新 id 追加**，绝不顶替
 *     （顶替会把「线上事故」改名成「技术债」，事件绑定全部错乱）。
 *
 * 硬约束：**读路径不写盘**（首次写操作才由 `persist` 把并集落盘完成转正）。
 * 认领结果只存在于内存视图，`getType` / `listTypes` 的所有消费方立即看到正确集合。
 */
function mergeBuiltinTypes(scope: string, disk: EventTypeRecord[]): EventTypeRecord[] {
  const builtins = buildBuiltinTypes(scope, nowMs());
  const out: EventTypeRecord[] = [...disk];

  for (const builtin of builtins) {
    const claimIdx = out.findIndex((t) => t.name === builtin.name);
    if (claimIdx >= 0) {
      const disk = out[claimIdx];
      const needsBuiltinFlag = !disk.builtin;
      /*
       * 描述是**唯一**会从内置定义补进盘上条目的字段，且只补「空」的情况。
       * 为什么破例：内置描述是本需求新加的字段，早于它落盘的库（如 kisearch-memory）
       * 盘上永远没有该字段，「以盘上为准」会让这批库永远看不到内置说明。
       * 副作用是有意的：清空内置类型的描述 = 恢复默认描述（自定义类型不受影响，仍可留空）。
       */
      const needsDescription = !disk.description && Boolean(builtin.description);
      if (needsBuiltinFlag || needsDescription) {
        out[claimIdx] = {
          ...disk,
          ...(needsBuiltinFlag ? { builtin: true } : {}),
          ...(needsDescription ? { description: builtin.description } : {}),
        };
      }
      continue;
    }

    if (!out.some((t) => t.id === builtin.id)) {
      out.push(builtin);
      continue;
    }

    const occupant = out.find((t) => t.id === builtin.id)!;
    const newId = nextTypeId(out);
    console.warn(
      `[events] 内置类型「${builtin.name}」的 id ${builtin.id} 已被「${occupant.name}」占用，改分配 ${newId}`,
    );
    out.push({ ...builtin, id: newId });
  }
  return out;
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

/**
 * 把「已关闭」固定到末位（2026-11-26 用户拍板）。
 *
 * 三种输入都必须收敛到同一形状：
 *   · 完全没有 → 用 `makeTerminal()` 造一条追加；
 *   · 在中间 → 提到末位（**保留原 key 与可见性**：事件位置存 key，换 key 就是数据漂移）；
 *   · 同名多条 → 只留第一条，其余丢弃（否则「阶段名必须唯一」会报错，用户还看不出该删哪条）。
 *
 * **不动 `disabled`**：末位被停用必须由 `validateStages` 显式报 1108 ——
 * 这里静默清掉会让用户以为「点了停用却没生效」。
 */
function pinTerminalStage(stages: EventStage[], makeTerminal: () => EventStage): EventStage[] {
  const last = stages[stages.length - 1];
  const closingCount = stages.filter((s) => s.name.trim() === TERMINAL_STAGE_NAME).length;
  // 已经唯一且在最末：原样返回，绝不重排（重排会换掉末位 key，停在那里的事件就成了悬空引用）
  if (last && last.name.trim() === TERMINAL_STAGE_NAME && closingCount === 1) return stages;

  /*
   * 优先保留**末位那条**（哪怕它叫别的名字、另有同名在中间）：
   * 末位的 key 被已收口事件引用着，换 key 等于让那些事件指向不存在的阶段。
   */
  const closing = last?.name.trim() === TERMINAL_STAGE_NAME
    ? last
    : stages.find((s) => s.name.trim() === TERMINAL_STAGE_NAME);
  const rest = stages.filter((s) => s !== closing && s.name.trim() !== TERMINAL_STAGE_NAME);
  if (closingCount > 1) {
    console.warn(`[events] 阶段链里有多条「${TERMINAL_STAGE_NAME}」，只保留末位那条`);
  }
  return [...rest, closing ?? makeTerminal()];
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
  /*
   * 末位名固定（2026-11-26）：收口动作挂在「到达末位」，末位名各类型不一（已完成 / 已上线 /
   * 已收敛）时看板与 AI 无法统一判断「关没关」。改名先于停用检查 —— 名字错时先纠正名字，
   * 报「不能停用」会让人以为只需取消停用。
   */
  const last = stages[stages.length - 1];
  if (last.name.trim() !== TERMINAL_STAGE_NAME) {
    throw new GovernanceError(
      'TERMINAL_STAGE_REQUIRED',
      `末位阶段必须是「${TERMINAL_STAGE_NAME}」（收到「${last.name}」）：它是唯一的收口入口，`
        + '改名会让该类型的事件永远停在中间阶段',
      { expected: TERMINAL_STAGE_NAME, received: last.name },
    );
  }
  if (last.disabled) {
    throw new GovernanceError(
      'TERMINAL_STAGE_CANNOT_DISABLE',
      '末位阶段是终态，不能停用（停用后该类型的事件永远收不了口）',
    );
  }
}

export interface CreateTypeInput {
  name: string;
  /** 类型用途说明（≤200 字）；null / 空串等同未描述 */
  description?: string | null;
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

    /*
     * 缺省骨架只给一个中间阶段，末位由 `pinTerminalStage` 补 ——
     * 自建类型也必须有「已关闭」（2026-11-26 用户要求），不再让用户自己记着加。
     */
    const rawStages = input.stages?.length ? input.stages : [
      { name: '进行中', visibility: 'hidden' as Visibility },
    ];
    const baseStages: EventStage[] = rawStages.map((s, i) => ({
      key: `st_${i + 1}`,
      name: s.name.trim(),
      visibility: s.visibility,
      ...(s.disabled ? { disabled: true } : {}),
    }));
    const stages = pinTerminalStage(baseStages, () => ({
      key: `st_${maxStageNo(baseStages) + 1}`,
      name: TERMINAL_STAGE_NAME,
      visibility: 'full' as Visibility,
    }));
    validateStages(stages);

    const description = normalizeTypeDescription(input.description);
    const now = nowMs();
    const record: EventTypeRecord = {
      id: nextTypeId(types),
      scope,
      name,
      ...(description ? { description } : {}),
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
  /** 类型用途说明：省略 = 不改；null / 空串 = 清除 */
  description?: string | null;
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
      const terminalKey = current.stages[current.stages.length - 1]?.key;
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
          const nextStageName = s.name.trim();
          /*
           * 末位名的两端都要拦 —— 归一函数无法替用户决定意图：
           *   · 把末位改名 → 归一只能理解成「新增中间阶段 + 补一条末位」，用户会看到凭空多一行；
           *   · 把别的阶段改名成「已关闭」→ 出现两条同名，保留哪条取决于数组顺序，等于随机换 key。
           * 两者都 fail-loud，文案指向「末位固定」这条规则。
           */
          /*
           * 只看「本来就是末位『已关闭』」的类型：存量未迁移类型（末位仍叫 已完成 / 已上线）
           * 必须放行，否则用户连可见性都改不了 —— 它们的收口阶段靠归一补齐，不是改名。
           */
          if (old.key === terminalKey && old.name.trim() === TERMINAL_STAGE_NAME && nextStageName !== TERMINAL_STAGE_NAME) {
            throw new GovernanceError(
              'TERMINAL_STAGE_REQUIRED',
              `末位阶段固定为「${TERMINAL_STAGE_NAME}」，不能改名（收到「${nextStageName}」）：`
                + '它是该类型唯一的收口入口；想记录结果请追加一个中间阶段',
              { expected: TERMINAL_STAGE_NAME, received: nextStageName },
            );
          }
          if (
            old.key !== terminalKey
            && nextStageName === TERMINAL_STAGE_NAME
            && current.stages.some((s) => s.key === terminalKey && s.name.trim() === TERMINAL_STAGE_NAME)
          ) {
            throw new GovernanceError(
              'TERMINAL_STAGE_REQUIRED',
              `「${TERMINAL_STAGE_NAME}」只能出现在末位：不能把中间阶段改成同名`,
              { expected: TERMINAL_STAGE_NAME, received: nextStageName },
            );
          }
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
      /*
       * 追加阶段一律落到「已关闭」之前（2026-11-26）：否则新阶段会顶掉收口入口，
       * 该类型从此再也收不了口。**归一而非报错** —— 前端仍按「追加到末尾」提交，
       * 顺序由服务端保证唯一，用户不必知道这条规则。
       *
       * 这里刻意**不动已有阶段的可见性**：把原末位降档必须与「存量已收口事件吸附」
       * 成对执行（见 migrate-closing-stage.ts），只降不吸会把停在原末位的历史事件
       * 静默降为「仅全文」，一次索引重建后语义检索就再也搜不到它们。
       */
      stages = pinTerminalStage(stages, () => ({
        key: `st_${maxStageNo(stages) + 1}`,
        name: TERMINAL_STAGE_NAME,
        visibility: 'full',
      }));
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
    /*
     * description 三态必须分开处理：`...current` 已把旧值带过来，
     * 因此「清除」必须显式 delete —— 只靠展开永远清不掉。
     */
    if (patch.description !== undefined) {
      const desc = normalizeTypeDescription(patch.description);
      if (desc) next.description = desc;
      else delete next.description;
    }

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

    /*
     * 只看 `builtin` 字段（S-02 起）：认领已在 `mergeBuiltinTypes` 里完成，
     * 而原先的固定 id 名单（`BUILTIN_EVENT_TYPE_IDS`）会误伤 ——
     * 任何库里恰好占用 `et_4` 的自定义类型都会被当成「内置不可删」。
     */
    if (target.builtin) {
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
