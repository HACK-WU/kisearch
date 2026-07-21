/**
 * ai-results.ts —— S-02：AI 输出的 ai-results.json 解析、校验、归一化
 *
 * 顶层结构：
 *   { meta: { sourceDir, rootName }, entries: ScanResultEntry[] }
 *
 * 解析规则（normalizeAiResults）：
 *   1. meta.sourceDir / meta.rootName 必填，缺失即 fail
 *   2. groupPath 缺失 → 自动从 path 推导 `${rootName}/${dirname(path)}`
 *   3. groupPath 首段必须等于 rootName，否则 fail（避免脏数据写入 Group 树）
 *   4. action 缺失 → 默认 'add'
 *   5. action === 'delete' 必须携带 memoryId，否则 fail
 *   6. memoryId 缺失 → null（首次导入由 batchVectorize 填充）
 *   7. enriched 缺失 → false
 */

import fs from 'fs';
import path from 'path';

export type EntryAction = 'add' | 'modify' | 'delete';

export interface AiResultsMeta {
  sourceDir: string;
  rootName: string;
}

export interface ScanResultEntry {
  /** 相对于 meta.sourceDir 的文件路径，posix 风格 */
  path: string;
  /** 在 Group 树中的完整路径，含 rootName 前缀，例如 "wiki/部署运维" */
  groupPath: string;
  summary: string;
  keywords: string[];
  enriched: boolean;
  /** 首次导入为 null；增量导入由 AI 提供（modify/delete 必填） */
  memoryId: string | null;
  /** 增量操作语义；首次导入默认 'add' */
  action: EntryAction;
  /** 旧字段保留兼容（重命名时关联旧 memory），不再使用建议忽略 */
  replaces?: string;
}

export interface AiResultsFile {
  meta: AiResultsMeta;
  entries: ScanResultEntry[];
}

/** 内部使用：原始 entry（字段全部可选） */
type RawEntry = Partial<ScanResultEntry> & { path?: string; action?: string };
type RawFile = { meta?: Partial<AiResultsMeta>; entries?: RawEntry[] };

function toPosix(input: string): string {
  return input.split(path.sep).join('/');
}

function deriveGroupPath(rootName: string, entryPath: string): string {
  const dir = path.posix.dirname(toPosix(entryPath));
  return dir === '.' ? rootName : `${rootName}/${dir}`;
}

/**
 * 读取并归一化 ai-results.json
 * @throws Error 含具体错误信息（meta 缺失 / JSON 非法 / 必填字段缺失）
 */
export function normalizeAiResults(resultsFile: string): AiResultsFile {
  if (!fs.existsSync(resultsFile)) {
    throw new Error(`ai-results 文件不存在：${resultsFile}`);
  }

  let raw: RawFile;
  try {
    raw = JSON.parse(fs.readFileSync(resultsFile, 'utf-8')) as RawFile;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`ai-results JSON 解析失败：${resultsFile}\n${detail}`);
  }

  // meta 校验
  const meta = raw.meta;
  if (!meta || typeof meta !== 'object') {
    throw new Error('ai-results 顶层缺少 meta 字段，应为 { sourceDir, rootName }');
  }
  const sourceDir = (meta.sourceDir || '').trim();
  const rootName = (meta.rootName || '').trim();
  if (!sourceDir) throw new Error('ai-results.meta.sourceDir 不能为空');
  if (!rootName) throw new Error('ai-results.meta.rootName 不能为空');

  const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
  const entries: ScanResultEntry[] = [];

  for (let i = 0; i < rawEntries.length; i++) {
    const e = rawEntries[i];
    const idx = `entries[${i}]`;
    if (!e || typeof e !== 'object') throw new Error(`${idx} 不是对象`);
    if (!e.path || typeof e.path !== 'string') {
      throw new Error(`${idx}.path 必填且为字符串`);
    }
    const entryPath = toPosix(e.path);

    // action 归一化
    let action: EntryAction = 'add';
    if (e.action) {
      const a = String(e.action).toLowerCase();
      if (a !== 'add' && a !== 'modify' && a !== 'delete') {
        throw new Error(`${idx}.action 非法：${e.action}，应为 add/modify/delete`);
      }
      action = a as EntryAction;
    }

    // memoryId 归一化
    const memoryId =
      typeof e.memoryId === 'string' && e.memoryId.trim()
        ? e.memoryId.trim()
        : null;

    // delete 必须带 memoryId
    if (action === 'delete' && !memoryId) {
      throw new Error(`${idx} action=delete 必须携带 memoryId`);
    }

    // groupPath 归一化
    let groupPath: string;
    if (typeof e.groupPath === 'string' && e.groupPath.trim()) {
      groupPath = e.groupPath.trim();
    } else {
      groupPath = deriveGroupPath(rootName, entryPath);
    }
    // 校验首段 === rootName
    const first = groupPath.split('/').filter(Boolean)[0];
    if (first !== rootName) {
      throw new Error(
        `${idx}.groupPath="${groupPath}" 首段 "${first}" 与 meta.rootName="${rootName}" 不一致`
      );
    }

    const summary = typeof e.summary === 'string' ? e.summary : '';
    const keywords = Array.isArray(e.keywords)
      ? [...new Set(e.keywords.map((kw) => String(kw).trim()).filter(Boolean))]
      : [];

    entries.push({
      path: entryPath,
      groupPath,
      summary,
      keywords,
      enriched: Boolean(e.enriched),
      memoryId,
      action,
      ...(e.replaces ? { replaces: String(e.replaces) } : {}),
    });
  }

  return {
    meta: { sourceDir, rootName },
    entries,
  };
}
