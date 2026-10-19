/**
 * duplicate-index.ts —— 「疑似重复文档」判据的**单一真相**（REQ-20261019-002）。
 *
 * 为什么独立成模块：预检（`import-preflight.ts`）与导入（`import.ts`）需要**同一套判据**，
 * 而 `import-preflight.ts` 已 `import` `import.ts` 的 `collectMarkdownFiles` —— 若 `import.ts`
 * 反向引用预检模块会形成 ESM 循环依赖；复制一份判据则两份真相必然漂移。
 *
 * 判据（与 REQ-20261010-001 R6 完全一致，不得在此之外扩展）：
 * - 文件**原文**（未清洗）sha256 与库中 local KB 原文哈希比对；
 * - 命中且 `sourcePath !== rel` → 判为疑似重复（同 sourcePath 是正常幂等更新）；
 * - 库中该 relation 无 `sourcePath`（历史 sync-relation 写入）→ 视为来源不同，算命中；
 * - 单文件读取失败按"未命中"处理（判据只做提示/剔除，不阻断；真正的失败在导入循环里 fail-loud）。
 *
 * 本模块**只读**：不写 KB / 向量 / 元数据，也不依赖 `import.ts`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAllGroupCaches } from './group-cache.js';
import { getLocalKbDir } from './scope.js';

export interface DuplicateHit {
  /** 库中命中的文档落点 */
  existingGroup: string;
  existingRelation: string;
  /** 库中该文档记录的来源路径（可能为空：手工 sync-relation 写入的文档没有 sourcePath） */
  existingSourcePath: string;
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 建库索引：原文哈希 → 命中文档（同哈希只保留第一条，够用于"提示/剔除"用途）。
 * 无原文（local KB 缺失该 relation）或原文为空的条目跳过——它们无从比对。
 * 单个 Group 的 KB 读取失败不影响整体（提示用途，不 fail-loud）。
 */
export function buildLibraryIndex(scope: string): Map<string, DuplicateHit> {
  const index = new Map<string, DuplicateHit>();
  for (const [groupPath, data] of readAllGroupCaches(scope)) {
    if (data.hot_relations.length === 0) continue;
    let localKb: Record<string, unknown>;
    try {
      const kbPath = getLocalKbDir(scope, groupPath);
      if (!fs.existsSync(kbPath)) continue;
      localKb = JSON.parse(fs.readFileSync(kbPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const relation of data.hot_relations) {
      const text = localKb[relation.text];
      if (typeof text !== 'string' || text.length === 0) continue;
      const hash = hashText(text);
      if (index.has(hash)) continue;
      index.set(hash, {
        existingGroup: groupPath,
        existingRelation: relation.text,
        existingSourcePath: relation.sourcePath ?? '',
      });
    }
  }
  return index;
}

/**
 * 在 `relPaths` 中找出「内容与库中已有文档一致且来源不同」的文件。
 *
 * @param args.relPaths 待检查的相对路径（相对 `sourceDir`，posix 风格）
 * @param args.index   复用已建索引（同进程连续调用时可省一次全库 sha256）
 * @returns key = 本次的相对路径；value = 库中命中文档信息
 */
export function collectDuplicateHits(args: {
  scope: string;
  sourceDir: string;
  relPaths: string[];
  index?: Map<string, DuplicateHit>;
  onProgress?: (done: number, total: number) => void;
}): Map<string, DuplicateHit> {
  const index = args.index ?? buildLibraryIndex(args.scope);
  const hits = new Map<string, DuplicateHit>();
  let done = 0;
  for (const rel of args.relPaths) {
    done += 1;
    args.onProgress?.(done, args.relPaths.length);
    let text: string;
    try {
      text = fs.readFileSync(path.resolve(args.sourceDir, rel), 'utf-8');
    } catch {
      continue; // 读取失败按"未命中"处理（见文件头说明）
    }
    const hit = index.get(hashText(text));
    // sourcePath 相同 = 正常的幂等更新，不算重复
    if (!hit || hit.existingSourcePath === rel) continue;
    hits.set(rel, hit);
  }
  return hits;
}
