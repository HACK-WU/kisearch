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
// 多映射（REQ-20261104-002）：候选重算必须与同步侧**同口径**（护栏 #2），
// 否则「重算出的 token」与合并层写下的 token 对不上，待删按钮永远 403。
import { mappingsOf, mappingTargetDir } from './datasource-mappings.js';
import { mergeMappingSync, type MappingSyncPart } from './datasource-sync-merge.js';
import type {
  DataSourceMappingItem,
  DataSourcePendingDelete,
  DataSourceRecord,
  DataSourceResultSnapshot,
} from './datasource-types.js';

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

  // 多映射：逐映射重算后合并（token 必须与同步时合并出的那份一致）
  const mappings = mappingsOf(record);
  if (mappings.length > 1) return planMultiMappingPrune({ scope, record, mappings, config });

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

const EMPTY_SNAPSHOT: DataSourceResultSnapshot = {
  files: {
    scanned: 0,
    fullScanned: 0,
    changed: 0,
    completed: 0,
    unchanged: 0,
    skipped: 0,
    incomplete: 0,
    duplicatesSkipped: 0,
  },
  vectorized: 0,
  fullTextIndexed: 0,
  groups: [],
  conflicts: [],
  failures: [],
};

/**
 * 多映射的候选重算：**逐映射**扫描 + 各自 `planImportPrune`，再用同步侧同一套合并逻辑
 * （`mergeMappingSync`）得到 items / token。
 *
 * 为什么要逐映射而不是把全部文件并起来算一次：`sourcePath` 是**相对各自子目录**的裸路径，
 * 合并算会把「A 子目录有 a.md、B 子目录没有」误判成「a.md 还在」，候选与 token 都会错。
 */
function planMultiMappingPrune(args: {
  scope: string;
  record: DataSourceRecord;
  mappings: DataSourceMappingItem[];
  config: KiConfig;
}): PlanDatasourcePruneResult {
  const { scope, record, mappings, config } = args;
  const git = record.git;
  if (!git) {
    return { ok: false, scope, code: 'PRUNE_SOURCE_UNAVAILABLE', error: '数据源类型为 git 但缺少 git 元信息' };
  }
  const extensions = resolveImportExtensions(config, scope);
  // 候选基线（已分桶）：`candidateSourcePaths` 在合并层写成 `subdir/rel`
  const bucketed = record.lastSync?.pendingDelete?.candidateSourcePaths ?? [];
  const parts: MappingSyncPart[] = [];
  const now = Date.now();
  let blockedReason: ImportPrunePlan['skipReason'] | undefined;
  let blockedDetail: string | undefined;
  let total = 0;
  let eligibleCount = 0;
  let unableCount = 0;

  for (let i = 0; i < mappings.length; i += 1) {
    const mapping = mappings[i];
    const label = `第 ${i + 1} 条映射（${mapping.subdir || '仓库根'}）`;
    const dir = mappingTargetDir(git.repoRoot, mapping.subdir);
    const dirCheck = checkSourceDir(dir, config, scope);
    if (!dirCheck.ok && dirCheck.code !== 'SOURCE_EMPTY') {
      return { ok: false, scope, code: 'PRUNE_SOURCE_UNAVAILABLE', error: `${label}：${dirCheck.error}` };
    }
    let files: string[];
    try {
      files = collectMarkdownFiles(dir, extensions).files;
    } catch (err) {
      return { ok: false, scope, code: 'PRUNE_SOURCE_UNAVAILABLE', error: `${label} 扫描失败：${(err as Error).message}` };
    }
    const subdir = mapping.subdir;
    const prefix = subdir ? `${subdir}/` : '';
    // 剥回该映射的裸 rel：有前缀的按前缀取；根映射只收「不被任何子目录前缀命中」的键
    const baseline = prefix
      ? bucketed.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
      : bucketed.filter((key) => mappings.every((item) => !item.subdir || !key.startsWith(`${item.subdir}/`)));
    const importedGroups = [...new Set(files.map((rel) => resolveGroupForSource(mapping.group ?? '', rel, scope)))];
    const plan = planImportPrune({
      scope,
      group: mapping.group ?? '',
      scannedRels: files,
      importedGroups,
      precheck: { pruneStale: true, pickMode: 'dir', subsetRetry: false, uploadIncomplete: false, scannedCount: files.length },
      eligibleRels: [...new Set([...files, ...baseline])],
      emitTokenWhenOverLimit: true,
    });
    if (plan.skipReason && !blockedReason) {
      blockedReason = plan.skipReason;
      blockedDetail = plan.skipDetail;
    }
    total += plan.total;
    eligibleCount += plan.eligibleCount;
    unableCount += plan.unableCount;
    parts.push({
      state: 'ok',
      result: EMPTY_SNAPSHOT,
      seenRels: files,
      pendingDelete: pendingFromPlan(plan, now),
    });
  }

  const merged = mergeMappingSync({
    mappings,
    parts,
    prevBuckets: mappings.map(() => []),
    params: {
      group: record.group,
      conflictMode: record.conflictMode,
      vector: record.vector,
      chunkSize: record.chunkSize,
      chunkOverlap: record.chunkOverlap,
      mode: record.lastSync?.params.mode ?? 'incremental',
    },
    at: now,
    computedAt: now,
  });

  // 摊平成 ImportPrunePlan 形状：execute 只用 token / items / skipReason，
  // 其余公示字段（libDocs / coordRatio 等）在多映射下没有单一含义，取保守值并在此说明。
  const plan: ImportPrunePlan = {
    scope,
    scopeGroups: new Set(merged.groups).size,
    libDocs: eligibleCount,
    judicable: eligibleCount,
    eligibleCount,
    scanned: parts.reduce((sum, part) => sum + part.seenRels.length, 0),
    overlap: eligibleCount,
    coordRatio: 1,
    deleteRatio: eligibleCount > 0 ? Math.min(1, total / eligibleCount) : 0,
    warn: eligibleCount > 0 ? total / eligibleCount > 0.2 : false,
    overLimit: merged.pendingDelete.overLimit,
    total,
    items: merged.pendingDelete.items.map((item) => ({
      group: item.group,
      relation: item.relation,
      sourcePath: item.sourcePath ?? item.relation,
      untouched: item.untouched === true,
    })),
    truncated: merged.pendingDelete.truncated,
    unableCount,
    untouchedGroups: merged.pendingDelete.untouchedGroups,
    // ★ 这里是**分桶**后的全量候选键（`subdir/rel`）：删除成功后 execute 会用它重建基线，
    //   用 items 的裸 sourcePath 重建会让下次重算找不到分桶键 ⇒ 候选整批丢失。
    allCandidateSourcePaths: merged.pendingDelete.candidateSourcePaths,
    ...(merged.pendingDelete.token ? { token: merged.pendingDelete.token } : {}),
    ...(blockedReason ? { skipReason: blockedReason } : {}),
    ...(blockedDetail ? { skipDetail: blockedDetail } : {}),
  };
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
    // 多映射：基线键是分桶的（`subdir/rel`），必须用重算出的全量键覆盖，
    // 否则下次重算以裸路径为基线 ⇒ 一条候选都对不上。
    if (after.plan.allCandidateSourcePaths && mappingsOf(latest.record).length > 1) {
      pendingDelete = { ...pendingDelete, candidateSourcePaths: after.plan.allCandidateSourcePaths };
    }
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
