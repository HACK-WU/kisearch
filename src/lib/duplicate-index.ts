/**
 * duplicate-index.ts —— 「疑似重复文档」判据的**单一真相**（REQ-20261019-002）。
 *
 * 为什么独立成模块：预检（`import-preflight.ts`）与导入（`import.ts`）需要**同一套判据**，
 * 而 `import-preflight.ts` 已 `import` `import.ts` 的 `collectMarkdownFiles` —— 若 `import.ts`
 * 反向引用预检模块会形成 ESM 循环依赖；复制一份判据则两份真相必然漂移。
 *
 * 判据：
 * - 文件**原文**（未清洗）sha256 与库中 local KB 原文哈希比对；
 * - **同一篇文档 = 「本次落点（groupPath + relation）与库中某条一致」或「sourcePath 与本次 rel 一致」**，
 *   命中任一即视为幂等更新，**不算重复**；
 * - 库中该 relation 无 `sourcePath`（历史 sync-relation 写入）时，仍可用落点比较兜住；
 * - 单文件读取失败按"未命中"处理（判据只做提示/剔除，不阻断；真正的失败在导入循环里 fail-loud）。
 *
 * ★ 2026-10-19 修复（debug）：旧判据只比 `sourcePath`（相对 sourceDir 的裸路径），
 *   而落点由 `group + rel` 共同决定。当 group 吸收了路径前缀时（上次 sourceDir 选父目录、
 *   本次选 `<group>` 子目录），裸 rel 不同但**落点相同** ⇒ 幂等更新被误判成「疑似重复」，
 *   预检面板会把整批"更新已有文档"报成"会新建副本"。
 *
 * 本模块**只读**：不写 KB / 向量 / 元数据，也不依赖 `import.ts`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAllGroupCaches } from './group-cache.js';
import { getLocalKbDir } from './scope.js';
import { relationOfPath, resolveGroupForSource } from './import-path.js';

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
 * 建库索引：原文哈希 → 命中文档**列表**。
 *
 * ★ 不能只保留第一条：库里可能存在多份同内容文档（不同 group 各一份）。只留第一条时，
 *   "与本次同落点"的那一条可能不在索引里，判据就会拿另一份的 sourcePath 去比而误判。
 * 无原文（local KB 缺失该 relation）或原文为空的条目跳过——它们无从比对。
 * 单个 Group 的 KB 读取失败不影响整体（提示用途，不 fail-loud）。
 */
export function buildLibraryIndex(scope: string): Map<string, DuplicateHit[]> {
  const index = new Map<string, DuplicateHit[]>();
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
      const hit: DuplicateHit = {
        existingGroup: groupPath,
        existingRelation: relation.text,
        existingSourcePath: relation.sourcePath ?? '',
      };
      const list = index.get(hash);
      if (list) list.push(hit);
      else index.set(hash, [hit]);
    }
  }
  return index;
}

/** 两条记录是否指向**同一篇文档**（同来源路径，或同落点） */
function isSameDocument(hit: DuplicateHit, rel: string, groupPath: string, relation: string): boolean {
  if (hit.existingSourcePath === rel) return true;
  return hit.existingGroup === groupPath && hit.existingRelation === relation;
}

/**
 * 在 `relPaths` 中找出「内容与库中已有文档一致且不是同一篇」的文件。
 *
 * @param args.relPaths 待检查的相对路径（相对 `sourceDir`，posix 风格）
 * @param args.group    本次导入的显式 group（与 `handleDirectImport` 同参数）；
 *                      缺省时按「相对目录即 group」推导，与真实落点规则一致
 * @param args.index    复用已建索引（同进程连续调用时可省一次全库 sha256）
 * @returns key = 本次的相对路径；value = 库中命中且与本次**不同落点**的文档（按 group/relation 排序取第一条）
 */
export function collectDuplicateHits(args: {
  scope: string;
  sourceDir: string;
  relPaths: string[];
  group?: string;
  index?: Map<string, DuplicateHit[]>;
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
    const candidates = index.get(hashText(text));
    if (!candidates || candidates.length === 0) continue;
    const groupPath = resolveGroupForSource(args.group ?? '', rel, args.scope);
    const relation = relationOfPath(rel);
    // 任一条与本次是同一篇 ⇒ 幂等更新，不算重复
    if (candidates.some((hit) => isSameDocument(hit, rel, groupPath, relation))) continue;
    // 提示对象取排序后的第一条，保证多次调用输出稳定
    const [first] = [...candidates].sort((a, b) => (
      a.existingGroup === b.existingGroup
        ? a.existingRelation.localeCompare(b.existingRelation)
        : a.existingGroup.localeCompare(b.existingGroup)
    ));
    hits.set(rel, first);
  }
  return hits;
}
