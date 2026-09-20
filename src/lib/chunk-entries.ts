/**
 * chunk-entries.ts —— 清洗后文本 → chunk → chunk 级向量化条目（import 与 rebuild 共用）
 *
 * 背景（一致性问题）：`ki import` 的向量化输入是「清洗后的 chunk」，而 local KB
 * （index.json）存的是「文件级原文」（方案 D：清洗只作用于向量化输入，KB 保原文）。
 * 若 `restore --rebuild-vector` 直接拿 KB 原文当向量输入（旧实现），两条链路会在
 * 两个维度上不一致：
 *   - 粒度：import 是 chunk 级（一个文件 N 条向量），rebuild 是文件级（N=1）；
 *   - 文本：import 是清洗后文本，rebuild 是含 frontmatter/HTML 注释等的原文。
 * 直接后果是 docId 与 memoryId 语义漂移、检索粒度粗化、噪声进入 embedding。
 *
 * 因此「chunk 命名 + 条目构造」收敛为本模块的唯一实现：import 与 rebuild 都必须
 * 经由 buildChunkEntries 构造 content 向量条目，禁止各自内联复制。
 *
 * 注意：清洗（内置规则 + 外部 hooks）由调用方在传入前完成——hooks 是异步的、
 * 且 import 侧带失败回滚逻辑，本模块保持纯同步，确保两条链路拿到完全相同的条目。
 */

import path from 'node:path';

import { splitIntoChunks, type Chunk } from './chunker.js';
import type { ScanResultEntry } from './ai-results.js';

// ─── 命名 ───

export function stripMarkdownExtension(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** 从 entry.path 推导 relation 文本（剥 .md + 去掉 markdown 强格式字符） */
export function deriveRelationText(filePath: string): string {
  const base = stripMarkdownExtension(path.posix.basename(filePath));
  const cleaned = base.replace(/[*~`]/g, '').trim();
  return cleaned || base;
}

/** chunk relation 命名：文件名-N（如 foo.md → foo-01），`#` 避免与 isUnsafeRelationName 冲突 */
export function deriveChunkRelation(filePath: string, chunkIndex: number): string {
  const base = deriveRelationText(filePath);
  return `${base}-${String(chunkIndex).padStart(2, '0')}`;
}

/** chunk 的 sourcePath：文件路径#序号（如 docs/foo.md#1），文件级 diff 前缀聚合的键 */
export function deriveChunkSourcePath(filePath: string, chunkIndex: number): string {
  return `${toPosix(filePath)}#${chunkIndex}`;
}

// ─── 条目构造 ───

export interface ChunkEntriesResult {
  chunks: Chunk[];
  entries: ScanResultEntry[];
}

/**
 * 把「已清洗文本」按切分参数切成 chunk，并构造 chunk 级向量化条目。
 *
 * @param params.fileKey 文件级标识：
 *   - import 传文件相对路径（`docs/foo.md`）；
 *   - rebuild 传 local KB 的键（= 导入时的 `deriveRelationText(rel)`，如 `foo`）。
 *   两者产出的 chunk relation 名一致（`foo-01`），docId 因此可复现。
 * @param params.text 已清洗文本（未清洗会让 rebuild 与 import 的向量文本不一致）
 */
export function buildChunkEntries(params: {
  fileKey: string;
  groupPath: string;
  text: string;
  chunkSize: number;
  chunkOverlap: number;
  /** 可选的文件级 relation 名；导入冲突自动后缀时与 fileKey basename 不同。 */
  relationName?: string;
}): ChunkEntriesResult {
  const chunks = splitIntoChunks(params.text, {
    chunkSize: params.chunkSize,
    overlap: params.chunkOverlap,
  });
  const entries: ScanResultEntry[] = chunks.map((chunk) => ({
    path: deriveChunkSourcePath(params.fileKey, chunk.index),
    groupPath: params.groupPath,
    text: chunk.text,
    memoryId: null,
    chunkRelation: params.relationName
      ? `${params.relationName}-${String(chunk.index).padStart(2, '0')}`
      : deriveChunkRelation(params.fileKey, chunk.index),
    fileRelation: params.relationName ?? deriveRelationText(params.fileKey),
  }));
  return { chunks, entries };
}
