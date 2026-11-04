/**
 * datasource-sync-merge.ts —— 多映射同步的**纯合并**逻辑（REQ-20261104-002 / 工作项 5）
 *
 * 为什么独立成纯函数：
 *  多映射同步 = 「每个映射跑一遍现有单映射链路」+「把 N 份 lastSync 合成 1 份」。
 *  前半段复用既有实现（护栏 #1 不许改 import 内部），后半段就是本模块。
 *  合并一旦算错会直接导致 **commit 水位错进**（失败文件永久漏同步，护栏 #3）与
 *  **待删候选错配**（token 失配 / 误删，护栏 #2），所以它必须能脱离 IO 被单测直接驱动。
 *
 * 输入口径：`parts[i].seenRels` 是**该映射的裸 rel**（虚拟记录同步时 sourceDir 就是映射目录），
 * 合并时按映射重新加前缀；这样 `record.lastSync.seenRels` 在落盘层永远是分桶键。
 */
import { computePruneToken } from './import-prune.js';
import { joinSeenRelsByMapping, seenRelKey } from './datasource-mappings.js';
import type {
  DataSourceLastSync,
  DataSourceMappingItem,
  DataSourcePendingDelete,
  DataSourceResultSnapshot,
  DataSourceSyncParams,
  DataSourceSyncState,
} from './datasource-types.js';

/** 触发候选冻结的闸门（与 `importAndPersist` 里的 freezeBaseline 同源） */
const FREEZE_REASONS: ReadonlySet<string> = new Set(['GATE_COORD', 'GATE_SCALE', 'EMPTY_SOURCE']);

/** 状态严重度：合并取最差 */
const SEVERITY: Record<DataSourceSyncState, number> = {
  cancelled: 3,
  failed: 4,
  partial: 2,
  ok: 0,
} as Record<DataSourceSyncState, number>;

export interface MergedMappingSync {
  state: DataSourceSyncState;
  /**
   * 护栏 #3：**只有全部映射都成功（ok/partial）且没有触发候选冻结**才允许推进 commit 水位。
   * 任一映射 failed/cancelled 或冻结 → 保留旧 commit，下次重跑该映射（文件未变则成本很低）。
   */
  canAdvanceCommit: boolean;
  files: DataSourceResultSnapshot['files'];
  vectorized: number;
  fullTextIndexed: number;
  groups: string[];
  conflicts: DataSourceResultSnapshot['conflicts'];
  failures: DataSourceResultSnapshot['failures'];
  created?: { group: string; relation: string }[];
  createdTotal?: number;
  createdTruncated?: boolean;
  modified?: { group: string; relation: string }[];
  modifiedTotal?: number;
  modifiedTruncated?: boolean;
  /** 分桶基线（`subdir/rel`），可直接落 `lastSync.seenRels` */
  seenRels: string[];
  pendingDelete: DataSourcePendingDelete;
}

/** 合并输入：只取合并真正需要的四样东西（窄接口便于编排层直接从 `summary` 构造） */
export interface MappingSyncPart {
  state: DataSourceSyncState;
  result: DataSourceResultSnapshot;
  /** 该映射的**裸 rel** 基线（相对该映射的子目录） */
  seenRels: string[];
  pendingDelete: DataSourcePendingDelete;
}

/**
 * 构造"失败映射"的合并输入：基线回退它自己的旧桶、计数为 0。
 * 失败时**不能**把 seenRels 清空（否则下次会把整批文档重新判成新文档），
 * 也不能沿用本次扫描结果（那份没写成功）。
 */
export function failedMappingPart(prevBucket: readonly string[], now: number): MappingSyncPart {
  return {
    state: 'failed',
    result: {
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
    },
    seenRels: [...prevBucket],
    pendingDelete: {
      computedAt: now,
      total: 0,
      overLimit: false,
      truncated: false,
      items: [],
      candidateSourcePaths: [],
      untouchedGroups: [],
      unableCount: 0,
      eligibleCount: 0,
      stale: true,
      staleReason: 'not-recomputed',
      blocked: null,
    },
  };
}

/** 合并 N 份单映射结果（`null` = 该映射本轮未跑 import：增量无变更 / 本次跳过） */
export function mergeMappingSync(input: {
  mappings: readonly DataSourceMappingItem[];
  /** 与 `mappings` 等长；顺序即映射顺序 */
  parts: readonly (MappingSyncPart | null)[];
  /** 每个映射上一次的基线桶（裸 rel），映射本轮失败时回退用它 */
  prevBuckets: readonly string[][];
  /** 本次运行的参数（group 取兼容位；mappings 用完整列表覆盖） */
  params: Omit<DataSourceSyncParams, 'mappings'>;
  at: number;
  computedAt: number;
}): MergedMappingSync {
  const { mappings, parts, prevBuckets, params, computedAt } = input;

  // ── 状态：取最差 ──
  let state: DataSourceSyncState = 'ok';
  for (const part of parts) {
    if (!part) continue;
    if (SEVERITY[part.state] > SEVERITY[state]) state = part.state;
  }

  // ── 候选冻结判定（与单映射同口径）──
  let frozen = false;
  let allBlocked = parts.length > 0;
  let firstBlocked: string | null = null;
  let blockedDetail: string | undefined;
  for (const part of parts) {
    const pending = part?.pendingDelete;
    if (!part) { allBlocked = false; continue; }
    if (pending?.blocked && FREEZE_REASONS.has(pending.blocked)) frozen = true;
    if (pending?.blocked) {
      if (!firstBlocked) firstBlocked = pending.blocked;
      if (!blockedDetail && pending.skipDetail) blockedDetail = pending.skipDetail;
    } else {
      allBlocked = false;
    }
  }
  const canAdvanceCommit = !frozen && (state === 'ok' || state === 'partial');

  // ── 计数器求和 ──
  const files: DataSourceResultSnapshot['files'] = {
    scanned: 0,
    fullScanned: 0,
    changed: 0,
    completed: 0,
    unchanged: 0,
    skipped: 0,
    incomplete: 0,
    duplicatesSkipped: 0,
  };
  let vectorized = 0;
  let fullTextIndexed = 0;
  const groups = new Set<string>();
  const conflicts: DataSourceResultSnapshot['conflicts'] = [];
  const failures: DataSourceResultSnapshot['failures'] = [];
  let created: { group: string; relation: string }[] | undefined;
  let createdTotal: number | undefined;
  let createdTruncated = false;
  let modified: { group: string; relation: string }[] | undefined;
  let modifiedTotal: number | undefined;
  let modifiedTruncated = false;

  for (const part of parts) {
    if (!part) continue;
    for (const key of Object.keys(files) as (keyof typeof files)[]) {
      files[key] += part.result.files[key] ?? 0;
    }
    vectorized += part.result.vectorized;
    fullTextIndexed += part.result.fullTextIndexed;
    for (const group of part.result.groups) groups.add(group);
    conflicts.push(...part.result.conflicts);
    failures.push(...part.result.failures);
    if (part.result.created) created = [...(created ?? []), ...part.result.created];
    if (part.result.createdTotal !== undefined) createdTotal = (createdTotal ?? 0) + part.result.createdTotal;
    if (part.result.createdTruncated) createdTruncated = true;
    if (part.result.modified) modified = [...(modified ?? []), ...part.result.modified];
    if (part.result.modifiedTotal !== undefined) modifiedTotal = (modifiedTotal ?? 0) + part.result.modifiedTotal;
    if (part.result.modifiedTruncated) modifiedTruncated = true;
  }

  // ── 基线：成功的映射用本次扫描结果，其余回退上次桶（护栏 #2：键必须带子目录前缀）──
  const buckets: string[][] = mappings.map((_, index) => {
    const part = parts[index];
    if (part && !(part.pendingDelete?.blocked && FREEZE_REASONS.has(part.pendingDelete.blocked))) {
      return [...part.seenRels];
    }
    return [...(prevBuckets[index] ?? [])];
  });
  const seenRels = joinSeenRelsByMapping(mappings, buckets);

  // ── 待删候选：合并 items 后**重算 token**（沿用某一份必然失配）──
  const items: DataSourcePendingDelete['items'] = [];
  const candidateSourcePaths: string[] = [];
  const untouchedGroups = new Set<string>();
  let total = 0;
  let overLimit = false;
  let truncated = false;
  let unableCount = 0;
  let eligibleCount = 0;
  for (const part of parts) {
    const pending = part?.pendingDelete;
    if (!pending) continue;
    total += pending.total;
    overLimit = overLimit || pending.overLimit;
    truncated = truncated || pending.truncated;
    unableCount += pending.unableCount;
    eligibleCount += pending.eligibleCount;
    items.push(...pending.items);
    for (const group of pending.untouchedGroups) untouchedGroups.add(group);
  }
  const blocked = allBlocked ? firstBlocked : null;
  const somePartIncomplete = parts.some((part) => part !== null && (
    part.pendingDelete.blocked !== null
    || part.pendingDelete.stale
    || part.state === 'failed'
    || part.state === 'cancelled'
  ));
  // ★ 候选基线必须**分桶**：`candidateSourcePaths` 是删除接口重算时的基线，
  //   两条映射里同名的 `a.md` 若都写成裸路径就分不清属于谁 → 重算出的候选与 token 对不上。
  //   单映射时 `seenRelKey('', x) === x`，与升级前逐字节一致。
  const bucketedCandidatePaths: string[] = [];
  parts.forEach((part, index) => {
    const subdir = mappings[index]?.subdir ?? '';
    for (const path of part?.pendingDelete.candidateSourcePaths ?? []) {
      bucketedCandidatePaths.push(seenRelKey(subdir, path));
    }
  });
  const token = items.length > 0
    ? computePruneToken(items.map((item) => ({
      group: item.group,
      relation: item.relation,
      sourcePath: item.sourcePath ?? item.relation,
      untouched: item.untouched === true,
    })))
    : undefined;
  const pendingDelete: DataSourcePendingDelete = {
    ...(token ? { token } : {}),
    computedAt,
    total,
    overLimit,
    truncated,
    items,
    candidateSourcePaths: bucketedCandidatePaths,
    untouchedGroups: [...untouchedGroups],
    unableCount,
    eligibleCount,
    // 有映射没算出候选（被闸门拦 / 本映射 stale / 整个失败）⇒ 候选不完整，必须让 UI 看得见。
    // ★ 失败映射的 `blocked` 是 null，只查 blocked 会把"半份候选"说成完整的 —— 要连 state 一起看。
    stale: blocked === null && somePartIncomplete,
    staleReason: blocked === null && somePartIncomplete ? 'not-recomputed' : null,
    blocked,
    ...(blocked && blockedDetail ? { skipDetail: blockedDetail } : {}),
  };

  return {
    state,
    canAdvanceCommit,
    files,
    vectorized,
    fullTextIndexed,
    groups: [...groups],
    conflicts,
    failures,
    ...(created ? { created } : {}),
    ...(createdTotal !== undefined ? { createdTotal } : {}),
    ...(createdTruncated ? { createdTruncated } : {}),
    ...(modified ? { modified } : {}),
    ...(modifiedTotal !== undefined ? { modifiedTotal } : {}),
    ...(modifiedTruncated ? { modifiedTruncated } : {}),
    seenRels,
    pendingDelete,
  };
}

/** 拼接 params（`group` 是首条兼容位，`mappings` 是完整真相） */
export function mappingParams(
  base: Omit<DataSourceSyncParams, 'mappings'>,
  mappings: readonly DataSourceMappingItem[],
): DataSourceSyncParams {
  return { ...base, mappings: [...mappings] };
}
