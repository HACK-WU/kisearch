/**
 * mem-client.ts —— mem CLI 调用统一封装
 *
 * 薄封装层：封装 mem CLI 的 spawnSync 调用，提供 PATH 注入、stdout 清洗、
 * JSON 解析、超时控制和错误归一化。ki 不持有向量状态，所有向量能力由 mem 提供。
 *
 * 设计要点：
 *   - PATH 注入：显式追加 nvm/homebrew 等常见路径，解决 spawnSync ENOENT
 *   - stdout 清洗：从输出末尾反向查找 JSON 对象，跳过 [mem:info] 等前导日志
 *   - 所有方法同步执行（spawnSync），与 ki 脚本执行模型一致
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── 类型定义 ───

export interface MemSearchResult {
  memoryId: string;
  content: string;
  score: number;
  tags?: string[];
}

export interface MemStoreResult {
  memoryId: string;
}

export interface BulkStoreItemResult {
  index: number;
  memoryId?: string;
  success: boolean;
  error?: string;
}

export interface MemBulkStoreResult {
  total: number;
  succeeded: number;
  failed: number;
  results: BulkStoreItemResult[];
}

export interface MemAvailableResult {
  available: boolean;
  reason?: string;
}

// ─── 常量 ───

const DEFAULT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 3_000;
const MEMORY_ID_PATTERN = /^[ \t]*Memory ID:[ \t]*(\S+)[ \t]*$/m;
const MAX_TEXT_LENGTH = 50_000;

// ─── PATH 注入 ───

function buildEnhancedPath(): string {
  const currentPath = process.env.PATH || '';
  const extra: string[] = [];

  // nvm 默认路径
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  const nvmVersionsDir = path.join(nvmDir, 'versions', 'node');
  try {
    if (fs.existsSync(nvmVersionsDir)) {
      const versions = fs.readdirSync(nvmVersionsDir);
      for (const v of versions) {
        extra.push(path.join(nvmVersionsDir, v, 'bin'));
      }
    }
  } catch { /* ignore */ }

  // 常见系统路径
  extra.push('/usr/local/bin', '/opt/homebrew/bin');

  // npm global bin
  try {
    const npmGlobalBin = execFileSync('npm', ['bin', '-g'], {
      encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (npmGlobalBin) extra.push(npmGlobalBin);
  } catch { /* ignore */ }

  return [...new Set([...extra, ...currentPath.split(path.delimiter)])].join(path.delimiter);
}

let _enhancedEnv: Record<string, string | undefined> | null = null;

function getEnhancedEnv(): Record<string, string | undefined> {
  if (!_enhancedEnv) {
    _enhancedEnv = { ...process.env, PATH: buildEnhancedPath() };
  }
  return _enhancedEnv!;
}

// ─── stdout 清洗 ───

/**
 * 从 mem CLI 的 stdout 中提取 JSON 对象。
 * mem 可能在 JSON 前输出 [mem:info] 等日志行，需清洗。
 */
function extractJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  // 快速路径：整个输出就是 JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }

  // 慢速路径：从末尾找最后一个 JSON 对象/数组
  for (const openChar of ['{', '[']) {
    const lastIdx = trimmed.lastIndexOf('\n' + openChar);
    if (lastIdx >= 0) {
      try { return JSON.parse(trimmed.slice(lastIdx + 1)); } catch { /* continue */ }
    }
  }

  // 最后尝试整行匹配
  try { return JSON.parse(trimmed); } catch { return null; }
}

// ─── 核心方法 ───

/**
 * 语义检索 mem 知识库
 */
export function memSearch(params: {
  scope: string;
  query: string;
  limit?: number;
  tags?: string;
  threshold?: number;
}): MemSearchResult[] {
  const args = ['search', params.query, '--scope', params.scope, '--json'];
  if (params.limit) args.push('--limit', String(params.limit));
  if (params.tags) args.push('--tags', params.tags);

  const stdout = execMem(args, DEFAULT_TIMEOUT_MS);
  const json = extractJson(stdout) as {
    details?: {
      memories?: Array<{
        id: string; text: string; score: number; category?: string; scope?: string;
        importance?: number; tags?: string[];
      }>;
    };
    results?: Array<{ id: string; content: string; score: number; tags?: string[] }>;
  } | null;

  // mem search 输出格式：{ details: { memories: [...] } } 或 { results: [...] }
  const memories = json?.details?.memories || json?.results || [];

  return memories
    .map(r => ({
      memoryId: r.id,
      content: (r as any).text || (r as any).content || '',
      score: r.score,
      tags: r.tags,
    }))
    .filter(r => {
      // threshold 过滤
      if (params.threshold !== undefined && r.score < params.threshold) return false;
      // tag 硬过滤：mem CLI --tags 在 JSON 模式下不是硬过滤，需客户端补过滤
      if (params.tags && !r.content.includes(`【标签:${params.tags}】`)) return false;
      return true;
    });
}

/**
 * 存储单条文本到 mem
 */
export function memStore(params: {
  scope: string;
  text: string;
  tags?: string;
  keywords?: string[];
  category?: string;
  importance?: number;
}): MemStoreResult {
  if (params.text.length > MAX_TEXT_LENGTH) {
    throw new Error(`text 超过 ${MAX_TEXT_LENGTH} 字符限制（当前 ${params.text.length}）`);
  }

  // 关键词追加到 text 末尾，提升语义搜索召回精度
  const fullText = params.keywords?.length
    ? `${params.text}\n\n[关键词] ${params.keywords.join(', ')}`
    : params.text;

  const args = ['store', fullText, '--scope', params.scope];
  if (params.tags) args.push('--tags', params.tags);
  if (params.category) args.push('--category', params.category);
  if (params.importance !== undefined) args.push('--importance', String(params.importance));

  const stdout = execMem(args, DEFAULT_TIMEOUT_MS);
  const m = stdout.match(MEMORY_ID_PATTERN);
  if (m) return { memoryId: m[1] };

  // 尝试从 JSON 输出提取
  const json = extractJson(stdout) as { id?: string; memoryId?: string } | null;
  const id = json?.id || json?.memoryId;
  if (id) return { memoryId: id };

  throw new Error('无法从 mem store 输出中解析 Memory ID');
}

/**
 * 批量存储文本到 mem
 */
export function memBulkStore(params: {
  scope: string;
  entries: { text: string; tags?: string; keywords?: string[] }[];
}): MemBulkStoreResult {
  if (params.entries.length === 0) {
    return { total: 0, succeeded: 0, failed: 0, results: [] };
  }

  // 构建 bulk-store JSON 文件
  const bulkData = params.entries.map(e => ({
    text: e.text,
    tags: e.tags || 'ki-search',
    scope: params.scope,
    category: 'other',
    importance: 0.5,
  }));

  const tmpFile = path.join(os.tmpdir(), `ki-mem-bulk-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(bulkData), 'utf-8');

    const stdout = execMem(
      ['bulk-store', '-f', tmpFile, '--json', '--scope', params.scope],
      DEFAULT_TIMEOUT_MS + params.entries.length * 10_000
    );

    const json = extractJson(stdout) as {
      total?: number;
      details?: {
        ok?: { index: number; id: string; text: string }[];
        errors?: { index: number; text: string; error: string }[];
        skipped?: { index: number; text: string; reason: string }[];
      };
    } | null;

    if (!json) {
      return {
        total: params.entries.length,
        succeeded: 0,
        failed: params.entries.length,
        results: params.entries.map((_, i) => ({
          index: i, success: false, error: '无法解析 bulk-store JSON 输出',
        })),
      };
    }

    const results: BulkStoreItemResult[] = [];
    for (const item of json.details?.ok || []) {
      results.push({ index: item.index, memoryId: item.id, success: true });
    }
    for (const item of json.details?.errors || []) {
      results.push({ index: item.index, success: false, error: item.error });
    }
    for (const item of json.details?.skipped || []) {
      results.push({ index: item.index, success: false, error: item.reason || 'skipped' });
    }

    // 按 index 排序
    results.sort((a, b) => a.index - b.index);

    return {
      total: json.total ?? params.entries.length,
      succeeded: (json.details?.ok || []).length,
      failed: (json.details?.errors || []).length + (json.details?.skipped || []).length,
      results,
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ─── 可用性检测 ───

let _memAvailable: MemAvailableResult | null = null;

/**
 * 检测 mem CLI 是否可用（每次调用实际执行 mem --version）
 */
export function checkMemAvailable(): MemAvailableResult {
  try {
    execFileSync('mem', ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHECK_TIMEOUT_MS,
      env: getEnhancedEnv(),
    });
    return { available: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return { available: false, reason: 'mem CLI 未安装。安装命令: npm install -g @anthropic/mem' };
    }
    if (e.code === 'ETIMEDOUT' || (e as any).killed) {
      return { available: false, reason: 'mem CLI 响应超时' };
    }
    return { available: false, reason: `mem CLI 异常: ${e.message}` };
  }
}

/**
 * 进程内缓存版可用性检测（推荐在业务逻辑中使用）
 */
export function ensureMemAvailable(): MemAvailableResult {
  if (_memAvailable === null) {
    _memAvailable = checkMemAvailable();
  }
  return _memAvailable;
}

// ─── 内部辅助 ───

function execMem(args: string[], timeout: number): string {
  try {
    return execFileSync('mem', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      env: getEnhancedEnv(),
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string };
    if (e.code === 'ENOENT') {
      throw new Error('mem CLI 未安装');
    }
    const stderr = e.stderr ? e.stderr.toString().trim().slice(0, 300) : '';
    const stdout = e.stdout ? e.stdout.toString() : '';
    // 非 0 退出但可能有有用输出（如 store 的 Memory ID）
    if (stdout) return stdout;
    throw new Error(`mem ${args[0]} 失败: ${e.message}${stderr ? `\n${stderr}` : ''}`);
  }
}
