/**
 * batch-vectorize.ts —— S-03：批量调用 `mem store` / `mem bulk-store` 完成 entries 向量化
 *
 * 设计要点：
 *   - bulkVectorize（推荐）：一次 `mem bulk-store` 进程写入全部条目，消除 N 次进程启动 + N 次锁获取
 *   - batchVectorize（兼容）：串行逐条 `mem store`，用于增量等小批量场景
 *   - vectorizeOne：单条向量化，增量 modify 使用
 *   - 通过 stdout `Memory ID: <id>` 行（由 src/cli.ts 输出）解析 memoryId
 *   - 失败条目记入 errors，不中断整体
 *   - 默认 category=kb-import，便于后续清理/统计
 *   - 不处理 action=delete 条目（调用方过滤）
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ScanResultEntry } from './ai-results.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CATEGORY = 'kb-import';
const MEMORY_ID_PATTERN = /^[ \t]*Memory ID:[ \t]*(\S+)[ \t]*$/m;

export interface BatchVectorizeResult {
  /** path → memoryId（成功条目） */
  ok: Map<string, string>;
  errors: { path: string; error: string }[];
}

export interface BatchVectorizeOptions {
  /** 每条 mem store 超时 (ms)，默认 30000 */
  timeoutMs?: number;
  /** memory category，默认 kb-import */
  category?: string;
}

/** bulk-store --json 输出结构 */
interface BulkStoreJsonResult {
  total: number;
  ok: number;
  errors: number;
  skipped: number;
  elapsedSeconds: number;
  details: {
    ok: { index: number; text: string; id: string }[];
    errors: { index: number; text: string; error: string }[];
    skipped: { index: number; text: string; reason: string }[];
  };
}

/**
 * 构造 mem store 的 content 文本
 *   [摘要] ...
 *   [关键词] k1, k2
 *   [路径] xxx
 */
export function buildVectorizeContent(entry: ScanResultEntry): string {
  const kw = (entry.keywords || []).join(', ');
  return `[摘要] ${entry.summary}\n[关键词] ${kw}\n[路径] ${entry.path}`;
}

/** 从 mem store stdout 提取 memoryId */
export function parseMemoryId(stdout: string): string | null {
  const m = stdout.match(MEMORY_ID_PATTERN);
  return m ? m[1] : null;
}

/**
 * 单条向量化
 * 内部使用，便于 S-06 modify/add 单条调用
 */
export function vectorizeOne(
  entry: ScanResultEntry,
  scope: string,
  options: BatchVectorizeOptions = {}
): { ok: true; memoryId: string } | { ok: false; error: string } {
  const category = options.category || DEFAULT_CATEGORY;
  const timeout = options.timeoutMs || parseInt(process.env.MEM_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
  const content = buildVectorizeContent(entry);

  try {
    const stdout = execFileSync(
      'mem',
      ['store', content, '--scope', scope, '--category', category, '--tags', 'ki-search'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      }
    );
    const id = parseMemoryId(stdout);
    if (!id) {
      return { ok: false, error: `无法从 stdout 解析 memoryId（缺少 "Memory ID:" 行）` };
    }
    return { ok: true, memoryId: id };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const stderr = e.stderr ? e.stderr.toString() : '';
    const stdout = e.stdout ? e.stdout.toString() : '';
    // 子进程返回非 0：可能 stdout 仍含 Memory ID（理论上 store 失败不会有），尝试一次
    const idMaybe = parseMemoryId(stdout);
    if (idMaybe) {
      return { ok: true, memoryId: idMaybe };
    }
    const statusInfo = typeof e.status === 'number' ? ` exitCode=${e.status}` : '';
    return {
      ok: false,
      error: `mem store 失败${statusInfo}: ${e.message || ''}${stderr ? `\nstderr=${stderr.trim()}` : ''}`.trim(),
    };
  }
}

/**
 * 批量向量化
 * @param entries  需要向量化的条目（调用方应预先过滤掉 action=delete）
 * @param scope    目标 scope
 * @returns        ok Map（成功）+ errors（失败明细）
 */
export function batchVectorize(
  entries: ScanResultEntry[],
  scope: string,
  options: BatchVectorizeOptions = {}
): BatchVectorizeResult {
  const ok = new Map<string, string>();
  const errors: { path: string; error: string }[] = [];

  for (const entry of entries) {
    if (entry.action === 'delete') {
      // 调用方未过滤，跳过以容错
      continue;
    }
    const r = vectorizeOne(entry, scope, options);
    if (r.ok) {
      ok.set(entry.path, r.memoryId);
    } else {
      errors.push({ path: entry.path, error: r.error });
    }
  }

  return { ok, errors };
}

/**
 * 删除单条记忆（S-06 modify/delete 路径使用）
 */
export function deleteMemory(
  memoryId: string,
  options: BatchVectorizeOptions = {}
): { ok: boolean; error?: string } {
  const timeout = options.timeoutMs || parseInt(process.env.MEM_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
  try {
    execFileSync('mem', ['delete', memoryId], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
    return { ok: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; status?: number };
    const stderr = e.stderr ? e.stderr.toString() : '';
    const statusInfo = typeof e.status === 'number' ? ` exitCode=${e.status}` : '';
    return { ok: false, error: `mem delete ${memoryId} 失败${statusInfo}: ${e.message}${stderr ? `\nstderr=${stderr.trim()}` : ''}`.trim() };
  }
}

/**
 * 批量向量化（使用 mem bulk-store）
 *
 * 一次进程写入全部条目，消除 N 次进程启动 + N 次文件锁获取的开销。
 * 100 条从 ~300s（串行 mem store）降至 ~30-50s（单进程 bulk-store）。
 *
 * @param entries  需要向量化的条目（调用方应预先过滤掉 action=delete）
 * @param scope    目标 scope
 * @param options  选项
 * @returns        ok Map（成功）+ errors（失败明细）
 */
export function bulkVectorize(
  entries: ScanResultEntry[],
  scope: string,
  options: BatchVectorizeOptions = {}
): BatchVectorizeResult {
  const ok = new Map<string, string>();
  const errors: { path: string; error: string }[] = [];

  if (entries.length === 0) return { ok, errors };

  const category = options.category || DEFAULT_CATEGORY;
  // bulk-store 耗时 = 条目数 × 1~3s，超时需要更宽裕
  const timeout = options.timeoutMs
    || parseInt(process.env.MEM_BULK_TIMEOUT_MS || '', 10)
    || (60_000 + entries.length * 10_000);

  // 1) 构建批量存储的 JSON 数组
  const bulkEntries = entries.map((entry) => ({
    text: buildVectorizeContent(entry),
    tags: 'ki-search',
    category,
    scope,
  }));

  // 2) 写入临时文件
  const tmpFile = path.join(os.tmpdir(), `mem-bulk-${scope}-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(bulkEntries), 'utf-8');

    // 3) 调用 mem bulk-store
    //    stdio: ['ignore', 'pipe', 'inherit']
    //    - stdout piped → 捕获 JSON 结果
    //    - stderr inherited → 用户可看到 bulk-store 的原生进度输出
    const stdout = execFileSync(
      'mem',
      ['bulk-store', '-f', tmpFile, '--json', '--scope', scope],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit'],
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB，足够容纳大量条目的 JSON 结果
      }
    );

    // 4) 解析 JSON 结果
    //    bulk-store --json 可能先输出人类可读进度到 stderr，stdout 只输出 JSON
    //    但防御性地处理 stdout 中可能混入的非 JSON 行
    const jsonStr = extractJsonObject(stdout);
    const result = JSON.parse(jsonStr) as BulkStoreJsonResult;

    // 5) 映射 index → entry path
    for (const item of result.details.ok) {
      const entry = entries[item.index];
      if (entry) {
        ok.set(entry.path, item.id);
      }
    }

    for (const item of result.details.errors) {
      const entry = entries[item.index];
      if (entry) {
        errors.push({ path: entry.path, error: item.error });
      }
    }

    // skipped 条目（text 为空等）也视为错误
    for (const item of result.details.skipped || []) {
      const entry = entries[item.index];
      if (entry) {
        errors.push({ path: entry.path, error: item.reason || 'skipped by bulk-store' });
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const stderr = e.stderr ? e.stderr.toString() : '';
    const statusInfo = typeof e.status === 'number' ? ` exitCode=${e.status}` : '';
    const errMsg = `mem bulk-store 失败${statusInfo}: ${e.message || ''}${stderr ? `\nstderr=${stderr.trim().slice(0, 500)}` : ''}`.trim();
    // 整体失败，所有条目标记为错误
    for (const entry of entries) {
      errors.push({ path: entry.path, error: errMsg });
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }

  return { ok, errors };
}

/** 从可能混入非 JSON 行的 stdout 中提取最后一个完整 JSON 对象 */
function extractJsonObject(stdout: string): string {
  const trimmed = stdout.trim();
  // 快速路径：整个输出就是一个 JSON 对象
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  // 慢速路径：从末尾找最后一个 JSON 对象
  const lastBrace = trimmed.lastIndexOf('\n{');
  if (lastBrace >= 0) {
    return trimmed.slice(lastBrace + 1);
  }
  // 兜底：直接尝试解析
  return trimmed;
}
