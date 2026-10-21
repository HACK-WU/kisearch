/**
 * import-prune.ts —— 目录导入后的「库中存在、本次目录已没有」候选计算（REQ-20261019-001）。
 *
 * 定位：**纯计算 + 一个读缓存的薄包装**，不写磁盘、不动向量。
 * 由 `import.ts` 在扫描完成后调用产出 `ImportResult.prune`，由 `/api/import/prune`
 * 用同一份逻辑重算以校验 `pruneToken`（两处必须同源，否则"看到的"和"删掉的"会不一致）。
 *
 * 三条不可动摇的判定前提（详见设计 S01 §3.3）：
 *  1. `scannedRels` 取 `collectMarkdownFiles` 的**全量扫描**。不能用 `filesForImport` /
 *     `budgetFiles` / `fileRecords`——增量未变、`skipDuplicates` 剔除、预算剔除的文件
 *     虽然没被写入，但**仍在本次目录里**，误用会把这些文档判成"本地已删"。
 *  2. 双闸门（坐标重合率 / 删除规模）任一不通过即整体关闭，不产候选。
 *  3. `sourcePath` 为空的文档永不进候选（无法判定来源）。
 */

import { createHash } from 'node:crypto';
import { readAllGroupCaches } from './group-cache.js';

// ─── 常量（阈值与上限，文案引用同一值，禁止写死第二处） ──────────────

/** 闸门 A：本次 rel 与库中 sourcePath 的重合率下限 */
export const PRUNE_COORD_THRESHOLD = 0.8;
/** 闸门 B：候选占可判定文档数的上限 */
export const PRUNE_SCALE_THRESHOLD = 0.8;
/** 候选占比超过此值时前端须强制二次确认（不关闭功能） */
export const PRUNE_WARN_THRESHOLD = 0.2;
/** 单次可删上限 */
export const PRUNE_MAX_ITEMS = 500;
/**
 * 明细上限**与可删上限对齐**：若明细少于可删数，用户会看到「共 500 篇」却只能勾选前 50 条，
 * 剩余项在界面上无入口（设计评审 B-1）。将来若下调明细，必须同时禁用删除。
 */
export const PRUNE_MAX_DETAIL = PRUNE_MAX_ITEMS;

// ─── 类型 ───────────────────────────────────────────────

export interface PruneLibItem {
  group: string;
  relation: string;
  /** 非空；差集只认它 */
  sourcePath: string;
}

/** 作用域裁剪后的库快照（由 {@link readPruneLibSnapshot} 产出，便于纯函数单测） */
export interface PruneLibSnapshot {
  /** 作用域内全部 group 键（含空组） */
  groups: string[];
  /** 作用域内文档总数（含 sourcePath 为空的） */
  docs: number;
  /** 作用域内 sourcePath 非空的文档数 —— 闸门 B 的分母 */
  judicable: number;
  /** 每个 group 的文档数（判「未触及 group」用） */
  groupDocs: Record<string, number>;
  items: PruneLibItem[];
}

export type PruneSkipReason =
  | 'DISABLED'          // 开关未开
  | 'NOT_DIR_MODE'      // pickMode 不是 'dir'
  | 'SUBSET_RETRY'      // onlyRelPaths 非空（只重试未完成）
  | 'UPLOAD_INCOMPLETE' // 上传存在失败批次/文件
  | 'EMPTY_SOURCE'      // 本次扫描到 0 篇
  | 'EMPTY_LIBRARY'     // 作用域内没有可判定文档
  | 'GATE_COORD'        // 闸门 A 不通过
  | 'GATE_SCALE'        // 闸门 B 不通过
  | 'ERROR';            // 计算异常（fail-soft，不影响导入）

export interface PruneCandidateItem {
  group: string;
  relation: string;
  sourcePath: string;
  /** 所属 group 本次没有任何文件落入 */
  untouched: boolean;
}

export interface ImportPrunePlan {
  scope: string;
  /** 作用域 group 数 */
  scopeGroups: number;
  /** 作用域内文档总数 */
  libDocs: number;
  /** 作用域内可判定文档数（未按基线收窄，仅作透明披露） */
  judicable: number;
  /**
   * 候选基线的可判定文档数（闸门 B 分母）。
   * 未传 `eligibleRels` 时 = {@link judicable}；传了则只数「基线内」的文档。
   */
  eligibleCount: number;
  /** 本次有效文件数（scannedRels ∪ preserveRels） */
  scanned: number;
  /** 交集个数 */
  overlap: number;
  /** 闸门 A 实际值（0~1，保留 3 位） */
  coordRatio: number;
  /** 闸门 B 实际值（0~1，保留 3 位） */
  deleteRatio: number;
  /** deleteRatio > 0.2：不关闭功能，但前端必须强制二次确认 */
  warn: boolean;
  /** 候选 > 单次上限（明细只给前 {@link PRUNE_MAX_DETAIL} 条） */
  overLimit: boolean;
  /** 候选总数（完整计数） */
  total: number;
  /** 明细（≤ PRUNE_MAX_DETAIL） */
  items: PruneCandidateItem[];
  /** items 被截断 */
  truncated: boolean;
  /** 无法判定来源（sourcePath 为空）的文档数 */
  unableCount: number;
  /** 本次未触及的 group（有文档且本次完全没有文件落入） */
  untouchedGroups: string[];
  /**
   * 候选指纹。缺省（Web 导入路径）只在「total>0 且未超限」时给出；
   * `emitTokenWhenOverLimit`（数据源路径）时超限也给，供分批删除。
   */
  token?: string;
  /**
   * **超限时**的全量候选 sourcePath（仅 `emitTokenWhenOverLimit` 且 overLimit 时给出）。
   * 数据源把它存进 `pendingDelete.candidateSourcePaths`：删除接口重算时用它作为基线
   * （否则同步后 seenRels 已更新，候选会被清零）。未超限时用 `items` 即可覆盖全量。
   */
  allCandidateSourcePaths?: string[];
  skipReason?: PruneSkipReason;
  /** 面向用户的原因补充（含实际数值），可直接渲染 */
  skipDetail?: string;
}

export interface PrunePrecheckInput {
  pruneStale: boolean;
  pickMode?: 'dir' | 'files' | 'mixed';
  /** 本次是「只重试未完成」子集 */
  subsetRetry: boolean;
  /** 上传会话存在失败批次/文件 */
  uploadIncomplete: boolean;
  /** 本次目录扫描到的文件数（未去重） */
  scannedCount: number;
}

// ─── 工具 ───────────────────────────────────────────────

/** 统一路径口径：posix + NFC + 去首尾斜杠（不做大小写折叠，避免 A.md / a.md 互相顶替） */
export function normalizePrunePath(raw: string): string {
  return raw.replaceAll('\\', '/').normalize('NFC').replace(/^\/+|\/+$/g, '');
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function inScope(groupPath: string, scopeRoot: string): boolean {
  if (!scopeRoot) return true;
  return groupPath === scopeRoot || groupPath.startsWith(`${scopeRoot}/`);
}

/** 候选集指纹：与顺序无关（先按 group/sourcePath/relation 稳定排序再哈希） */
export function computePruneToken(candidates: PruneCandidateItem[]): string {
  const lines = [...candidates]
    .sort((a, b) => (a.group === b.group
      ? (a.sourcePath === b.sourcePath ? a.relation.localeCompare(b.relation) : a.sourcePath.localeCompare(b.sourcePath))
      : a.group.localeCompare(b.group)))
    .map((item) => `${item.group}\u0000${item.relation}\u0000${item.sourcePath}`)
    .join('\n');
  return createHash('sha256').update(lines).digest('hex').slice(0, 16);
}

// ─── 前置校验（可独立单测） ──────────────────────────────

/**
 * 判定是否连计算都不必做。顺序即优先级：
 * 关闭开关 → 非目录模式 → 子集重试 → 上传不完整 → 空源。
 */
export function resolvePrunePrecheck(input: PrunePrecheckInput): { reason: PruneSkipReason; detail: string } | null {
  if (!input.pruneStale) return { reason: 'DISABLED', detail: '未开启「导入后提示清理」' };
  if (input.pickMode !== 'dir') {
    return {
      reason: 'NOT_DIR_MODE',
      detail: input.pickMode === 'mixed'
        ? '目录与文件混合选择时不支持清理（路径口径不一致），请分开导入'
        : '仅「选择目录」上传时可用',
    };
  }
  if (input.subsetRetry) return { reason: 'SUBSET_RETRY', detail: '「重试未完成」模式不做清理' };
  if (input.uploadIncomplete) {
    return {
      reason: 'UPLOAD_INCOMPLETE',
      detail: '本次有文件未上传成功，已跳过清理（这些文件本地仍在，不能被当作已删除）',
    };
  }
  if (input.scannedCount === 0) return { reason: 'EMPTY_SOURCE', detail: '本次未扫描到任何文档，已跳过清理' };
  return null;
}

// ─── 核心：纯函数 ───────────────────────────────────────

export interface ComputePrunePlanInput {
  scope: string;
  /** 显式 Group（'' = 全 scope）；与导入时同口径 */
  group: string;
  /** 本次目录**全量扫描**到的文件相对路径 */
  scannedRels: string[];
  /** 上传阶段失败的文件（视为「本次有」，永不进候选） */
  preserveRels?: string[];
  /** 由 import.ts 用 resolveGroupForSource 推导后传入 */
  importedGroups: string[];
  lib: PruneLibSnapshot;
  /**
   * 候选基线（数据源路径用）：只允许「这些 sourcePath」进入候选。
   * 缺省 `undefined` ⇒ 现有 Web 导入行为（全 scope 差集）逐字节不变。
   * 传空数组 ⇒ 零候选（首次同步没有历史基线，不做任何删除提案）。
   */
  eligibleRels?: string[];
  /**
   * 超限（候选 > {@link PRUNE_MAX_ITEMS}）时是否仍生成 token。
   * 缺省 `false`（Web 路径：超限不删）；数据源路径传 `true` 以支持分批删除。
   */
  emitTokenWhenOverLimit?: boolean;
}

/** 按基线收窄后的库条目（未传基线时 = 全部条目） */
function eligibleItemsOf(input: ComputePrunePlanInput): PruneLibItem[] {
  if (input.eligibleRels === undefined) return input.lib.items;
  const eligible = new Set(input.eligibleRels.map(normalizePrunePath));
  return input.lib.items.filter((item) => eligible.has(normalizePrunePath(item.sourcePath)));
}

function emptyPlan(input: ComputePrunePlanInput, scanned: number): ImportPrunePlan {
  const eligibleCount = eligibleItemsOf(input).length;
  return {
    scope: input.scope,
    scopeGroups: input.lib.groups.length,
    libDocs: input.lib.docs,
    judicable: input.lib.judicable,
    eligibleCount,
    scanned,
    overlap: 0,
    coordRatio: 0,
    deleteRatio: 0,
    warn: false,
    overLimit: false,
    total: 0,
    items: [],
    truncated: false,
    unableCount: Math.max(0, input.lib.docs - input.lib.judicable),
    untouchedGroups: [],
  };
}

/**
 * 差集 + 双闸门 + token。零 IO，单测直接用构造的库快照驱动。
 *
 * 顺序固定：先算闸门 A（不枚举候选，选错目录时库内可能有数万篇）→ 再枚举 → 再算闸门 B。
 */
export function computePrunePlan(input: ComputePrunePlanInput): ImportPrunePlan {
  const scanned = uniqSorted([...input.scannedRels, ...(input.preserveRels ?? [])].map(normalizePrunePath));
  const plan = emptyPlan(input, scanned.length);
  // 基线口径：未传 eligibleRels ⇒ 全部条目（保持 Web 导入行为不变）
  const eligibleItems = eligibleItemsOf(input);
  const eligibleCount = eligibleItems.length;

  if (input.lib.judicable === 0) {
    return { ...plan, skipReason: 'EMPTY_LIBRARY', skipDetail: '库中没有可判定来源的文档（sourcePath 均为空），无需清理' };
  }
  if (scanned.length === 0) {
    return { ...plan, skipReason: 'EMPTY_SOURCE', skipDetail: '本次未扫描到任何文档，已跳过清理' };
  }
  // ★ 空基线必须早退：否则下面闸门 A 的分母 Math.min(scanned, libRels)=0 → NaN/Infinity。
  //   语义：本数据源上次什么都没见过（首次同步）⇒ 库里任何文档都不属于它，零候选。
  if (input.eligibleRels !== undefined && eligibleCount === 0) {
    return plan;
  }

  const effective = new Set(scanned);
  const libRels = uniqSorted(eligibleItems.map((item) => normalizePrunePath(item.sourcePath)));
  const overlap = libRels.filter((rel) => effective.has(rel)).length;
  const coordRatio = round3(overlap / Math.min(scanned.length, libRels.length));

  if (coordRatio < PRUNE_COORD_THRESHOLD) {
    return {
      ...plan,
      overlap,
      coordRatio,
      skipReason: 'GATE_COORD',
      skipDetail: `本次上传的路径与库中记录仅 ${Math.round(coordRatio * 100)}% 重合，低于 ${Math.round(PRUNE_COORD_THRESHOLD * 100)}% 阈值；直接清理会误删 ${eligibleCount - overlap} 篇。这也可能意味着本次选错了目录层级，请核对`,
    };
  }

  const importedGroups = new Set(input.importedGroups);
  const candidates: PruneCandidateItem[] = eligibleItems
    .filter((item) => !effective.has(normalizePrunePath(item.sourcePath)))
    .map((item) => ({
      group: item.group,
      relation: item.relation,
      sourcePath: item.sourcePath,
      untouched: !importedGroups.has(item.group),
    }));

  const deleteRatio = round3(candidates.length / eligibleCount);
  if (deleteRatio > PRUNE_SCALE_THRESHOLD) {
    return {
      ...plan,
      overlap,
      coordRatio,
      deleteRatio,
      total: candidates.length,
      skipReason: 'GATE_SCALE',
      skipDetail: `本次将删除库中 ${Math.round(deleteRatio * 100)}% 的文档（${candidates.length}/${eligibleCount}），超过 ${Math.round(PRUNE_SCALE_THRESHOLD * 100)}% 阈值`,
    };
  }

  const untouchedGroups = uniqSorted(
    input.lib.groups.filter((groupPath) => (input.lib.groupDocs[groupPath] ?? 0) > 0 && !importedGroups.has(groupPath)),
  );
  const overLimit = candidates.length > PRUNE_MAX_ITEMS;
  const items = candidates.slice(0, PRUNE_MAX_DETAIL);
  // Web 路径（缺省）：超限不给 token（保持既有"请用 CLI 清理"语义）；
  // 数据源路径：超限也给 token，供「分批删除」逐批校验。
  const token = candidates.length > 0 && (!overLimit || input.emitTokenWhenOverLimit === true)
    ? computePruneToken(candidates)
    : undefined;

  return {
    ...plan,
    overlap,
    coordRatio,
    deleteRatio,
    warn: deleteRatio > PRUNE_WARN_THRESHOLD,
    overLimit,
    total: candidates.length,
    items,
    truncated: candidates.length > items.length,
    untouchedGroups,
    ...(token ? { token } : {}),
    // 超限时 items 只含前 500 条：把全量 sourcePath 一并给出，供数据源持久化后重算
    ...(overLimit && input.emitTokenWhenOverLimit === true
      ? { allCandidateSourcePaths: candidates.map((item) => item.sourcePath) }
      : {}),
  };
}

// ─── 薄包装：读缓存 + 作用域裁剪 ────────────────────────

/** 读某个 scope 的库快照并按作用域裁剪（只读本地缓存，不开引擎） */
export function readPruneLibSnapshot(scope: string, groupRoot: string): PruneLibSnapshot {
  const all = readAllGroupCaches(scope);
  const groups: string[] = [];
  const items: PruneLibItem[] = [];
  const groupDocs: Record<string, number> = {};
  let docs = 0;
  let judicable = 0;

  for (const [groupPath, data] of all) {
    if (!inScope(groupPath, groupRoot)) continue;
    const relations = data.hot_relations ?? [];
    groups.push(groupPath);
    groupDocs[groupPath] = relations.length;
    docs += relations.length;
    for (const relation of relations) {
      const sourcePath = typeof relation.sourcePath === 'string' ? relation.sourcePath.trim() : '';
      if (!sourcePath) continue;
      judicable += 1;
      items.push({ group: groupPath, relation: relation.text, sourcePath });
    }
  }

  return { groups: groups.sort(), docs, judicable, groupDocs, items };
}

/**
 * 组合入口：前置校验 → 读库快照 → 纯函数计算。
 *
 * 任何异常都降级为 `skipReason='ERROR'`：清理是附加能力，不得反噬导入主流程。
 */
export function planImportPrune(args: {
  scope: string;
  group: string;
  scannedRels: string[];
  preserveRels?: string[];
  importedGroups: string[];
  precheck: PrunePrecheckInput;
  /** 候选基线（数据源路径用）；缺省 = 现有 Web 行为 */
  eligibleRels?: string[];
  /** 超限仍生成 token（数据源分批删除用） */
  emitTokenWhenOverLimit?: boolean;
}): ImportPrunePlan {
  const EMPTY_LIB: PruneLibSnapshot = { groups: [], docs: 0, judicable: 0, groupDocs: {}, items: [] };
  const precheck = resolvePrunePrecheck(args.precheck);
  const baseInput: ComputePrunePlanInput = {
    scope: args.scope,
    group: args.group,
    scannedRels: args.scannedRels,
    preserveRels: args.preserveRels,
    importedGroups: args.importedGroups,
    lib: EMPTY_LIB,
    eligibleRels: args.eligibleRels,
    emitTokenWhenOverLimit: args.emitTokenWhenOverLimit,
  };

  try {
    if (precheck) {
      return {
        ...emptyPlan(baseInput, args.scannedRels.length),
        skipReason: precheck.reason,
        skipDetail: precheck.detail,
      };
    }
    return computePrunePlan({ ...baseInput, lib: readPruneLibSnapshot(args.scope, args.group.trim()) });
  } catch (error) {
    return {
      ...emptyPlan(baseInput, args.scannedRels.length),
      skipReason: 'ERROR',
      skipDetail: (error as Error).message,
    };
  }
}

/** token 比对（`/api/import/prune` 用；两侧都由 {@link computePruneToken} 生成） */
export function verifyPruneToken(plan: ImportPrunePlan, token: string): boolean {
  return typeof plan.token === 'string' && plan.token.length > 0 && plan.token === token;
}
