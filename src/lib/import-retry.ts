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
