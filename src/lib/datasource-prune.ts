/**
 * datasource-prune.ts —— 数据源待删候选的「删除链路」（设计 S-03）
 *
 * 规则（顺序不可换）：
 *   1. 读登记 → 目录可读
 *   2. 全量扫描（扩展名与导入**同源**）
 *   3. 用 `lastSync.seenRels` 收窄（Q14）+ 双闸门
 *   4. 与请求 token 比对（失配 409）
 *   5. `selected` 只与**重算返回的可见 items** 取交集，且 ≤500
 *   6. `executeBatchDelete(..., { wikiDelete:false })` —— 只删库，不动源目录
 *   7. 删除成功后重算剩余候选并写回 pendingDelete（新 token）
 */
import { loadConfig, resolveScope, type KiConfig } from './config.js';
import { readDataSource, writeDataSource, checkSourceDir } from './datasource.js';
import { pendingFromPlan } from './datasource.js';
import { collectMarkdownFiles } from './import.js';
import { resolveImportExtensions } from './config.js';
import { planImportPrune, verifyPruneToken, PRUNE_MAX_ITEMS, type ImportPrunePlan } from './import-prune.js';
import { resolveGroupForSource } from './import-path.js';
import { executeBatchDelete } from '../delete-relation.js';
import type { DataSourcePendingDelete, DataSourceRecord } from './datasource-types.js';

export type PruneErrorCode =
  | 'INVALID_SCOPE'
  | 'PRUNE_NO_DATASOURCE'
  | 'PRUNE_SOURCE_UNAVAILABLE'
  | 'PRUNE_TOKEN_STALE'
  | 'PRUNE_BLOCKED'
  | 'PRUNE_EMPTY_SELECTION'
  | 'PRUNE_SELECTION_TOO_LARGE'
  | 'PRUNE_FAILED';

export type PlanDatasourcePruneResult =
  | { ok: true; scope: string; record: DataSourceRecord; plan: ImportPrunePlan }
  | { ok: false; scope: string; code: PruneErrorCode; error: string };

/**
 * 重算候选（只读）。与同步时的候选**必须同源**：
 * extensions 用 `resolveImportExtensions`、group 用登记值、基线用 `lastSync.seenRels`。
 */
export function planDatasourcePrune(input: { scope: string; config?: KiConfig }): PlanDatasourcePruneResult {
  const config = input.config ?? loadConfig();
  let scope: string;
  try {
    scope = resolveScope(config, input.scope);
  } catch (err) {
    return { ok: false, scope: input.scope, code: 'INVALID_SCOPE', error: (err as Error).message };
  }
  const read = readDataSource(scope);
  if (!read.ok) return { ok: false, scope, code: 'PRUNE_NO_DATASOURCE', error: read.error };
  const record = read.record;

  const dirCheck = checkSourceDir(record.dir, config, scope);
  // 空目录不算"不可用"：让 plan 返回 EMPTY_SOURCE（与同步口径一致）
  if (!dirCheck.ok && dirCheck.code !== 'SOURCE_EMPTY') {
    return { ok: false, scope, code: 'PRUNE_SOURCE_UNAVAILABLE', error: dirCheck.error };
  }

  let files: string[];
  try {
    files = collectMarkdownFiles(record.dir, resolveImportExtensions(config, scope)).files;
  } catch (err) {
    return { ok: false, scope, code: 'PRUNE_SOURCE_UNAVAILABLE', error: `扫描源目录失败：${(err as Error).message}` };
  }

  const importedGroups = [...new Set(files.map((rel) => resolveGroupForSource(record.group ?? '', rel, scope)))];
  // 重算基线与同步时**必不相同**：同步成功后 seenRels 已更新为本次扫描，
  // 直接用它会把候选清零。正确基线 = 本次扫描 ∪ 上次算出的候选（见 S-03 §3.2 注）。
  const pending = record.lastSync?.pendingDelete;
  const baseline = [
    ...(pending?.candidateSourcePaths ?? []),
    ...(pending?.items ?? []).map((item) => item.sourcePath).filter((path): path is string => typeof path === 'string' && path.length > 0),
  ];
  const eligibleRels = [...new Set([...files, ...baseline])];
  const plan = planImportPrune({
    scope,
    group: record.group ?? '',
    scannedRels: files,
    importedGroups,
    precheck: { pruneStale: true, pickMode: 'dir', subsetRetry: false, uploadIncomplete: false, scannedCount: files.length },
    eligibleRels,
    emitTokenWhenOverLimit: true,
  });
  return { ok: true, scope, record, plan };
}

export interface ExecuteDatasourcePruneInput {
  scope: string;
  token: string;
  selected: { group: string; relation: string }[];
  dryRun?: boolean;
  config?: KiConfig;
}

export type ExecuteDatasourcePruneResult =
  | { ok: true; scope: string; dryRun: true; plan: ImportPrunePlan }
  | {
    ok: true;
    scope: string;
    dryRun: false;
    deleted: number;
    failed: number;
    results: unknown[];
    skipped: { group: string; relation: string; reason: string }[];
    pendingDelete: DataSourcePendingDelete;
  }
  | { ok: false; scope: string; code: PruneErrorCode; error: string; plan?: ImportPrunePlan };

const keyOf = (item: { group: string; relation: string }): string => `${item.group}\u0000${item.relation}`;

function dedupeSelected(items: { group: string; relation: string }[]): { group: string; relation: string }[] {
  const seen = new Set<string>();
  const out: { group: string; relation: string }[] = [];
  for (const item of items) {
    const group = typeof item?.group === 'string' ? item.group.trim() : '';
    const relation = typeof item?.relation === 'string' ? item.relation.trim() : '';
    if (!group || !relation) continue;
    const key = keyOf({ group, relation });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ group, relation });
  }
  return out;
}

export async function executeDatasourcePrune(input: ExecuteDatasourcePruneInput): Promise<ExecuteDatasourcePruneResult> {
  const planned = planDatasourcePrune({ scope: input.scope, config: input.config });
  if (!planned.ok) return planned;
  const { scope, record, plan } = planned;

  if (input.dryRun) return { ok: true, scope, dryRun: true, plan };
  if (plan.skipReason) {
    return { ok: false, scope, code: 'PRUNE_BLOCKED', error: plan.skipDetail ?? '未生成候选', plan };
  }
  if (!verifyPruneToken(plan, input.token)) {
    return { ok: false, scope, code: 'PRUNE_TOKEN_STALE', error: '源目录已变化，请重新同步后重试', plan };
  }

  const selected = dedupeSelected(input.selected);
  if (selected.length === 0) return { ok: false, scope, code: 'PRUNE_EMPTY_SELECTION', error: 'selected 为空', plan };
  if (selected.length > PRUNE_MAX_ITEMS) {
    return { ok: false, scope, code: 'PRUNE_SELECTION_TOO_LARGE', error: `单次最多删除 ${PRUNE_MAX_ITEMS} 篇（分批：删完刷新继续）`, plan };
  }

  // 只删「重算后仍在可见 items 内」的项（保证删的都是界面上看得见的）
  const candidateKeys = new Set(plan.items.map(keyOf));
  const toDelete = selected.filter((item) => candidateKeys.has(keyOf(item)));
  const skipped = selected
    .filter((item) => !candidateKeys.has(keyOf(item)))
    .map((item) => ({ ...item, reason: 'not-in-candidates' }));
  if (toDelete.length === 0) {
    return { ok: false, scope, code: 'PRUNE_EMPTY_SELECTION', error: '所选项均不在当前候选内', plan };
  }

  const batch = await executeBatchDelete(scope, toDelete, { wikiDelete: false });
  const deleted = batch.results.filter((item) => item.deleted).length;
  const failedResults = batch.results.filter((item) => !item.deleted);

  // 删除后重算剩余候选：目录未变（只变了库），因此扫描结果与本次一致；
  // 重新算才能拿到「剩余全量候选」的 token（plan.items 在超限时只有前 500 条）。
  let pendingDelete: DataSourcePendingDelete;
  const latest = readDataSource(scope);
  const after = planDatasourcePrune({ scope, config: input.config });
  if (after.ok && latest.ok) {
    pendingDelete = pendingFromPlan(after.plan, Date.now());
    if (latest.record.lastSync) {
      writeDataSource(scope, {
        ...latest.record,
        updatedAt: Date.now(),
        lastSync: { ...latest.record.lastSync, pendingDelete },
      });
    }
  } else {
    pendingDelete = latest.ok && latest.record.lastSync
      ? { ...latest.record.lastSync.pendingDelete, stale: true, staleReason: 'not-recomputed' }
      : { ...pendingFromPlan(undefined, Date.now()) };
  }

  return {
    ok: true,
    scope,
    dryRun: false,
    deleted,
    failed: failedResults.length,
    results: batch.results,
    skipped,
    pendingDelete,
  };
}
