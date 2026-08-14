/**
 * ai-results.ts —— 导入条目的最小数据结构
 *
 * REQ-04（批次 3）：ai-results.json 输入契约已删除。本文件仅保留：
 *   - ScanResultEntry：导入使用的条目类型（瘦身为 {path, groupPath, text, memoryId, chunkRelation}）
 *   - deriveGroupPath：从文件相对路径推导 groupPath（含 group 前缀）
 */

import path from 'path';

export interface ScanResultEntry {
  /** 相对 sourceDir 的文件路径，posix 风格；直导 chunk 为 `文件#N`（deriveChunkSourcePath） */
  path: string;
  /** 在 Group 树中的完整路径，例如 "wiki/部署运维" */
  groupPath: string;
  /** 原文内容（直导：chunk 原文 / 文件全文） */
  text: string;
  /** 向量 docId；首次导入为 null，向量化成功后回填 */
  memoryId: string | null;
  /** 直导专用：chunk 的 relation 名（如 foo-01） */
  chunkRelation?: string;
}

function toPosix(input: string): string {
  return input.split(path.sep).join('/');
}

/** 从 entry 相对路径推导 groupPath（group 作为根前缀） */
export function deriveGroupPath(group: string, entryPath: string): string {
  const dir = path.posix.dirname(toPosix(entryPath));
  return dir === '.' ? group : `${group}/${dir}`;
}
