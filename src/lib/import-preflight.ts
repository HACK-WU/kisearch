/**
 * import-preflight.ts —— 重复导入预检（REQ-20261010-001 R6 / A10）。
 *
 * 目的：导入**前**告诉用户「本次 N 篇与库中已有文档内容一致，但 sourcePath 不同，
 * 会作为新文档创建」，由用户确认后才继续；取消则什么都不发生（本模块**只读**：
 * 不复制附件、不写 local KB / 向量 / 元数据）。
 *
 * 为什么需要它：路径口径对齐（R1）之后，跨入口重复导入已被幂等覆盖吸收；剩下的
 * "内容一致但 rel 不同"（例如同一份 wiki 被克隆到别处、或目录层级不同）仍会产生副本，
 * 而这类重复从进度条上看不出来。
 *
 * 判据：文件**原文**（未清洗）sha256 与库中 local KB 原文哈希比对，命中且
 * `sourcePath !== rel` → 判为疑似重复。
 * - 选原文而非 chunk docId：预检要便宜（不跑清洗规则、不切分），且更保守——
 *   原文一致必然是"内容一致"，不会因清洗细节产生误报；
 * - `sourcePath` 相同的不算重复（那是正常的幂等更新，见 import-conflict.ts）。
 *
 * 成本：O(库内文档数) 次 sha256 + O(本次文件数)。数万篇量级为数十~数百毫秒；
 * 暂不设上限（如需可加“库内文档数超阈值则跳过预检”的降级）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectMarkdownFiles, DEFAULT_EXTENSIONS } from './import.js';
import { readAllGroupCaches } from './group-cache.js';
import { getLocalKbDir } from './scope.js';

export interface ImportPreflightDuplicate {
  /** 本次待导入文件的相对路径（与 `ki import` 的 rel 同口径） */
  rel: string;
  /** 库中命中的文档落点 */
  existingGroup: string;
  existingRelation: string;
  /** 库中该文档记录的来源路径（可能为空：手工 sync-relation 写入的文档没有 sourcePath） */
  existingSourcePath: string;
}

export interface ImportPreflightResult {
  ok: true;
  scope: string;
  files: {
    /** 本次预检扫描到的 Markdown 文件数 */
    scanned: number;
    /** 命中「内容一致但来源不同」的文件数（完整计数，不受明细截断影响） */
    matched: number;
  };
  duplicates: ImportPreflightDuplicate[];
  /** 明细被截断（`duplicates.length` 达到上限；`files.matched` 仍是完整计数） */
  truncated: boolean;
}

export const DEFAULT_PREFLIGHT_MAX_DETAIL = 50;

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 建库索引：原文哈希 → 命中文档（同哈希只保留第一条，够用于"提示"用途）。
 * 无原文（local KB 缺失该 relation）或原文为空的条目跳过——它们无从比对。
 */
function buildLibraryIndex(scope: string): Map<string, Omit<ImportPreflightDuplicate, 'rel'>> {
  const index = new Map<string, Omit<ImportPreflightDuplicate, 'rel'>>();
  for (const [groupPath, data] of readAllGroupCaches(scope)) {
    if (data.hot_relations.length === 0) continue;
    let localKb: Record<string, unknown>;
    try {
      const kbPath = getLocalKbDir(scope, groupPath);
      if (!fs.existsSync(kbPath)) continue;
      localKb = JSON.parse(fs.readFileSync(kbPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // 单个 Group 的 KB 读取失败不影响整体预检（提示用途，不 fail-loud）
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
 * 预检暂存目录（`~/.ki/import-uploads/<uploadId>/`）里的文件是否与库中已有文档重复。
 *
 * @param args.onlyRelPaths 只检查这些相对路径（「重试未完成」子集与 run 同口径）
 */
export function preflightImportDuplicates(args: {
  scope: string;
  sourceDir: string;
  onlyRelPaths?: string[];
  maxDetail?: number;
  extensions?: string[];
}): ImportPreflightResult {
  const maxDetail = args.maxDetail ?? DEFAULT_PREFLIGHT_MAX_DETAIL;
  const { files } = collectMarkdownFiles(args.sourceDir, args.extensions ?? DEFAULT_EXTENSIONS);
  const onlySet = args.onlyRelPaths ? new Set(args.onlyRelPaths) : null;
  const effective = (onlySet ? files.filter((rel) => onlySet.has(rel)) : files).sort();
  const index = buildLibraryIndex(args.scope);
  const duplicates: ImportPreflightDuplicate[] = [];
  let matched = 0;
  for (const rel of effective) {
    let text: string;
    try {
      text = fs.readFileSync(path.resolve(args.sourceDir, rel), 'utf-8');
    } catch {
      continue; // 读取失败按"未命中"处理：预检是提示，不阻断（真正的失败在 run 阶段 fail-loud）
    }
    const hit = index.get(hashText(text));
    // sourcePath 相同 = 正常的幂等更新，不算重复
    if (!hit || hit.existingSourcePath === rel) continue;
    matched += 1;
    if (duplicates.length < maxDetail) duplicates.push({ rel, ...hit });
  }
  return {
    ok: true,
    scope: args.scope,
    files: { scanned: effective.length, matched },
    duplicates,
    truncated: matched > duplicates.length,
  };
}
