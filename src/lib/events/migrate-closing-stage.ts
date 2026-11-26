/**
 * 末位阶段统一为「已关闭」的迁移（2026-11-26 用户拍板）。
 *
 * 为什么要迁移：内置定义只在 `_types.json` 缺失时生效，而各库早已落盘 ——
 * 改 `builtin-types.ts` 对它们完全无效（实测 `kisearch-memory`：`et_2` 末位是「已完成」、
 * `et_3` 只三段末位「已上线」、`et_4` 末位「已收敛」）。
 *
 * 两条改动**必须成对**，缺一就会静默坏数据：
 *
 *   ① 类型：末位追加「已关闭」，被顶下末位的原阶段 `full` → `fts-only`
 *      （事件未关闭时不该被语义检索召回）；
 *   ② 事件：把**已收口**且停在非末位阶段的事件吸附到「已关闭」。
 *
 * 为什么 ② 不能省：阶段可见性是按事件**当前阶段**实时查表的
 * （`resolveStageVisibility`，被 `members` / `refs-service` / visibility-index 共用），
 * 只降档不吸附，那些历史事件的成员文档会在一次索引重建后静默降为「仅全文」，
 * 语义检索再也搜不到 —— 不报错、只在结果里显形。
 *
 * 三条硬约束：
 *   1. **不改 `closedAt`、不调 `applyTerminalAction`**：吸附只是换阶段名，
 *      收口时间与文档去向都保持原样（否则 `trash` 类型会二次搬用户文档）；
 *   2. **幂等**：末位已是「已关闭」且事件已在末位 → 全部 skipped，不推进 revision；
 *   3. **写盘前备份**：与 `migrate-tech-debt` 共用 `backupTypesFile`（不覆盖已有 `.bak`）。
 *
 * CLI 包装在 `src/event-types.ts`；逻辑留在这里，便于测试直接 import（不触发 commander）。
 */

import { readTypesDoc, writeTypesDoc, readAllEvents, writeEvent } from './store.js';
import { appendStageLog } from './stage-log.js';
import { backupTypesFile } from './migrate-backup.js';
import { withScopeWriteLock } from '../scope-write-lock.js';
import { TERMINAL_STAGE_NAME } from './types.js';
import type { EventStage, EventTypeRecord } from './types.js';

export interface ClosingTypeChange {
  id: string;
  name: string;
  before: string[];
  after: string[];
}

export interface ClosingEventChange {
  id: string;
  shortId: number;
  from: string;
  to: string;
}

export interface ClosingMigrateResult {
  ok: boolean;
  scope: string;
  skipped?: string;
  dryRun?: boolean;
  backupPath?: string;
  types: {
    changed: ClosingTypeChange[];
    skipped: Array<{ id: string; name: string; reason: string }>;
  };
  events: {
    changed: ClosingEventChange[];
    skipped: Array<{ id: string; shortId?: number; reason: string }>;
  };
  /** 非阻断提示：如 `--skip-events` 时仍有待吸附事件（会留下类型与事件不一致的中间态） */
  warning?: string;
}

function maxStageNo(stages: EventStage[]): number {
  return stages.reduce((m, s) => {
    const match = /^st_(\d+)$/.exec(s.key);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
}

interface Plan {
  next: EventTypeRecord;
  change?: ClosingTypeChange;
  skipReason?: string;
}

/** 规划单个类型的末位形态；不改任何已有阶段的 key */
function planType(type: EventTypeRecord): Plan {
  if (type.stages.length < 2) {
    return { next: type, skipReason: '阶段不足 2 个（类型定义异常）' };
  }
  /*
   * 先判末位（而不是先 find 同名）：末位已经是「已关闭」就整条跳过。
   * 否则脏数据（中间也有一条同名）会让 find 命中中间那条、把它提到末位并丢弃原末位 ——
   * 原末位的 key 一换，停在那里的已收口事件全部变成悬空引用。
   */
  const lastStage = type.stages[type.stages.length - 1];
  if (lastStage.name.trim() === TERMINAL_STAGE_NAME) {
    return { next: type, skipReason: '末位已是「已关闭」' };
  }
  const closing = type.stages.find((s) => s.name.trim() === TERMINAL_STAGE_NAME);
  const rest = type.stages.filter((s) => s !== closing && s.name.trim() !== TERMINAL_STAGE_NAME);
  if (rest.length === 0) {
    return { next: type, skipReason: '除「已关闭」外没有其他阶段（类型定义异常）' };
  }

  /*
   * 只降「原末位」这一条：它从终态退成普通中间阶段。
   * 不提升 hidden —— 起始阶段本来就该藏，用户自己的档位不该被迁移改。
   */
  const prevTerminalVisibility = rest[rest.length - 1].visibility;
  const adjusted = rest.map((s, i) => (
    i === rest.length - 1 && s.visibility === 'full' ? { ...s, visibility: 'fts-only' as const } : s
  ));
  /*
   * 新末位**继承原末位的档位**，不写死 full：迁移只换名字 / 加一段，不该改变用户对
   * 「收口后这份文档能不能被检索」的选择。写死 full 会把一个刻意设为 hidden 的终态
   * 提升成「语义+全文可召回」，等于把已收口的历史文档重新推到搜索结果里。
   */
  const terminal: EventStage = closing ?? {
    key: `st_${maxStageNo(type.stages) + 1}`,
    name: TERMINAL_STAGE_NAME,
    visibility: prevTerminalVisibility,
  };
  const nextStages = [...adjusted, terminal];

  return {
    next: { ...type, stages: nextStages, revision: type.revision + 1, updatedAt: Date.now() },
    change: {
      id: type.id,
      name: type.name,
      before: type.stages.map((s) => s.name),
      after: nextStages.map((s) => s.name),
    },
  };
}

export async function migrateClosingStage(
  scope: string,
  opts: { dryRun?: boolean; skipEvents?: boolean } = {},
): Promise<ClosingMigrateResult> {
  return withScopeWriteLock(scope, 'event-type-write', async () => {
    const empty = { changed: [], skipped: [] };
    // 文件损坏时 readTypesDoc 抛错：迁移中止，不写任何数据（宁可不迁）
    const doc = readTypesDoc(scope);
    if (!doc || doc.types.length === 0) {
      return {
        ok: true,
        scope,
        types: empty,
        events: empty,
        skipped: '该库没有落盘的类型定义（内置定义已含「已关闭」，无需迁移）',
      };
    }

    const plans = doc.types.map((t) => ({ type: t, plan: planType(t) }));
    const changed = plans.map((p) => p.plan.change).filter((c): c is ClosingTypeChange => Boolean(c));
    const typeSkipped = plans
      .filter((p) => p.plan.skipReason)
      .map((p) => ({ id: p.type.id, name: p.type.name, reason: p.plan.skipReason! }));

    const nextTypes = plans.map((p) => p.plan.next);
    const byId = new Map(nextTypes.map((t) => [t.id, t] as const));

    // ── 事件吸附（先只算清单，dry-run 也要给预览；落盘在下面统一做）──────
    const eventChanges: ClosingEventChange[] = [];
    const eventSkipped: Array<{ id: string; shortId?: number; reason: string }> = [];

    for (const event of readAllEvents(scope)) {
      if (event.closedAt === null) continue; // 未收口：停在哪个阶段都是对的，不动
      const type = byId.get(event.typeId);
      if (!type) {
        eventSkipped.push({ id: event.id, shortId: event.shortId, reason: `类型「${event.typeId}」不存在` });
        continue;
      }
      const idx = type.stages.findIndex((s) => s.key === event.stageKey);
      if (idx < 0) {
        eventSkipped.push({ id: event.id, shortId: event.shortId, reason: `阶段键 ${event.stageKey} 悬空（不在类型阶段链中）` });
        continue;
      }
      const last = type.stages.length - 1;
      if (idx === last) continue; // 已在末位

      const terminal = type.stages[last];
      eventChanges.push({
        id: event.id,
        shortId: event.shortId,
        from: type.stages[idx].name,
        to: terminal.name,
      });
    }

    if (opts.dryRun) {
      return {
        ok: true,
        scope,
        dryRun: true,
        types: { changed, skipped: typeSkipped },
        events: opts.skipEvents
          ? { changed: [], skipped: [{ id: '-', reason: '已指定 --skip-events，事件不吸附' }] }
          : { changed: eventChanges, skipped: eventSkipped },
        ...(opts.skipEvents && eventChanges.length > 0
          ? { warning: `${eventChanges.length} 条已收口事件仍停在旧末位阶段（本次不吸附），其成员文档档位按旧阶段计算` }
          : {}),
      };
    }

    const backupPath = changed.length > 0 ? backupTypesFile(scope) : null;

    if (changed.length > 0) {
      writeTypesDoc(scope, { ...doc, revision: doc.revision + 1, types: nextTypes });
    }

    // ── 事件落盘：只改 stageKey / stageIndex / revision（不动 closedAt、不动 updatedAt）──
    if (!opts.skipEvents && eventChanges.length > 0) {
      const now = Date.now();
      const changedIds = new Set(eventChanges.map((c) => c.id));
      for (const event of readAllEvents(scope)) {
        if (!changedIds.has(event.id)) continue;
        const type = byId.get(event.typeId);
        const last = type!.stages.length - 1;
        const terminal = type!.stages[last];
        const from = type!.stages.find((s) => s.key === event.stageKey);
        /*
         * ⚠️ 这里**不调用** `transitionEvent`：它会按 `terminalAction` 搬成员文档
         * 并重写 `closedAt`，对一条历史已收口事件等于二次收口（trash 类型会再搬一次用户文档）。
         * 吸附只解决「阶段名对不上」，收口事实与文档去向保持原样。
         */
        /*
         * **不动 `updatedAt`**：它驱动列表「最近更新」排序与侧栏事件红点，迁移属于运维动作、
         * 不是用户改动内容 —— 跟着刷新会让十几条历史事件集体跳到列表最前并点亮红点。
         */
        writeEvent(scope, {
          ...event,
          stageKey: terminal.key,
          stageIndex: last,
          revision: event.revision + 1,
        });
        appendStageLog(scope, {
          eventId: event.id,
          fromKey: from?.key ?? event.stageKey,
          toKey: terminal.key,
          at: now,
          by: 'user',
          note: `迁移：末位统一为「${TERMINAL_STAGE_NAME}」（不触发终态动作）`,
          status: 'committed',
        });
      }
    }

    return {
      ok: true,
      scope,
      types: { changed, skipped: typeSkipped },
      events: opts.skipEvents
        ? { changed: [], skipped: [{ id: '-', reason: '已指定 --skip-events，事件未吸附' }] }
        : { changed: eventChanges, skipped: eventSkipped },
      ...(opts.skipEvents && eventChanges.length > 0
        ? { warning: `${eventChanges.length} 条已收口事件仍停在旧末位阶段（本次未吸附），其成员文档档位按旧阶段计算` }
        : {}),
      ...(backupPath ? { backupPath } : {}),
    };
  });
}
