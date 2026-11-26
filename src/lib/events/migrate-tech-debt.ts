/**
 * 技术债阶段迁移（REQ-20261123-007 · S-03）。
 *
 * 为什么需要它：内置类型定义只在 `_types.json` 缺失时生效，已落盘的库拿不到新内置。
 * 「技术债」在各库里已经以两阶段的自建形态存在，要把它们补成四阶段，必须有一步**显式**
 * 的动作 —— 隐式覆盖会静默回滚用户对内置类型做过的所有调整。
 *
 * 三条硬约束：
 *   1. **幂等键是阶段名**：重复执行只返回 skipped，不会重复插；
 *   2. **只插中间、不删不改**：已有阶段的 `stageKey` 原样保留（事件位置存的是 key，
 *      动了就是数据漂移），可见性 / 停用状态也不碰；
 *   3. **写盘前备份**：备份失败即中止，宁可不迁也不要在没有回滚点时改用户数据。
 *
 * 为什么**不走 `updateType`**（2026-11-26 起）：那条路径会顺手把「已关闭」补到末位
 * （末位统一规则），与本函数「只插中间、不删不改」的承诺冲突。
 * 补末位 + 降档 + 存量事件吸附由 `migrate-closing-stage.ts` 单独负责，两者可任意顺序跑。
 *
 * CLI 包装在 `src/event-types.ts`；逻辑留在这里，便于测试直接 import（不触发 commander）。
 */

import { readTypesDoc, writeTypesDoc } from './store.js';
import { backupTypesFile } from './migrate-backup.js';
import { MAX_STAGES } from './type-service.js';
import { GovernanceError } from '../governance-errors.js';
import { withScopeWriteLock } from '../scope-write-lock.js';
import type { EventStage, Visibility } from './types.js';

const TECH_DEBT = '技术债';

/**
 * 要补的两个阶段及其**前驱**。
 *
 * 用「前驱」而非固定下标：半迁移状态（只缺「偿还中」）时，它必须插到「已排期」之后，
 * 而不是统一插到「待处理」之后 —— 后者会把顺序排成「待处理 / 偿还中 / 已排期」。
 * 可见性与另外三条内置同构：进行中仅全文可命中。
 */
const INSERT_STAGES: Array<{ name: string; visibility: Visibility; after: string }> = [
  { name: '已排期', visibility: 'fts-only', after: '待处理' },
  { name: '偿还中', visibility: 'fts-only', after: '已排期' },
];

export interface MigrateResult {
  ok: boolean;
  scope: string;
  typeId?: string;
  added?: string[];
  skipped?: string;
  stagesBefore?: string[];
  stagesAfter?: string[];
  dryRun?: boolean;
  backupPath?: string;
}

function maxStageNo(stages: EventStage[]): number {
  return stages.reduce((m, s) => {
    const match = /^st_(\d+)$/.exec(s.key);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
}

export async function migrateTechDebtStages(
  scope: string,
  opts: { dryRun?: boolean } = {},
): Promise<MigrateResult> {
  return withScopeWriteLock(scope, 'event-type-write', async () => {
    /*
     * 只认**盘上**的记录（`readTypesDoc`，不含内置补齐）：
     * 迁移的对象是「用户库里那份两阶段自建类型」。盘上没有它时，内置定义本来就是四阶段，
     * 无需迁移 —— 若这里改用 `listTypes`，永远能查到内置的技术债，会误报「已迁移」，
     * 也让「该库没有这个类型」这个真实状态无法表达。
     */
    const doc = readTypesDoc(scope);
    const target = (doc?.types ?? []).find((t) => t.name === TECH_DEBT);
    if (!target) {
      return { ok: true, scope, skipped: `该库没有「${TECH_DEBT}」类型` };
    }

    const existing = new Set(target.stages.map((s) => s.name));
    const missing = INSERT_STAGES.filter((s) => !existing.has(s.name));
    if (missing.length === 0) {
      return { ok: true, scope, typeId: target.id, skipped: '已迁移' };
    }

    const stagesBefore = target.stages.map((s) => s.name);
    type StageDraft = { key?: string; name: string; visibility: Visibility; disabled?: boolean };
    const toDraft = (s: EventStage): StageDraft => ({
      key: s.key,
      name: s.name,
      visibility: s.visibility,
      ...(s.disabled ? { disabled: true } : {}),
    });

    /*
     * 逐个按「前驱」插入，而不是一次性拼数组：半迁移状态下「偿还中」的前驱是「已排期」，
     * 若统一按「待处理之后」插会把顺序排错。
     * 新阶段不带 key → 下面分配 st_${max+1}，因此 key 可能与位置不同序
     * （如 st_1, st_3, st_4, st_2）；key 只作稳定标识，不要求同序。
     */
    const drafts: StageDraft[] = target.stages.map(toDraft);
    for (const m of missing) {
      const afterPos = drafts.findIndex((s) => s.name === m.after);
      const at = afterPos >= 0 ? afterPos + 1 : 0;
      drafts.splice(at, 0, { name: m.name, visibility: m.visibility });
    }

    if (opts.dryRun) {
      return {
        ok: true,
        scope,
        typeId: target.id,
        added: missing.map((m) => m.name),
        stagesBefore,
        stagesAfter: drafts.map((s) => s.name),
        dryRun: true,
      };
    }

    const backupPath = backupTypesFile(scope);

    // 已存在阶段原样回填（含 originalName / disabled），新阶段才分配 key
    const byKey = new Map(target.stages.map((s) => [s.key, s] as const));
    let stageNo = maxStageNo(target.stages);
    const finalStages: EventStage[] = drafts.map((d) => {
      const old = d.key ? byKey.get(d.key) : undefined;
      if (old) {
        return {
          ...old,
          name: d.name,
          visibility: d.visibility,
          ...(d.disabled ? { disabled: true } : {}),
        };
      }
      stageNo += 1;
      return {
        key: `st_${stageNo}`,
        name: d.name,
        visibility: d.visibility,
        ...(d.disabled ? { disabled: true } : {}),
      };
    });

    /*
     * 直写绕过了 `validateStages`，这里补回**结构**护栏（数量上限 / 名字唯一）。
     * 末位名的检查刻意不补：技术债迁移只负责「插中间两段」，末位统一由
     * migrate-closing-stage 负责 —— 在这里补末位会破坏本函数「只插不改」的承诺。
     */
    if (finalStages.length > MAX_STAGES) {
      throw new GovernanceError(
        'TYPE_STAGES_TOO_MANY',
        `插入后阶段数 ${finalStages.length} 超过上限 ${MAX_STAGES}（「${target.name}」），已中止且未写盘`,
      );
    }
    const stageNames = finalStages.map((s) => s.name.trim());
    if (new Set(stageNames).size !== stageNames.length) {
      throw new GovernanceError(
        'TYPE_STAGES_TOO_FEW',
        `插入后阶段名重复（${stageNames.join(' / ')}），已中止且未写盘`,
      );
    }

    const now = Date.now();
    const next = { ...target, stages: finalStages, revision: target.revision + 1, updatedAt: now };
    const nextTypes = doc!.types.map((t) => (t.id === target.id ? next : t));
    writeTypesDoc(scope, { ...doc!, revision: doc!.revision + 1, types: nextTypes });

    return {
      ok: true,
      scope,
      typeId: next.id,
      added: missing.map((m) => m.name),
      stagesBefore,
      stagesAfter: next.stages.map((s) => s.name),
      ...(backupPath ? { backupPath } : {}),
    };
  });
}
