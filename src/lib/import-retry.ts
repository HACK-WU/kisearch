/**
 * import-retry.ts —— 「未完成导入清单」的 scope 级持久化（R2 / REQ-20261009-001）
 *
 * 背景：R1 让系统性向量故障下的导入变成「文件级部分成功」——已完成文件提交可用，
 * 未完成文件不写元数据。R2 要求「只重试未完成部分」，因此未完成清单必须**跨进程/跨会话
 * 存活**（不能只留在本次任务的返回值里，否则用户离开页面/终端后无从重试）。
 *
 * 落点：`<scope>/.ki-import-incomplete.json`（点号前缀，与 `.relations/`、`.ki-tasks/` 同族，
 * 不进组名空间、不被 `listGroupPaths` 当作分片）。语义：
 *   - 部分成功（`result.partial`）→ 覆盖写入本次未完成清单；
 *   - 全部完成 → **删除**该文件（清单清空 = 没有待重试项）。
 *
 * 跨源目录（P1，review REQ-20261009-001）：清单是 scope 级单文件，同一 scope 先后导入
 * 两个源目录时会互相覆盖。覆盖/清除前的旧清单会先备份为
 * `<scope>/.ki-import-incomplete.prev.json`（只保留最近一份）并告警——不静默丢弃。
 *
 * fail-loud（P2，review）：清单写入失败返回 `false`，由调用方告警（不再静默吞掉）；
 * 主清单损坏与「不存在」在 `readImportIncompleteStatus` 中可区分，避免把损坏说成"没有待办"。
 */
import fs from 'fs';
import path from 'path';
import { getKbDir, validateScope } from './scope.js';
import { readJson, writeJson } from './store.js';
import { logWarn } from './progress.js';
import type { ImportIncompleteItem } from './import.js';

const RETRY_FILE = '.ki-import-incomplete.json';
/** 被「另一源目录」的批次覆盖/清除前的旧清单备份（只保留最近一份） */
const RETRY_PREV_FILE = '.ki-import-incomplete.prev.json';

/** 重试所需的最小参数快照（忠实复现原批次语义：切分口径、是否向量化、标签、冲突策略） */
export interface ImportRetryParams {
  group?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  vector: boolean;
  tags?: string;
  conflictMode?: string;
  conflictSuffix?: string;
}

export interface ImportIncompleteRecord {
  version: 1;
  scope: string;
  /** 写入时刻（ISO） */
  createdAt: string;
  /** 本次导入的源目录（原文直导的 `--source` / `--dir` 或 Web 暂存目录） */
  sourceDir: string;
  /** 原批次参数（重试时若命令行未显式覆盖则沿用） */
  params: ImportRetryParams;
  /** 未完成文件清单（文件级；已成功文件不在其中） */
  items: ImportIncompleteItem[];
  /** 停止原因（若有）——用于向用户解释"为什么没导完" */
  stopReason?: { kind: string; code: string; phase: string; reason: string };
  /** 本轮是否因取消而停止 */
  cancelled?: boolean;
  /**
   * 写入本清单的任务 ID（2026-10-13）：供任务中心按任务校验归属——
   * 清单是 scope 级单文件，后被导入覆盖后，旧任务详情再点"重试"必须能识别出
   * 「清单已属于别的批次」（否则会静默按最新清单重试，重试错对象）。
   * 可选：早于本字段写入的旧清单没有它 ⇒ 调用方按"归属未知"处理（放行 + 提示）。
   */
  taskId?: string;
}

export interface ImportIncompleteRead {
  /** 主清单（不存在或损坏时为 null） */
  record: ImportIncompleteRecord | null;
  /** 主清单文件存在但损坏/不可解析（区别于"没有待重试项"） */
  corrupted: boolean;
  /** 上次跨源覆盖时留下的备份清单（主清单缺失时可提示用户） */
  previous: ImportIncompleteRecord | null;
}

export function getImportIncompletePath(scope: string): string {
  validateScope(scope);
  return path.join(getKbDir(scope), RETRY_FILE);
}

/** 跨源覆盖前的旧清单备份路径 */
export function getImportIncompletePrevPath(scope: string): string {
  validateScope(scope);
  return path.join(getKbDir(scope), RETRY_PREV_FILE);
}

/** 读取单个清单文件：`missing` 与 `corrupted` 分开返回，调用方可给出准确结论 */
function readRecordFile(file: string): { record: ImportIncompleteRecord | null; corrupted: boolean } {
  if (!fs.existsSync(file)) return { record: null, corrupted: false };
  try {
    const parsed = readJson<ImportIncompleteRecord>(file);
    if (!parsed || !Array.isArray(parsed.items)) return { record: null, corrupted: true };
    // 结构校验（2026-10-13 评审）：只判 `items` 是数组不够——缺 `sourceDir` / `params`
    // 的清单若放行，下游（HTTP 摘要、按清单重试）会以 `path.resolve(undefined)` 之类的
    // TypeError 收场，落到统一 catch 后只剩一串英文 Node 报错，用户拿不到可读结论。
    // 这里把「结构不合格」并入 `corrupted`（与"文件不存在"仍然区分，fail-loud 不静默）。
    if (typeof parsed.sourceDir !== 'string' || parsed.sourceDir.length === 0) {
      return { record: null, corrupted: true };
    }
    if (!parsed.params || typeof parsed.params !== 'object' || Array.isArray(parsed.params)) {
      return { record: null, corrupted: true };
    }
    if (parsed.items.some((item) => !item || typeof item !== 'object')) {
      return { record: null, corrupted: true };
    }
    return { record: parsed, corrupted: false };
  } catch {
    return { record: null, corrupted: true };
  }
}

/**
 * 读取清单全貌（主清单 + 是否有跨源备份 + 主清单是否损坏）。
 * 不承载不可再生数据，但仍按 fail-loud 呈现——损坏不等于"没有待办"。
 */
export function readImportIncompleteStatus(scope: string): ImportIncompleteRead {
  const main = readRecordFile(getImportIncompletePath(scope));
  const prev = readRecordFile(getImportIncompletePrevPath(scope));
  return { record: main.record, corrupted: main.corrupted, previous: prev.record };
}

/** 读取未完成清单；不存在或损坏返回 null（调用方需区分时用 `readImportIncompleteStatus`） */
export function readImportIncomplete(scope: string): ImportIncompleteRecord | null {
  return readImportIncompleteStatus(scope).record;
}

/**
 * 写入未完成清单。
 * @returns 是否写入成功——失败由调用方告警（清单写不进去时"重试入口"实际不可用，不能静默）
 */
export function writeImportIncomplete(scope: string, record: ImportIncompleteRecord): boolean {
  try {
    writeJson(getImportIncompletePath(scope), record as unknown as Record<string, unknown>);
    return true;
  } catch (error) {
    logWarn(`未完成清单写入失败（${(error as Error).message}）：本次未完成文件将无法通过 --retry-incomplete 找回，请检查 scope 目录权限/磁盘空间`);
    return false;
  }
}

/**
 * 覆盖/清除前把现有主清单备份为 `.ki-import-incomplete.prev.json`（只保留最近一份）。
 * 用于「同一 scope 先后导入不同源目录」时避免前一批未完成项被静默抹掉。
 * @returns 备份路径；无旧清单或备份失败返回 null
 */
export function backupImportIncomplete(scope: string): string | null {
  const file = getImportIncompletePath(scope);
  if (!fs.existsSync(file)) return null;
  const prev = getImportIncompletePrevPath(scope);
  try {
    fs.rmSync(prev, { force: true });
    fs.renameSync(file, prev);
    return prev;
  } catch (error) {
    logWarn(`未完成清单备份失败（${(error as Error).message}）：旧清单将被本次结果覆盖`);
    return null;
  }
}

/** 清空未完成清单（全量成功 / 已无待重试项时调用；不存在时 no-op） */
export function clearImportIncomplete(scope: string): void {
  try {
    const file = getImportIncompletePath(scope);
    if (fs.existsSync(file)) fs.rmSync(file);
  } catch {
    /* ignore */
  }
}

// ─── 清单摘要与来源分类（2026-10-13：任务中心「重试未完成」入口）────────────────
//
// 背景：重试入口此前只存在于导入页当前会话（依赖浏览器凭据 uploadId + 内存 job 结果），
// 任务中心（/tasks）对失败/取消/中断任务无任何出路。本段为「按清单重试」提供**只读判据**：
// HTTP 层只输出类型与存在性，**绝不回显绝对路径**（沿用 task-registry 的脱敏惯例）。

/**
 * 清单源目录类型：
 *   - `upload`：Web 上传暂存目录（`<uploadsRoot>/<uploadId>`）—— 重试直接复用其内容；
 *   - `external`：外部 Wiki 目录（CLI `ki import --source` 的落点）—— 需存在性校验。
 */
export type ImportIncompleteSourceKind = 'upload' | 'external';

/**
 * 若 `sourceDir` 恰为 `uploadsRoot` 的**直接子目录**，返回其目录名（uploadId 候选）；否则 null。
 * ★ 刻意不做 UUID 格式校验：那份规则（`UPLOAD_ID_RE`）属 HTTP 层单一真相，此处只做路径归属判定。
 */
export function uploadIdFromSourceDir(sourceDir: string, uploadsRoot: string): string | null {
  const root = path.resolve(uploadsRoot);
  const dir = path.resolve(sourceDir);
  if (dir === root || !dir.startsWith(root + path.sep)) return null;
  const rel = dir.slice(root.length + 1);
  if (!rel || rel.includes(path.sep)) return null;
  return rel;
}

/** 清单摘要（HTTP 层直接序列化；**不含任何绝对路径**） */
export interface ImportIncompleteSummary {
  /** 主清单存在且可解析 */
  hasRecord: boolean;
  /** 主清单文件存在但损坏（≠ 没有待办，必须与"无清单"区分） */
  corrupted: boolean;
  /** 旧清单：写入时还没有 taskId 字段 ⇒ 归属未知（放行重试，但调用方必须提示） */
  legacy: boolean;
  /** 归属任务 ID（清单写入时记录） */
  taskId?: string;
  /** 未完成文件数 */
  itemCount: number;
  createdAt?: string;
  cancelled?: boolean;
  stopReason?: ImportIncompleteRecord['stopReason'];
  sourceKind?: ImportIncompleteSourceKind;
  /** 源目录当前是否存在（源目录被删/移走后不可重试） */
  sourceExists?: boolean;
  /** 是否可以按本清单重试——**前端只认这一个判据** */
  canRetry: boolean;
  /** canRetry=false 时的原因（面向用户，可直接展示） */
  reason?: string;
  /** 跨源覆盖前的备份清单摘要（主清单缺失时给用户出路线索） */
  previous?: { itemCount: number; sourceKind: ImportIncompleteSourceKind; sourceExists: boolean } | null;
}

function sourceKindOf(sourceDir: string, uploadsRoot: string): ImportIncompleteSourceKind {
  return uploadIdFromSourceDir(sourceDir, uploadsRoot) ? 'upload' : 'external';
}

/**
 * `stopReason.reason` 是引擎/网络报错原文（`error.message`），可能含本机绝对路径。
 * HTTP 摘要在边界上做一次**脱敏 + 截断**（2026-10-13 评审 P2）——让"响应不含绝对路径"
 * 由代码保证，而不是"当前恰好没有路径"；正则口径与 task-registry 的脱敏惯例一致。
 */
function redactStopReason(
  stopReason: NonNullable<ImportIncompleteRecord['stopReason']>,
): NonNullable<ImportIncompleteRecord['stopReason']> {
  const redacted = stopReason.reason
    .replace(/(^|[\s([{:：='"])(?:\/[^\s,;)}，。；'"]+|[A-Za-z]:\\[^\s,;)}，。；'"]+)/g, '$1[path]')
    .slice(0, 200);
  return { ...stopReason, reason: redacted };
}

/**
 * 汇总某 scope 的未完成清单状态，供任务中心「重试未完成」入口判定。
 * 只读（读清单文件 + `existsSync` 源目录），不产生任何写入。
 */
export function summarizeImportIncomplete(
  scope: string,
  options: { uploadsRoot: string },
): ImportIncompleteSummary {
  const status = readImportIncompleteStatus(scope);
  const previous = status.previous
    ? {
      itemCount: status.previous.items.length,
      sourceKind: sourceKindOf(status.previous.sourceDir, options.uploadsRoot),
      sourceExists: fs.existsSync(path.resolve(status.previous.sourceDir)),
    }
    : null;

  if (status.corrupted) {
    return {
      hasRecord: false,
      corrupted: true,
      legacy: false,
      itemCount: 0,
      canRetry: false,
      reason: '未完成清单损坏（无法解析）：请删除 <scope>/.ki-import-incomplete.json 后重新导入',
      previous,
    };
  }
  const record = status.record;
  if (!record) {
    return {
      hasRecord: false,
      corrupted: false,
      legacy: false,
      itemCount: 0,
      canRetry: false,
      reason: previous
        ? '本批没有待重试清单（上一批清单已被另一次导入覆盖，备份仍可人工处理）'
        : '没有待重试的未完成清单（可能已全部导入完成）',
      previous,
    };
  }

  const sourceDir = path.resolve(record.sourceDir);
  const sourceExists = fs.existsSync(sourceDir);
  const sourceKind = sourceKindOf(record.sourceDir, options.uploadsRoot);
  const base = {
    hasRecord: true,
    corrupted: false,
    legacy: record.taskId === undefined,
    ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
    itemCount: record.items.length,
    createdAt: record.createdAt,
    ...(record.cancelled !== undefined ? { cancelled: record.cancelled } : {}),
    ...(record.stopReason !== undefined ? { stopReason: redactStopReason(record.stopReason) } : {}),
    sourceKind,
    sourceExists,
    previous,
  };

  if (record.items.length === 0) {
    return { ...base, canRetry: false, reason: '未完成清单为空，无需重试' };
  }
  if (!sourceExists) {
    return {
      ...base,
      canRetry: false,
      reason: sourceKind === 'upload'
        ? '上次导入的暂存目录已不存在（可能已被清理）：请重新上传后导入'
        : '上次导入的源目录已不存在：请用当前源目录重新导入',
    };
  }
  return { ...base, canRetry: true };
}
