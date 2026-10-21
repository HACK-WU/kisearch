/**
 * task-snapshot.ts —— 任务台账的参数快照 / 结果摘要抽取（REQ-20261019-004 S-02）
 *
 * 背景：三端（web job / CLI 直连 / daemon RPC）创建任务时只写 `{operation, scope}`，
 * 导入参数与结果统计只活在内存 Job 或 CLI stdout，1h 后不可回看。
 *
 * 设计约束（见 DESIGN.md D2-2）：抽取逻辑**只有这一份实现**——三端只调用，不各自组装。
 * 本项目已因"两处入口各写一份判断"漏标过 coordinator kind（daemon-rpc.ts:492-493 有注释）。
 *
 * 依赖边界：本模块可以 import `import-retry.ts`（业务层），但 `task-registry.ts` 不行
 * （落盘层必须零业务依赖，见 D1-3）。
 */
import os from 'node:os';
import path from 'node:path';
import type { TaskParamSnapshot, TaskResultSnapshot } from './task-registry.js';
import { uploadIdFromSourceDir } from './import-retry.js';
// ★ 必须复用导入侧同一解析：小写化、去重、过滤内部保留 tag（ki-search/ki-relation/ki-path）。
//   自解析会让「快照里的 tag」与「实际写进 relation.tags 的 tag」不一致（code-review P1-2 核实成立）。
import { parseContentTags } from './constants.js';

/** 单类明细上限：与 `task-registry.MAX_TASK_DETAIL_ITEMS` 同值（此处不 import 常量以避免循环依赖） */
export const MAX_SNAPSHOT_DETAIL = 20;

const DEFAULT_UPLOADS_ROOT = path.join(os.homedir(), '.ki', 'import-uploads');

/** `handleDirectImport` 入参中与本快照相关的子集 */
export interface ImportArgsLike {
  sourceDir?: string;
  type?: 'directory' | 'git';
  mode?: 'incremental' | 'full';
  group?: string;
  tags?: string;
  vector?: boolean;
  conflictMode?: string;
  conflictSuffix?: string;
  skipDuplicates?: boolean;
  chunkSize?: number;
  chunkOverlap?: number;
}

/**
 * 导入类任务的参数快照；非 `import` operation 返回 `undefined`（restore/rebuild 无此语义）。
 *
 * @param uploadsRoot 受控上传根目录（web 端传入 `getUploadsRoot()`；CLI/daemon 用默认值）
 */
export function toParamSnapshot(
  operation: string,
  args: ImportArgsLike | undefined,
  uploadsRoot: string = DEFAULT_UPLOADS_ROOT,
): TaskParamSnapshot | undefined {
  // 数据源同步复用导入参数形态（sourceDir/group/conflict/vector/chunk）；
  // 结果快照不写入台账——完整结果在 datasource.json.lastSync（SSOT，不受 1h TTL 影响）。
  if ((operation !== 'import' && operation !== 'datasource-sync') || !args) return undefined;
  const snapshot: TaskParamSnapshot = {};
  const sourceDir = typeof args.sourceDir === 'string' ? args.sourceDir : '';
  // 来源形态决定「能否事后重试」：暂存目录会被 UPLOAD_IDLE_TTL_MS 清理，外部目录不会
  if (sourceDir) {
    snapshot.sourceKind = uploadIdFromSourceDir(sourceDir, uploadsRoot) !== null ? 'upload' : 'external';
  }
  if (args.type === 'git' || args.type === 'directory') snapshot.type = args.type;
  if (args.mode === 'incremental' || args.mode === 'full') snapshot.mode = args.mode;
  if (typeof args.group === 'string' && args.group.trim()) snapshot.group = args.group.trim();
  // 与 `handleDirectImport` 的 `customTags` 同源解析（大小写/去重/保留 tag 过滤），
  // 保证详情展示的就是实际生效的标签集合
  const tags = parseContentTags(typeof args.tags === 'string' ? args.tags : '').slice(0, MAX_SNAPSHOT_DETAIL);
  if (tags.length > 0) snapshot.tags = tags;
  // 缺省与 handleDirectImport 同口径：vector 缺省 true；conflictMode 缺省 incremental
  snapshot.vector = args.vector !== false;
  snapshot.conflictMode = typeof args.conflictMode === 'string' && args.conflictMode.trim()
    ? args.conflictMode.trim()
    : 'incremental';
  if (snapshot.conflictMode === 'suffix' && typeof args.conflictSuffix === 'string' && args.conflictSuffix.trim()) {
    snapshot.conflictSuffix = args.conflictSuffix.trim();
  }
  snapshot.skipDuplicates = args.skipDuplicates === true;
  if (Number.isFinite(args.chunkSize)) snapshot.chunkSize = Number(args.chunkSize);
  if (Number.isFinite(args.chunkOverlap)) snapshot.chunkOverlap = Number(args.chunkOverlap);
  return snapshot;
}

function toCount(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(Number(value))) : 0;
}

/**
 * `skipped` 的三类拆分（不变量：`conflict + duplicate + other === skipped`）。
 *
 * 依据 `handleDirectImport` 的 `stats.files.skipped`（**文件级**口径，不是顶层
 * `stats.skipped` 的条目级口径）：它已是「过大 / 超限 / hook 失败 / 冲突跳过 / 疑似重复」的
 * 合并值，因此不能把三项各自计数直接相加，必须以 `skipped` 为上限反算 `other`。
 */
export function splitSkipped(
  skipped: number,
  duplicatesSkipped: number,
  conflicts: Array<{ action?: string }> | undefined,
): { conflict: number; duplicate: number; other: number } {
  const total = toCount(skipped);
  const duplicate = Math.min(total, toCount(duplicatesSkipped));
  const conflictCount = (Array.isArray(conflicts) ? conflicts : []).filter((item) => item?.action === 'skip').length;
  const conflict = Math.min(total - duplicate, Math.max(0, conflictCount));
  return { conflict, duplicate, other: Math.max(0, total - conflict - duplicate) };
}

interface ImportResultLike {
  stats?: {
    vectorized?: number;
    fullTextIndexed?: number;
    assets?: number;
    files?: {
      total?: number;
      completed?: number;
      incomplete?: number;
      scanned?: number;
      skipped?: number;
      unchanged?: number;
      duplicatesSkipped?: number;
    };
  };
  duplicatesSkipped?: Array<{ path?: string; existingGroup?: string; existingRelation?: string }>;
  duplicatesSkippedTruncated?: boolean;
  conflicts?: Array<{ path?: string; relation?: string; action?: string; skipReason?: string; unchanged?: boolean }>;
  groups?: string[];
}

const CONFLICT_ACTIONS = new Set(['overwrite', 'skip', 'suffix']);

/**
 * 导入类任务的结果摘要；结构不可解析或非导入 operation 时返回 `undefined`
 * （调用方仍会通过 `errorCode` 写入可判别错误码）。
 */
export function toResultSnapshot(operation: string, result: unknown): TaskResultSnapshot | undefined {
  if (operation !== 'import' || !result || typeof result !== 'object') return undefined;
  const value = result as ImportResultLike;
  const out: TaskResultSnapshot = {};
  let truncated = value.duplicatesSkippedTruncated === true;

  const files = value.stats?.files;
  if (files && typeof files === 'object') {
    const skipped = toCount(files.skipped);
    const duplicatesSkipped = toCount(files.duplicatesSkipped);
    const conflicts = Array.isArray(value.conflicts) ? value.conflicts : [];
    out.files = {
      scanned: toCount(files.scanned),
      completed: toCount(files.completed),
      incomplete: toCount(files.incomplete),
      skipped,
      unchanged: toCount(files.unchanged),
      duplicatesSkipped,
      skippedReasons: splitSkipped(skipped, duplicatesSkipped, conflicts),
    };
  }

  if (Number.isFinite(value.stats?.vectorized)) out.vectorized = toCount(value.stats?.vectorized);
  if (Number.isFinite(value.stats?.fullTextIndexed)) out.fullTextIndexed = toCount(value.stats?.fullTextIndexed);
  if (Number.isFinite(value.stats?.assets)) out.assets = toCount(value.stats?.assets);

  const groups = (Array.isArray(value.groups) ? value.groups : [])
    .filter((group): group is string => typeof group === 'string' && group.trim().length > 0)
    .map((group) => group.trim());
  const uniqueGroups = [...new Set(groups)];
  if (uniqueGroups.length > MAX_SNAPSHOT_DETAIL) truncated = true;
  if (uniqueGroups.length > 0) out.groups = uniqueGroups.slice(0, MAX_SNAPSHOT_DETAIL);

  const duplicates = (Array.isArray(value.duplicatesSkipped) ? value.duplicatesSkipped : [])
    .filter((item) => typeof item?.path === 'string' && typeof item?.existingRelation === 'string')
    .map((item) => ({
      path: String(item.path),
      existingGroup: typeof item.existingGroup === 'string' ? item.existingGroup : '',
      existingRelation: String(item.existingRelation),
    }));
  if (duplicates.length > MAX_SNAPSHOT_DETAIL) truncated = true;
  if (duplicates.length > 0) out.duplicates = duplicates.slice(0, MAX_SNAPSHOT_DETAIL);

  const conflicts = (Array.isArray(value.conflicts) ? value.conflicts : [])
    .filter((item) => typeof item?.path === 'string' && typeof item?.relation === 'string'
      && typeof item?.action === 'string' && CONFLICT_ACTIONS.has(item.action))
    .map((item) => ({
      path: String(item.path),
      relation: String(item.relation),
      action: item.action as 'overwrite' | 'skip' | 'suffix',
      ...(item.skipReason === 'already-imported' || item.skipReason === 'same-name'
        ? { skipReason: item.skipReason }
        : {}),
      // 实际结果：判定为覆盖但内容未变、未执行（见 `ImportConflict.unchanged` 注释）
      ...(item.unchanged === true ? { unchanged: true as const } : {}),
    }));
  if (conflicts.length > MAX_SNAPSHOT_DETAIL) truncated = true;
  if (conflicts.length > 0) out.conflicts = conflicts.slice(0, MAX_SNAPSHOT_DETAIL);

  if (truncated) out.truncated = true;
  return Object.keys(out).length > 0 ? out : undefined;
}
