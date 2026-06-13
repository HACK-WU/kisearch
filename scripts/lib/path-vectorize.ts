/**
 * path-vectorize.ts —— 路径向量索引写入模块
 *
 * 为 ki 命令的 group 路径和 relation 名称提供向量语义索引能力。
 * 写入 tag=ki-path 和 tag=ki-relation 的向量记录，供 path-search.ts 查询时兜底。
 *
 * 设计要点：
 *   - 路径层级用空格分隔存储（禁止用 /），如 "告警系统设计 告警收敛机制"
 *   - 去除根节点名（如 BK-Monitor-Wiki），减少噪音
 *   - category=other, importance=0.5（路径索引不是核心记忆）
 *   - 写入失败不阻塞主流程，errors 仅记录日志
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── 类型 ───

export interface PathVectorizeEntry {
  /** 向量文本内容（空格分隔格式） */
  text: string;
  /** 标签：ki-path 或 ki-relation */
  tag: 'ki-path' | 'ki-relation';
  /** scope */
  scope: string;
}

export interface PathVectorizeOptions {
  /** mem 命令超时 (ms)，默认 60000 + entries.length * 10000 */
  timeoutMs?: number;
}

export interface PathVectorizeResult {
  /** text → memoryId（成功条目） */
  ok: Map<string, string>;
  errors: { text: string; error: string }[];
}

// ─── 常量 ───

const DEFAULT_TIMEOUT_MS = 60_000;
const PATH_CATEGORY = 'other';
const PATH_IMPORTANCE = '0.5';
const MEMORY_ID_PATTERN = /^[ \t]*Memory ID:[ \t]*(\S+)[ \t]*$/m;

// ─── 文本构建 ───

/**
 * 构建 Group 路径向量文本
 *
 * 格式：路径层级用空格分隔（含根节点） | 关键词
 * @example buildGroupPathContent("BK-Monitor-Wiki/告警系统设计/告警收敛机制", ["告警收敛","降噪"])
 *          → "BK-Monitor-Wiki 告警系统设计 告警收敛机制 | 告警收敛,降噪"
 */
export function buildGroupPathContent(
  groupPath: string,
  keywords: string[]
): string {
  // 保留根节点，整条路径用空格分隔，确保 extractPathFromContent 能还原完整路径
  const pathWords = groupPath.split('/').filter(Boolean).join(' ');
  const kw = keywords.filter(Boolean).join(',');
  return kw ? `${pathWords} | ${kw}` : pathWords;
}

/**
 * 构建 Relation 向量文本
 *
 * 格式：Relation 名称 | Group: 路径层级（空格分隔，含根节点）| 关键词
 * @example buildRelationContent("告警收敛服务", "BK-Monitor-Wiki/告警系统设计/告警处理服务", ["收敛","去重"])
 *          → "告警收敛服务 | Group: BK-Monitor-Wiki 告警系统设计 告警处理服务 | 收敛,去重"
 */
export function buildRelationContent(
  relationText: string,
  groupPath: string,
  keywords: string[]
): string {
  // 保留根节点，保证路径可还原
  const pathWords = groupPath.split('/').filter(Boolean).join(' ');
  const kw = keywords.filter(Boolean).join(',');
  const groupPart = pathWords ? ` | Group: ${pathWords}` : '';
  const kwPart = kw ? ` | ${kw}` : '';
  return `${relationText}${groupPart}${kwPart}`;
}

// ─── 批量存储 ───

/**
 * 批量存储路径向量（使用 mem bulk-store）
 *
 * 一次进程写入全部条目，消除 N 次进程启动开销。
 */
export function bulkStorePaths(
  entries: PathVectorizeEntry[],
  options?: PathVectorizeOptions
): PathVectorizeResult {
  const ok = new Map<string, string>();
  const errors: { text: string; error: string }[] = [];

  if (entries.length === 0) return { ok, errors };

  // 按 scope 分组（bulk-store 一次只能指定一个 scope）
  const byScope = new Map<string, PathVectorizeEntry[]>();
  for (const entry of entries) {
    const list = byScope.get(entry.scope) || [];
    list.push(entry);
    byScope.set(entry.scope, list);
  }

  for (const [scope, scopeEntries] of byScope) {
    const timeout = options?.timeoutMs
      || parseInt(process.env.MEM_BULK_TIMEOUT_MS || '', 10)
      || (DEFAULT_TIMEOUT_MS + scopeEntries.length * 10_000);

    // 构建 JSON
    const bulkData = scopeEntries.map((e) => ({
      text: e.text,
      tags: e.tag,
      scope: e.scope,
      category: PATH_CATEGORY,
      importance: parseFloat(PATH_IMPORTANCE),
    }));

    const tmpFile = path.join(os.tmpdir(), `mem-path-bulk-${scope}-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(bulkData), 'utf-8');

      const stdout = execFileSync(
        'mem',
        ['bulk-store', '-f', tmpFile, '--json', '--scope', scope],
        {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'inherit'],
          timeout,
          maxBuffer: 10 * 1024 * 1024,
        }
      );

      // 解析 JSON 结果
      const result = parseBulkStoreJson(stdout);
      if (result) {
        for (const item of result.details?.ok || []) {
          const entry = scopeEntries[item.index];
          if (entry) ok.set(entry.text, item.id);
        }
        for (const item of result.details?.errors || []) {
          const entry = scopeEntries[item.index];
          if (entry) errors.push({ text: entry.text, error: item.error });
        }
        for (const item of result.details?.skipped || []) {
          const entry = scopeEntries[item.index];
          if (entry) errors.push({ text: entry.text, error: item.reason || 'skipped' });
        }
      } else {
        // JSON 解析失败，全部标记为错误
        for (const entry of scopeEntries) {
          errors.push({ text: entry.text, error: '无法解析 bulk-store JSON 输出' });
        }
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; status?: number };
      const stderr = e.stderr ? e.stderr.toString() : '';
      const statusInfo = typeof e.status === 'number' ? ` exitCode=${e.status}` : '';
      const errMsg = `[path-vectorize] bulk-store 失败${statusInfo}: ${e.message || ''}${stderr ? `\n${stderr.trim().slice(0, 300)}` : ''}`.trim();
      for (const entry of scopeEntries) {
        errors.push({ text: entry.text, error: errMsg });
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  return { ok, errors };
}

// ─── 单条存储 ───

/**
 * 单条存储路径向量（sync-relation / incremental 场景）
 */
export function storeOnePath(
  entry: PathVectorizeEntry,
  options?: PathVectorizeOptions
): { ok: true; memoryId: string } | { ok: false; error: string } {
  const timeout = options?.timeoutMs
    || parseInt(process.env.MEM_TIMEOUT_MS || '', 10)
    || DEFAULT_TIMEOUT_MS;

  try {
    const stdout = execFileSync(
      'mem',
      [
        'store', entry.text,
        '--scope', entry.scope,
        '--tags', entry.tag,
        '--category', PATH_CATEGORY,
        '--importance', PATH_IMPORTANCE,
      ],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      }
    );

    const m = stdout.match(MEMORY_ID_PATTERN);
    if (m) {
      return { ok: true, memoryId: m[1] };
    }
    return { ok: false, error: '无法从 stdout 解析 Memory ID' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const stdout = e.stdout ? e.stdout.toString() : '';
    // 非 0 退出但可能有 Memory ID
    const m = stdout.match(MEMORY_ID_PATTERN);
    if (m) return { ok: true, memoryId: m[1] };

    const stderr = e.stderr ? e.stderr.toString() : '';
    const statusInfo = typeof e.status === 'number' ? ` exitCode=${e.status}` : '';
    return {
      ok: false,
      error: `[path-vectorize] store 失败${statusInfo}: ${e.message || ''}${stderr ? `\n${stderr.trim().slice(0, 200)}` : ''}`.trim(),
    };
  }
}

// ─── 删除 ───

/**
 * 删除路径向量
 * 先搜索找到 memoryId，再删除
 */
export function deletePathVector(
  text: string,
  tag: 'ki-path' | 'ki-relation',
  scope: string,
  options?: PathVectorizeOptions
): { ok: boolean; error?: string } {
  const timeout = options?.timeoutMs
    || parseInt(process.env.MEM_TIMEOUT_MS || '', 10)
    || DEFAULT_TIMEOUT_MS;

  try {
    // 搜索找到 memoryId
    const searchStdout = execFileSync(
      'mem',
      ['search', text, '--scope', scope, '--tags', tag, '--limit', '1', '--json'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      }
    );

    const searchJson = JSON.parse(searchStdout.trim()) as { results?: { id: string; content: string; score: number }[] };
    if (!searchJson.results?.length) {
      return { ok: true }; // 没有找到，视为已删除
    }

    // 找到最匹配的（精确文本匹配或高 score）
    const match = searchJson.results.find((r) => r.content === text && r.score > 0.95);
    if (!match) {
      return { ok: true }; // 没有精确匹配，跳过
    }

    // 删除
    execFileSync('mem', ['delete', match.id], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });

    return { ok: true };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: `[path-vectorize] delete 失败: ${e.message}` };
  }
}

// ─── 辅助 ───

interface BulkStoreJsonResult {
  total: number;
  ok: number;
  errors: number;
  skipped: number;
  details: {
    ok: { index: number; text: string; id: string }[];
    errors: { index: number; text: string; error: string }[];
    skipped: { index: number; text: string; reason: string }[];
  };
}

function parseBulkStoreJson(stdout: string): BulkStoreJsonResult | null {
  const trimmed = stdout.trim();
  try {
    // 快速路径：整个输出就是 JSON
    if (trimmed.startsWith('{')) {
      return JSON.parse(trimmed);
    }
    // 慢速路径：从末尾找最后一个 JSON 对象
    const lastBrace = trimmed.lastIndexOf('\n{');
    if (lastBrace >= 0) {
      return JSON.parse(trimmed.slice(lastBrace + 1));
    }
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
